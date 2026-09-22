import { all, db, one, run } from "../db";
import { id, nowIso } from "../core/ids";
import { SEVERITY_RANK, type Severity, type SourceType } from "../core/types";
import { publish } from "../l4/bus";
import { groupingWindowSeconds } from "./settings";

/**
 * L3 -- where a raw finding becomes a record that lasts.
 *
 * An event is the first thing written to disk. The millions of per-frame
 * observations beneath it stay in memory and are thrown away, which is what
 * keeps the database small enough to live at a remote post.
 *
 * Events are also grouped into incidents here, because an operator's unit of
 * work is "someone crossed the fence", not "here are forty detections".
 */

/**
 * How long an incident stays open to new related events.
 *
 * Read per event from the org's settings rather than held as a constant here:
 * the right window is a property of the ground being watched, so a post has to
 * be able to change it without a deploy. `l3/settings.ts` owns the value, its
 * bounds and the audit row every change leaves behind.
 */

export interface EventInput {
  orgId: string;
  siteId: string;
  kind: string;
  sourceType: SourceType;
  sourceId: string;
  simulated: boolean;
  cameraId?: string | null;
  zoneId?: string | null;
  trackedThingId?: string | null;
  class?: string | null;
  direction?: string | null;
  rule?: string | null;
  confidence?: number | null;
  severity: Severity;
  /** false means: write it to the log, never raise it to a human. */
  alertable: boolean;
  /**
   * Base64 JPEG of the subject, cut from the frame this was judged on.
   *
   * Optional everywhere. The simulator sends none, a lost-track event has no
   * current frame to cut, and a picture must never be the reason an intrusion
   * fails to record -- so this is the one field whose absence changes nothing
   * about how the event is treated.
   */
  thumbnail?: string | null;
  suppressedReason?: string | null;
  occurredAt: string;
  evidence?: unknown;
  /** Events sharing this key inside the window join the same incident. */
  groupKey: string;
  title: string;
}

export interface EventRow {
  seq: number;
  id: string;
  org_id: string;
  site_id: string;
  kind: string;
  source_type: string;
  source_id: string;
  simulated: number;
  camera_id: string | null;
  zone_id: string | null;
  tracked_thing_id: string | null;
  class: string | null;
  direction: string | null;
  rule: string | null;
  confidence: number | null;
  severity: Severity;
  alertable: number;
  suppressed_reason: string | null;
  occurred_at: string;
  received_at: string;
  evidence: string;
  incident_id: string | null;
  /**
   * 1 when a thumbnail exists, from `thumbnail IS NOT NULL`.
   *
   * The base64 itself is NEVER selected into a row. A list of fifty events
   * would otherwise carry a megabyte of pictures nobody asked for, over a link
   * section 8 of ibvap/CLAUDE.md promises to keep small. The image is fetched
   * one at a time by `/api/events/:id/thumbnail`, which is also what lets the
   * browser cache it like any other image.
   */
  has_thumbnail: number;
}

/**
 * Every event column except the picture, plus a flag saying there is one.
 *
 * Spelled out rather than `SELECT *` for exactly one reason: `thumbnail` is the
 * first column in this table that is large, and `SELECT *` would have quietly
 * put it into every list response the day it was added.
 */
const EVENT_COLUMNS = `seq, id, org_id, site_id, kind, source_type, source_id, simulated,
   camera_id, zone_id, tracked_thing_id, class, direction, rule, confidence,
   severity, alertable, suppressed_reason, occurred_at, received_at, evidence,
   incident_id, thumbnail IS NOT NULL AS has_thumbnail`;

/**
 * The base64 JPEG for one event, or null.
 *
 * The only place the column is read. Separate from every other read so that
 * "fetch the picture" is always a deliberate act with its own query.
 */
export function eventThumbnail(eventId: string): string | null {
  const row = one<{ thumbnail: string | null }>(
    "SELECT thumbnail FROM event WHERE id = $id",
    { $id: eventId },
  );
  return row?.thumbnail ?? null;
}

/**
 * The open incident this event belongs to, or a new one.
 *
 * Grouping is capped two ways so it cannot swallow a second genuine intrusion:
 * the same group key, and inside a bounded time window. A dismissed incident
 * is never reopened -- a fresh event after a dismissal starts a fresh incident,
 * so an operator's decision cannot be silently undone by later activity.
 */
