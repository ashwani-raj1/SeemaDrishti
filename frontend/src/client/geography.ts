/**
 * Where this deployment actually is (#39).
 *
 * Geography is configuration, not code -- the same reason zones are. A naval
 * deployment supplies a jetty and a waterline here; nothing in the map
 * component knows which force it is drawing for.
 *
 * Coordinates are WGS84 decimal degrees, Attari sector, Amritsar district,
 * Punjab -- the Attari-Wagah crossing on the India-Pakistan border.
 *
 * Honest about accuracy: the crossing, the ICP and Attari village sit at their
 * real published positions. The fence, patrol road and BOP placements are a
 * representative alignment for that sector at roughly the right offsets --
 * they are not a survey, and nothing here is derived from restricted data.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface Landmark {
  name: string;
  kind: "settlement" | "crossing" | "post" | "checkpost";
  at: GeoPoint;
}

export interface CameraPlacement {
  /** Where the camera sits. */
  at: GeoPoint;
  /** Compass bearing it faces, degrees from true north. */
  bearing: number;
  /** Horizontal field of view. */
  fovDeg: number;
  /** Useful range in metres -- how far it can actually resolve a person. */
  rangeM: number;
}

export interface SiteGeography {
  label: string;
  region: string;
  datum: string;
  bounds: { north: number; south: number; east: number; west: number };
  /** The international boundary. */
  border: GeoPoint[];
  /** The fence, inside the boundary. */
  fence: GeoPoint[];
  patrolRoad: GeoPoint[];
  /** Metalled road running in from the interior. */
  highway: { name: string; path: GeoPoint[] };
  landmarks: Landmark[];
  cameras: Record<string, CameraPlacement>;
}

export const ATTARI_SECTOR: SiteGeography = {
  label: "Attari sector",
  region: "Amritsar district, Punjab",
  datum: "WGS84",
  bounds: { north: 31.652, south: 31.57, west: 74.555, east: 74.615 },

  border: [
    { lat: 31.652, lon: 74.5875 },
    { lat: 31.64, lon: 74.582 },
    { lat: 31.628, lon: 74.5775 },
    { lat: 31.616, lon: 74.5745 },
    { lat: 31.6047, lon: 74.573 },
    { lat: 31.593, lon: 74.5722 },
    { lat: 31.582, lon: 74.573 },
    { lat: 31.57, lon: 74.5755 },
  ],

  fence: [
    { lat: 31.652, lon: 74.5892 },
    { lat: 31.64, lon: 74.5837 },
    { lat: 31.628, lon: 74.5792 },
    { lat: 31.616, lon: 74.5762 },
    { lat: 31.6047, lon: 74.5747 },
    { lat: 31.593, lon: 74.5739 },
    { lat: 31.582, lon: 74.5747 },
    { lat: 31.57, lon: 74.5772 },
  ],

  patrolRoad: [
    { lat: 31.652, lon: 74.5917 },
    { lat: 31.64, lon: 74.5862 },
    { lat: 31.628, lon: 74.5817 },
    { lat: 31.616, lon: 74.5787 },
    { lat: 31.6047, lon: 74.5772 },
    { lat: 31.593, lon: 74.5764 },
    { lat: 31.582, lon: 74.5772 },
    { lat: 31.57, lon: 74.5797 },
  ],

  highway: {
    name: "NH-3 (Grand Trunk Road) — Amritsar 28 km",
    path: [
      { lat: 31.6035, lon: 74.615 },
      { lat: 31.6033, lon: 74.6006 },
      { lat: 31.6045, lon: 74.5885 },
      { lat: 31.6047, lon: 74.573 },
    ],
  },

  landmarks: [
    { name: "Attari village", kind: "settlement", at: { lat: 31.6033, lon: 74.6006 } },
    { name: "ICP Attari", kind: "checkpost", at: { lat: 31.6045, lon: 74.5885 } },
    { name: "Wagah crossing", kind: "crossing", at: { lat: 31.6047, lon: 74.573 } },
  ],

  cameras: {
    cam_fence_north: {
      at: { lat: 31.633, lon: 74.582 },
      bearing: 260,
      fovDeg: 62,
      rangeM: 420,
    },
    cam_farm_gate: {
      at: { lat: 31.619, lon: 74.58 },
      bearing: 245,
      fovDeg: 55,
      rangeM: 300,
    },
    cam_patrol_road: {
      at: { lat: 31.606, lon: 74.5832 },
      bearing: 200,
      fovDeg: 70,
      rangeM: 380,
    },
    cam_waterline: {
      at: { lat: 31.585, lon: 74.58 },
      bearing: 275,
      fovDeg: 58,
      rangeM: 450,
    },
  },
};

