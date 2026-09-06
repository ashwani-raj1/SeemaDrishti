import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import { recordAction } from "../l3/audit";
import { cameraDetail, listCameras, updateCamera } from "../l3/cameras";
import { listIncidents, queryEvents } from "../l3/events";
import { publish } from "../l4/bus";
import { BadRequest } from "../l4/hooks";
import { actorOf, handled, json, NotFound, query, readJson, requireRole } from "../http";

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

export const cameraRoutes = {
  "/api/cameras": handled(async () => json(listCameras(DEFAULT_SITE))),

  "/api/cameras/:cameraId": {
    GET: handled(async (req: any) => json(requireCamera(req.params.cameraId))),

    PATCH: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const cameraId = req.params.cameraId;
      const before = requireCamera(cameraId);
      const body = await readJson(req);

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
      return json(after);
    }),
  },

  /**
   * Everything that has happened on this feed.
   *
   * The queue is ranked for triage across the whole post; this is the same
   * records asked a different question, which is why it is a separate route
   * rather than a filter somebody has to remember to set.
   */
  "/api/cameras/:cameraId/incidents": handled(async (req: any) => {
    const cameraId = req.params.cameraId;
    requireCamera(cameraId);

    const params = query(req);
    return json({
      camera: cameraDetail(cameraId),
      incidents: listIncidents(DEFAULT_ORG, {
        cameraId,
        status: params.get("status") ?? undefined,
        limit: Number(params.get("limit") ?? 100),
      }),
      recentEvents: queryEvents(DEFAULT_ORG, { cameraId, limit: 50 }),
    });
  }),
} as const;