function attachIncident(input: EventInput): { incidentId: string; opened: boolean } {
  const window = groupingWindowSeconds(input.orgId);
  const cutoff = new Date(Date.parse(input.occurredAt) - window * 1000).toISOString();

  const existing = one<{ id: string; severity: Severity }>(
    `SELECT id, severity FROM incident_state
      WHERE group_key = $key
        AND last_event_at >= $cutoff
        AND status != 'DISMISSED'
      ORDER BY last_event_at DESC
      LIMIT 1`,
    { $key: input.groupKey, $cutoff: cutoff },
  );

  if (existing) {
    const worse = SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity];

    // The headline has to describe the worst thing in the incident, not the
    // first. A rejected flicker can open an incident that a real crossing then
    // joins -- leaving the title saying "logged only" above a CRITICAL badge,
    // which reads as a bug to the one person who has to triage it.
    run(
      worse
        ? `UPDATE incident SET last_event_at = $at, severity = $severity, title = $title WHERE id = $id`
        : `UPDATE incident SET last_event_at = $at WHERE id = $id`,
      worse
        ? { $at: input.occurredAt, $severity: input.severity, $title: input.title, $id: existing.id }
        : { $at: input.occurredAt, $id: existing.id },
    );
    return { incidentId: existing.id, opened: false };
  }

  const incidentId = id("inc");
  run(
    `INSERT INTO incident
       (id, org_id, site_id, camera_id, zone_id, title, severity, group_key, opened_at, last_event_at)
     VALUES
       ($id, $org, $site, $camera, $zone, $title, $severity, $key, $at, $at)`,
    {
      $id: incidentId,
      $org: input.orgId,
      $site: input.siteId,
      $camera: input.cameraId ?? null,
      $zone: input.zoneId ?? null,
      $title: input.title,
      $severity: input.severity,
      $key: input.groupKey,
      $at: input.occurredAt,
    },
  );
  return { incidentId, opened: true };
}

/**
 * Write one event, group it, and raise an alert if it deserves one.
 *
 * Non-alertable events (an animal on the fence line, a rejected flicker) still
 * get an incident and still appear in the log and in history -- they simply
 * never produce an alert. Nothing is hidden; it is only kept off the screen.
 */
export function recordEvent(input: EventInput): EventRow {
  const write = db.transaction((): EventRow => {
    const { incidentId, opened } = attachIncident(input);
    const eventId = id("evt");

    run(
      `INSERT INTO event
         (id, org_id, site_id, kind, source_type, source_id, simulated, camera_id, zone_id,
          tracked_thing_id, class, direction, rule, confidence, severity, alertable,
          suppressed_reason, occurred_at, received_at, evidence, thumbnail, incident_id)
       VALUES
         ($id, $org, $site, $kind, $stype, $sid, $sim, $camera, $zone,
          $track, $class, $direction, $rule, $confidence, $severity, $alertable,
          $suppressed, $occurred, $received, $evidence, $thumbnail, $incident)`,
      {
        $id: eventId,
        $org: input.orgId,
        $site: input.siteId,
        $kind: input.kind,
        $stype: input.sourceType,
        $sid: input.sourceId,
        $sim: input.simulated ? 1 : 0,
        $camera: input.cameraId ?? null,
        $zone: input.zoneId ?? null,
        $track: input.trackedThingId ?? null,
        $class: input.class ?? null,
        $direction: input.direction ?? null,
        $rule: input.rule ?? null,
        $confidence: input.confidence ?? null,
        $severity: input.severity,
        $alertable: input.alertable ? 1 : 0,
        $suppressed: input.suppressedReason ?? null,
        $occurred: input.occurredAt,
        $received: nowIso(),
        $evidence: JSON.stringify(input.evidence ?? {}),
        $thumbnail: input.thumbnail ?? null,
        $incident: incidentId,
      },
    );

    if (input.alertable) {
      run(
        `INSERT INTO alert (id, incident_id, channel, severity, created_at)
         VALUES ($id, $incident, 'screen', $severity, $at)`,
        { $id: id("alr"), $incident: incidentId, $severity: input.severity, $at: nowIso() },
      );
    }

    const row = one<EventRow>(`SELECT ${EVENT_COLUMNS} FROM event WHERE id = $id`, { $id: eventId })!;
    return Object.assign(row, { __opened: opened }) as EventRow;
  });

  const row = write();
  publish({ type: "event", data: shapeEvent(row) });
  publish({ type: "incident", data: getIncident(row.incident_id!) });
  return row;
}

