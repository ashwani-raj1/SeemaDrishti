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
  -- How long an incident stays open to new events sharing its group key.
  -- Post-tunable because the right answer is a property of the ground, not of
  -- the software: a gate where vehicles queue wants a longer window than a
  -- fence line in open country, and getting it wrong shows up either as one
  -- incident swallowing a second genuine intrusion or as forty incidents for
  -- one person walking a fence. Changed only through `/api/settings`, which
  -- writes an audit row -- see `l3/settings.ts`.
  grouping_window_seconds INTEGER NOT NULL DEFAULT 300,
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
  -- A free-text label grouping zones that belong to the same stretch of ground
  -- ("Fence line north"). Advisory only; nothing in judgement reads it.
  --
  -- Called `area` and not `sector` on purpose: `camera.sector` already means
  -- the POST a camera belongs to ("bop_attari"), and one word meaning two
  -- things was a standing source of confusion in the console.
  --
  -- There is no `area` table. The set of areas is whatever DISTINCT values the
  -- live zones carry, so an area cannot outlive the last zone that used it and
  -- there is no second list to keep in step.
  area       TEXT,
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

-- A camera belongs to exactly ONE zone at a time.
--
-- A zone may still span many cameras -- the fence line seen from two angles is
-- one place, and siblingCameras()/crossReference() depend on that. What this
-- forbids is the other direction: one camera carrying several zones, and so
-- several shapes.
--
-- PARTIAL, on `active`, because a binding is retired by setting active = 0 and
-- never deleted: past events still point at it, and re-adding the camera has
-- to find its old target overrides waiting. A plain UNIQUE(camera_id) would
-- make a camera unusable the moment it had ever left a zone.
--
-- Enforced at the API too (requireFreeCameras in routes/zones.ts) so the caller
-- gets a 409 naming the zone that holds it, rather than a raw constraint error.
CREATE UNIQUE INDEX IF NOT EXISTS zone_camera_one_zone
  ON zone_camera(camera_id) WHERE active = 1;

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
  -- A base64 JPEG of the subject, cut from the frame this was judged on by
  -- `vision-service/core/thumbnail.py`. NULL is normal and always survivable: the
  -- simulator posts no picture, a lost-track event has no current frame, and
  -- the console falls back to drawing the geometry.
  --
  -- Stored inline rather than as a file on disk because a BOP's evidence has
  -- to move as one thing: a row that references a picture the backup did not
  -- take is a row that lies. At a few tens of KB on confirmed crossings only,
  -- the column stays smaller than the video of the same second would be. It is
  -- never SELECTed by the list queries -- see `EVENT_COLUMNS`.
  thumbnail         TEXT,
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
  -- A number a human can say over a radio. Per org, assigned on insert; see
  -- attachIncident in l3/events.ts for why it is not AUTOINCREMENT.
  number        INTEGER,
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
  (SELECT COUNT(*) FROM event e WHERE e.incident_id = i.id) AS event_count,
  -- What KIND of thing this is: zone_crossing, camera_health, plate_read.
  -- Taken from the incident's own events rather than parsed out of the title,
  -- which is prose and changes. Grouping is by `group_key`, which pins the
  -- camera, zone and rule, so an incident's events share a kind in practice --
  -- the newest is taken so a shape that changed underneath cannot leave the
  -- filter pointing at what this used to be.
  (SELECT e.kind FROM event e WHERE e.incident_id = i.id
    ORDER BY e.seq DESC LIMIT 1) AS kind,
  -- Every class seen in this incident, comma-separated. An operator filtering
  -- the queue thinks "show me the people, not the cattle" long before they
  -- think about event kinds, and one incident can hold both.
  (SELECT GROUP_CONCAT(DISTINCT e.class) FROM event e
    WHERE e.incident_id = i.id AND e.class IS NOT NULL) AS classes,
  -- Did anything in here actually raise an alert? An incident exists for every
  -- event, alertable or not, so "recorded" and "shouted about" are different
  -- questions and the queue has to be able to ask the second one.
  (SELECT MAX(e.alertable) FROM event e WHERE e.incident_id = i.id) AS alertable
FROM incident i;

