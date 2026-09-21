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
  area: string | null;
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
    area: zone.area,
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

/**
 * One camera joining a new zone, with the shape somebody drew for it.
 *
 * Everything past `cameraId` is optional and each omission means the same
 * thing: nobody drew it. The camera then joins on the placeholder with
 * `placed = 0`, exactly as it always did.
 */
export interface CreateZoneCamera {
  cameraId: string;
  geometry?: ZoneGeometry;
  /** Normalised 0..1 against this camera's frame. Presence is what marks it placed. */
  points?: Point[];
  direction?: Direction | "both";
  confirmSeconds?: number;
  /** This camera's exceptions to the zone policy, if it has any. */
  targets?: TargetInput[];
}

export interface CreateZoneInput {
  orgId: string;
  siteId: string;
  name: string;
  kind: ZoneKind;
  area?: string | null;
  cameras: CreateZoneCamera[];
  targets: TargetInput[];
  direction?: Direction | "both";
  confirmSeconds?: number;
}

/**
 * Create a zone, join its cameras, and record the shapes drawn for them -- all
 * in one transaction.
 *
 * WHY THE SHAPES COME IN HERE rather than as PATCHes afterwards. The console
 * now walks a supervisor through drawing every camera before the zone exists,
 * so there is a moment where a zone's whole configuration is known and nothing
 * has been written yet. Writing it in pieces would mean a cancelled or
 * half-failed run leaves a live zone watching ground nobody finished
 * describing -- and a zone that exists but was never meant to is worse than no
 * zone, because coverage looks accounted for.
 *
 * A camera with no points still joins on the placeholder with `placed = 0`.
 * That path is unchanged and still the right one: a camera with no picture
 * cannot be drawn on, and refusing it would make a dead feed block the zone.
 * The flag is what stops the detector alerting on a shape nobody chose
 * (`ibvap/config.py` sends it as `provisional`; `l4/vision.ts` suppresses with
 * `zone_not_placed`).
 */
export function createZone(input: CreateZoneInput): string {
  const zoneId = id("zone");
  const at = nowIso();
  const fallback = placeholderShape(input.kind);

  db.transaction(() => {
    run(
      `INSERT INTO zone (id, org_id, site_id, name, kind, area, active, created_at, updated_at)
       VALUES ($id, $org, $site, $name, $kind, $area, 1, $at, $at)`,
      {
        $id: zoneId,
        $org: input.orgId,
        $site: input.siteId,
        $name: input.name,
        $kind: input.kind,
        $area: input.area ?? null,
        $at: at,
      },
    );

    for (const camera of input.cameras) {
      const drawn = camera.points !== undefined && camera.points.length > 0;
      run(
        `INSERT INTO zone_camera
           (id, zone_id, camera_id, geometry, points, direction, confirm_seconds, placed, active, created_at, updated_at)
         VALUES ($id, $zone, $camera, $geometry, $points, $direction, $confirm, $placed, 1, $at, $at)`,
        {
          $id: id("zc"),
          $zone: zoneId,
          $camera: camera.cameraId,
          $geometry: (drawn ? camera.geometry : undefined) ?? fallback.geometry,
          $points: JSON.stringify(drawn ? camera.points : fallback.points),
          $direction: camera.direction ?? input.direction ?? "both",
          $confirm: camera.confirmSeconds ?? input.confirmSeconds ?? 2,
          $placed: drawn ? 1 : 0,
          $at: at,
        },
      );
    }
  })();

  // Outside the transaction above because `setTargets` opens its own. Both are
  // on the same connection, so a failure here still leaves the zone -- which is
  // why the route validates every target before calling this.
  if (input.targets.length > 0) setTargets(zoneId, null, input.targets);
  for (const camera of input.cameras) {
    if (camera.targets && camera.targets.length > 0) {
      setTargets(zoneId, camera.cameraId, camera.targets);
    }
  }
  return zoneId;
}

/**
 * The areas currently in use at a site.
 *
 * Derived, never stored as its own list: an area exists exactly as long as a
 * zone carries the label. That is what lets the console offer "type to filter,
 * or create it by typing a new one" without anything to prune afterwards.
 */
export function listAreas(siteId: string): string[] {
  return all<{ area: string }>(
    `SELECT DISTINCT area FROM zone
      WHERE site_id = $site AND area IS NOT NULL AND TRIM(area) != ''
      ORDER BY area COLLATE NOCASE`,
    { $site: siteId },
  ).map((row) => row.area);
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
  patch: { name?: string; kind?: ZoneKind; area?: string | null; active?: boolean },
) {
  const current = one<ZoneRow>("SELECT * FROM zone WHERE id = $id", { $id: zoneId });
  if (!current) return null;

  run(
    `UPDATE zone SET name = $name, kind = $kind, area = $area, active = $active, updated_at = $at
     WHERE id = $id`,
    {
      $name: patch.name ?? current.name,
      $kind: patch.kind ?? current.kind,
      // `undefined` leaves it alone, `null` clears it -- so a zone can be taken
      // out of an area without being given a different one.
      $area: patch.area === undefined ? current.area : patch.area,
      $active: patch.active === undefined ? current.active : patch.active ? 1 : 0,
      $at: nowIso(),
      $id: zoneId,
    },
  );

  return zoneDetail(zoneId);
}

