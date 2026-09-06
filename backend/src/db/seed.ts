import { one, run } from ".";
import { id, nowIso } from "../core/ids";

/**
 * A starting configuration so the system has something to watch on first run.
 *
 * Everything here is data, not code. Adapting to another force means editing
 * these rows -- there is no "if this is the Navy" branch anywhere below.
 *
 * Note the fence line: one zone, two cameras. A fence runs past more than one
 * camera, and each of them watches it from a different angle with its own
 * shape. That is the whole reason a zone is not tied to a single camera.
 */

const ORG = "org_bsf";
const SITE = "site_bop_attari";

const CAMERAS = [
  { id: "cam_fence_north", name: "BOP-01 Fence North" },
  { id: "cam_farm_gate", name: "BOP-02 Farm Gate" },
  { id: "cam_patrol_road", name: "BOP-03 Patrol Road" },
  { id: "cam_waterline", name: "BOP-04 Waterline" },
];

interface TargetSeed {
  class: string;
  severity: string;
  action: "alert" | "log_only";
}

interface BindingSeed {
  camera_id: string;
  geometry: "line" | "polygon";
  points: number[][];
  direction: string;
  confirm_seconds: number;
}

interface ZoneSeed {
  id: string;
  name: string;
  kind: string;
  sector: string;
  /** Ordered: the first entry is the highest priority. */
  targets: TargetSeed[];
  cameras: BindingSeed[];
  /** Camera-specific exceptions to the zone policy. */
  overrides?: Record<string, TargetSeed[]>;
}

const ZONES: ZoneSeed[] = [
  {
    id: "zone_fence_line",
    name: "Fence line north",
    kind: "fence_line",
    sector: "fence_north",
    targets: [
      { class: "person", severity: "CRITICAL", action: "alert" },
      { class: "vehicle", severity: "WARNING", action: "alert" },
      { class: "tractor", severity: "WARNING", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
      { class: "dog", severity: "INFO", action: "log_only" },
      { class: "nilgai", severity: "INFO", action: "log_only" },
      { class: "wild_boar", severity: "INFO", action: "log_only" },
    ],
    cameras: [
      {
        camera_id: "cam_fence_north",
        geometry: "line",
        // Drawn left to right; the friendly side is below, so inbound means
        // "came towards us".
        points: [[0.05, 0.62], [0.95, 0.56]],
        direction: "both",
        confirm_seconds: 2,
      },
      {
        // The same fence, seen further along from the patrol road camera --
        // a different shape entirely, which is exactly the point.
        camera_id: "cam_patrol_road",
        geometry: "line",
        points: [[0.12, 0.30], [0.88, 0.38]],
        direction: "inbound",
        confirm_seconds: 3,
      },
    ],
  },
  {
    id: "zone_farm_gate",
    name: "Farm gate",
    kind: "gate",
    sector: "gate_approach",
    // Farmers cross here daily on a fixed schedule, so a gate is a warning,
    // not a critical alarm.
    targets: [
      { class: "person", severity: "WARNING", action: "alert" },
      { class: "tractor", severity: "WARNING", action: "alert" },
      { class: "vehicle", severity: "WARNING", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
      { class: "dog", severity: "INFO", action: "log_only" },
    ],
    cameras: [
      {
        camera_id: "cam_farm_gate",
        geometry: "polygon",
        points: [[0.34, 0.42], [0.66, 0.42], [0.70, 0.86], [0.30, 0.86]],
        direction: "both",
        confirm_seconds: 3,
      },
    ],
  },
  {
    id: "zone_patrol_road",
    name: "Patrol road verge",
    kind: "restricted_area",
    sector: "patrol_road",
    targets: [
      { class: "person", severity: "WARNING", action: "alert" },
      { class: "vehicle", severity: "WARNING", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
      { class: "dog", severity: "INFO", action: "log_only" },
      { class: "nilgai", severity: "INFO", action: "log_only" },
    ],
    cameras: [
      {
        camera_id: "cam_patrol_road",
        geometry: "polygon",
        points: [[0.10, 0.55], [0.90, 0.50], [0.92, 0.92], [0.08, 0.92]],
        direction: "inbound",
        confirm_seconds: 2,
      },
    ],
  },
  {
    id: "zone_waterline",
    name: "Waterline",
    kind: "waterline",
    sector: "waterline",
    targets: [
      { class: "person", severity: "CRITICAL", action: "alert" },
      { class: "boat", severity: "CRITICAL", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
    ],
    cameras: [
      {
        camera_id: "cam_waterline",
        geometry: "line",
        points: [[0.02, 0.48], [0.98, 0.52]],
        direction: "inbound",
        confirm_seconds: 2,
      },
    ],
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
      `INSERT INTO zone (id, org_id, site_id, name, kind, sector, active, created_at, updated_at)
       VALUES ($id, $org, $site, $name, $kind, $sector, 1, $at, $at)`,
      {
        $id: zone.id,
        $org: ORG,
        $site: SITE,
        $name: zone.name,
        $kind: zone.kind,
        $sector: zone.sector,
        $at: at,
      },
    );

    for (const binding of zone.cameras) {
      run(
        `INSERT INTO zone_camera
           (id, zone_id, camera_id, geometry, points, direction, confirm_seconds, placed, active, created_at, updated_at)
         VALUES ($id, $zone, $camera, $geometry, $points, $direction, $confirm, 1, 1, $at, $at)`,
        {
          $id: id("zc"),
          $zone: zone.id,
          $camera: binding.camera_id,
          $geometry: binding.geometry,
          $points: JSON.stringify(binding.points),
          $direction: binding.direction,
          $confirm: binding.confirm_seconds,
          $at: at,
        },
      );
    }

    const writeTargets = (cameraId: string | null, targets: TargetSeed[]) =>
      targets.forEach((target, index) =>
        run(
          `INSERT INTO zone_target
             (id, zone_id, camera_id, class, severity, action, priority, created_at, updated_at)
           VALUES ($id, $zone, $camera, $class, $severity, $action, $priority, $at, $at)`,
          {
            $id: id("tgt"),
            $zone: zone.id,
            $camera: cameraId,
            $class: target.class,
            $severity: target.severity,
            $action: target.action,
            $priority: index + 1,
            $at: at,
          },
        ),
      );

    writeTargets(null, zone.targets);
    for (const [cameraId, targets] of Object.entries(zone.overrides ?? {})) {
      writeTargets(cameraId, targets);
    }
  }

  for (const user of USERS) {
    run(
      `INSERT INTO app_user (id, org_id, name, role, created_at)
       VALUES ($id, $org, $name, $role, $at)`,
      { $id: user.id, $org: ORG, $name: user.name, $role: user.role, $at: at },
    );
  }

  const bindings = ZONES.reduce((total, zone) => total + zone.cameras.length, 0);
  console.log(
    `seeded ${CAMERAS.length} cameras, ${ZONES.length} zones (${bindings} camera bindings), ${USERS.length} users`,
  );
}

export const DEFAULT_ORG = ORG;
export const DEFAULT_SITE = SITE;