export function shapeEvent(row: EventRow) {
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind,
    source: { type: row.source_type, id: row.source_id, simulated: row.simulated === 1 },
    cameraId: row.camera_id,
    zoneId: row.zone_id,
    trackedThingId: row.tracked_thing_id,
    class: row.class,
    direction: row.direction,
    rule: row.rule,
    confidence: row.confidence,
    severity: row.severity,
    alertable: row.alertable === 1,
    suppressedReason: row.suppressed_reason,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    evidence: JSON.parse(row.evidence),
    // The flag, not the picture. `/api/events/:id/thumbnail` serves the image.
    hasThumbnail: row.has_thumbnail === 1,
    incidentId: row.incident_id,
  };
}

/**
 * One incident, shaped exactly as `listIncidents` shapes them.
 *
 * ONE SHAPE, TWO DOORS, and they must not drift. This is what the SSE push
 * carries (`publish({ type: "incident" })`), and the console merges a pushed
 * incident straight into the list it got from `listIncidents`. A field present
 * on one and missing on the other means a live-arriving incident silently
 * behaves differently from an identical one that came from a fetch -- it would
 * drop out of a filter, or out of a count, for no reason anybody could see.
 */
const shapeIncident = (row: any) => ({
  id: row.id,
  title: row.title,
  severity: row.severity,
  status: row.status,
  cameraId: row.camera_id,
  zoneId: row.zone_id,
  openedAt: row.opened_at,
  lastEventAt: row.last_event_at,
  eventCount: row.event_count,
  kind: row.kind ?? null,
  // Split here rather than leaving the console to parse a comma string --
  // GROUP_CONCAT is a storage detail and should not reach a screen. Empty for
  // an incident whose events carry no class, e.g. a camera going quiet.
  classes: row.classes ? String(row.classes).split(",").filter(Boolean) : [],
  // MAX over a 0/1 column: true when ANY event in here raised an alert.
  alertable: row.alertable === 1,
});

export function getIncident(incidentId: string) {
  const row = one<any>("SELECT * FROM incident_state WHERE id = $id", { $id: incidentId });
  return row ? shapeIncident(row) : null;
}

export interface EventQuery {
  cameraId?: string;
  zoneId?: string;
  incidentId?: string;
  severity?: Severity;
  class?: string;
  /** zone_crossing | camera_health | sensor_contact | reidentification */
  kind?: string;
  /**
   * Tri-state: undefined means both. A plain boolean could only ever ask for
   * "alertable = 1", and the question worth asking now is the opposite one --
   * what did we record and deliberately NOT shout about, and why.
   */
  alertable?: boolean;
  /** e.g. `zone_not_placed`, `target_is_log_only`, `zone_no_longer_bound`. */
  suppressedReason?: string;
  simulated?: boolean;
  since?: string;
  until?: string;
  afterSeq?: number;
  limit?: number;
  /** @deprecated superseded by the tri-state `alertable`. */
  alertableOnly?: boolean;
}

