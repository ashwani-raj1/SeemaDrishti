import { Router } from "express";
import { DEFAULT_ORG } from "../db/seed";
import {
  crossReference,
  eventThumbnail,
  getIncident,
  incidentCamera,
  listIncidents,
  queryEvents,
  type EventQuery,
} from "../l3/events";
import { actionsFor, queryActions, recordAction, verifyChain } from "../l3/audit";
import { publish } from "../l4/bus";
import { BadRequest } from "../l4/hooks";
import { actorOf, NotFound, num, query, readJson, requireRole, type Query } from "../http";

/**
 * Incidents, the events under them, and the record of who did what about
 * them. Reading is open to any operator; looking backwards through history
 * is a supervisor's job and is itself recorded.
 */

export type Decision = "acknowledge" | "escalate" | "dismiss";
const DECISIONS: Decision[] = ["acknowledge", "escalate", "dismiss"];

/** POST /api/incidents/:incidentId/decision */
export interface DecisionBody {
  decision?: Decision;
  reason?: string | null;
}

type EventFilterKey =
  | "camera_id" | "zone_id" | "incident_id" | "severity" | "class" | "kind" | "alertable"
  | "suppressed_reason" | "simulated" | "since" | "until" | "limit";

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
function eventQuery(params: Query<EventFilterKey>): EventQuery {
  const tri = (key: EventFilterKey) =>
    params[key] !== undefined ? params[key] === "true" : undefined;

  return {
    cameraId: params.camera_id,
    zoneId: params.zone_id,
    incidentId: params.incident_id,
    severity: params.severity as EventQuery["severity"],
    class: params.class,
    kind: params.kind,
    alertable: tri("alertable"),
    suppressedReason: params.suppressed_reason,
    simulated: tri("simulated"),
    since: params.since,
    until: params.until,
    limit: num(params.limit, 200),
  };
}

export const incidentRoutes = Router();

// ---------------------------------------------------------------- incidents

incidentRoutes.get("/api/incidents", (req, res) => {
  const params = query<
    "status" | "camera_id" | "zone_id" | "kind" | "severity" | "class" | "since" | "until"
    | "limit"
  >(req);
  res.json(
    listIncidents(DEFAULT_ORG, {
      status: params.status,
      cameraId: params.camera_id,
      zoneId: params.zone_id,
      // The queue's own filters. Named to match `/api/events` where they
      // mean the same thing, so an operator moving between the two screens
      // does not have to learn two vocabularies for one question.
      kind: params.kind,
      severity: params.severity,
      class: params.class,
      since: params.since,
      until: params.until,
      limit: num(params.limit, 100),
    }),
  );
});

incidentRoutes.get("/api/incidents/:incidentId", (req, res) => {
  const incidentId = req.params.incidentId;
  const incident = getIncident(incidentId);
  if (!incident) throw new NotFound(`no incident ${incidentId}`);
  res.json({
    incident,
    events: queryEvents(DEFAULT_ORG, { incidentId, limit: 500 }),
    // The camera this came from, as its own field. `crossReference` below
    // knows the camera only through the zone, and bails entirely when an
    // incident has no zone -- which is exactly the case for a camera that
    // went dark. Those incidents used to carry no camera information at all.
    camera: incidentCamera(incidentId),
    // The full chain of accountability for this piece of work.
    actions: actionsFor("incident", incidentId),
    // What else watches this zone, and what it saw around the same time.
    crossReference: crossReference(incidentId),
  });
});

incidentRoutes.post("/api/incidents/:incidentId/decision", (req, res) => {
  const actor = actorOf(req);
  const incidentId = req.params.incidentId;
  if (!getIncident(incidentId)) throw new NotFound(`no incident ${incidentId}`);

  const body = readJson<DecisionBody>(req);
  const decision = body.decision;
  if (!decision || !DECISIONS.includes(decision)) {
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
  res.json(updated);
});

// ---------------------------------------------------------------- events and history

incidentRoutes.get("/api/events", (req, res) => {
  const params = query<EventFilterKey | "after_seq">(req);
  const q: EventQuery = {
    ...eventQuery(params),
    // Replay for a reconnecting peer; history has no use for it.
    afterSeq: num(params.after_seq),
  };
  res.json(queryEvents(DEFAULT_ORG, q));
});

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
incidentRoutes.get("/api/events/:eventId/thumbnail", (req, res) => {
  const encoded = eventThumbnail(req.params.eventId);
  if (!encoded) throw new NotFound("no thumbnail for this event");

  // The event log is append-only and an id is never reused, so this bytes
  // stream can never change. Cached hard, which is what makes a list of
  // fifty thumbnails cost fifty requests once rather than on every render.
  res
    .type("image/jpeg")
    .set("cache-control", "public, max-age=31536000, immutable")
    .send(Buffer.from(encoded, "base64"));
});

/**
 * Looking backwards through the record. Supervisors only -- and every search
 * is itself recorded as a decision, so "who went looking, and for what" is
 * as answerable as "who dismissed this alarm".
 */
incidentRoutes.get("/api/history", (req, res) => {
  const actor = actorOf(req);
  requireRole(actor, "supervisor", "admin");

  const params = query<EventFilterKey | "reason">(req);
  const q: EventQuery = eventQuery(params);

  const results = queryEvents(DEFAULT_ORG, q);

  recordAction({
    actor,
    orgId: DEFAULT_ORG,
    verb: "history.search",
    targetType: "search",
    targetId: null,
    reason: params.reason ?? null,
    detail: { query: q, resultCount: results.length },
  });

  res.json({ query: q, results });
});

// ---------------------------------------------------------------- audit

incidentRoutes.get("/api/audit", (req, res) => {
  const params = query<
    "actor_id" | "verb" | "target_type" | "target_id" | "since" | "until" | "limit"
  >(req);
  res.json(
    queryActions(DEFAULT_ORG, {
      actorId: params.actor_id,
      verb: params.verb,
      targetType: params.target_type,
      targetId: params.target_id,
      since: params.since,
      until: params.until,
      limit: num(params.limit, 200),
    }),
  );
});

/** Recompute the hash chain from the beginning and report the first break. */
incidentRoutes.get("/api/audit/verify", (_req, res) => {
  res.json(verifyChain());
});
