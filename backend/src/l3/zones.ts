import { all, db, one, run } from "../db";
import { id, nowIso } from "../core/ids";
import type {
  Direction, Point, Severity, TargetAction, Zone, ZoneGeometry, ZoneKind, ZoneTarget,
} from "../core/types";

/**
 * Zones: named places, the cameras that watch them, and what matters there.
 *
 * The shape of this module follows one decision. A zone spans cameras, but a
 * polygon drawn in one camera's frame is meaningless in another's -- so the
 * zone owns identity and policy, while each camera owns its own shape. Reading
 * a zone "for a camera" is therefore always a resolve, never a plain select.
 */

// ------------------------------------------------------------------ rows

interface ZoneRow {
  id: string;
  org_id: string;
  site_id: string;
  name: string;
  kind: string;
  sector: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  id: string;
  zone_id: string;
  camera_id: string;
  geometry: string;
  points: string;
  direction: string;
  confirm_seconds: number;
  placed: number;
  active: number;
}

interface TargetRow {
  id: string;
  zone_id: string;
  camera_id: string | null;
  class: string;
  severity: string;
  action: string;
  priority: number;
}

/**
 * The shape a camera gets when it joins a zone.
 *
 * Deliberately a plain line across the middle rather than something clever: it
 * is a placeholder, `placed` stays 0, and the console says so. Guessing at a
 * shape from the camera's bearing would look positioned without being it.
 */
export function placeholderShape(kind: ZoneKind): { geometry: ZoneGeometry; points: Point[] } {
  const areaKinds: ZoneKind[] = ["perimeter", "restricted_area", "gate"];
  if (areaKinds.includes(kind)) {
    return {
      geometry: "polygon",
      points: [[0.3, 0.4], [0.7, 0.4], [0.7, 0.8], [0.3, 0.8]],
    };
  }
  return { geometry: "line", points: [[0.05, 0.6], [0.95, 0.6]] };
}

// ------------------------------------------------------------------ targets

/**
 * The effective target list for a zone on one camera.
 *
 * The zone's own rows are the policy. A row naming the camera replaces the
 * zone's row for that class, or adds a class the zone never listed. That is
 * what "one policy, explicit exceptions" means in practice -- and it is done
 * here, once, so nothing downstream has to remember the rule.
 *
 * The merged list is renumbered 1..n. The two scopes rank independently, so
 * their raw priorities collide on merge; leaving them would show an operator a
 * list numbered "1, 1, 2, 2". Stored ranks are untouched -- only this resolved
 * view is renumbered, and an exception sorts above the zone rule it displaced.
 */
export function resolveTargets(zoneId: string, cameraId: string | null): ZoneTarget[] {
  const rows = all<TargetRow>(
    `SELECT * FROM zone_target
      WHERE zone_id = $zone AND (camera_id IS NULL OR camera_id = $camera)`,
    { $zone: zoneId, $camera: cameraId },
  );

  const byClass = new Map<string, ZoneTarget>();

  for (const row of rows) {
    const target: ZoneTarget = {
      class: row.class,
      severity: row.severity as Severity,
      action: row.action as TargetAction,
      priority: row.priority,
      overridden: row.camera_id !== null,
    };
    const existing = byClass.get(row.class);
    // A camera row always wins; order of arrival must not decide.
    if (!existing || target.overridden) byClass.set(row.class, target);
  }

  return [...byClass.values()]
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        Number(Boolean(b.overridden)) - Number(Boolean(a.overridden)) ||
        a.class.localeCompare(b.class),
    )
    .map((target, index) => ({ ...target, priority: index + 1 }));
}

/** The zone's own policy rows, without any camera overrides mixed in. */
export function zoneTargets(zoneId: string): ZoneTarget[] {
  return all<TargetRow>(
    "SELECT * FROM zone_target WHERE zone_id = $zone AND camera_id IS NULL ORDER BY priority",
    { $zone: zoneId },
  ).map((row) => ({
    class: row.class,
    severity: row.severity as Severity,
    action: row.action as TargetAction,
    priority: row.priority,
  }));
}