// ------------------------------------------------------------------ maths

/**
 * Metres per degree on WGS84, as a function of latitude.
 *
 * A single constant is the equatorial value and overshoots by roughly half a
 * percent at 31°N -- five metres in every kilometre, in a system whose whole
 * job is saying which side of a fence someone is on. These are the standard
 * series expansions; they cost two lines and remove the error.
 */
const M_PER_DEG_LAT_AT = (lat: number) => {
  const p = (lat * Math.PI) / 180;
  return (
    111_132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p)
  );
};

const M_PER_DEG_LON_AT = (lat: number) => {
  const p = (lat * Math.PI) / 180;
  return 111_412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
};

/** Width and height of the sector in metres. Drives the scale bar. */
export function sectorSpanM(geo: SiteGeography): { width: number; height: number } {
  const midLat = (geo.bounds.north + geo.bounds.south) / 2;
  return {
    width: (geo.bounds.east - geo.bounds.west) * M_PER_DEG_LON_AT(midLat),
    height: (geo.bounds.north - geo.bounds.south) * M_PER_DEG_LAT_AT(midLat),
  };
}

/**
 * Equirectangular projection into a 0..1 box.
 *
 * Good enough over a few kilometres and it needs no library. A conformal
 * projection would matter at national scale; over one BOP sector the error is
 * far below the width of the lines being drawn.
 */
export function project(point: GeoPoint, geo: SiteGeography): { x: number; y: number } {
  const { north, south, east, west } = geo.bounds;
  return {
    x: (point.lon - west) / (east - west),
    y: (north - point.lat) / (north - south),
  };
}

export const GRID_COLS = 6;
export const GRID_ROWS = 8;
const COLUMN_LETTERS = "ABCDEF";

/**
 * A military-style grid reference, so an incident can be spoken over a radio:
 * "person detected grid 4B". Columns are lettered west to east, rows numbered
 * north to south.
 */
export function gridRef(point: GeoPoint, geo: SiteGeography): string {
  const { x, y } = project(point, geo);
  const column = Math.min(GRID_COLS - 1, Math.max(0, Math.floor(x * GRID_COLS)));
  const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor(y * GRID_ROWS)));
  return `${row + 1}${COLUMN_LETTERS[column]}`;
}

/** Offset a point by a distance and a compass bearing. */
export function offset(from: GeoPoint, bearingDeg: number, metres: number): GeoPoint {
  const radians = (bearingDeg * Math.PI) / 180;
  return {
    lat: from.lat + (Math.cos(radians) * metres) / M_PER_DEG_LAT_AT(from.lat),
    lon: from.lon + (Math.sin(radians) * metres) / M_PER_DEG_LON_AT(from.lat),
  };
}

/**
 * A camera's coverage as a closed polygon: the mount, then an arc across the
 * field of view. Drawn so an operator can see which ground is actually watched
 * -- and, by omission, which is not.
 */
export function fovPolygon(placement: CameraPlacement, steps = 12): GeoPoint[] {
  const { at, bearing, fovDeg, rangeM } = placement;
  const start = bearing - fovDeg / 2;
  const arc = Array.from({ length: steps + 1 }, (_, index) =>
    offset(at, start + (fovDeg * index) / steps, rangeM),
  );
  return [at, ...arc];
}

export const formatLatLon = (point: GeoPoint) =>
  `${point.lat.toFixed(4)}°N ${point.lon.toFixed(4)}°E`;
