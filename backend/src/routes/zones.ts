import { one, run } from "../db";
import { nowIso } from "../core/ids";
import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import type { Severity, TargetAction, ZoneKind } from "../core/types";
import { validateZonePoints } from "../l2/geometry";
import { forgetZone } from "../l2/fence";
import { recordAction } from "../l3/audit";
import {
  addCamera, createZone, getBinding, listAreas, listZones, removeCamera, replaceZone,
  setTargets, updateBinding, updateZone, zoneDetail, type CreateZoneCamera, type TargetInput,
} from "../l3/zones";
import { publish } from "../l4/bus";
import { BadRequest } from "../l4/hooks";
import { actorOf, Conflict, handled, json, NotFound, readJson, requireRole } from "../http";

/**
 * Zone routes.
 *
 * A zone is created against an area's cameras, carries an ordered target list,
 * and lets any one of its cameras override that list. Every write here is
 * recorded as a decision -- creating a zone, moving a shape, reordering the
 * targets and adding a camera are all things somebody should have to answer
 * for later.
 */

const ZONE_KINDS: ZoneKind[] = [
  "fence_line", "gate", "waterline", "perimeter", "pass", "restricted_area",
];
const SEVERITIES: Severity[] = ["INFO", "WARNING", "CRITICAL"];
const DIRECTIONS = ["inbound", "outbound", "both"];
const ACTIONS: TargetAction[] = ["alert", "log_only"];

const requireZone = (zoneId: string) => {
  const zone = zoneDetail(zoneId);
  if (!zone) throw new NotFound(`no zone ${zoneId}`);
  return zone;
};

function validateZoneFields(fields: Record<string, any>): void {
  if (fields.kind !== undefined && !ZONE_KINDS.includes(fields.kind)) {
    throw new BadRequest(`kind must be one of ${ZONE_KINDS.join(", ")}`);
  }
  if (fields.geometry !== undefined && !["line", "polygon"].includes(fields.geometry)) {
    throw new BadRequest("geometry must be line or polygon");
  }
  if (fields.direction !== undefined && !DIRECTIONS.includes(fields.direction)) {
    throw new BadRequest(`direction must be one of ${DIRECTIONS.join(", ")}`);
  }
  if (fields.confirmSeconds !== undefined) {
    const value = fields.confirmSeconds;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 60) {
      throw new BadRequest("confirmSeconds must be between 0 and 60");
    }
  }
}

/**
 * Targets arrive as an ordered array -- position is the priority. The caller
 * never sends a rank, so two targets can never claim the same one.
 */
function parseTargets(raw: unknown): TargetInput[] {
  if (!Array.isArray(raw)) throw new BadRequest("targets must be an array");

  const seen = new Set<string>();
  return raw.map((item: any, index: number) => {
    if (!item || typeof item !== "object") {
      throw new BadRequest(`targets[${index}] must be an object`);
    }
    const className = item.class;
    if (typeof className !== "string" || !className.trim()) {
      throw new BadRequest(`targets[${index}].class is required`);
    }
    if (seen.has(className)) throw new BadRequest(`${className} is listed twice`);
    seen.add(className);

    const severity = item.severity ?? "WARNING";
    if (!SEVERITIES.includes(severity)) {
      throw new BadRequest(`targets[${index}].severity must be one of ${SEVERITIES.join(", ")}`);
    }
    const action = item.action ?? "alert";
    if (!ACTIONS.includes(action)) {
      throw new BadRequest(`targets[${index}].action must be alert or log_only`);
    }
    return { class: className.trim(), severity, action };
  });
}

function requireCameras(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new BadRequest("a zone needs at least one camera");
  }
  for (const cameraId of ids) {
    if (!one("SELECT id FROM camera WHERE id = $id", { $id: cameraId })) {
      throw new NotFound(`no camera ${cameraId}`);
    }
  }
  return ids as string[];
}

