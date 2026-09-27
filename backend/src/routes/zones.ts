import { one, run } from "../db";
import { nowIso } from "../core/ids";
import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import type {
  Direction, Point, Severity, TargetAction, ZoneGeometry, ZoneKind,
} from "../core/types";
import { validateZonePoints } from "../l2/geometry";
import { forgetZone } from "../l2/fence";
import { recordAction } from "../l3/audit";
import {
  addCamera, createZone, getBinding, listZones, removeCamera, setTargets,
  updateBinding, updateZone, zoneDetail, type TargetInput,
} from "../l3/zones";
import { publish } from "../l4/bus";
import { BadRequest } from "../l4/hooks";
import { Router } from "express";
import { actorOf, NotFound, optionalJson, readJson, requireRole } from "../http";

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
const DIRECTIONS: ZoneDirection[] = ["inbound", "outbound", "both"];
const ACTIONS: TargetAction[] = ["alert", "log_only"];

type ZoneDirection = Direction | "both";

/** One entry of a target list, as sent. Position in the array is its priority. */
export interface TargetBody {
  class?: string;
  severity?: Severity;
  action?: TargetAction;
}

/** The fields every zone and zone-camera write may carry, checked by `validateZoneFields`. */
export interface ZoneFieldsBody {
  kind?: ZoneKind;
  geometry?: ZoneGeometry;
  direction?: ZoneDirection;
  confirmSeconds?: number;
}

export interface ReasonBody {
  reason?: string | null;
}

/** POST /api/zones */
export interface CreateZoneBody extends ZoneFieldsBody, ReasonBody {
  name?: string;
  sector?: string | null;
  cameraIds?: string[];
  targets?: TargetBody[];
}

/** PATCH /api/zones/:zoneId */
export interface UpdateZoneBody extends ZoneFieldsBody, ReasonBody {
  name?: string;
  sector?: string | null;
  active?: boolean;
}

/** PUT /api/zones/:zoneId/targets and /api/zones/:zoneId/cameras/:cameraId/targets */
export interface TargetsBody extends ReasonBody {
  targets?: TargetBody[];
}

/** POST /api/zones/:zoneId/cameras */
export interface AddZoneCameraBody extends ReasonBody {
  cameraId?: string;
}

/** PATCH /api/zones/:zoneId/cameras/:cameraId */
export interface UpdateZoneCameraBody extends ZoneFieldsBody, ReasonBody {
  points?: Point[];
}

const requireZone = (zoneId: string) => {
  const zone = zoneDetail(zoneId);
  if (!zone) throw new NotFound(`no zone ${zoneId}`);
  return zone;
};

function validateZoneFields(fields: ZoneFieldsBody): void {
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

const cameraView = (zone: any, cameraId: string) =>
  zone.cameras.find((c: any) => c.cameraId === cameraId);

const activeCameraIds = (zone: any) =>
  zone.cameras.filter((c: any) => c.active).map((c: any) => c.cameraId);

export const zoneRoutes = Router();

/** Every zone at this site, each with its cameras, policy and overrides. */
zoneRoutes.get("/api/zones", (_req, res) => {
  res.json(listZones(DEFAULT_SITE));
});

/**
 * Create a zone across a set of cameras.
 *
 * The cameras come from an area the supervisor picked in the console; this
 * only checks they exist. Each starts with a placeholder shape, so a zone
 * never goes live pretending somebody positioned it.
 */
zoneRoutes.post("/api/zones", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const body = readJson<CreateZoneBody>(req);
  validateZoneFields(body);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new BadRequest("name is required");

  const cameraIds = requireCameras(body.cameraIds);
  const targets = parseTargets(body.targets ?? []);
  if (targets.length === 0) {
    throw new BadRequest("a zone needs at least one thing to detect against");
  }

  const zoneId = createZone({
    orgId: DEFAULT_ORG,
    siteId: DEFAULT_SITE,
    name,
    kind: body.kind ?? "fence_line",
    sector: body.sector ?? null,
    cameraIds,
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
      sector: body.sector ?? null,
      cameras: cameraIds.length,
      targets: targets.length,
    },
    after: created,
  });

  publish({ type: "camera", data: { zoneChanged: zoneId } });
  res.status(201).json(created);
});