/**
 * Replace a zone's entire configuration in one transaction.
 *
 * WHY THIS EXISTS RATHER THAN THE SIX ENDPOINTS IT SUBSUMES. Creating a zone
 * is one guided act -- name it, pick cameras, draw each, set the policy, save.
 * Changing it was six: PATCH the zone, PATCH each shape, PUT the targets, PUT
 * each camera's overrides, POST and DELETE cameras. So the console could offer
 * a wizard for creation and only a scavenger hunt for editing, and a supervisor
 * halfway through rearranging a zone had already half-applied it.
 *
 * ALL OR NOTHING, INCLUDING THE TARGETS. `setTargets` opens its own
 * transaction; bun:sqlite nests those as savepoints, so calling it inside this
 * one is safe and the whole replace still rolls back as a unit. That matters
 * more here than at creation: a failure partway through leaves a zone that
 * EXISTS, is live, and is watching some mixture of the old and new
 * configuration -- with the console showing whichever it asked for last.
 *
 * BINDINGS ARE RETIRED, NEVER DELETED (see `removeCamera`). A camera dropped
 * here keeps its row and its overrides, so putting it back restores the
 * exceptions somebody set up for it rather than silently losing them.
 *
 * WHAT THIS DOES NOT TOUCH: the zone's id, its created_at, and every event
 * pointing at it. That is the whole reason editing must not be
 * delete-and-recreate -- `event.zone_id` deliberately carries no foreign key,
 * so a rebuilt zone would orphan its own history without the database
 * objecting.
 */
export function replaceZone(
  zoneId: string,
  input: {
    name: string;
    kind: ZoneKind;
    area?: string | null;
    cameras: CreateZoneCamera[];
    targets: TargetInput[];
  },
): ReturnType<typeof zoneDetail> {
  const current = one<ZoneRow>("SELECT * FROM zone WHERE id = $id", { $id: zoneId });
  if (!current) return null;

  const at = nowIso();
  const fallback = placeholderShape(input.kind);
  const wanted = new Map(input.cameras.map((camera) => [camera.cameraId, camera]));

  db.transaction(() => {
    run(
      `UPDATE zone SET name = $name, kind = $kind, area = $area, updated_at = $at WHERE id = $id`,
      {
        $name: input.name,
        $kind: input.kind,
        $area: input.area ?? null,
        $at: at,
        $id: zoneId,
      },
    );

    // Every binding this zone has ever had, active or retired -- a camera
    // coming back must reuse its row rather than insert a second one, which
    // the one-zone-per-camera index would reject anyway.
    const existing = all<BindingRow>(
      "SELECT * FROM zone_camera WHERE zone_id = $zone",
      { $zone: zoneId },
    );
    const known = new Map(existing.map((row) => [row.camera_id, row]));

    for (const row of existing) {
      if (row.active === 1 && !wanted.has(row.camera_id)) {
        run(
          "UPDATE zone_camera SET active = 0, updated_at = $at WHERE id = $id",
          { $at: at, $id: row.id },
        );
      }
    }

    for (const camera of input.cameras) {
      const drawn = camera.points !== undefined && camera.points.length > 0;
      const row = known.get(camera.cameraId);

      // Omitting `points` means "leave the shape alone", not "un-draw it".
      // The console sends every camera on every save, so treating a missing
      // shape as a reset would wipe a drawing whenever somebody renamed the
      // zone. `placed` therefore only ever goes 0 -> 1 here.
      const geometry = drawn
        ? (camera.geometry ?? "line")
        : (row?.geometry ?? fallback.geometry);
      const points = drawn
        ? camera.points!
        : (row ? (JSON.parse(row.points) as Point[]) : fallback.points);
      const placed = drawn ? 1 : (row?.placed ?? 0);

      if (row) {
        run(
          `UPDATE zone_camera SET
             geometry = $geometry, points = $points, direction = $direction,
             confirm_seconds = $confirm, placed = $placed, active = 1, updated_at = $at
           WHERE id = $id`,
          {
            $geometry: geometry,
            $points: JSON.stringify(points),
            $direction: camera.direction ?? row.direction,
            $confirm: camera.confirmSeconds ?? row.confirm_seconds,
            $placed: placed,
            $at: at,
            $id: row.id,
          },
        );
      } else {
        run(
          `INSERT INTO zone_camera
             (id, zone_id, camera_id, geometry, points, direction, confirm_seconds, placed, active, created_at, updated_at)
           VALUES ($id, $zone, $camera, $geometry, $points, $direction, $confirm, $placed, 1, $at, $at)`,
          {
            $id: id("zc"),
            $zone: zoneId,
            $camera: camera.cameraId,
            $geometry: geometry,
            $points: JSON.stringify(points),
            $direction: camera.direction ?? "both",
            $confirm: camera.confirmSeconds ?? 2,
            $placed: placed,
            $at: at,
          },
        );
      }
    }

    setTargets(zoneId, null, input.targets);

    // Overrides are replaced wholesale for every camera in the zone, including
    // the ones sending none: an empty list is how an exception is CLEARED, and
    // skipping those would make "follow the zone policy again" impossible to
    // express -- the bug the per-camera PUT endpoint already documents.
    for (const camera of input.cameras) {
      setTargets(zoneId, camera.cameraId, camera.targets ?? []);
    }
  })();

  return zoneDetail(zoneId);
}
