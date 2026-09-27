import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import { recordAction } from "../l3/audit";
import { cameraDetail, createCamera, listCameras, updateCamera } from "../l3/cameras";
import { listIncidents, queryEvents } from "../l3/events";
import { publish } from "../l4/bus";
import { BadRequest } from "../l4/hooks";
import { Router } from "express";
import { actorOf, NotFound, num, query, readJson, requireRole } from "../http";

/**
 * Camera routes.
 *
 * Two jobs. Reading one camera answers "what has happened on this feed, and
 * what else is watching the same ground" -- the question an operator asks by
 * clicking a camera. Writing to one is configuration, so it is supervisor-only
 * and recorded like every other decision.
 */

const requireCamera = (cameraId: string) => {
  const camera = cameraDetail(cameraId);
  if (!camera) throw new NotFound(`no camera ${cameraId}`);
  return camera;
};

/**
 * An RTSP URL, or nothing.
 *
 * Deliberately permissive about the rest of the string -- camera vendors put
 * all sorts in the path -- but the scheme has to be one we can actually read,
 * because the whole constraint of this project is speaking ordinary protocols.
 */
function validateStreamUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new BadRequest("streamUrl must be text");

  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequest("streamUrl must be a full URL, e.g. rtsp://host:554/stream1");
  }
  if (!["rtsp:", "rtsps:", "http:", "https:"].includes(parsed.protocol)) {
    throw new BadRequest(`${parsed.protocol.replace(":", "")} is not a stream protocol we read`);
  }
  return trimmed;
}

/** POST /api/cameras */
export interface CreateCameraBody {
  id?: string;
  name?: string;
  streamUrl?: string | null;
  reason?: string | null;
}

/** PATCH /api/cameras/:cameraId */
export interface UpdateCameraBody {
  name?: string;
  streamUrl?: string | null;
  enabled?: boolean;
  reason?: string | null;
}

export const cameraRoutes = Router();

cameraRoutes.get("/api/cameras", (_req, res) => {
  res.json(listCameras(DEFAULT_SITE));
});

/**
 * Adopt a camera the media hub is already serving.
 *
 * The id is the hub's path name, not something generated here: the vision
 * service stamps that same string on every detection, and the node matches
 * on it exactly. Taking it as given is what makes the two agree.
 *
 * Supervisor-only and audited like every other configuration change --
 * adding an eye to the system is a decision somebody made, and the record
 * should say who.
 */
cameraRoutes.post("/api/cameras", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const body = readJson<CreateCameraBody>(req);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) throw new BadRequest("id is required, and must be the hub's path name");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    // The id becomes a URL path segment on the hub and a key in the
    // database. Anything outside this set is a bug waiting to happen in
    // one of the two.
    throw new BadRequest("id may contain only letters, digits, underscore and hyphen");
  }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : id;
  const created = createCamera({
    id,
    siteId: DEFAULT_SITE,
    name,
    streamUrl: validateStreamUrl(body.streamUrl),
  });
  // Already known. Not an error: two operators watching the same "not
  // seeded" banner will both click it, and the second must not see a
  // failure for a camera that is now present.
  if (!created) {
    res.json(cameraDetail(id));
    return;
  }

  recordAction({
    actor,
    orgId: DEFAULT_ORG,
    verb: "camera.create",
    targetType: "camera",
    targetId: id,
    reason: body.reason ?? null,
    detail: { name, adoptedFromHub: true },
    after: created,
  });

  publish({ type: "camera", data: created });
  res.status(201).json(created);
});

cameraRoutes.get("/api/cameras/:cameraId", (req, res) => {
  res.json(requireCamera(req.params.cameraId));
});

cameraRoutes.patch("/api/cameras/:cameraId", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const cameraId = req.params.cameraId;
  const before = requireCamera(cameraId);
  const body = readJson<UpdateCameraBody>(req);

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new BadRequest("name cannot be empty");
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new BadRequest("enabled must be true or false");
  }

  const streamUrl =
    body.streamUrl === undefined ? undefined : validateStreamUrl(body.streamUrl);

  // Taking a feed out of service is the consequential one: nothing crossing
  // it is judged while it is off, so it needs a stated reason.
  const goingDark = body.enabled === false && before.enabled;
  if (goingDark && !String(body.reason ?? "").trim()) {
    throw new BadRequest("say why this feed is being taken out of service");
  }

  const after = updateCamera(cameraId, {
    name: body.name?.trim(),
    streamUrl,
    enabled: body.enabled,
  });

  recordAction({
    actor,
    orgId: DEFAULT_ORG,
    verb: goingDark
      ? "camera.disable"
      : body.enabled === true && !before.enabled
        ? "camera.enable"
        : "camera.update",
    targetType: "camera",
    targetId: cameraId,
    reason: body.reason ?? null,
    before: { name: before.name, streamUrl: before.streamUrl, enabled: before.enabled },
    after: after && { name: after.name, streamUrl: after.streamUrl, enabled: after.enabled },
  });

  publish({ type: "camera", data: { cameraId } });
  res.json(after);
});

/**
 * Everything that has happened on this feed.
 *
 * The queue is ranked for triage across the whole post; this is the same
 * records asked a different question, which is why it is a separate route
 * rather than a filter somebody has to remember to set.
 */
cameraRoutes.get("/api/cameras/:cameraId/incidents", (req, res) => {
  const cameraId = req.params.cameraId;
  requireCamera(cameraId);

  const params = query<"status" | "limit">(req);
  res.json({
    camera: cameraDetail(cameraId),
    incidents: listIncidents(DEFAULT_ORG, {
      cameraId,
      status: params.status,
      limit: num(params.limit, 100),
    }),
    recentEvents: queryEvents(DEFAULT_ORG, { cameraId, limit: 50 }),
  });
});
