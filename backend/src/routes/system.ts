import { Router } from "express";
import { all, one } from "../db";
import { DEFAULT_ORG, DEFAULT_SITE } from "../db/seed";
import { nowIso } from "../core/ids";
import { debugMode, mediaConfig } from "../core/env";
import { SEVERITY_RANK, type Role, type Severity } from "../core/types";
import { liveTrackCount } from "../l2/fence";
import { listZones, zonesForCamera } from "../l3/zones";
import { recordAction } from "../l3/audit";
import { resetOperationalData, resetPreview } from "../l3/reset";
import { getSettings } from "../l3/settings";
import { publish, streamTo, subscriberCount } from "../l4/bus";
import { BadRequest } from "../l4/hooks";
import { actorOf, NotFound, readJson, requireRole } from "../http";
import * as sim from "../sim/simulator";

/** POST /api/admin/reset */
export interface ResetBody {
  confirm?: string;
  reason?: string;
}

/**
 * The node describing itself: is it up, what is it configured with, and the
 * live stream that carries everything else as it happens.
 */

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  at: string;
  liveTracks: number;
  streamSubscribers: number;
  simulator: ReturnType<typeof sim.status>;
}

export const systemRoutes = Router();

systemRoutes.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    at: nowIso(),
    liveTracks: liveTrackCount(),
    streamSubscribers: subscriberCount(),
    simulator: sim.status(),
  } satisfies HealthResponse);
});

/** Live push: events, incidents and decisions as they happen. */
systemRoutes.get("/api/stream", (req, res) => {
  streamTo(req, res);
});

systemRoutes.get("/api/config", (_req, res) => {
  const site = one<any>("SELECT * FROM site WHERE id = $id", { $id: DEFAULT_SITE });
  const cameras = all<any>("SELECT * FROM camera WHERE site_id = $site ORDER BY name", {
    $site: DEFAULT_SITE,
  });
  res.json({
    org: one<any>("SELECT * FROM organisation WHERE id = $id", { $id: DEFAULT_ORG }),
    site,
    users: all<{ id: string; name: string; role: Role }>(
      "SELECT id, name, role FROM app_user WHERE org_id = $org",
      { $org: DEFAULT_ORG },
    ),
    // Where the console gets video and live boxes. Addresses only -- a real
    // camera's RTSP credentials stay in media/cameras.yml on the hub machine
    // and never enter this database or this response.
    media: mediaConfig(),
    // Behaviour the console has to be able to explain. The grouping window
    // is why two crossings appear as one incident, so it travels with the
    // rest of the deployment's shape rather than being a number only the
    // settings page knows how to ask for.
    settings: getSettings(DEFAULT_ORG),
    // A camera reaches its zones through the binding table now, and each
    // one arrives already resolved -- this camera's shape, and the target
    // list after any camera override.
    cameras: cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      status: camera.status,
      // The hub path for this camera's video. Identical to its id on
      // purpose: whether that path is fed by a looping clip or a camera on
      // a wall is invisible from here, which is what makes the swap a
      // config change rather than a code change.
      streamPath: camera.id,
      zones: zonesForCamera(camera.id).map((zone) => ({
        id: zone.id,
        bindingId: zone.bindingId,
        cameraId: zone.camera_id,
        name: zone.name,
        kind: zone.kind,
        geometry: zone.geometry,
        points: zone.points,
        direction: zone.direction,
        confirmSeconds: zone.confirm_seconds,
        // True when nobody has drawn this shape against this camera's view:
        // it is the stock placeholder, and the node records crossings of it
        // without ever alerting. The vision service carries this through to
        // the event as a FACT and never acts on it -- severity is the node's
        // job (ibvap/CLAUDE.md sections 1 and 14). `provisional === !placed`;
        // `placed` is the console's word for the same bit.
        provisional: !zone.placed,
        targets: zone.targets,
        // Derived from the targets, for the map tooltips and status board
        // that only ever want "what is alerted on here, and how loudly".
        // Kept as views so there is still one source of truth.
        watchClasses: zone.targets.filter((t) => t.action === "alert").map((t) => t.class),
        logOnlyClasses: zone.targets.filter((t) => t.action === "log_only").map((t) => t.class),
        severity: zone.targets
          .filter((t) => t.action === "alert")
          .reduce<Severity>(
            (worst, t) => (SEVERITY_RANK[t.severity] > SEVERITY_RANK[worst] ? t.severity : worst),
            "INFO",
          ),
        active: zone.active,
      })),
    })),
    zones: listZones(DEFAULT_SITE),
  });
});

/**
 * Empty the operational record. Developer boxes only.
 *
 * THREE LOCKS, and each one is doing different work:
 *
 *   1. `IBVAP_DEBUG` must be on. Off is what a deployment gets by saying
 *      nothing, so this route does not exist on a post at all -- not
 *      disabled, not permission-denied, absent. A capability that can only
 *      be reached by editing a file on the machine is not a capability an
 *      operator can be socially engineered into using.
 *   2. Shift supervisor or admin. The same bar as creating a zone.
 *   3. The caller must type the confirmation word. A destructive action one
 *      click deep is a destructive action somebody takes by accident.
 *
 * GET reports what a reset would remove, so the console can say "1,284
 * events" on the button rather than asking for a leap of faith.
 *
 * The audit row is written BEFORE the delete, on purpose: a crash in between
 * must leave a console that has forgotten everything with a record saying
 * why, not a silent gap that is indistinguishable from tampering. The audit
 * log itself is never cleared -- see `l3/reset.ts`.
 */
systemRoutes.get("/api/admin/reset", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");
  if (!debugMode()) throw new NotFound("not a developer node");
  res.json({ debug: true, counts: resetPreview() });
});

systemRoutes.post("/api/admin/reset", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");
  if (!debugMode()) throw new NotFound("not a developer node");

  const body = readJson<ResetBody>(req);
  if (body.confirm !== "RESET") {
    throw new BadRequest('confirm must be the word "RESET"');
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) throw new BadRequest("say why, in a few words");

  const counts = resetPreview();
  recordAction({
    actor,
    orgId: DEFAULT_ORG,
    verb: "admin.reset",
    targetType: "site",
    targetId: DEFAULT_SITE,
    reason,
    detail: counts,
    before: counts,
    after: { events: 0, incidents: 0, alerts: 0, trackedThings: 0, plateDetections: 0 },
  });

  const removed = resetOperationalData();

  // Every open console is showing rows that no longer exist. Told to
  // refetch rather than left to discover it by clicking something gone.
  publish({ type: "incident", data: { reset: true } as any });
  publish({ type: "event", data: { reset: true } as any });

  res.json({ ok: true, removed });
});
