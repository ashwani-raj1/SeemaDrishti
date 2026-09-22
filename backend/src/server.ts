import { all, one } from "./db";
import { seed, DEFAULT_ORG, DEFAULT_SITE } from "./db/seed";
import { detachments } from "./db/migrate";
import { nowIso } from "./core/ids";
import { SEVERITY_RANK, type Severity } from "./core/types";
import { liveTrackCount } from "./l2/fence";
import { listZones, zonesForCamera } from "./l3/zones";
import { withLogging, logFallback, logFormat } from "./core/logger";
import { zoneRoutes } from "./routes/zones";
import { debugMode, mediaConfig } from "./core/env";
import { cameraRoutes } from "./routes/cameras";
import { watchlistRoutes } from "./routes/watchlist";
import { mediaRoutes } from "./routes/media";
import { clipRoutes } from "./routes/clips";
import { settingsRoutes } from "./routes/settings";
import {
  crossReference,
  eventThumbnail,
  getIncident,
  listIncidents,
  queryEvents,
  shapeEvent,
  type EventQuery,
} from "./l3/events";
import { actionsFor, queryActions, recordAction, verifyChain } from "./l3/audit";
import { resetOperationalData, resetPreview } from "./l3/reset";
import { getSettings } from "./l3/settings";
import { streamResponse, subscriberCount, publish } from "./l4/bus";
import {
  BadRequest,
  ingestDetections,
  ingestSensorContact,
  parseDetectionFrame,
  parseSensorContact,
} from "./l4/hooks";
import { ingestVisionEvent, parseVisionEvent } from "./l4/vision";
import {
  actorOf, CORS, fail, handled, json, NotFound, query, readJson, requireRole,
} from "./http";
import * as sim from "./sim/simulator";

seed();

// A schema migration can change what is being watched -- the one-zone-per-camera
// rule retires duplicate bindings. That belongs in the hash chain like any other
// change to coverage, and it cannot be written from inside migrate.ts, because
// l3/audit.ts imports ../db and the migration runs while that module is still
// being constructed. So it is recorded here, at the first moment it can be.
for (const detached of detachments) {
  recordAction({
    actor: { id: "system", name: "schema migration", role: "admin" },
    orgId: DEFAULT_ORG,
    verb: "zone.camera.detach",
    targetType: "zone",
    targetId: detached.zoneId,
    reason: "one camera belongs to one zone",
    detail: { cameraId: detached.cameraId, bindingId: detached.bindingId },
  });
}

const PORT = Number(process.env.PORT ?? 8000);

/**
 * The filters `/api/events` and `/api/history` share.
 *
 * One parser, two doors, on purpose: history is the audited door and must
 * never be the weaker of the two. A filter that works on one and not the other
 * sends an operator to the unaudited one to get their answer.
 *
 * `alertable` is tri-state -- absent means both. After the provisional-zone
 * work the interesting query is `alertable=false`, i.e. what did we record and
 * deliberately not shout about.
 */
function eventQuery(params: URLSearchParams): EventQuery {
  const tri = (key: string) =>
    params.has(key) ? params.get(key) === "true" : undefined;

  return {
    cameraId: params.get("camera_id") ?? undefined,
    zoneId: params.get("zone_id") ?? undefined,
    incidentId: params.get("incident_id") ?? undefined,
    severity: (params.get("severity") as EventQuery["severity"]) ?? undefined,
    class: params.get("class") ?? undefined,
    kind: params.get("kind") ?? undefined,
    alertable: tri("alertable"),
    suppressedReason: params.get("suppressed_reason") ?? undefined,
    simulated: tri("simulated"),
    since: params.get("since") ?? undefined,
    until: params.get("until") ?? undefined,
    limit: Number(params.get("limit") ?? 200),
  };
}

// ------------------------------------------------------------------ routes

