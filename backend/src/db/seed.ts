import { one, run } from ".";
import { nowIso } from "../core/ids";

/**
 * A starting configuration so the system has something to watch on first run.
 *
 * Everything here is data, not code. Adapting to another force means editing
 * these rows -- there is no "if this is the Navy" branch anywhere below.
 */

const ORG = "org_bsf";
const SITE = "site_bop_attari";

interface CameraSeed {
  id: string;
  name: string;
}

interface ZoneSeed {
  id: string;
  camera_id: string;
  name: string;
  kind: string;
  geometry: string;
  points: number[][];
  watch_classes: string[];
  log_only_classes: string[];
  direction: string;
  confirm_seconds: number;
  severity: string;
}

const CAMERAS: CameraSeed[] = [
  { id: "cam_fence_north", name: "BOP-01 Fence North" },
  { id: "cam_farm_gate", name: "BOP-02 Farm Gate" },
  { id: "cam_patrol_road", name: "BOP-03 Patrol Road" },
  { id: "cam_waterline", name: "BOP-04 Waterline" },
];

const ZONES: ZoneSeed[] = [
  {
    id: "zone_fence_line",
    camera_id: "cam_fence_north",
    name: "Fence line north",
    kind: "fence_line",
    geometry: "line",
    // Drawn left to right; the friendly side is below, so inbound means
    // "came towards us".
    points: [[0.05, 0.62], [0.95, 0.56]],
    watch_classes: ["person", "vehicle", "tractor"],
    log_only_classes: ["cattle", "dog", "nilgai", "wild_boar"],
    direction: "both",
    confirm_seconds: 2,
    severity: "CRITICAL",
  },
  {
    id: "zone_farm_gate",
    camera_id: "cam_farm_gate",
    name: "Farm gate",
    kind: "gate",
    geometry: "polygon",
    points: [[0.34, 0.42], [0.66, 0.42], [0.70, 0.86], [0.30, 0.86]],
    // Farmers cross here daily on a fixed schedule, so a gate is a warning,
    // not a critical alarm.
    watch_classes: ["person", "tractor", "vehicle"],
    log_only_classes: ["cattle", "dog"],
    direction: "both",
    confirm_seconds: 3,
    severity: "WARNING",
  },
  {
    id: "zone_patrol_road",
    camera_id: "cam_patrol_road",
    name: "Patrol road verge",
    kind: "restricted_area",
    geometry: "polygon",
    points: [[0.10, 0.55], [0.90, 0.50], [0.92, 0.92], [0.08, 0.92]],
    watch_classes: ["person", "vehicle"],
    log_only_classes: ["cattle", "dog", "nilgai"],
    direction: "inbound",
    confirm_seconds: 2,
    severity: "WARNING",
  },
  {
    id: "zone_waterline",
    camera_id: "cam_waterline",
    name: "Waterline",
    kind: "waterline",
    geometry: "line",
    points: [[0.02, 0.48], [0.98, 0.52]],
    watch_classes: ["person", "boat"],
    log_only_classes: ["cattle"],
    direction: "inbound",
    confirm_seconds: 2,
    severity: "CRITICAL",
  },
];

const USERS = [
  { id: "usr_operator", name: "Duty Operator", role: "operator" },
  { id: "usr_supervisor", name: "Shift Supervisor", role: "supervisor" },
];

export function seed(): void {
  if (one("SELECT id FROM organisation WHERE id = $id", { $id: ORG })) return;

  const at = nowIso();

  run(
    `INSERT INTO organisation (id, name, code, retention_days, created_at)
     VALUES ($id, 'Border Security Force', 'BSF', 30, $at)`,
    { $id: ORG, $at: at },
  );

  run(
    `INSERT INTO site (id, org_id, name, kind, created_at)
     VALUES ($id, $org, 'BOP Attari', 'bop', $at)`,
    { $id: SITE, $org: ORG, $at: at },
  );

  for (const camera of CAMERAS) {
    run(
      `INSERT INTO camera (id, site_id, name, stream_url, status, created_at)
       VALUES ($id, $site, $name, NULL, 'FULL', $at)`,
      { $id: camera.id, $site: SITE, $name: camera.name, $at: at },
    );
  }

  for (const zone of ZONES) {
    run(
      `INSERT INTO zone
         (id, camera_id, org_id, name, kind, geometry, points, watch_classes, log_only_classes,
          direction, confirm_seconds, severity, active, created_at, updated_at)
       VALUES
         ($id, $camera, $org, $name, $kind, $geometry, $points, $watch, $logOnly,
          $direction, $confirm, $severity, 1, $at, $at)`,
      {
        $id: zone.id,
        $camera: zone.camera_id,
        $org: ORG,
        $name: zone.name,
        $kind: zone.kind,
        $geometry: zone.geometry,
        $points: JSON.stringify(zone.points),
        $watch: JSON.stringify(zone.watch_classes),
        $logOnly: JSON.stringify(zone.log_only_classes),
        $direction: zone.direction,
        $confirm: zone.confirm_seconds,
        $severity: zone.severity,
        $at: at,
      },
    );
  }

  for (const user of USERS) {
    run(
      `INSERT INTO app_user (id, org_id, name, role, created_at)
       VALUES ($id, $org, $name, $role, $at)`,
      { $id: user.id, $org: ORG, $name: user.name, $role: user.role, $at: at },
    );
  }

  console.log(`seeded ${CAMERAS.length} cameras, ${ZONES.length} zones, ${USERS.length} users`);
}

export const DEFAULT_ORG = ORG;
export const DEFAULT_SITE = SITE;
