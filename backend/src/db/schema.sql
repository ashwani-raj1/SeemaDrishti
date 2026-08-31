-- IBVAP edge node schema.
--
-- Eight object types (Plate 08), plus `app_user` and `alert`.
--
-- Two tables are append-only and enforced as such by triggers: `event` and
-- `action`. Everything an operator does lands in `action`; an incident's
-- status is never stored, it is derived from that log (view `incident_state`).
-- That is what makes "every decision is recorded" structural rather than a
-- promise -- there is no code path that can change an incident's state
-- without leaving an action row behind.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- where things are

CREATE TABLE IF NOT EXISTS organisation (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL DEFAULT 30,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organisation(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,                -- bop | check_post | jetty | pass
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS camera (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES site(id),
  name         TEXT NOT NULL,
  stream_url   TEXT,
  -- The blindness ladder (Plate 07). Held here so the operator screen can say
  -- out loud where we are blind instead of failing quietly.
  status       TEXT NOT NULL DEFAULT 'FULL',   -- FULL|DEGRADED|MOTION_ONLY|RECORD_ONLY|DEAD
  created_at   TEXT NOT NULL
);

-- A zone is a shape plus a label saying what kind of place it is. A border
-- fence line and a naval jetty perimeter are the same primitive with a
-- different `kind` -- there is no force-specific code anywhere below this.
--
-- `points` are normalised 0..1 against the frame, so a zone survives a camera
-- being swapped for one with a different resolution.
CREATE TABLE IF NOT EXISTS zone (
  id                TEXT PRIMARY KEY,
  camera_id         TEXT NOT NULL REFERENCES camera(id),
  org_id            TEXT NOT NULL REFERENCES organisation(id),
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL,          -- fence_line|gate|waterline|perimeter|pass|restricted_area
  geometry          TEXT NOT NULL,          -- 'line' | 'polygon'
  points            TEXT NOT NULL,          -- JSON [[x,y], ...]
  watch_classes     TEXT NOT NULL,          -- JSON, classes that may raise an alert
  log_only_classes  TEXT NOT NULL,          -- JSON, classes written to the log and never alerted (#12)
  direction         TEXT NOT NULL DEFAULT 'both',   -- inbound | outbound | both
  confirm_seconds   REAL NOT NULL DEFAULT 2.0,      -- wait-and-confirm before shouting (#13)
  severity          TEXT NOT NULL DEFAULT 'WARNING',
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS zone_by_camera ON zone(camera_id, active);

-- ---------------------------------------------------------------- what happened

-- A track with a beginning and an end -- deliberately NOT a person with a
-- history. `same_as` links a track to an earlier one believed to be the same
-- figure (cross-camera following); it points at another live track, never at
-- a stored library of past individuals.
CREATE TABLE IF NOT EXISTS tracked_thing (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  camera_id  TEXT NOT NULL REFERENCES camera(id),
  track_ref  TEXT NOT NULL,                 -- the id the detector gave it
  class      TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  path       TEXT NOT NULL DEFAULT '[]',    -- JSON [[x,y,t], ...], trimmed
  same_as    TEXT REFERENCES tracked_thing(id),
  UNIQUE(camera_id, track_ref)
);

-- One fact. Append-only. `seq` counts up and never repeats -- it is the field
-- that makes reconnection cheap ("give me everything after 18,423").
CREATE TABLE IF NOT EXISTS event (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  org_id            TEXT NOT NULL,
  site_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,          -- zone_crossing | sensor_contact | camera_health
  source_type       TEXT NOT NULL,          -- camera | external_sensor | operator | peer_node
  source_id         TEXT NOT NULL,
  simulated         INTEGER NOT NULL DEFAULT 0,   -- set once per adapter, never per-call
  camera_id         TEXT,
  zone_id           TEXT,
  tracked_thing_id  TEXT,
  class             TEXT,
  direction         TEXT,                   -- inbound | outbound
  rule              TEXT,                   -- the named rule that fired
  confidence        REAL,
  severity          TEXT NOT NULL,
  -- 0 means: written to the log, never raised to a human. An animal crossing
  -- the fence is a record, not an alarm.
  alertable         INTEGER NOT NULL DEFAULT 1,
  suppressed_reason TEXT,
  occurred_at       TEXT NOT NULL,
  received_at       TEXT NOT NULL,          -- differs from occurred_at when a link was down
  evidence          TEXT NOT NULL DEFAULT '{}',
  incident_id       TEXT
);

CREATE INDEX IF NOT EXISTS event_by_time     ON event(occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_by_incident ON event(incident_id);
CREATE INDEX IF NOT EXISTS event_by_camera   ON event(camera_id, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;

-- Many related events grouped into one thing a human deals with. Note there
-- is no `status` column: see `incident_state` below.
CREATE TABLE IF NOT EXISTS incident (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  camera_id     TEXT,
  zone_id       TEXT,
  title         TEXT NOT NULL,
  severity      TEXT NOT NULL,
  group_key     TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  last_event_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS incident_by_group ON incident(group_key, last_event_at DESC);

CREATE TABLE IF NOT EXISTS alert (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incident(id),
  channel      TEXT NOT NULL,               -- screen | webhook | log
  severity     TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------- who did what

CREATE TABLE IF NOT EXISTS app_user (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organisation(id),
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,                 -- operator | supervisor | admin
  created_at TEXT NOT NULL
);

-- The audit spine. Every acknowledgement, escalation, dismissal, zone edit,
-- sensitivity change and history search is one row here, with who / when / why.
--
-- Append-only, and hash-chained: each row's `hash` covers the previous row's
-- hash, so removing or rewriting any row breaks every hash after it. Verify
-- with GET /api/audit/verify.
CREATE TABLE IF NOT EXISTS action (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  org_id      TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  verb        TEXT NOT NULL,                -- incident.acknowledge | zone.update | history.search | ...
  target_type TEXT NOT NULL,                -- incident | zone | camera | search | session
  target_id   TEXT,
  reason      TEXT,                         -- the "why", required for escalate and dismiss
  detail      TEXT NOT NULL DEFAULT '{}',
  before      TEXT,                         -- state before the change, for edits
  after       TEXT,
  at          TEXT NOT NULL,
  prev_hash   TEXT,
  hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS action_by_target ON action(target_type, target_id, seq DESC);
CREATE INDEX IF NOT EXISTS action_by_time   ON action(at DESC);

CREATE TRIGGER IF NOT EXISTS action_no_update BEFORE UPDATE ON action
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS action_no_delete BEFORE DELETE ON action
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

-- An incident's status is not stored; it is whatever the most recent
-- state-changing decision in the audit log says it is. There is therefore no
-- way to change an incident's state without recording who did it and why.
CREATE VIEW IF NOT EXISTS incident_state AS
SELECT
  i.*,
  COALESCE((
    SELECT CASE a.verb
             WHEN 'incident.acknowledge' THEN 'ACKNOWLEDGED'
             WHEN 'incident.escalate'    THEN 'ESCALATED'
             WHEN 'incident.dismiss'     THEN 'DISMISSED'
           END
    FROM action a
    WHERE a.target_type = 'incident'
      AND a.target_id   = i.id
      AND a.verb IN ('incident.acknowledge', 'incident.escalate', 'incident.dismiss')
    ORDER BY a.seq DESC
    LIMIT 1
  ), 'OPEN') AS status,
  (SELECT COUNT(*) FROM event e WHERE e.incident_id = i.id) AS event_count
FROM incident i;
