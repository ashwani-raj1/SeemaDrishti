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
  --
  -- This is OBSERVED: the analysis engine writes it from what it can actually
  -- see. Nobody sets it by hand.
  status       TEXT NOT NULL DEFAULT 'FULL',   -- FULL|DEGRADED|MOTION_ONLY|RECORD_ONLY|DEAD
  -- This is DECIDED: a person took the feed out of service, for maintenance or
  -- because it is pointing at nothing useful. Kept apart from `status` because
  -- "we cannot see" and "we chose to stop looking" are different facts, and an
  -- operator needs to be able to tell them apart on the status board.
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);

-- A monitoring zone is a named place that one or more cameras watch.
--
-- It deliberately holds no geometry of its own. A polygon drawn in one
-- camera's frame is meaningless in another's, so the shape belongs to the
-- pairing of a zone with a camera (`zone_camera`), not to the zone. What the
-- zone owns is identity and policy: what this place is, and what matters here.
--
-- A border fence line and a naval jetty perimeter are the same primitive with
-- a different `kind`. There is no force-specific code anywhere below this.
CREATE TABLE IF NOT EXISTS zone (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organisation(id),
  site_id    TEXT NOT NULL REFERENCES site(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- fence_line|gate|waterline|perimeter|pass|restricted_area
  -- The named area this zone was cut from, kept so the console can show where
  -- it came from. Advisory only; nothing in judgement reads it.
  sector     TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS zone_by_site ON zone(site_id, active);

-- One camera's view of one zone: the shape it watches, and how patient it is.
--
-- `points` are normalised 0..1 against that camera's frame, so the shape
-- survives the camera being swapped for a different resolution. Direction and
-- the confirm delay live here too, because the same fence seen down its length
-- from one camera and across from another genuinely needs different settings.
CREATE TABLE IF NOT EXISTS zone_camera (
  id              TEXT PRIMARY KEY,
  zone_id         TEXT NOT NULL REFERENCES zone(id),
  camera_id       TEXT NOT NULL REFERENCES camera(id),
  geometry        TEXT NOT NULL,          -- 'line' | 'polygon'
  points          TEXT NOT NULL,          -- JSON [[x,y], ...]
  direction       TEXT NOT NULL DEFAULT 'both',   -- inbound | outbound | both
  confirm_seconds REAL NOT NULL DEFAULT 2.0,      -- wait-and-confirm (#13)
  -- 0 means the shape is still the placeholder handed out when the camera was
  -- added to the zone. The console says so rather than implying somebody has
  -- actually positioned it against this camera's view.
  placed          INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(zone_id, camera_id)
);

CREATE INDEX IF NOT EXISTS zone_camera_by_camera ON zone_camera(camera_id, active);

-- What must be detected against here, in the order it matters.
--
-- `camera_id NULL` is the zone's own policy, applying to every camera in it.
-- A row naming a camera overrides the zone policy for that class on that
-- camera alone -- one policy per zone, with exceptions stated explicitly
-- rather than by duplicating the whole list per camera.
--
-- `priority` is an explicit rank, 1 highest -- the order somebody declared
-- these matter in, and the order they are read back in.
-- `action` of 'log_only' is the animal case (#12): written down, never alerted.
CREATE TABLE IF NOT EXISTS zone_target (
  id         TEXT PRIMARY KEY,
  zone_id    TEXT NOT NULL REFERENCES zone(id),
  camera_id  TEXT REFERENCES camera(id),   -- NULL = the zone's own policy
  class      TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'WARNING',
  action     TEXT NOT NULL DEFAULT 'alert',  -- alert | log_only
  priority   INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One rule per class per scope. Two rows for 'person' on the same camera would
-- make which one applies a matter of luck.
CREATE UNIQUE INDEX IF NOT EXISTS zone_target_unique
  ON zone_target(zone_id, IFNULL(camera_id, ''), class);
CREATE INDEX IF NOT EXISTS zone_target_by_zone ON zone_target(zone_id, priority);

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

-- ---------------------------------------------------------------- vehicle & plate watchlist (#36)

CREATE TABLE IF NOT EXISTS watchlist_entry (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organisation(id),
  plate_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'car',
  make_model   TEXT,
  color        TEXT,
  severity     TEXT NOT NULL DEFAULT 'WARNING',
  flag_reason  TEXT NOT NULL,
  notes        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  added_by     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS watchlist_by_plate ON watchlist_entry(plate_number);
CREATE INDEX IF NOT EXISTS watchlist_by_org   ON watchlist_entry(org_id, active);

CREATE TABLE IF NOT EXISTS plate_detection (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL,
  camera_id            TEXT NOT NULL REFERENCES camera(id),
  zone_id              TEXT REFERENCES zone(id),
  plate_number         TEXT NOT NULL,
  vehicle_type         TEXT NOT NULL DEFAULT 'car',
  confidence           REAL NOT NULL DEFAULT 1.0,
  plate_confidence     REAL NOT NULL DEFAULT 1.0,
  matched_watchlist_id TEXT REFERENCES watchlist_entry(id),
  match_status         TEXT NOT NULL DEFAULT 'CLEAR',
  severity             TEXT NOT NULL DEFAULT 'INFO',
  bbox                 TEXT NOT NULL DEFAULT '[0,0,0,0]',
  plate_bbox           TEXT NOT NULL DEFAULT '[0,0,0,0]',
  image_snapshot       TEXT,
  simulated            INTEGER NOT NULL DEFAULT 0,
  occurred_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plate_detection_by_time  ON plate_detection(occurred_at DESC);
CREATE INDEX IF NOT EXISTS plate_detection_by_plate ON plate_detection(plate_number);
CREATE INDEX IF NOT EXISTS plate_detection_by_match ON plate_detection(match_status, occurred_at DESC);

-- One row per uniquely tracked vehicle visit. Unlike `plate_detection`, this
-- also records vehicles whose registration plate was unreadable, so traffic
-- totals do not silently become OCR-success totals.
CREATE TABLE IF NOT EXISTS vehicle_traffic_event (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  camera_id    TEXT NOT NULL REFERENCES camera(id),
  source_key   TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'vehicle',
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(org_id, source_key)
);

CREATE INDEX IF NOT EXISTS vehicle_traffic_by_time
  ON vehicle_traffic_event(org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_traffic_by_camera
  ON vehicle_traffic_event(camera_id, occurred_at DESC);

-- ---------------------------------------------------------------- person watchlist (face + appearance)
--
-- The plate watchlist's sibling for people, not a copy of its shape: a plate
-- is compared by string edit-distance (platesMatch, above); a person is
-- compared by embedding cosine similarity, computed once by the vision
-- service's own models (ibvap/modules/face.py) and stored here as plain JSON
-- float arrays -- this table holds vectors, never photos, and never runs a
-- model itself. Both signals are optional and independent: a close-up photo
-- yields a face embedding (strong), a photo with no usable face still yields
-- an appearance embedding (weak, colour-based) so enrolment never silently
-- fails just because a face was not visible.
--
-- The single source of truth for TWO different processes: ibvap/main.py's
-- live per-camera pipeline and ibvap/people_ai_service.py's upload/webcam
-- endpoint both poll this table (GET /api/watchlist/people) on a timer and
-- match against their own cached copy, the same pattern zones already use
-- (see media/cameras.yml's comment on zone_refresh_seconds) -- so an
-- enrolment reaches every camera without restarting a worker.
CREATE TABLE IF NOT EXISTS person_watchlist (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organisation(id),
  name                 TEXT NOT NULL,
  face_embedding       TEXT,                 -- JSON float array, or NULL
  appearance_embedding TEXT,                 -- JSON float array, or NULL
  notes                TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  added_by             TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS person_watchlist_by_org ON person_watchlist(org_id, active);