const routes = {
  "/api/health": handled(async () =>
    json({
      ok: true,
      at: nowIso(),
      liveTracks: liveTrackCount(),
      streamSubscribers: subscriberCount(),
      simulator: sim.status(),
    }),
  ),

  /** Live push: events, incidents and decisions as they happen. */
  "/api/stream": handled(async () => streamResponse()),

  "/api/config": handled(async () => {
    const site = one<any>("SELECT * FROM site WHERE id = $id", { $id: DEFAULT_SITE });
    const cameras = all<any>("SELECT * FROM camera WHERE site_id = $site ORDER BY name", {
      $site: DEFAULT_SITE,
    });
    return json({
      org: one<any>("SELECT * FROM organisation WHERE id = $id", { $id: DEFAULT_ORG }),
      site,
      users: all<any>("SELECT id, name, role FROM app_user WHERE org_id = $org", {
        $org: DEFAULT_ORG,
      }),
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
  }),

  ...zoneRoutes,
  ...clipRoutes,
  ...cameraRoutes,
  ...watchlistRoutes,
  ...mediaRoutes,
  ...settingsRoutes,

  // ---------------------------------------------------------------- incidents

  "/api/incidents": handled(async (req) => {
    const params = query(req);
    return json(
      listIncidents(DEFAULT_ORG, {
        status: params.get("status") ?? undefined,
        cameraId: params.get("camera_id") ?? undefined,
        zoneId: params.get("zone_id") ?? undefined,
        // The queue's own filters. Named to match `/api/events` where they
        // mean the same thing, so an operator moving between the two screens
        // does not have to learn two vocabularies for one question.
        kind: params.get("kind") ?? undefined,
        severity: params.get("severity") ?? undefined,
        class: params.get("class") ?? undefined,
        since: params.get("since") ?? undefined,
        until: params.get("until") ?? undefined,
        limit: Number(params.get("limit") ?? 100),
      }),
    );
  }),

  "/api/incidents/:incidentId": handled(async (req: any) => {
    const incidentId = req.params.incidentId;
    const incident = getIncident(incidentId);
    if (!incident) throw new NotFound(`no incident ${incidentId}`);
    return json({
      incident,
      events: queryEvents(DEFAULT_ORG, { incidentId, limit: 500 }),
      // The full chain of accountability for this piece of work.
      actions: actionsFor("incident", incidentId),
      // What else watches this zone, and what it saw around the same time.
      crossReference: crossReference(incidentId),
    });
  }),

  "/api/incidents/:incidentId/decision": {
    POST: handled(async (req: any) => {
      const actor = actorOf(req);
      const incidentId = req.params.incidentId;
      if (!getIncident(incidentId)) throw new NotFound(`no incident ${incidentId}`);

      const body = await readJson(req);
      const decision = body.decision;
      if (!["acknowledge", "escalate", "dismiss"].includes(decision)) {
        throw new BadRequest("decision must be acknowledge, escalate or dismiss");
      }

      // Recording the decision IS the state change -- there is no status
      // column to update, so this cannot be done without an audit row.
      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: `incident.${decision}`,
        targetType: "incident",
        targetId: incidentId,
        reason: body.reason ?? null,
        detail: { via: "operator_screen" },
      });

      const updated = getIncident(incidentId);
      publish({ type: "incident", data: updated });
      return json(updated);
    }),
  },

  // ---------------------------------------------------------------- events and history

  "/api/events": handled(async (req) => {
    const params = query(req);
    const q: EventQuery = {
      ...eventQuery(params),
      // Replay for a reconnecting peer; history has no use for it.
      afterSeq: params.has("after_seq") ? Number(params.get("after_seq")) : undefined,
    };
    return json(queryEvents(DEFAULT_ORG, q));
  }),

  /**
   * The frame one event was judged on.
   *
   * Served as an image rather than inside the JSON so the browser can cache it,
   * render it with a plain `<img src>`, and fetch only the ones actually on
   * screen. The list endpoint carries `hasThumbnail` and nothing heavier.
   *
   * 404 rather than a placeholder when there is no picture. A missing thumbnail
   * is a real and common state -- the simulator posts none, a lost-track event
   * has no frame to cut -- and the console draws the geometry instead. Shipping
   * a grey rectangle here would make "no picture was taken" indistinguishable
   * from "the picture failed to load".
   */
  "/api/events/:eventId/thumbnail": handled(async (req: any) => {
    const encoded = eventThumbnail(req.params.eventId);
    if (!encoded) throw new NotFound("no thumbnail for this event");

    // The event log is append-only and an id is never reused, so this bytes
    // stream can never change. Cached hard, which is what makes a list of
    // fifty thumbnails cost fifty requests once rather than on every render.
    return new Response(Buffer.from(encoded, "base64"), {
      headers: {
        ...CORS,
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }),

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
  "/api/admin/reset": {
    GET: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");
      if (!debugMode()) throw new NotFound("not a developer node");
      return json({ debug: true, counts: resetPreview() });
    }),

    POST: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");
      if (!debugMode()) throw new NotFound("not a developer node");

      const body = await readJson(req);
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

      return json({ ok: true, removed });
    }),
  },

  /**
   * Looking backwards through the record. Supervisors only -- and every search
   * is itself recorded as a decision, so "who went looking, and for what" is
   * as answerable as "who dismissed this alarm".
   */
  "/api/history": handled(async (req) => {
    const actor = actorOf(req);
    requireRole(actor, "supervisor", "admin");

    const params = query(req);
    const q: EventQuery = eventQuery(params);

    const results = queryEvents(DEFAULT_ORG, q);

    recordAction({
      actor,
      orgId: DEFAULT_ORG,
      verb: "history.search",
      targetType: "search",
      targetId: null,
      reason: params.get("reason"),
      detail: { query: q, resultCount: results.length },
    });

    return json({ query: q, results });
  }),

  // ---------------------------------------------------------------- audit

  "/api/audit": handled(async (req) => {
    const params = query(req);
    return json(
      queryActions(DEFAULT_ORG, {
        actorId: params.get("actor_id") ?? undefined,
        verb: params.get("verb") ?? undefined,
        targetType: params.get("target_type") ?? undefined,
        targetId: params.get("target_id") ?? undefined,
        since: params.get("since") ?? undefined,
        until: params.get("until") ?? undefined,
        limit: Number(params.get("limit") ?? 200),
      }),
    );
  }),

  /** Recompute the hash chain from the beginning and report the first break. */
  "/api/audit/verify": handled(async () => json(verifyChain())),

  // ---------------------------------------------------------------- ingress

  /**
   * Raw per-frame detections, judged here by the fence (l2/fence.ts).
   * The simulator posts through this door.
   */
  "/hooks/ingress/detections": {
    POST: handled(async (req) => {
      const frame = parseDetectionFrame(await readJson(req));
      return json(ingestDetections(frame), 202);
    }),
  },

  /**
   * Already-confirmed events from the vision service, which runs fence
   * geometry and plate OCR itself. It sends a FACT ("person crossed zone_3
   * inbound, held 1.4s"); this node applies the POLICY (severity, whether a
   * human is woken), because that policy lives in operator-editable zone
   * targets and is audited here. See l4/vision.ts for why that line is drawn
   * where it is.
   */
  "/hooks/ingress/events": {
    POST: handled(async (req) => {
      const event = parseVisionEvent(await readJson(req));
      return json(ingestVisionEvent(event), 202);
    }),
  },

  "/hooks/ingress/sensor": {
    POST: handled(async (req) => {
      const contact = parseSensorContact(await readJson(req));
      const event = ingestSensorContact(contact);
      return json(shapeEvent(event), 202);
    }),
  },

  // ---------------------------------------------------------------- simulator

  "/api/sim": handled(async () => json(sim.status())),

  "/api/sim/start": {
    POST: handled(async (req) => {
      const body = await readJson(req).catch(() => ({}) as Record<string, any>);
      sim.start(body.ambient !== false);
      return json(sim.status());
    }),
  },

  "/api/sim/stop": {
    POST: handled(async () => {
      sim.stop();
      return json(sim.status());
    }),
  },

  "/api/sim/scenario": {
    POST: handled(async (req) => {
      const body = await readJson(req);
      const name = body.name as sim.ScenarioName;
      if (!sim.status().scenarios.includes(name)) {
        throw new BadRequest(`unknown scenario ${name}`);
      }
      return json({ spawned: sim.runScenario(name), status: sim.status() });
    }),
  },
} as const;

const server = Bun.serve({
  port: PORT,
  // The live stream is a long-lived response. Bun closes an idle request after
  // ten seconds by default, which silently tore the operator's stream down and
  // made the screen flicker between "live" and "no link" all shift.
  idleTimeout: 0,
  // Wrapped once, over the whole table: a logger you have to remember
  // to add at each route is a logger missing from the route you most need.
  routes: withLogging(routes) as any,
  // Logged too: an unmatched path is the symptom when a console or a worker
  // is pointed at the wrong URL, and that is precisely when a silent 404 costs
  // an hour.
  fetch: logFallback((req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return fail("not found", 404);
  }),
  error(error) {
    console.error(error);
    return fail(error.message, 500);
  },
});

console.log(`IBVAP edge node on ${server.url}`);
console.log(`  request log  ${logFormat} (IBVAP_LOG=dev|combined|off)`);
console.log(`  detections  POST ${server.url}hooks/ingress/detections`);
console.log(`  vision      POST ${server.url}hooks/ingress/events`);
console.log(`  live stream  GET ${server.url}api/stream`);

export { server, routes };