/** The override rows for one camera, if any. */
export function cameraOverrides(zoneId: string, cameraId: string): ZoneTarget[] {
  return all<TargetRow>(
    "SELECT * FROM zone_target WHERE zone_id = $zone AND camera_id = $camera ORDER BY priority",
    { $zone: zoneId, $camera: cameraId },
  ).map((row) => ({
    class: row.class,
    severity: row.severity as Severity,
    action: row.action as TargetAction,
    priority: row.priority,
    overridden: true,
  }));
}

export interface TargetInput {
  class: string;
  severity: Severity;
  action: TargetAction;
}

/**
 * Replace the target list for one scope.
 *
 * The whole list is rewritten rather than patched, because priority is a
 * property of the order as a whole -- editing one row's rank without the
 * others is how two things end up ranked the same.
 */
export function setTargets(
  zoneId: string,
  cameraId: string | null,
  targets: TargetInput[],
): ZoneTarget[] {
  const at = nowIso();

  db.transaction(() => {
    run(
      cameraId === null
        ? "DELETE FROM zone_target WHERE zone_id = $zone AND camera_id IS NULL"
        : "DELETE FROM zone_target WHERE zone_id = $zone AND camera_id = $camera",
      cameraId === null ? { $zone: zoneId } : { $zone: zoneId, $camera: cameraId },
    );

    targets.forEach((target, index) => {
      run(
        `INSERT INTO zone_target
           (id, zone_id, camera_id, class, severity, action, priority, created_at, updated_at)
         VALUES ($id, $zone, $camera, $class, $severity, $action, $priority, $at, $at)`,
        {
          $id: id("tgt"),
          $zone: zoneId,
          $camera: cameraId,
          $class: target.class,
          $severity: target.severity,
          $action: target.action,
          // Rank comes from position in the list the caller sent.
          $priority: index + 1,
          $at: at,
        },
      );
    });

    run("UPDATE zone SET updated_at = $at WHERE id = $id", { $at: at, $id: zoneId });
  })();

  return cameraId === null ? zoneTargets(zoneId) : cameraOverrides(zoneId, cameraId);
}

// ------------------------------------------------------------------ reading

function hydrate(zone: ZoneRow, binding: BindingRow): Zone {
  return {
    id: zone.id,
    bindingId: binding.id,
    camera_id: binding.camera_id,
    org_id: zone.org_id,
    site_id: zone.site_id,
    name: zone.name,
    kind: zone.kind as ZoneKind,
    geometry: binding.geometry as ZoneGeometry,
    points: JSON.parse(binding.points) as Point[],
    direction: binding.direction as Direction | "both",
    confirm_seconds: binding.confirm_seconds,
    targets: resolveTargets(zone.id, binding.camera_id),
    active: zone.active === 1 && binding.active === 1,
    // Carried into judgement on purpose. Dropping it here was how an undrawn
    // placeholder came to produce fully alertable intrusions against geometry
    // nobody chose -- `zonesForCamera` is the judgement layer's only way in,
    // so a flag absent here is a flag that cannot be honoured anywhere.
    placed: binding.placed === 1,
  };
}

/**
 * A shape nobody has drawn is a fallback, not a fence.
 *
 * Crossings of it are real -- somebody did walk over the stock line -- so they
 * are recorded, attached to an incident and queryable. They are never alerted,
 * because severity would be a claim that a specific place was crossed, and
 * nobody chose that place. Drawing the shape turns the alarm on, by itself,
 * within one zone-refresh interval.
 *
 * ibvap/CLAUDE.md section 15: "a fence judging against geometry nobody drew is
 * worse than a fence that says out loud it has none."
 */
export const PROVISIONAL_SUPPRESSION = "zone_not_placed";
export const isProvisional = (zone: Zone): boolean => !zone.placed;

