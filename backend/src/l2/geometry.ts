import type { Point, Zone, Direction } from "../core/types";

/**
 * Zone geometry. Pure functions over normalised (0..1) frame coordinates --
 * no database, no clock, no state, so this is the part that can be tested
 * exhaustively and trusted everywhere else.
 */

/**
 * The point on a detection that is compared against a zone: bottom-centre of
 * the box, i.e. where the subject touches the ground. Using the box centre
 * would make a tall person cross a line roughly half a body-height early.
 */
export function groundPoint(bbox: [number, number, number, number]): Point {
  const [x, y, w, h] = bbox;
  return [x + w / 2, y + h];
}

/**
 * Which side of a directed segment a point falls on.
 * Positive is the right-hand side looking along p1 -> p2.
 */
function sideOf(p1: Point, p2: Point, p: Point): number {
  return (p2[0] - p1[0]) * (p[1] - p1[1]) - (p2[1] - p1[1]) * (p[0] - p1[0]);
}

function sign(n: number, epsilon = 1e-9): -1 | 0 | 1 {
  if (n > epsilon) return 1;
  if (n < -epsilon) return -1;
  return 0;
}

/** Do segments a1-a2 and b1-b2 properly intersect? */
export function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = sign(sideOf(b1, b2, a1));
  const d2 = sign(sideOf(b1, b2, a2));
  const d3 = sign(sideOf(a1, a2, b1));
  const d4 = sign(sideOf(a1, a2, b2));
  return d1 !== d2 && d3 !== d4;
}

/** Ray casting. Points exactly on an edge count as inside. */
export function pointInPolygon(polygon: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const straddles = yi > p[1] !== yj > p[1];
    if (straddles && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Where a subject stands relative to a zone, reduced to one bit.
 *
 * For a polygon: inside or outside.
 * For a line (or polyline): which side of it. A polyline uses its first and
 * last vertex to define the overall direction, so "inbound" stays meaningful
 * on a fence drawn with a kink in it.
 */
export function sideForZone(zone: Zone, p: Point): 1 | -1 | 0 {
  if (zone.geometry === "polygon") {
    return pointInPolygon(zone.points, p) ? 1 : -1;
  }
  const first = zone.points[0]!;
  const last = zone.points[zone.points.length - 1]!;
  return sign(sideOf(first, last, p));
}

/**
 * Did the move from `from` to `to` cross this zone, and which way?
 *
 * Convention, and it is worth stating because operators will draw these:
 *   - line zone: the subject crosses INBOUND when it moves onto the
 *     right-hand side of the line as drawn (first point -> last point).
 *     Draw the fence left-to-right with the friendly side below it and
 *     inbound means "came towards us".
 *   - polygon zone: INBOUND is entering the shape, OUTBOUND is leaving it.
 *
 * Returns null when the subject did not cross.
 */
export function crossingOf(zone: Zone, from: Point, to: Point): Direction | null {
  if (zone.geometry === "polygon") {
    const was = pointInPolygon(zone.points, from);
    const is = pointInPolygon(zone.points, to);
    if (was === is) return null;
    return is ? "inbound" : "outbound";
  }

  // A line zone may be a polyline; the subject crosses if its movement
  // intersects any segment of it.
  let touched = false;
  for (let i = 0; i < zone.points.length - 1; i++) {
    if (segmentsCross(from, to, zone.points[i]!, zone.points[i + 1]!)) {
      touched = true;
      break;
    }
  }
  if (!touched) return null;

  const before = sideForZone(zone, from);
  const after = sideForZone(zone, to);
  // Standing ON the line. `sign` is tri-state, so 0 means "no side established
  // yet" -- not a side, and not a crossing. Falling through would report every
  // on-line landing as OUTBOUND regardless of travel direction. Nothing is
  // lost: the crossing fires on the next step, from the side actually reached.
  // Ported from core/geometry.py -- change one, change the other.
  if (after === 0) return null;
  if (before === after) return null; // grazed a vertex without changing side
  return after === 1 ? "inbound" : "outbound";
}

/** Does this zone care about a crossing in this direction? */
export function directionWanted(zone: Zone, direction: Direction): boolean {
  return zone.direction === "both" || zone.direction === direction;
}

/** Reject a zone that cannot be evaluated, before it is ever stored. */
export function validateZonePoints(geometry: string, points: unknown): string | null {
  if (!Array.isArray(points)) return "points must be an array";
  const minimum = geometry === "polygon" ? 3 : 2;
  if (points.length < minimum) {
    return `a ${geometry} zone needs at least ${minimum} points`;
  }
  for (const point of points) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number" ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      return "each point must be a pair of finite numbers";
    }
    if (point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) {
      return "points are normalised and must fall between 0 and 1";
    }
  }
  return null;
}
