import { all, one, run } from "./db";
import { seed, DEFAULT_ORG, DEFAULT_SITE } from "./db/seed";
import { id, nowIso } from "./core/ids";
import type { Actor, Role } from "./core/types";
import { validateZonePoints } from "./l2/geometry";
import { forgetZone, hydrateZone, liveTrackCount } from "./l2/fence";
import {
  getIncident,
  listIncidents,
  queryEvents,
  shapeEvent,
  type EventQuery,
} from "./l3/events";
import { actionsFor, queryActions, recordAction, ReasonRequired, verifyChain } from "./l3/audit";
import { streamResponse, subscriberCount, publish } from "./l4/bus";
import {
  BadRequest,
  ingestDetections,
  ingestSensorContact,
  parseDetectionFrame,
  parseSensorContact,
} from "./l4/hooks";
import * as sim from "./sim/simulator";

seed();

const PORT = Number(process.env.PORT ?? 8000);

// ------------------------------------------------------------------ plumbing

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-ibvap-actor",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

const fail = (message: string, status = 400) => json({ error: message }, status);

class Forbidden extends Error {}
class NotFound extends Error {}

/**
 * Who is acting. Every mutating route needs this, because an unattributed
 * change is exactly what the audit log exists to make impossible.
 *
 * Real logins are a later job; today the caller names itself and the name is
 * recorded. What matters for this slice is that no write path is anonymous.
 */
function actorOf(req: Request): Actor {
  const wanted = req.headers.get("x-ibvap-actor") ?? "usr_operator";
  const row = one<{ id: string; name: string; role: Role }>(
    "SELECT id, name, role FROM app_user WHERE id = $id",
    { $id: wanted },
  );
  if (!row) throw new Forbidden(`unknown actor ${wanted}`);
  return row;
}

function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw new Forbidden(`${actor.role} may not do this; requires ${roles.join(" or ")}`);
  }
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") throw new Error();
    return body as Record<string, any>;
  } catch {
    throw new BadRequest("expected a JSON object body");
  }
}

/** One place that turns a thrown error into the right status code. */
function handled(fn: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (error) {
      if (error instanceof ReasonRequired) return fail(error.message, 422);
      if (error instanceof BadRequest) return fail(error.message, 400);
      if (error instanceof Forbidden) return fail(error.message, 403);
      if (error instanceof NotFound) return fail(error.message, 404);
      console.error(error);
      return fail((error as Error).message ?? "internal error", 500);
    }
  };
}

const query = (req: Request) => new URL(req.url).searchParams;

// ------------------------------------------------------------------ zones

const zoneRow = (zoneId: string) => {
  const row = one<any>("SELECT * FROM zone WHERE id = $id", { $id: zoneId });
  if (!row) throw new NotFound(`no zone ${zoneId}`);
  return row;
};

/** The shape stored in the audit log's before/after, and returned to the screen. */
const zoneView = (row: any) => ({
  id: row.id,
  cameraId: row.camera_id,
  name: row.name,
  kind: row.kind,
  geometry: row.geometry,
  points: JSON.parse(row.points),
  watchClasses: JSON.parse(row.watch_classes),
  logOnlyClasses: JSON.parse(row.log_only_classes),
  direction: row.direction,
  confirmSeconds: row.confirm_seconds,
  severity: row.severity,
  active: row.active === 1,
  updatedAt: row.updated_at,
});

const ZONE_KINDS = ["fence_line", "gate", "waterline", "perimeter", "pass", "restricted_area"];
const SEVERITIES = ["INFO", "WARNING", "CRITICAL"];
const DIRECTIONS = ["inbound", "outbound", "both"];