/** The searchable log. Also what a reconnecting peer replays, via afterSeq. */
export function queryEvents(orgId: string, q: EventQuery) {
  const where = ["org_id = $org"];
  const params: Record<string, unknown> = { $org: orgId };

  if (q.cameraId) (where.push("camera_id = $camera"), (params.$camera = q.cameraId));
  if (q.zoneId) (where.push("zone_id = $zone"), (params.$zone = q.zoneId));
  if (q.incidentId) (where.push("incident_id = $incident"), (params.$incident = q.incidentId));
  if (q.severity) (where.push("severity = $severity"), (params.$severity = q.severity));
  if (q.class) (where.push("class = $class"), (params.$class = q.class));
  if (q.kind) (where.push("kind = $kind"), (params.$kind = q.kind));
  if (q.alertable !== undefined) where.push(`alertable = ${q.alertable ? 1 : 0}`);
  else if (q.alertableOnly) where.push("alertable = 1");
  if (q.suppressedReason) {
    where.push("suppressed_reason = $suppressed");
    params.$suppressed = q.suppressedReason;
  }
  if (q.simulated !== undefined) where.push(`simulated = ${q.simulated ? 1 : 0}`);
  if (q.since) (where.push("occurred_at >= $since"), (params.$since = q.since));
  if (q.until) (where.push("occurred_at <= $until"), (params.$until = q.until));
  if (q.afterSeq !== undefined) (where.push("seq > $after"), (params.$after = q.afterSeq));

  params.$limit = Math.min(q.limit ?? 200, 2000);

  const order = q.afterSeq !== undefined ? "seq ASC" : "seq DESC";
  return all<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM event WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $limit`,
    params,
  ).map(shapeEvent);
}

/** The operator's screen: incidents ranked by severity, then recency. */
export function listIncidents(
  orgId: string,
  opts: {
    status?: string;
    cameraId?: string;
    zoneId?: string;
    /** Event kind: zone_crossing, camera_health, plate_read, reidentification. */
    kind?: string;
    severity?: string;
    /** One class the incident saw, e.g. "person". Matches if ANY event did. */
    class?: string;
    /** Bounds on `last_event_at`, not `opened_at`. */
    since?: string;
    until?: string;
    limit?: number;
  } = {},
) {
  const where = ["org_id = $org"];
  const params: Record<string, unknown> = { $org: orgId };

  if (opts.status) (where.push("status = $status"), (params.$status = opts.status));
  // "Everything that has happened on this feed" -- the question you ask after
  // clicking a camera, which the unfiltered queue is not shaped to answer.
  if (opts.cameraId) (where.push("camera_id = $camera"), (params.$camera = opts.cameraId));
  if (opts.zoneId) (where.push("zone_id = $zone"), (params.$zone = opts.zoneId));
  if (opts.kind) (where.push("kind = $kind"), (params.$kind = opts.kind));
  if (opts.severity) (where.push("severity = $severity"), (params.$severity = opts.severity));
  // `classes` is a comma-separated list from GROUP_CONCAT, so matching needs
  // the commas on both ends -- otherwise "cattle" would match "wild_cattle"
  // and "person" would match nothing when it is second in the list.
  if (opts.class) {
    where.push("(',' || COALESCE(classes, '') || ',') LIKE $class");
    params.$class = `%,${opts.class},%`;
  }
  // FILTERED ON `last_event_at`, deliberately. An incident opened yesterday
  // that is still collecting events today is today's problem, and a date
  // filter that hid it behind its opening time would be the one that loses it.
  if (opts.since) (where.push("last_event_at >= $since"), (params.$since = opts.since));
  if (opts.until) (where.push("last_event_at <= $until"), (params.$until = opts.until));
  params.$limit = Math.min(opts.limit ?? 100, 500);

  return all<any>(
    `SELECT * FROM incident_state
      WHERE ${where.join(" AND ")}
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
               last_event_at DESC
      LIMIT $limit`,
    params,
  ).map(shapeIncident);
}


/** How far either side of an incident to look for related activity. */
const CROSS_REFERENCE_WINDOW_SECONDS = 1800;

/**
 * What else was watching, and what else it saw.
 *
 * A zone spans cameras, so when something crosses on one feed the operator's
 * next question is "what else could have seen this, and did it?" -- which used
 * to be a guess and is now a lookup. Cameras that cover the same zone are
 * listed whether or not they caught anything, because "the other camera saw
 * nothing" is itself worth knowing.
 */
export function crossReference(incidentId: string) {
  const incident = one<any>("SELECT * FROM incident_state WHERE id = $id", { $id: incidentId });
  if (!incident || !incident.zone_id) {
    return { zone: null, cameras: [], incidents: [] };
  }

  const zone = one<{ id: string; name: string }>(
    "SELECT id, name FROM zone WHERE id = $id",
    { $id: incident.zone_id },
  );

  const cameras = all<any>(
    `SELECT c.id, c.name, c.status, c.enabled
       FROM zone_camera zc
       JOIN camera c ON c.id = zc.camera_id
      WHERE zc.zone_id = $zone AND zc.active = 1
      ORDER BY c.name`,
    { $zone: incident.zone_id },
  ).map((row) => ({
    cameraId: row.id,
    cameraName: row.name,
    cameraStatus: row.status,
    enabled: row.enabled === 1,
    /** The camera this incident actually came from. */
    isSource: row.id === incident.camera_id,
  }));

  const from = new Date(
    Date.parse(incident.opened_at) - CROSS_REFERENCE_WINDOW_SECONDS * 1000,
  ).toISOString();
  const until = new Date(
    Date.parse(incident.last_event_at) + CROSS_REFERENCE_WINDOW_SECONDS * 1000,
  ).toISOString();

  const related = all<any>(
    `SELECT * FROM incident_state
      WHERE zone_id = $zone
        AND id != $id
        AND last_event_at >= $from
        AND opened_at <= $until
      ORDER BY last_event_at DESC
      LIMIT 20`,
    { $zone: incident.zone_id, $id: incidentId, $from: from, $until: until },
  ).map((row) => ({
    id: row.id,
    title: row.title,
    severity: row.severity,
    status: row.status,
    cameraId: row.camera_id,
    openedAt: row.opened_at,
    lastEventAt: row.last_event_at,
    eventCount: row.event_count,
  }));

  return { zone, cameras, incidents: related, windowSeconds: CROSS_REFERENCE_WINDOW_SECONDS };
}
