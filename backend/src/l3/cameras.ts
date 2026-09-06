import { all, one, run } from "../db";
import { nowIso } from "../core/ids";
import { SEVERITY_RANK, type CameraStatus, type Severity } from "../core/types";
import { resolveTargets } from "./zones";

/**
 * Cameras: the feeds this post reads, and the settings a person controls.
 *
 * Two states are kept deliberately apart. `status` is observed -- the analysis
 * engine writes what it can actually see, and that is the blindness ladder.
 * `enabled` is decided -- somebody took the feed out of service. Collapsing
 * them would make "we are blind here" indistinguishable from "we stopped
 * looking here", and only one of those needs a foot patrol.
 */

export interface CameraRow {
  id: string;
  site_id: string;
  name: string;
  stream_url: string | null;
  status: CameraStatus;
  enabled: number;
  created_at: string;
  updated_at: string | null;
}

/** The zones this camera watches, with its own shape in each. */
function zonesOf(cameraId: string) {
  return all<any>(
    `SELECT z.id, z.name, z.kind, z.sector, zc.geometry, zc.points, zc.direction,
            zc.confirm_seconds, zc.placed
       FROM zone_camera zc
       JOIN zone z ON z.id = zc.zone_id
      WHERE zc.camera_id = $camera AND zc.active = 1 AND z.active = 1
      ORDER BY z.name`,
    { $camera: cameraId },
  ).map((row) => {
    const targets = resolveTargets(row.id, cameraId);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      sector: row.sector,
      geometry: row.geometry,
      points: JSON.parse(row.points),
      direction: row.direction,
      confirmSeconds: row.confirm_seconds,
      placed: row.placed === 1,
      targets,
      // Derived, so anything drawing a zone gets the same fields wherever it
      // fetched it from. A consumer having to reach for a cast is the signal
      // that the payload was wrong, not the consumer.
      watchClasses: targets.filter((t) => t.action === "alert").map((t) => t.class),
      logOnlyClasses: targets.filter((t) => t.action === "log_only").map((t) => t.class),
      severity: targets
        .filter((t) => t.action === "alert")
        .reduce<Severity>(
          (worst, t) => (SEVERITY_RANK[t.severity] > SEVERITY_RANK[worst] ? t.severity : worst),
          "INFO",
        ),
    };
  });
}

/**
 * The other cameras watching the same ground.
 *
 * This is what a zone spanning cameras buys: when something crosses on one
 * feed, the operator's next question is "what else could have seen it", and
 * the answer is a lookup rather than a guess.
 */
export function siblingCameras(cameraId: string) {
  return all<any>(
    `SELECT DISTINCT c.id, c.name, c.status, c.enabled, z.id AS zone_id, z.name AS zone_name
       FROM zone_camera mine
       JOIN zone_camera theirs ON theirs.zone_id = mine.zone_id AND theirs.camera_id != mine.camera_id
       JOIN camera c ON c.id = theirs.camera_id
       JOIN zone z   ON z.id = mine.zone_id
      WHERE mine.camera_id = $camera
        AND mine.active = 1 AND theirs.active = 1 AND z.active = 1
      ORDER BY z.name, c.name`,
    { $camera: cameraId },
  ).map((row) => ({
    cameraId: row.id,
    cameraName: row.name,
    cameraStatus: row.status as CameraStatus,
    enabled: row.enabled === 1,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
  }));
}

export const cameraRow = (cameraId: string) =>
  one<CameraRow>("SELECT * FROM camera WHERE id = $id", { $id: cameraId });

export function shapeCamera(row: CameraRow) {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    streamUrl: row.stream_url,
    status: row.status,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Every camera at a site, in full.
 *
 * Deliberately the same shape as `cameraDetail` rather than a lighter one.
 * A list endpoint that returns a subset of the detail endpoint is a trap
 * across an HTTP boundary -- the types agree on both sides and the missing
 * field only shows up as a crash in somebody's browser. A handful of cameras
 * is not worth that.
 */
export function listCameras(siteId: string) {
  return all<{ id: string }>(
    "SELECT id FROM camera WHERE site_id = $site ORDER BY name",
    { $site: siteId },
  ).map((row) => cameraDetail(row.id)!);
}

export function cameraDetail(cameraId: string) {
  const row = cameraRow(cameraId);
  if (!row) return null;

  const counts = one<{ open: number; total: number }>(
    `SELECT
       SUM(CASE WHEN status IN ('OPEN','ACKNOWLEDGED') THEN 1 ELSE 0 END) AS open,
       COUNT(*) AS total
     FROM incident_state WHERE camera_id = $camera`,
    { $camera: cameraId },
  );

  return {
    ...shapeCamera(row),
    zones: zonesOf(cameraId),
    siblings: siblingCameras(cameraId),
    incidents: { open: counts?.open ?? 0, total: counts?.total ?? 0 },
  };
}

export interface CameraPatch {
  name?: string;
  streamUrl?: string | null;
  enabled?: boolean;
}

export function updateCamera(cameraId: string, patch: CameraPatch) {
  const current = cameraRow(cameraId);
  if (!current) return null;

  run(
    `UPDATE camera SET name = $name, stream_url = $stream, enabled = $enabled, updated_at = $at
     WHERE id = $id`,
    {
      $name: patch.name ?? current.name,
      $stream: patch.streamUrl === undefined ? current.stream_url : patch.streamUrl,
      $enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      $at: nowIso(),
      $id: cameraId,
    },
  );

  return cameraDetail(cameraId);
}

/** False when a person has taken this feed out of service. */
export function cameraEnabled(cameraId: string): boolean {
  const row = one<{ enabled: number }>("SELECT enabled FROM camera WHERE id = $id", {
    $id: cameraId,
  });
  return row ? row.enabled === 1 : false;
}