function validateZoneFields(fields: Record<string, any>): void {
  if (fields.kind !== undefined && !ZONE_KINDS.includes(fields.kind)) {
    throw new BadRequest(`kind must be one of ${ZONE_KINDS.join(", ")}`);
  }
  if (fields.geometry !== undefined && !["line", "polygon"].includes(fields.geometry)) {
    throw new BadRequest("geometry must be line or polygon");
  }
  if (fields.severity !== undefined && !SEVERITIES.includes(fields.severity)) {
    throw new BadRequest(`severity must be one of ${SEVERITIES.join(", ")}`);
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
      users: all<any>("SELECT id, name, role FROM app_user WHERE org_id = $org", { $org: DEFAULT_ORG }),
      cameras: cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        status: camera.status,
        zones: all<any>("SELECT * FROM zone WHERE camera_id = $camera AND active = 1", {
          $camera: camera.id,
        }).map(zoneView),
      })),
    });
  }),

  // ---------------------------------------------------------------- zones

  "/api/zones": {
    GET: handled(async (req) => {
      const cameraId = query(req).get("camera_id");
      const rows = cameraId
        ? all<any>("SELECT * FROM zone WHERE camera_id = $camera AND active = 1", { $camera: cameraId })
        : all<any>("SELECT * FROM zone WHERE active = 1");
      return json(rows.map(zoneView));
    }),

    POST: handled(async (req) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const body = await readJson(req);
      validateZoneFields(body);

      const cameraId = body.cameraId;
      if (!one("SELECT id FROM camera WHERE id = $id", { $id: cameraId })) {
        throw new NotFound(`no camera ${cameraId}`);
      }

      const geometry = body.geometry ?? "line";
      const problem = validateZonePoints(geometry, body.points);
      if (problem) throw new BadRequest(problem);

      const zoneId = id("zone");
      const at = nowIso();
      run(
        `INSERT INTO zone
           (id, camera_id, org_id, name, kind, geometry, points, watch_classes, log_only_classes,
            direction, confirm_seconds, severity, active, created_at, updated_at)
         VALUES
           ($id, $camera, $org, $name, $kind, $geometry, $points, $watch, $logOnly,
            $direction, $confirm, $severity, 1, $at, $at)`,
        {
          $id: zoneId,
          $camera: cameraId,
          $org: DEFAULT_ORG,
          $name: body.name ?? "Untitled zone",
          $kind: body.kind ?? "fence_line",
          $geometry: geometry,
          $points: JSON.stringify(body.points),
          $watch: JSON.stringify(body.watchClasses ?? ["person", "vehicle"]),
          $logOnly: JSON.stringify(body.logOnlyClasses ?? ["cattle", "dog", "nilgai"]),
          $direction: body.direction ?? "both",
          $confirm: body.confirmSeconds ?? 2,
          $severity: body.severity ?? "WARNING",
          $at: at,
        },
      );

      const created = zoneView(zoneRow(zoneId));
      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.create",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        after: created,
      });

      return json(created, 201);
    }),
  },

  "/api/zones/:zoneId": {
    PATCH: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = zoneView(zoneRow(zoneId));
      const body = await readJson(req);
      validateZoneFields(body);

      const geometry = body.geometry ?? before.geometry;
      const points = body.points ?? before.points;
      const problem = validateZonePoints(geometry, points);
      if (problem) throw new BadRequest(problem);

      run(
        `UPDATE zone SET
           name = $name, kind = $kind, geometry = $geometry, points = $points,
           watch_classes = $watch, log_only_classes = $logOnly, direction = $direction,
           confirm_seconds = $confirm, severity = $severity, updated_at = $at
         WHERE id = $id`,
        {
          $id: zoneId,
          $name: body.name ?? before.name,
          $kind: body.kind ?? before.kind,
          $geometry: geometry,
          $points: JSON.stringify(points),
          $watch: JSON.stringify(body.watchClasses ?? before.watchClasses),
          $logOnly: JSON.stringify(body.logOnlyClasses ?? before.logOnlyClasses),
          $direction: body.direction ?? before.direction,
          $confirm: body.confirmSeconds ?? before.confirmSeconds,
          $severity: body.severity ?? before.severity,
          $at: nowIso(),
        },
      );

      // A track holding a pending crossing against the old shape would confirm
      // against geometry that no longer exists.
      forgetZone(zoneId);

      const after = zoneView(zoneRow(zoneId));
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

      publish({ type: "camera", data: { cameraId: after.cameraId, zoneChanged: zoneId } });
      return json(after);
    }),

    DELETE: handled(async (req: any) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const zoneId = req.params.zoneId;
      const before = zoneView(zoneRow(zoneId));
      const body = await readJson(req).catch(() => ({}) as Record<string, any>);

      // Deactivated, not deleted -- past events still point at it.
      run("UPDATE zone SET active = 0, updated_at = $at WHERE id = $id", {
        $id: zoneId,
        $at: nowIso(),
      });
      forgetZone(zoneId);

      recordAction({
        actor,
        orgId: DEFAULT_ORG,
        verb: "zone.delete",
        targetType: "zone",
        targetId: zoneId,
        reason: body.reason ?? null,
        before,
        after: { ...before, active: false },
      });

      publish({ type: "camera", data: { cameraId: before.cameraId, zoneChanged: zoneId } });
      return json({ ok: true });
    }),
  },

  // ---------------------------------------------------------------- incidents

  "/api/incidents": handled(async (req) => {
    const params = query(req);
    return json(
      listIncidents(DEFAULT_ORG, {
        status: params.get("status") ?? undefined,
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
      cameraId: params.get("camera_id") ?? undefined,
      zoneId: params.get("zone_id") ?? undefined,
      severity: (params.get("severity") as EventQuery["severity"]) ?? undefined,
      class: params.get("class") ?? undefined,
      alertableOnly: params.get("alertable") === "true",
      since: params.get("since") ?? undefined,
      until: params.get("until") ?? undefined,
      afterSeq: params.has("after_seq") ? Number(params.get("after_seq")) : undefined,
      limit: Number(params.get("limit") ?? 200),
    };
    return json(queryEvents(DEFAULT_ORG, q));
  }),

  /**
   * Looking backwards through the record. Supervisors only -- and every search
   * is itself recorded as a decision, so "who went looking, and for what" is
   * as answerable as "who dismissed this alarm".
   */
  "/api/history": handled(async (req) => {
    const actor = actorOf(req);
    requireRole(actor, "supervisor", "admin");

    const params = query(req);
    const q: EventQuery = {
      cameraId: params.get("camera_id") ?? undefined,
      zoneId: params.get("zone_id") ?? undefined,
      severity: (params.get("severity") as EventQuery["severity"]) ?? undefined,
      class: params.get("class") ?? undefined,
      since: params.get("since") ?? undefined,
      until: params.get("until") ?? undefined,
      limit: Number(params.get("limit") ?? 200),
    };

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

  "/hooks/ingress/detections": {
    POST: handled(async (req) => {
      const frame = parseDetectionFrame(await readJson(req));
      return json(ingestDetections(frame), 202);
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
  routes: routes as any,
  fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return fail("not found", 404);
  },
  error(error) {
    console.error(error);
    return fail(error.message, 500);
  },
});

console.log(`IBVAP edge node on ${server.url}`);
console.log(`  detections  POST ${server.url}hooks/ingress/detections`);
console.log(`  live stream  GET ${server.url}api/stream`);

export { server, routes };