/** Every zone this camera watches, resolved. The judgement layer's only way in. */
export function zonesForCamera(cameraId: string): Zone[] {
  const rows = all<ZoneRow & { binding: string }>(
    `SELECT z.*, zc.id AS binding
       FROM zone_camera zc
       JOIN zone z ON z.id = zc.zone_id
      WHERE zc.camera_id = $camera AND zc.active = 1 AND z.active = 1`,
    { $camera: cameraId },
  );

  return rows.map((row) => {
    const binding = one<BindingRow>("SELECT * FROM zone_camera WHERE id = $id", { $id: row.binding })!;
    return hydrate(row, binding);
  });
}

export function getBinding(zoneId: string, cameraId: string): BindingRow | null {
  return one<BindingRow>(
    "SELECT * FROM zone_camera WHERE zone_id = $zone AND camera_id = $camera",
    { $zone: zoneId, $camera: cameraId },
  );
}

/** The console's view: the zone, its cameras, its policy, and any overrides. */
export function zoneDetail(zoneId: string) {
  const zone = one<ZoneRow>("SELECT * FROM zone WHERE id = $id", { $id: zoneId });
  if (!zone) return null;

  const bindings = all<BindingRow & { camera_name: string; camera_status: string }>(
    `SELECT zc.*, c.name AS camera_name, c.status AS camera_status
       FROM zone_camera zc JOIN camera c ON c.id = zc.camera_id
      WHERE zc.zone_id = $zone
      ORDER BY c.name`,
    { $zone: zoneId },
  );

  return {
    id: zone.id,
    siteId: zone.site_id,
    name: zone.name,
    kind: zone.kind,
    sector: zone.sector,
    active: zone.active === 1,
    createdAt: zone.created_at,
    updatedAt: zone.updated_at,
    targets: zoneTargets(zoneId),
    cameras: bindings.map((binding) => ({
      bindingId: binding.id,
      cameraId: binding.camera_id,
      cameraName: binding.camera_name,
      cameraStatus: binding.camera_status,
      geometry: binding.geometry,
      points: JSON.parse(binding.points) as Point[],
      direction: binding.direction,
      confirmSeconds: binding.confirm_seconds,
      placed: binding.placed === 1,
      active: binding.active === 1,
      overrides: cameraOverrides(zoneId, binding.camera_id),
      effectiveTargets: resolveTargets(zoneId, binding.camera_id),
    })),
  };
}

/**
 * Every zone at a site, oldest first.
 *
 * The order is ASCENDING on purpose. A site profile is applied positionally --
 * profile entry N rewrites zone N -- so a newest-first list would silently
 * re-map every zone's profile entry the moment somebody created a new one.
 * Oldest-first is stable: a zone keeps its position for life.
 */
export function listZones(siteId: string) {
  return all<ZoneRow>(
    "SELECT id FROM zone WHERE site_id = $site ORDER BY created_at ASC, id ASC",
    { $site: siteId },
  ).map((row) => zoneDetail(row.id)!);
}

// ------------------------------------------------------------------ writing

export interface CreateZoneInput {
  orgId: string;
  siteId: string;
  name: string;
  kind: ZoneKind;
  sector?: string | null;
  cameraIds: string[];
  targets: TargetInput[];
  direction?: Direction | "both";
  confirmSeconds?: number;
}

/**
 * Create a zone and join cameras to it in one go.
 *
 * Every camera gets the placeholder shape; positioning it is a separate,
 * separately-recorded act. Doing both at once would let a zone go live with a
 * shape nobody has looked at.
 */
export function createZone(input: CreateZoneInput): string {
  const zoneId = id("zone");
  const at = nowIso();
  const shape = placeholderShape(input.kind);

  db.transaction(() => {
    run(
      `INSERT INTO zone (id, org_id, site_id, name, kind, sector, active, created_at, updated_at)
       VALUES ($id, $org, $site, $name, $kind, $sector, 1, $at, $at)`,
      {
        $id: zoneId,
        $org: input.orgId,
        $site: input.siteId,
        $name: input.name,
        $kind: input.kind,
        $sector: input.sector ?? null,
        $at: at,
      },
    );

    for (const cameraId of input.cameraIds) {
      run(
        `INSERT INTO zone_camera
           (id, zone_id, camera_id, geometry, points, direction, confirm_seconds, placed, active, created_at, updated_at)
         VALUES ($id, $zone, $camera, $geometry, $points, $direction, $confirm, 0, 1, $at, $at)`,
        {
          $id: id("zc"),
          $zone: zoneId,
          $camera: cameraId,
          $geometry: shape.geometry,
          $points: JSON.stringify(shape.points),
          $direction: input.direction ?? "both",
          $confirm: input.confirmSeconds ?? 2,
          $at: at,
        },
      );
    }
  })();

  if (input.targets.length > 0) setTargets(zoneId, null, input.targets);
  return zoneId;
}

