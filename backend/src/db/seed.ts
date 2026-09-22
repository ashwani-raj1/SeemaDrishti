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
  // Added in media/cameras.yml (the ANPR update) but missed here -- every
  // detection from it was rejected with "unknown camera cam_garden" until
  // now. claude.md's own warning about exactly this: a camera present in
  // the manifest but not seeded runs fine and produces zero events.
  { id: "cam_garden", name: "BOP-05 Garden" },
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

  // ------------------------------------------------------------- Watchlist (#36)
  const WATCHLIST_SEEDS = [
    {
      id: "wl_scorpio_4821",
      plate_number: "PB 02 AK 4821",
      vehicle_type: "suv",
      make_model: "Mahindra Scorpio-N",
      color: "Black",
      severity: "CRITICAL",
      flag_reason: "Suspected contraband transport / BOLO alert from Amritsar Rural",
      notes: "Armed occupants reported. Alert nearest QRT immediately if sighted.",
      active: 1,
      added_by: "Shift Supervisor",
    },
    {
      id: "wl_tractor_9182",
      plate_number: "PB 02 T 9182",
      vehicle_type: "tractor",
      make_model: "Swaraj 855 FE",
      color: "Blue",
      severity: "WARNING",
      flag_reason: "Gate pass revoked — unauthorized fence perimeter movement",
      notes: "Farmer identity dispute at Gate 4. Hold for verification.",
      active: 1,
      added_by: "Duty Operator",
    },
    {
      id: "wl_fortuner_1111",
      plate_number: "DL 1C AA 1111",
      vehicle_type: "suv",
      make_model: "Toyota Fortuner 4x4",
      color: "White",
      severity: "CRITICAL",
      flag_reason: "Stolen vehicle linked to cross-border drone drop retrieval",
      notes: "Spotted in Gurdaspur sector 48 hours ago.",
      active: 1,
      added_by: "Shift Supervisor",
    },
    {
      id: "wl_truck_5512",
      plate_number: "HR 26 DQ 5512",
      vehicle_type: "truck",
      make_model: "Tata 407 LPT",
      color: "Silver",
      severity: "WARNING",
      flag_reason: "Unauthorized nighttime transit near zero line patrol road",
      notes: "Check cargo manifest against site customs clearance.",
      active: 1,
      added_by: "Shift Supervisor",
    },
    {
      id: "wl_brezza_7744",
      plate_number: "PB 08 BX 7744",
      vehicle_type: "car",
      make_model: "Maruti Suzuki Brezza",
      color: "Dark Blue",
      severity: "INFO",
      flag_reason: "Routine surveillance flag — frequent loitering near culvert 14",
      notes: "Log sightings and occupants if stationary longer than 5 minutes.",
      active: 1,
      added_by: "Duty Operator",
    },
  ];

  for (const wl of WATCHLIST_SEEDS) {
    run(
      `INSERT OR IGNORE INTO watchlist_entry
         (id, org_id, plate_number, vehicle_type, make_model, color, severity, flag_reason, notes, active, added_by, created_at, updated_at)
       VALUES ($id, $org, $plate, $type, $make, $color, $severity, $reason, $notes, $active, $added_by, $at, $at)`,
      {
        $id: wl.id,
        $org: ORG,
        $plate: wl.plate_number,
        $type: wl.vehicle_type,
        $make: wl.make_model,
        $color: wl.color,
        $severity: wl.severity,
        $reason: wl.flag_reason,
        $notes: wl.notes,
        $active: wl.active,
        $added_by: wl.added_by,
        $at: at,
      },
    );
  }

  const DETECTIONS_SEED = [
    {
      id: "pd_seed_01",
      camera_id: "cam_fence_north",
      zone_id: "zone_fence_line",
      plate_number: "PB 02 AK 4821",
      vehicle_type: "suv",
      confidence: 0.94,
      plate_confidence: 0.96,
      matched_watchlist_id: "wl_scorpio_4821",
      match_status: "MATCHED",
      severity: "CRITICAL",
      bbox: JSON.stringify([0.22, 0.45, 0.78, 0.88]),
      plate_bbox: JSON.stringify([0.44, 0.74, 0.58, 0.81]),
      image_snapshot: "preset_scorpio_black",
      simulated: 1,
      occurred_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
    },
    {
      id: "pd_seed_02",
      camera_id: "cam_farm_gate",
      zone_id: "zone_farm_gate",
      plate_number: "PB 02 T 9182",
      vehicle_type: "tractor",
      confidence: 0.91,
      plate_confidence: 0.89,
      matched_watchlist_id: "wl_tractor_9182",
      match_status: "MATCHED",
      severity: "WARNING",
      bbox: JSON.stringify([0.28, 0.38, 0.72, 0.84]),
      plate_bbox: JSON.stringify([0.46, 0.68, 0.56, 0.74]),
      image_snapshot: "preset_tractor_blue",
      simulated: 1,
      occurred_at: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    },
    {
      id: "pd_seed_03",
      camera_id: "cam_patrol_road",
      zone_id: "zone_patrol_road",
      plate_number: "PB 02 E 3391",
      vehicle_type: "car",
      confidence: 0.96,
      plate_confidence: 0.95,
      matched_watchlist_id: null,
      match_status: "CLEAR",
      severity: "INFO",
      bbox: JSON.stringify([0.18, 0.52, 0.68, 0.91]),
      plate_bbox: JSON.stringify([0.38, 0.78, 0.50, 0.84]),
      image_snapshot: "preset_bolero_white",
      simulated: 1,
      occurred_at: new Date(Date.now() - 1000 * 60 * 92).toISOString(),
    },
    {
      id: "pd_seed_04",
      camera_id: "cam_farm_gate",
      zone_id: "zone_farm_gate",
      plate_number: "PB 02 AB 1042",
      vehicle_type: "tractor",
      confidence: 0.88,
      plate_confidence: 0.92,
      matched_watchlist_id: null,
      match_status: "CLEAR",
      severity: "INFO",
      bbox: JSON.stringify([0.31, 0.40, 0.69, 0.85]),
      plate_bbox: JSON.stringify([0.47, 0.70, 0.55, 0.76]),
      image_snapshot: "preset_sonalika_red",
      simulated: 1,
      occurred_at: new Date(Date.now() - 1000 * 60 * 140).toISOString(),
    },
  ];

  for (const det of DETECTIONS_SEED) {
    run(
      `INSERT OR IGNORE INTO plate_detection
         (id, org_id, camera_id, zone_id, plate_number, vehicle_type, confidence, plate_confidence,
          matched_watchlist_id, match_status, severity, bbox, plate_bbox, image_snapshot, simulated, occurred_at, created_at)
       VALUES ($id, $org, $cam, $zone, $plate, $type, $conf, $pconf, $matched, $status, $sev, $bbox, $pbbox, $snap, $sim, $occ, $at)`,
      {
        $id: det.id,
        $org: ORG,
        $cam: det.camera_id,
        $zone: det.zone_id,
        $plate: det.plate_number,
        $type: det.vehicle_type,
        $conf: det.confidence,
        $pconf: det.plate_confidence,
        $matched: det.matched_watchlist_id,
        $status: det.match_status,
        $sev: det.severity,
        $bbox: det.bbox,
        $pbbox: det.plate_bbox,
        $snap: det.image_snapshot,
        $sim: det.simulated,
        $occ: det.occurred_at,
        $at: at,
      },
    );
  }

  const bindings = ZONES.reduce((total, zone) => total + zone.cameras.length, 0);
  console.log(
    `seeded ${CAMERAS.length} cameras, ${ZONES.length} zones (${bindings} camera bindings), ${USERS.length} users, ${WATCHLIST_SEEDS.length} watchlist plates`,
  );
}

export const DEFAULT_ORG = ORG;
export const DEFAULT_SITE = SITE;

