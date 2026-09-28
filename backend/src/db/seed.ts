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
  // Declared in media/cameras.yml and, until now, missing here -- so every
  // durable event from that worker was rejected by cameraContext() for an
  // unknown camera, and the worker looked like it was running fine while
  // producing nothing. It is also the one camera pointed at real footage.
  { id: "cam_garden", name: "BOP-05 Garden" },
  // Same gap as cam_garden's own comment above, inherited from upstream's
  // own cameras.yml addition: declared there with no matching row here, so
  // every detection from it was being silently rejected as an unknown
  // camera before this merge added it.
  { id: "cam_border_gate", name: "Border Gate" },
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
  /** Free-text label grouping zones on the same stretch of ground. */
  area: string;
  /** Ordered: the first entry is the highest priority. */
  targets: TargetSeed[];
  cameras: BindingSeed[];
  /** Camera-specific exceptions to the zone policy. */
  overrides?: Record<string, TargetSeed[]>;
}

const ZONES: ZoneSeed[] = [
  // ONE zone, every camera.
  //
  // A zone spans cameras; a camera belongs to exactly one zone
  // (zone_camera_one_zone). Those two rules together make "one zone holding
  // the whole post" the simplest configuration the schema can express, and it
  // is the one to start a demo from: every feed is judged, nothing is bound
  // twice, and there is a single policy to point at when somebody asks what
  // this post alerts on.
  //
  // Per-camera differences that used to justify separate zones now live where
  // they belong: the SHAPE is per binding (each camera sees different ground,
  // so each gets its own geometry, direction and patience), and a class that
  // matters differently on one camera is a camera OVERRIDE rather than a
  // second zone. Splitting this back out is a console action, not a code
  // change -- create a zone, move the camera into it.
  {
    id: "zone_perimeter",
    name: "BOP perimeter",
    kind: "perimeter",
    // A label a supervisor would type, not an id. It used to read
    // "bop_attari", which was the POST's id in a column that meant something
    // else entirely -- the collision this rename exists to end.
    area: "BOP Attari",
    // The union of what the four old zones watched for, in priority order.
    // Animals are named on purpose: a zone that cannot name them has no way to
    // say "write it down, never alert", which is what log_only exists for.
    targets: [
      { class: "person", severity: "CRITICAL", action: "alert" },
      { class: "vehicle", severity: "WARNING", action: "alert" },
      { class: "boat", severity: "CRITICAL", action: "alert" },
      { class: "tractor", severity: "WARNING", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
      { class: "dog", severity: "INFO", action: "log_only" },
      { class: "nilgai", severity: "INFO", action: "log_only" },
      { class: "wild_boar", severity: "INFO", action: "log_only" },
    ],
    // One shape per camera. The same place seen from five positions is five
    // different polygons -- geometry drawn in one camera's frame means nothing
    // in another's, which is why it lives on the binding and not on the zone.
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
        camera_id: "cam_farm_gate",
        geometry: "line",
        points: [[0.12, 0.30], [0.88, 0.38]],
        direction: "inbound",
        confirm_seconds: 3,
      },
      {
        camera_id: "cam_patrol_road",
        geometry: "polygon",
        points: [[0.10, 0.55], [0.90, 0.50], [0.92, 0.92], [0.08, 0.92]],
        direction: "inbound",
        confirm_seconds: 2,
      },
      {
        camera_id: "cam_waterline",
        geometry: "line",
        points: [[0.02, 0.48], [0.98, 0.52]],
        direction: "inbound",
        confirm_seconds: 2,
      },
      {
        camera_id: "cam_garden",
        geometry: "polygon",
        points: [[0.34, 0.42], [0.66, 0.42], [0.70, 0.86], [0.30, 0.86]],
        direction: "inbound",
        confirm_seconds: 2,
      },
    ],
    // Kept so the override mechanism is still exercised by the seed: herds move
    // towards the river, so on the waterline camera cattle are worth an alert
    // rather than a log line. Same zone, same policy, one camera's exception.
    overrides: {
      cam_waterline: [{ class: "cattle", severity: "WARNING", action: "alert" }],
    },
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
    `INSERT INTO organisation
       (id, name, code, retention_days, grouping_window_seconds, created_at)
     VALUES ($id, 'Border Security Force', 'BSF', 30, 300, $at)`,
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
      `INSERT INTO zone (id, org_id, site_id, name, kind, area, active, created_at, updated_at)
       VALUES ($id, $org, $site, $name, $kind, $area, 1, $at, $at)`,
      {
        $id: zone.id,
        $org: ORG,
        $site: SITE,
        $name: zone.name,
        $kind: zone.kind,
        $area: zone.area,
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
      zone_id: "zone_perimeter",
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
      zone_id: "zone_perimeter",
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
      zone_id: "zone_perimeter",
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
      zone_id: "zone_perimeter",
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

  // Mock government-ID/vehicle-ownership records (schema.sql's own
  // person_watchlist comment explains why address/owned_plates/govt_id are
  // mock): seeded with NO embeddings, because a fabricated float vector
  // would never genuinely match a face and claiming otherwise would be
  // exactly the false capability claim claude.md §7 forbids. What IS real:
  // plate_number here is the exact string pd_seed_01/pd_seed_02 above and
  // WATCHLIST_SEEDS' own flagged plates already carry, so a dossier lookup
  // by name, govt ID or plate surfaces those real detections immediately --
  // an operator later enrolling a photo of the same name (People or Face
  // Detection page) adds the live-recognition half without touching this.
  const PERSON_WATCHLIST_SEEDS = [
    {
      id: "pw_karamjit_singh",
      name: "Karamjit Singh",
      govt_id: "IND-PB-2291-04821",
      address: "Village Rajatal, Amritsar Rural, Punjab",
      owned_plates: ["PB 02 AK 4821"], // wl_scorpio_4821 / pd_seed_01 -- CRITICAL
    },
    {
      id: "pw_ranjit_kaur",
      name: "Ranjit Kaur",
      govt_id: "IND-PB-1187-09182",
      address: "Gate 4 Colony, Amritsar Rural, Punjab",
      owned_plates: ["PB 02 T 9182"], // wl_tractor_9182 / pd_seed_02 -- WARNING
    },
  ];

  for (const person of PERSON_WATCHLIST_SEEDS) {
    run(
      `INSERT OR IGNORE INTO person_watchlist
         (id, org_id, name, face_embedding, appearance_embedding, notes, address, owned_plates, govt_id, active, added_by, created_at, updated_at)
       VALUES ($id, $org, $name, NULL, NULL, NULL, $address, $plates, $govtId, 1, $addedBy, $at, $at)`,
      {
        $id: person.id,
        $org: ORG,
        $name: person.name,
        $address: person.address,
        $plates: JSON.stringify(person.owned_plates),
        $govtId: person.govt_id,
        $addedBy: "Government ID Registry (mock)",
        $at: at,
      },
    );
  }

  const bindings = ZONES.reduce((total, zone) => total + zone.cameras.length, 0);
  console.log(
    `seeded ${CAMERAS.length} cameras, ${ZONES.length} zones (${bindings} camera bindings), ${USERS.length} users, ${WATCHLIST_SEEDS.length} watchlist plates, ${PERSON_WATCHLIST_SEEDS.length} person registry records`,
  );
}

export const DEFAULT_ORG = ORG;
export const DEFAULT_SITE = SITE;