export function addCamera(zoneId: string, cameraId: string, kind: ZoneKind): string {
  const shape = placeholderShape(kind);
  const at = nowIso();
  const bindingId = id("zc");

  run(
    `INSERT INTO zone_camera
       (id, zone_id, camera_id, geometry, points, direction, confirm_seconds, placed, active, created_at, updated_at)
     VALUES ($id, $zone, $camera, $geometry, $points, 'both', 2.0, 0, 1, $at, $at)`,
    {
      $id: bindingId,
      $zone: zoneId,
      $camera: cameraId,
      $geometry: shape.geometry,
      $points: JSON.stringify(shape.points),
      $at: at,
    },
  );
  return bindingId;
}

/**
 * Take a camera out of a zone.
 *
 * The binding is deactivated rather than deleted, and its overrides are left
 * alone -- past events still point at this zone, and re-adding the camera
 * should not silently lose the exceptions somebody set up for it.
 */
export function removeCamera(zoneId: string, cameraId: string): void {
  run(
    "UPDATE zone_camera SET active = 0, updated_at = $at WHERE zone_id = $zone AND camera_id = $camera",
    { $at: nowIso(), $zone: zoneId, $camera: cameraId },
  );
}

export interface BindingPatch {
  geometry?: ZoneGeometry;
  points?: Point[];
  direction?: Direction | "both";
  confirmSeconds?: number;
}

export function updateBinding(zoneId: string, cameraId: string, patch: BindingPatch) {
  const current = getBinding(zoneId, cameraId);
  if (!current) return null;

  const points = patch.points ?? (JSON.parse(current.points) as Point[]);

  run(
    `UPDATE zone_camera SET
       geometry = $geometry, points = $points, direction = $direction,
       confirm_seconds = $confirm, placed = $placed, updated_at = $at
     WHERE zone_id = $zone AND camera_id = $camera`,
    {
      $geometry: patch.geometry ?? current.geometry,
      $points: JSON.stringify(points),
      $direction: patch.direction ?? current.direction,
      $confirm: patch.confirmSeconds ?? current.confirm_seconds,
      // Only DRAWING places a shape. This used to be an unconditional 1, so a
      // supervisor nudging confirmSeconds from 2 to 3 marked the stock line
      // "positioned" -- which would decay the provisional flag into noise
      // within a day of use, and with it the alert suppression that depends on
      // it. Never un-places: a drawn shape stays drawn when a setting changes.
      $placed: patch.points !== undefined ? 1 : current.placed,
      $at: nowIso(),
      $zone: zoneId,
      $camera: cameraId,
    },
  );

  return getBinding(zoneId, cameraId);
}

export function updateZone(
  zoneId: string,
  patch: { name?: string; kind?: ZoneKind; sector?: string | null; active?: boolean },
) {
  const current = one<ZoneRow>("SELECT * FROM zone WHERE id = $id", { $id: zoneId });
  if (!current) return null;

  run(
    `UPDATE zone SET name = $name, kind = $kind, sector = $sector, active = $active, updated_at = $at
     WHERE id = $id`,
    {
      $name: patch.name ?? current.name,
      $kind: patch.kind ?? current.kind,
      $sector: patch.sector === undefined ? current.sector : patch.sector,
      $active: patch.active === undefined ? current.active : patch.active ? 1 : 0,
      $at: nowIso(),
      $id: zoneId,
    },
  );

  return zoneDetail(zoneId);
}