zoneRoutes.get("/api/zones/:zoneId", (req, res) => {
  res.json(requireZone(req.params.zoneId));
});

zoneRoutes.patch("/api/zones/:zoneId", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const zoneId = req.params.zoneId;
  const before = requireZone(zoneId);
  const body = readJson<UpdateZoneBody>(req);
  validateZoneFields(body);

  const after = updateZone(zoneId, {
    name: body.name,
    kind: body.kind,
    sector: body.sector,
    active: body.active,
  });
  forgetZone(zoneId);

  recordAction({
    actor,
    orgId: DEFAULT_ORG,
    verb: "zone.update",
    targetType: "zone",
    targetId: zoneId,
    reason: body.reason ?? null,
    before,
    after,
  });

  publish({ type: "camera", data: { zoneChanged: zoneId } });
  res.json(after);
});

zoneRoutes.delete("/api/zones/:zoneId", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const zoneId = req.params.zoneId;
  const before = requireZone(zoneId);
  const body = optionalJson<ReasonBody>(req);

  // Deactivated, not deleted -- past events still point at it.
  const after = updateZone(zoneId, { active: false });
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
  res.json({ ok: true });
});

/**
 * The zone's own target policy, in priority order. The whole list is
 * replaced on every write, because a rank only means anything relative to
 * the others.
 */
zoneRoutes.put("/api/zones/:zoneId/targets", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const zoneId = req.params.zoneId;
  const before = requireZone(zoneId);
  const body = readJson<TargetsBody>(req);
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
  res.json(after);
});

zoneRoutes.post("/api/zones/:zoneId/cameras", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const zoneId = req.params.zoneId;
  const before = requireZone(zoneId);
  const body = readJson<AddZoneCameraBody>(req);
  const [cameraId] = requireCameras([body.cameraId]);

  const existing = getBinding(zoneId, cameraId!);
  if (existing && existing.active === 1) {
    throw new BadRequest("that camera is already in this zone");
  }

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
  res.status(201).json(after);
});

/** Move or retune this camera's shape. Marks it placed. */
zoneRoutes.patch("/api/zones/:zoneId/cameras/:cameraId", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const { zoneId, cameraId } = req.params;
  const before = requireZone(zoneId);
  const body = readJson<UpdateZoneCameraBody>(req);
  validateZoneFields(body);

  const binding = getBinding(zoneId, cameraId);
  if (!binding) throw new NotFound(`camera ${cameraId} is not in this zone`);

  const geometry = body.geometry ?? (binding.geometry as ZoneGeometry);
  const points = body.points ?? JSON.parse(binding.points);
  const problem = validateZonePoints(geometry, points);
  if (problem) throw new BadRequest(problem);

  updateBinding(zoneId, cameraId, {
    geometry,
    points,
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
  res.json(after);
});

zoneRoutes.delete("/api/zones/:zoneId/cameras/:cameraId", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const { zoneId, cameraId } = req.params;
  const before = requireZone(zoneId);
  if (activeCameraIds(before).length <= 1) {
    throw new BadRequest("a zone must keep at least one camera; deactivate the zone instead");
  }
  const body = optionalJson<ReasonBody>(req);

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
  res.json({ ok: true });
});

/**
 * Camera-specific exceptions to the zone policy. An empty list clears them
 * and puts the camera back on the zone's own policy -- the only way to undo
 * an override.
 */
zoneRoutes.put("/api/zones/:zoneId/cameras/:cameraId/targets", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const { zoneId, cameraId } = req.params;
  const before = requireZone(zoneId);
  if (!getBinding(zoneId, cameraId)) {
    throw new NotFound(`camera ${cameraId} is not in this zone`);
  }

  const body = readJson<TargetsBody>(req);
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
  res.json(after);
});