/**
 * The cameras of a new zone, each optionally carrying the shape drawn for it.
 *
 * Two request shapes are accepted and they are not equivalent:
 *
 *   cameraIds: ["cam_a"]                    -- joins on the placeholder
 *   cameras:   [{ cameraId, points, ... }]  -- joins already positioned
 *
 * The first is kept because adding a camera without drawing it is still a real
 * thing to want (a feed that is dark right now, a zone declared ahead of the
 * survey). The second is what the console's wizard sends, so that a zone and
 * every shape in it are written or not written together.
 *
 * Shapes are validated HERE, before anything is inserted. `createZone` runs one
 * transaction and a shape rejected halfway through it would roll back the zone
 * but not the caller's belief that it exists.
 */
function parseCreateCameras(body: Record<string, any>): CreateZoneCamera[] {
  if (body.cameras === undefined) {
    return requireCameras(body.cameraIds).map((cameraId) => ({ cameraId }));
  }
  if (!Array.isArray(body.cameras) || body.cameras.length === 0) {
    throw new BadRequest("a zone needs at least one camera");
  }

  const seen = new Set<string>();
  return body.cameras.map((entry: any, index: number) => {
    if (!entry || typeof entry !== "object") {
      throw new BadRequest(`cameras[${index}] must be an object`);
    }
    const cameraId = entry.cameraId;
    if (typeof cameraId !== "string" || !cameraId.trim()) {
      throw new BadRequest(`cameras[${index}].cameraId is required`);
    }
    if (!one("SELECT id FROM camera WHERE id = $id", { $id: cameraId })) {
      throw new NotFound(`no camera ${cameraId}`);
    }
    // The database's one-zone-per-camera index would catch this, but as a
    // UNIQUE failure naming neither the camera nor the duplicate.
    if (seen.has(cameraId)) throw new BadRequest(`${cameraId} is listed twice`);
    seen.add(cameraId);

    validateZoneFields(entry);

    const drawn = entry.points !== undefined;
    if (drawn) {
      const geometry = entry.geometry ?? "line";
      const problem = validateZonePoints(geometry, entry.points);
      if (problem) throw new BadRequest(`cameras[${index}]: ${problem}`);
    }

    return {
      cameraId,
      geometry: entry.geometry,
      points: drawn ? entry.points : undefined,
      direction: entry.direction,
      confirmSeconds: entry.confirmSeconds,
      targets: entry.targets === undefined ? undefined : parseTargets(entry.targets),
    };
  });
}

/**
 * A camera belongs to exactly one zone.
 *
 * Enforced in the database by the partial unique index `zone_camera_one_zone`,
 * but checked here first so the caller gets a 409 naming the zone that holds
 * it, instead of a 500 with "UNIQUE constraint failed" as the body.
 *
 * `exceptZoneId` lets a zone re-check its own cameras without colliding with
 * itself, which matters on the re-activation path below.
 */
function requireFreeCameras(ids: string[], exceptZoneId?: string): void {
  for (const cameraId of ids) {
    const held = one<{ zone_id: string; name: string }>(
      `SELECT zc.zone_id, z.name FROM zone_camera zc
         JOIN zone z ON z.id = zc.zone_id
        WHERE zc.camera_id = $cam AND zc.active = 1 AND zc.zone_id != $except`,
      { $cam: cameraId, $except: exceptZoneId ?? "" },
    );
    if (held) {
      throw new Conflict(
        `${cameraId} already watches "${held.name}" (${held.zone_id}); ` +
          "a camera belongs to one zone - remove it there first",
      );
    }
  }
}

const cameraView = (zone: any, cameraId: string) =>
  zone.cameras.find((c: any) => c.cameraId === cameraId);

const activeCameraIds = (zone: any) =>
  zone.cameras.filter((c: any) => c.active).map((c: any) => c.cameraId);