-- ---------------------------------------------------------------- evidence clips
--
-- The seconds either side of a confirmed crossing, as the frames the detector
-- actually judged. Not video: `vision-service/core/clip.py` explains why, and why this
-- does not contradict the "never video" line in section 8 (that is about what
-- syncs UPSTREAM over a BOP uplink; these stay on the node and serve the
-- console over the LAN).
--
-- A clip is EVIDENCE, NOT THE RECORD. The event is the record and is
-- append-only; a clip is the picture attached to it. So there is no
-- append-only trigger here and there IS a retention sweep: losing a clip to
-- retention costs a picture, and the event it belonged to is still there
-- saying what happened.
CREATE TABLE IF NOT EXISTS clip (
  id          TEXT PRIMARY KEY,          -- minted by the worker, see core/clip.py
  org_id      TEXT NOT NULL,
  camera_id   TEXT,
  -- The crossing this was cut around, as the worker's wall clock saw it.
  at          TEXT NOT NULL,
  -- The rate these frames were ACTUALLY captured at, not the configured target.
  -- The console shows this to the operator, so a wrong one is a lie about the
  -- evidence rather than a cosmetic slip.
  fps         REAL NOT NULL DEFAULT 0,
  frame_count INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  simulated   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS clip_by_age ON clip(created_at);

-- One row per frame, which is what makes a scrubber a lookup rather than a
-- parse: the console asks for frame N and gets exactly that, and the filmstrip
-- is the manifest without the pixels.
CREATE TABLE IF NOT EXISTS clip_frame (
  clip_id     TEXT NOT NULL REFERENCES clip(id),
  seq         INTEGER NOT NULL,
  -- Seconds relative to the crossing: negative before, positive after. Lets
  -- the console place the playhead without knowing the wall clock.
  offset_s    REAL NOT NULL,
  jpeg        TEXT NOT NULL,             -- base64, same as event.thumbnail
  boxes       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (clip_id, seq)
);

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
  verified             INTEGER NOT NULL DEFAULT 1,
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
-- service's own models (vision-service/modules/face.py) and stored here as plain JSON
-- float arrays -- this table holds vectors, never photos, and never runs a
-- model itself. Both signals are optional and independent: a close-up photo
-- yields a face embedding (strong), a photo with no usable face still yields
-- an appearance embedding (weak, colour-based) so enrolment never silently
-- fails just because a face was not visible.
--
-- The single source of truth for TWO different processes: vision-service/main.py's
-- live per-camera pipeline and vision-service/people_ai_service.py's upload/webcam
-- endpoint both poll this table (GET /api/watchlist/people) on a timer and
-- match against their own cached copy, the same pattern zones already use
-- (see media/cameras.yml's comment on zone_refresh_seconds) -- so an
-- enrolment reaches every camera without restarting a worker.
-- `address` and `owned_plates` are DELIBERATELY MOCK -- there is no
-- registry of residence or vehicle ownership feeding this system, and
-- pretending otherwise would be a false claim of capability the same way
-- claude.md §7 forbids for an accuracy number. They exist so the person
-- dossier page (routes/person_watchlist.ts's :name/dossier) has SOMETHING
-- to show beyond a bare sighting log, seeded by an operator the same way a
-- plate gets added to the vehicle watchlist. `owned_plates` is the one
-- genuinely internal connection to ANPR: it is compared against REAL rows
-- in `plate_detection` (an actual OCR read, actually seen by a camera), so
-- a dossier's vehicle history is real detections cross-referenced against a
-- mock ownership claim, and the dossier UI must say so, not blur the two.
CREATE TABLE IF NOT EXISTS person_watchlist (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organisation(id),
  name                 TEXT NOT NULL,
  face_embedding       TEXT,                 -- JSON float array, or NULL
  appearance_embedding TEXT,                 -- JSON float array, or NULL
  notes                TEXT,
  address              TEXT,                 -- mock, operator-entered
  owned_plates         TEXT,                 -- mock, JSON array of plate strings
  -- MOCK -- see schema.sql's own person_watchlist comment above (address,
  -- owned_plates). Stands in for a government ID registry this system does
  -- not have access to; unique so "look someone up by ID" has one answer.
  govt_id              TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  added_by             TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS person_watchlist_by_org ON person_watchlist(org_id, active);
