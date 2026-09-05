/**
 * The map's arithmetic.
 *
 * Projection and bearing errors do not crash — they quietly plot an incident
 * in the wrong field, which is worse. Distances are checked against an
 * independent haversine rather than against the same constants the source
 * uses, so a wrong constant cannot agree with itself.
 */
import { describe, expect, test } from "bun:test";
import {
  ATTARI_SECTOR, fovPolygon, gridRef, offset, project, sectorSpanM, type GeoPoint,
} from "../src/client/geography";

const R = 6_371_008.8;

function haversine(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const geo = ATTARI_SECTOR;

/**
 * The source works on the WGS84 ellipsoid; this check uses a sphere. They
 * genuinely disagree by about 0.3% at this latitude, so the assertion is a
 * relative tolerance — tightening it further would be asserting that two
 * different earth models are the same model.
 */
const within = (actual: number, expected: number, fraction = 0.005) =>
  Math.abs(actual - expected) / expected < fraction;

describe("projection", () => {
  test("the sector corners map to the unit box", () => {
    const nw = project({ lat: geo.bounds.north, lon: geo.bounds.west }, geo);
    const se = project({ lat: geo.bounds.south, lon: geo.bounds.east }, geo);
    expect(nw.x).toBeCloseTo(0, 6);
    expect(nw.y).toBeCloseTo(0, 6);
    expect(se.x).toBeCloseTo(1, 6);
    expect(se.y).toBeCloseTo(1, 6);
  });

  test("the sector is a few kilometres across, not a few hundred", () => {
    const span = sectorSpanM(geo);
    expect(span.width).toBeGreaterThan(4_000);
    expect(span.width).toBeLessThan(7_000);
    expect(span.height).toBeGreaterThan(8_000);
    expect(span.height).toBeLessThan(10_000);
  });
});

describe("grid references", () => {
  test("known positions land in the expected square", () => {
    // Wagah crossing, at its real published position.
    expect(gridRef({ lat: 31.6047, lon: 74.573 }, geo)).toBe("5B");
    expect(gridRef(geo.cameras.cam_fence_north!.at, geo)).toBe("2C");
  });

  test("a point outside the sector clamps instead of inventing a square", () => {
    expect(gridRef({ lat: 40, lon: 60 }, geo)).toBe("1A");
    expect(gridRef({ lat: 10, lon: 90 }, geo)).toBe("8F");
  });

  test("every camera resolves to a real square", () => {
    for (const placement of Object.values(geo.cameras)) {
      expect(gridRef(placement.at, geo)).toMatch(/^[1-8][A-F]$/);
    }
  });
});

describe("bearings and coverage", () => {
  test("offset moves the stated distance in the stated direction", () => {
    const from = { lat: 31.6, lon: 74.58 };

    const north = offset(from, 0, 1_000);
    expect(north.lat).toBeGreaterThan(from.lat);
    expect(north.lon).toBeCloseTo(from.lon, 6);
    expect(within(haversine(from, north), 1_000)).toBe(true);

    const east = offset(from, 90, 1_000);
    expect(east.lon).toBeGreaterThan(from.lon);
    expect(east.lat).toBeCloseTo(from.lat, 6);
    expect(within(haversine(from, east), 1_000)).toBe(true);

    // South and west must actually go the other way, not just "somewhere".
    expect(offset(from, 180, 500).lat).toBeLessThan(from.lat);
    expect(offset(from, 270, 500).lon).toBeLessThan(from.lon);
  });

  test("a field of view closes back on the camera at the right radius", () => {
    const placement = geo.cameras.cam_fence_north!;
    const wedge = fovPolygon(placement, 12);

    // The mount, plus an arc of steps + 1 points.
    expect(wedge).toHaveLength(14);
    expect(wedge[0]).toEqual(placement.at);

    for (const point of wedge.slice(1)) {
      expect(within(haversine(placement.at, point), placement.rangeM)).toBe(true);
    }
  });
});

describe("sector geometry is coherent", () => {
  test("the fence sits inside the border, never across it", () => {
    expect(geo.fence).toHaveLength(geo.border.length);
    geo.border.forEach((borderPoint, index) => {
      const fencePoint = geo.fence[index]!;
      // India is east of the boundary in this sector.
      expect(fencePoint.lon).toBeGreaterThan(borderPoint.lon);
      expect(haversine(borderPoint, fencePoint)).toBeLessThan(400);
    });
  });

  test("the patrol road sits behind the fence", () => {
    geo.fence.forEach((fencePoint, index) => {
      expect(geo.patrolRoad[index]!.lon).toBeGreaterThan(fencePoint.lon);
    });
  });

  test("every camera is inside the sector it claims to watch", () => {
    for (const placement of Object.values(geo.cameras)) {
      expect(placement.at.lat).toBeLessThan(geo.bounds.north);
      expect(placement.at.lat).toBeGreaterThan(geo.bounds.south);
      expect(placement.at.lon).toBeLessThan(geo.bounds.east);
      expect(placement.at.lon).toBeGreaterThan(geo.bounds.west);
    }
  });
});