export const zoneRoutes = {
  "/api/zones": {
    /** Every zone at this site, each with its cameras, policy and overrides. */
    GET: handled(async () => json(listZones(DEFAULT_SITE))),

    /**
     * Create a zone across a set of cameras, with their shapes if they have
     * been drawn.
     *
     * The whole call is one decision: name, area, cameras, every shape and
     * every target, written together or not at all. The console walks a
     * supervisor through all of it before sending anything, so a run abandoned
     * halfway leaves nothing behind -- see `parseCreateCameras`.
     */
    POST: handled(async (req) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const body = await readJson(req);
      validateZoneFields(body);

      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new BadRequest("name is required");

      const cameras = parseCreateCameras(body);
      // All or nothing. Creating the zone minus the offending camera would
      // show the supervisor a success and leave a camera they believe is
      // covered watching nothing -- the worst outcome for a coverage tool.
      requireFreeCameras(cameras.map((camera) => camera.cameraId));
      const targets = parseTargets(body.targets ?? []);
      if (targets.length === 0) {
        throw new BadRequest("a zone needs at least one thing to detect against");
      }

      // Trimmed to nothing is no area, not an area named "". Otherwise a
      // stray space becomes an entry in the picker that nobody can ever
      // match, delete, or tell apart from the empty one next to it.
      const area = typeof body.area === "string" ? body.area.trim() || null : null;

      const zoneId = createZone({
        orgId: DEFAULT_ORG,
        siteId: DEFAULT_SITE,
        name,
        kind: body.kind ?? "fence_line",
        area,
        cameras,
        targets,
        direction: body.direction,
        confirmSeconds: body.confirmSeconds,
      });

      const created = requireZone(zoneId);
      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.create",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: {
          area,
          cameras: cameras.length,
          // Worth recording separately: it is the difference between a zone
          // somebody positioned and one that went live on placeholders.
          placed: cameras.filter((camera) => camera.points !== undefined).length,
          targets: targets.length,
        },
        after: created,
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json(created, 201);
    }),
  },

  /**
   * The area labels currently in use, for the console's picker.
   *
   * Read-only and derived on purpose: there is nothing to create here. An area
   * comes into existence when a zone is saved carrying the label and stops
   * existing when the last zone using it stops. A POST would create a second
   * list to keep in step with this one, which is the whole problem the old
   * hardcoded area polygons had.
   *
   * Bun matches a literal segment ahead of `:zoneId` whatever the declaration
   * order, so this cannot be read as a zone called "areas". Kept next to its
   * sibling anyway, for the reader rather than the router.
   */
  "/api/zones/areas": {
    GET: handled(async () => json({ areas: listAreas(DEFAULT_SITE) })),
  },

  "/api/zones/:zoneId": {
    GET: handled(async (req: any) => json(requireZone(req.params.zoneId))),

    /**
     * Replace the zone's whole configuration: name, kind, area, cameras with
     * their shapes, the policy, and every camera's exceptions.
     *
     * The editing counterpart of POST, and deliberately the same shape of
     * call. The console walks a supervisor through all of it and sends one
     * request, so a run they abandon changes nothing and a run that fails
     * changes nothing -- rather than leaving a live zone holding half of what
     * they asked for.
     *
     * PATCH is still here and still does name/kind/area/active on its own. It
     * is the right call for a one-field change (the deactivate button uses
     * it); this is the right call for "here is what the zone should now be".
     */
    PUT: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = requireZone(zoneId);
      const body = await readJson(req);
      validateZoneFields(body);

      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new BadRequest("name is required");

      const cameras = parseCreateCameras(body);
      // `exceptZoneId` so a zone re-saving its OWN cameras does not collide
      // with itself -- without it, editing a zone's name would 409 on every
      // camera already in it.
      requireFreeCameras(cameras.map((camera) => camera.cameraId), zoneId);

      const targets = parseTargets(body.targets ?? []);
      if (targets.length === 0) {
        throw new BadRequest("a zone needs at least one thing to detect against");
      }

      const area = typeof body.area === "string" ? body.area.trim() || null : null;

      const after = replaceZone(zoneId, { name, kind: body.kind ?? before.kind, area, cameras, targets });
      if (!after) throw new NotFound(`no zone ${zoneId}`);

      // Shapes may have moved, so a crossing held against the old geometry
      // would otherwise confirm against a line that no longer exists.
      forgetZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.update",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: {
          cameras: cameras.length,
          placed: cameras.filter((camera) => camera.points !== undefined).length,
          targets: targets.length,
        },
        // The whole zone either side. This is the only record of what changed
        // now that shapes no longer get their own `zone.camera.update` row --
        // a deliberate trade for the atomic save, noted here so the next
        // person looking for "who moved this line" knows where it went.
        before,
        after,
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json(after);
    }),

    PATCH: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = requireZone(zoneId);
      const body = await readJson(req);
      validateZoneFields(body);

      updateZone(zoneId, {
        name: body.name,
        kind: body.kind,
        // Same trim rule as create, and `null` still clears the label.
        area:
          typeof body.area === "string" ? body.area.trim() || null : body.area,
        active: body.active,
      });

      // Bringing a zone back has to bring its cameras back too, or it returns
      // alive and watching nothing -- a zone on screen, judging no ground, with
      // nothing saying why. Deactivating released the bindings (see DELETE
      // below); this is the other half.
      //
      // Only cameras that are still FREE can return: one may have joined
      // another zone while this one was out of service, and that newer decision
      // wins. Whoever reactivated is told which ones stayed behind rather than
      // finding out from a quiet gap in coverage.
      const stranded: string[] = [];
      if (body.active === true && before.active === false) {
        for (const camera of before.cameras) {
          const taken = one<{ zone_id: string; name: string }>(
            `SELECT zc.zone_id, z.name FROM zone_camera zc
               JOIN zone z ON z.id = zc.zone_id
              WHERE zc.camera_id = $cam AND zc.active = 1 AND zc.zone_id != $zone`,
            { $cam: camera.cameraId, $zone: zoneId },
          );
          if (taken) {
            stranded.push(`${camera.cameraId} (now in ${taken.name})`);
            continue;
          }
          run(
            `UPDATE zone_camera SET active = 1, updated_at = $at
              WHERE zone_id = $zone AND camera_id = $cam`,
            { $at: nowIso(), $zone: zoneId, $cam: camera.cameraId },
          );
        }
      }

      const after = requireZone(zoneId);
      forgetZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.update",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: stranded.length ? { camerasNotReturned: stranded } : {},
        before,
        after,
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json({ ...after, camerasNotReturned: stranded });
    }),

    DELETE: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = requireZone(zoneId);
      const body = await readJson(req).catch(() => ({}) as Record<string, any>);

      // Deactivated, not deleted -- past events still point at it.
      const after = updateZone(zoneId, { active: false });
      // And its cameras are RELEASED. The one-zone-per-camera index is on
      // zone_camera.active, not zone.active, so leaving the bindings live
      // would keep every camera hostage to a zone that no longer exists as far
      // as an operator is concerned -- unable to join anything, with nothing on
      // screen explaining why.
      run(
        "UPDATE zone_camera SET active = 0, updated_at = $at WHERE zone_id = $zone AND active = 1",
        { $at: nowIso(), $zone: zoneId },
      );
      forgetZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.delete",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        before,
        after,
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json({ ok: true });
    }),
  },

  /**
   * The zone's own target policy, in priority order. The whole list is
   * replaced on every write, because a rank only means anything relative to
   * the others.
   */
  "/api/zones/:zoneId/targets": {
    PUT: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = requireZone(zoneId);
      const body = await readJson(req);
      const targets = parseTargets(body.targets);
      if (targets.length === 0) {
        throw new BadRequest("a zone needs at least one thing to detect against");
      }

      setTargets(zoneId, null, targets);
      forgetZone(zoneId);
      const after = requireZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.targets",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        before: { targets: before.targets },
        after: { targets: after.targets },
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json(after);
    }),
  },

  "/api/zones/:zoneId/cameras": {
    POST: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = requireZone(zoneId);
      const body = await readJson(req);
      const [cameraId] = requireCameras([body.cameraId]);

      const existing = getBinding(zoneId, cameraId!);
      if (existing && existing.active === 1) {
        throw new BadRequest("that camera is already in this zone");
      }
      // Checked on the re-activation path too: flipping active back to 1 hits
      // the same unique index as a fresh insert.
      requireFreeCameras([cameraId!], zoneId);

      if (existing) {
        // Re-joining: its old shape and any overrides are still there.
        run("UPDATE zone_camera SET active = 1, updated_at = $at WHERE id = $id", {
          $at: nowIso(),
          $id: existing.id,
        });
      } else {
        addCamera(zoneId, cameraId!, before.kind as ZoneKind);
      }

      const after = requireZone(zoneId);
      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.camera.add",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: { cameraId, rejoined: Boolean(existing) },
        before: { cameras: activeCameraIds(before) },
        after: { cameras: activeCameraIds(after) },
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json(after, 201);
    }),
  },

  "/api/zones/:zoneId/cameras/:cameraId": {
    /** Move or retune this camera's shape. Marks it placed. */
    PATCH: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const { zoneId, cameraId } = req.params;
      const before = requireZone(zoneId);
      const body = await readJson(req);
      validateZoneFields(body);

      const binding = getBinding(zoneId, cameraId);
      if (!binding) throw new NotFound(`camera ${cameraId} is not in this zone`);

      const geometry = body.geometry ?? binding.geometry;
      const points = body.points ?? JSON.parse(binding.points);
      const problem = validateZonePoints(geometry, points);
      if (problem) throw new BadRequest(problem);

      updateBinding(zoneId, cameraId, {
        geometry,
        // `body.points`, not the defaulted `points` above: passing the
        // fallback would make every settings-only PATCH look like a drawing,
        // and updateBinding uses "were points sent?" to decide whether this
        // shape has now been positioned. Validation above still runs against
        // the effective shape either way.
        points: body.points,
        direction: body.direction,
        confirmSeconds: body.confirmSeconds,
      });

      // A pending crossing held against the old shape would otherwise confirm
      // against geometry that no longer exists.
      forgetZone(zoneId);
      const after = requireZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.camera.update",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: { cameraId },
        before: cameraView(before, cameraId),
        after: cameraView(after, cameraId),
      });

      publish({ type: "camera", data: { cameraId, zoneChanged: zoneId } });
      return json(after);
    }),

    DELETE: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const { zoneId, cameraId } = req.params;
      const before = requireZone(zoneId);
      // A zone with no camera is now a legitimate state: "declared, not
      // watched". It has to be, because a camera belongs to exactly one zone --
      // refusing to release the last one would mean the only way to move a
      // camera is to delete the zone and rebuild it, losing its targets, its
      // history and its id. The zone keeps its identity and policy; geometry
      // was never its job.
      const body = await readJson(req).catch(() => ({}) as Record<string, any>);

      removeCamera(zoneId, cameraId);
      forgetZone(zoneId);
      const after = requireZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.camera.remove",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: { cameraId },
        before: { cameras: activeCameraIds(before) },
        after: { cameras: activeCameraIds(after) },
      });

      publish({ type: "camera", data: { zoneChanged: zoneId } });
      return json({ ok: true });
    }),
  },

  /**
   * Camera-specific exceptions to the zone policy. An empty list clears them
   * and puts the camera back on the zone's own policy -- the only way to undo
   * an override.
   */
  "/api/zones/:zoneId/cameras/:cameraId/targets": {
    PUT: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const { zoneId, cameraId } = req.params;
      const before = requireZone(zoneId);
      if (!getBinding(zoneId, cameraId)) {
        throw new NotFound(`camera ${cameraId} is not in this zone`);
      }

      const body = await readJson(req);
      const targets = parseTargets(body.targets ?? []);

      setTargets(zoneId, cameraId, targets);
      forgetZone(zoneId);
      const after = requireZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.camera.targets",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        detail: { cameraId, cleared: targets.length === 0 },
        before: { overrides: cameraView(before, cameraId)?.overrides ?? [] },
        after: { overrides: cameraView(after, cameraId)?.overrides ?? [] },
      });

      publish({ type: "camera", data: { cameraId, zoneChanged: zoneId } });
      return json(after);
    }),
  },
} as const;
