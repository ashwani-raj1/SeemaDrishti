# Zone → camera → drawn area → judged → incident

## Context

The flow you described — *create zone → add cameras → mark the area per camera view → save →
vision service fetches it (or falls back to a default) → issue an incident* — **already exists end
to end**: `createZone` → `zone_camera` → `/api/config` → `config.py:fetch_zones` →
`modules/fence.py` → `POST /hooks/ingress/events` → `l4/vision.ts:ingestIntrusion` → `recordEvent`
→ incident + alert. The drawing editor exists and is good (`frontend/src/features/zones/shape-editor.tsx`,
446 lines: live WHEP video, click-to-place normalised points, vertex dragging, mandatory audit
reason). So does the events query endpoint, the history screen, and the incident click-through —
the backend has been sending `incidentId` on every event all along and the frontend type just
omits it.

This is therefore not a build. It is **four defects, one cardinality change, one reversal, and
about a page and a half of wiring.**

The defects matter more than the features:

1. **The fallback region already exists and lies about itself.** Every camera added to a zone gets
   a stock placeholder shape with `placed = 0` (`l3/zones.ts:59-68`). That flag is not in
   `/api/config` and is checked nowhere in judgement, so an undrawn placeholder is served to the
   detector and produces fully **alertable** intrusions against geometry no operator drew.
   `ibvap/CLAUDE.md` §15 and `ibvap/config.py:267-271` forbid exactly this. Python keeps the
   promise; the node breaks it. **Labelling it is simultaneously the bug fix and the "default
   region" you asked for** — no new mechanism required.
2. **A geometry bug silently swallows crossings** (reproduced; details in step 1).
3. **`updateBinding` marks a shape "drawn" when only `confirmSeconds` changed**, so the flag above
   would decay to noise within a day of use.
4. **The read-only overlay and the editor disagree on coordinates** on any non-16:9 source — the
   editor forces the container to the frame's aspect, the tile hard-codes 16:9 with `object-contain`
   and a full-bleed canvas. What the supervisor draws is not where the tile paints it.

### Decisions taken
| | |
|---|---|
| Cardinality | A zone holds many cameras; a camera belongs to exactly one zone — so **one shape per camera** |
| Provisional region | **Record, don't alert**: `alertable = 0`, `suppressed_reason = 'zone_not_placed'` |
| Node down | **Keep judging from a cached copy**, explicitly marked stale — a deliberate reversal of §15 |
| Incident | Keep the existing event→incident machinery; extend `/history` rather than add a page |
| Watchlist link | On `plate_detection` (evidence), not on `watchlist_entry` (rule) |

Two things to know about the node-down decision before step 6: **if the node is down the events
cannot be delivered either.** `DurableSink` queues 512 and sheds the newest beyond that
(`core/dispatcher.py:239-268`). So a cached-zone outage banks events in memory and delivers them
on recovery, up to 512, then counts and drops. That bound belongs in the run summary, not in a
surprise on stage.

---

## Phase A — the defects (~9 h)

Everything here fixes something that is currently wrong. None of it needs a migration and none of
it breaks a test.

### A1. The side-0 crossing bug — reproduced, and it fails toward a *missed* intrusion

`core/geometry.py:_sign` is tri-state (+1/0/−1 within `EPSILON = 1e-9`), so `side_for_zone` can
return **0** for a ground point lying on a line zone. Two defects compound:

- **`core/geometry.py:128`** — `crossing_of` ends `return "inbound" if after == 1 else "outbound"`,
  so landing exactly *on* the line reports **outbound** regardless of travel direction.
- **`modules/fence.py:205`** — compares `side_now != pending["side_after"]` with strict equality
  over that tri-state. The crossing frame stores `side_after = 0`; next frame the subject is
  genuinely at +1, read as "came straight back", discarded as flicker — and the `return None` at
  :213 exits *before* the crossing check, so the genuine `inbound` that would have fired on that
  same frame is thrown away too.

Reproduced against the real module: a horizontal line at y = 0.50 with samples landing on 0.50
gives `confirmed=0, rejected_flicker=1`; the same walk offset by 0.03 gives one correct `inbound`.
Ground points are pixel-quantised (`ny1 + nh`), so a horizontal zone on a 480-row frame is hit by
exactly 1 row in 480. Rare, silent, and **disguised as the debounce working correctly** — the
worst possible failure signature.

**Fix — treat side 0 as *undetermined, not a side*:**
- `core/geometry.py`, in `crossing_of`'s line branch before the `before == after` check:
  `if after == 0: return None`. The crossing is not lost — it fires on the next frame from the
  side actually reached, with the right direction. `before == 0 → after == ±1` already works and
  keeps working (`segments_cross` still returns true: `d1 = 0`, `d2 = ±1`). Leave `side_for_zone`
  tri-state; polygons never return 0 and the tri-state is what makes the guard expressible.
- `modules/fence.py:203`, before the flicker comparison: `if side_now == 0: return None` — hold
  the pending crossing, don't count the frame as evidence. Held *seconds* keep accruing, which is
  correct: the two clocks are deliberately independent (§5). This is independently necessary even
  after the geometry fix — a subject that crosses cleanly then drifts back onto the line would
  otherwise lose a confirmed crossing.
- This establishes an invariant worth writing into both files: **a pending crossing's `side_after`
  is never 0.**

**Mirror into the node in the same commit — §5 requires it**, and there it is worse:
- `backend/src/l2/geometry.ts:104-107` — the identical `if (after === 0) return null;`.
- `backend/src/l2/fence.ts:313` — the node's rejection path doesn't just drop the crossing, it
  **emits a `zone.crossing.flicker_rejected` durable event**, so a side-0 frame writes a false
  "did not persist" record into the permanent log. Add `if (currentSide === 0) return;` before the
  reject.

Fixing two of the three copies is worse than fixing none — it produces a disagreement between the
console preview, the simulator and the detector that no test would catch.

*Cost: 0.75 h Python + 0.5 h TypeScript.*

### A2. Make the provisional default region honest

`placed` already exists in every database (`schema.sql:95`). No migration.

- **`backend/src/core/types.ts`** — add `placed: boolean` to `interface Zone`.
- **`backend/src/l3/zones.ts:199-215`** — `hydrate()` selects `placed` in `BindingRow` and drops
  it. Add `placed: binding.placed === 1`. This one line makes the flag reachable from
  `zonesForCamera()`, judgement's only way in.
- **`backend/src/l3/zones.ts`** — the shared decision, so both fences agree:
  ```ts
  export const PROVISIONAL_SUPPRESSION = "zone_not_placed";
  export const isProvisional = (zone: Zone) => !zone.placed;
  ```
- **`backend/src/l4/vision.ts:190-195`** and **`backend/src/l2/fence.ts:201-208`** — both
  `routeClass` implementations return `{ kind: "log_only", reason: PROVISIONAL_SUPPRESSION }` when
  provisional, *before* the target lookup. Reuses the existing `log_only` path exactly: stored,
  attached to an incident, queryable — `alertable = 0`, nobody woken. Same shape as the existing
  `zone_no_longer_bound` and `track_lost_before_confirmation`. **Both doors or neither**, or the
  simulator and the detector disagree.
- **`backend/src/server.ts:82-104`** — emit `provisional: !zone.placed` in the `/api/config` zone
  object. `config.py` builds its dict key by key, so this is additive.
- **`backend/src/l3/zones.ts:401-424`** — **fix `updateBinding` lying.** Use
  `$placed: patch.points !== undefined ? 1 : current.placed`, and change `routes/zones.ts:330-335`
  to pass `points: body.points` (undefined when absent) instead of pre-defaulting it. The audit
  guarantee then holds for free — `recordAction` already records `before`/`after` from `zoneDetail`,
  which includes `placed`, so the false→true transition is already in the hash chain.

**Keep `placeholderShape` stock.** `l3/zones.ts:52-68` already argues it: a shape guessed from the
camera's bearing "would look positioned without being it". The label is the fix, not a better guess.

New tests in `backend/test/zones.test.ts`: a crossing on a fresh zone is `alertable === false` with
`suppressedReason === "zone_not_placed"`; after `updateBinding(..., {points})` the same crossing
alerts at the target's severity; changing only `confirmSeconds` leaves `placed === false`;
`zonesForCamera()` returns `placed`.

*Cost: 3–4 h with tests. Zero tests broken — `seed.ts:204` writes `placed = 1` for every seeded
binding, so every existing fence test is unaffected.*

### A3. Carry `provisional` through Python — and do not act on it there

- `ibvap/config.py:283-296` — `"provisional": bool(zone.get("provisional", False))`. Default
  `False` when absent: an older node has the unlabelled-placeholder bug anyway, and defaulting to
  `True` would mark every drawn zone provisional. `fetch_zones` keeps raising; its docstring stays
  true word for word.
- `ibvap/modules/fence.py` — carry it in `configure()`, into `_intrusion()`'s `data` (the node puts
  it in `evidence`; no schema change), and into `process()`'s `zone_states` so the live overlay can
  mark it without waiting for a durable event. Mirror in `FenceExtra` (`frontend/src/lib/live.ts:52-59`).
- `stats()` — add `provisional_zones`. The run summary is the project's only measurement surface
  (§7) and "3 of 5 zones are defaults nobody drew" belongs in it.
- Announce **on change, not every refresh** — `reconfigure()` runs every 15 s regardless, so a
  naive `print` spams the demo terminal. Keep `self._announced: set[str]` across `configure()`
  calls (the `hasattr` idiom already at `fence.py:121-125`).

**Python must not suppress provisional crossings.** Four reasons, in the order I'd defend them:
it isn't this process's decision (§1, `fence.py:16-19` — the wire carries a fact, the node applies
policy); suppressing here makes a supervisor's fix wait for a *second* process's poll; an event
never sent cannot be distinguished from anything, which destroys the audit record the flag exists
to create; and two suppressors is two places to disagree.

**Do not touch `main.py:82-89`.** That unconditional `params["zones"] = zones` is what makes "the
node is the only writer of geometry" true, and `main.py:391` blocks on the first refresh before
frame one — so a default written into `media/cameras.yml` would survive exactly zero frames.
Worth a two-line comment saying so, because the next person will try it.

*Cost: 1.5 h.*

### A4. The two coordinate bugs in the console

**`shape-editor.tsx:133-140` — `addPoint` never checks that `aspect` has been measured**, so a
click before `onLoadedMetadata` maps against a guessed 16/9 and lands in the wrong place silently.
One line: `if (aspect === null) return;`. The container already shows `cursor-wait` in that state,
so only the handler is lying. *Highest value per minute in the whole plan.*

**`camera-feed.tsx` letterbox mismatch — fix it, in draw space.** The editor forces the container
to the frame's aspect because a *click* must land in frame space; the tile only draws, so map into
a fitted rect and leave the grid layout alone. After sizing the backing store (:186-195):
```ts
const vw = video.videoWidth, vh = video.videoHeight;
const scale = vw && vh ? Math.min(width / vw, height / vh) : 1;
const dw = vw ? vw * scale : width, dh = vh ? vh * scale : height;
const ox = (width - dw) / 2, oy = (height - dh) / 2;
```
Then every `x * width` → `ox + x * dw` and `y * height` → `oy + y * dh` — zones, trails, boxes,
plate boxes, labels. ~20 substitutions in one function plus a `videoRef` read in the closure; no
new state, no re-render; falls back to full-bleed before metadata, so nothing regresses.

Worth the hour because `shape-editor.tsx:35-41` states in capitals that aspect ratio is
load-bearing and the tile then walks into exactly that hazard 200 lines away — and because the
overlay is the entire visual proof that what the supervisor drew is what the detector judges. The
team's sources are video files and a webcam; 16:9 is not safe to assume.

*Cost: 1 h + 0.2 h.*

### A5. Show provisional zones as provisional

- `frontend/src/lib/types.ts` — `provisional: boolean` on `Zone`. Write the equivalence down once
  in a comment: **`provisional === !placed`** — `placed` is the editor's word, `provisional` is the
  detector's. Renaming touches four files for no behavioural gain; two names plus one comment is
  the cheaper honesty.
- `components/ibvap/camera-feed.tsx` — a provisional zone must be unmistakable on a dark tile at
  3 a.m.: muted amber stroke, dashed *regardless of geometry* (today only polygons dash, so a
  provisional line would look normal), half fill alpha, small `provisional` label at the first vertex.
- `components/ibvap/badges.tsx` — one `ProvisionalBadge` beside the existing `SimulatedBadge` /
  `SuppressedBadge`, worded once: *"Default shape — nobody has drawn this against the camera's
  view. Crossings are recorded and never alerted."* One component means the console cannot
  describe this state three different ways on three pages.
- Place it in `features/services/fence.tsx:73-101` (with a "Draw it" link) and upgrade
  `features/cameras/page.tsx:184-188` to name the consequence rather than the state.
  `features/zones/screen.tsx:126-131` is already the model to match.

*Cost: 2 h.*

---

## Phase B — the durable-events page (~3.5 h)

**Extend `/history`. Do not add a page.** Three reasons: `/api/history` is supervisor-gated and
writes a `history.search` audit row with the query and result count (`server.ts:197-222`), while
`/api/events` has neither — a new operator-facing search over `/api/events` would hand every
operator an unaudited retrospective search, undercutting the accountability claim in §8;
`registry.tsx:17-19` says a nav entry a user must learn to skip is clutter, and "History" beside
"Events" is exactly that; and it's about a third of the work.

- **`frontend/src/lib/types.ts`** — add `incidentId: string | null` to `IbvapEvent`. The backend
  has always sent it (`l3/events.ts:213`); the hand-written mirror just omits it. This one line is
  most of the click-through.
- **`components/ibvap/event-table.tsx`** — optional `onOpen?: (event) => void`, row becomes
  `cursor-pointer` when `incidentId` is set (same pattern as `incidents/screen.tsx:218-226`).
  Keeping `useNavigate` out of a shared component and passing the handler from the feature is the
  same instinct as the module/transport split on the Python side. Add **Zone** and **Camera**
  columns — an event list whose zone you can't see isn't a query tool — and a `ProvisionalBadge`
  in the Flags cell on `evidence.provisional`.
- **`backend/src/l3/events.ts:233-268`** — `EventQuery` is missing `kind`, and `alertableOnly` is a
  boolean that can only express "alertable = 1"; after A2 the interesting query is the opposite.
  Make it tri-state (`alertable?: boolean`), add `kind`, `suppressedReason`, `simulated`; keep
  `alertableOnly` as a deprecated alias for one release. **`queryEvents` already supports
  `incidentId` (:253) and neither route parses it** — free.
- **`backend/src/server.ts`** — parse the new params in **both** `/api/events` and `/api/history`,
  so the audited path is not the weaker one.
- **`features/history/screen.tsx`** — a Zone select (source from `useZones()` in
  `client/context.tsx:150-153`; the `ALL` sentinel pattern is already there), an alertable switch,
  and a "provisional shapes only" toggle filtered client-side on `evidence.provisional` (server-side
  would need an index on a JSON field; client-side over a 200-row result is free, and it answers the
  exact question the provisional design exists for). Pass
  `onOpen={e => navigate("/incidents/" + e.incidentId)}`.
- **Prefill from URL search params, but do not auto-run the search.** A search here writes an audit
  row against the operator's name; firing one because somebody followed a link makes the audit
  trail describe an intention nobody had. Render *"Filters set from where you came. Press Search."*
- **Cross-links in**, all plain `<Link>`, all hidden (not disabled) for operators since the sidebar
  already hides `/history` from them: `service-shell.tsx:287-294` → `/history?camera_id=` (one
  edit, all four service pages get it); `cameras/page.tsx:242-245`; `zones/screen.tsx:122-132` →
  `/history?zone_id=`; `services/fence.tsx:73-101`; `incidents/page.tsx` beside the cross-reference
  panel.

No new route, no registry entry, no role change.

Do **not** denormalise incident status onto the event row — `incident_state` derives it from the
audit log (`schema.sql:263-280`), and a copy on an append-only table could never be corrected.

New `backend/test/events.test.ts`: filter by `kind`; by `incident_id`; `alertable=false` returns
suppressed rows and excludes alerted ones; `limit` clamps at 2000.

---

## Phase C — one camera, one zone (~8–12 h, 5 tests to fix)

**What is lost, plainly:** a camera carries exactly one shape. "A line at the gate AND a polygon
round the shed on `cam_farm_gate`" becomes impossible, and so does the seeded arrangement —
`cam_patrol_road` currently watches the fence line from its own angle *and* its own patrol-road
polygon (`seed.ts:79`, `:125`), a legitimate configuration. You confirmed this trade.

**Constraint.** Keep `UNIQUE(zone_id, camera_id)` (removing a table constraint means a full
rebuild) and add to `schema.sql` after :102:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS zone_camera_one_zone
  ON zone_camera(camera_id) WHERE active = 1;
```
Partial on `active` because a binding is retired by `active = 0`, never deleted, and re-adding a
camera must not lose its overrides (`routes/zones.ts:283-291`).

**Migration, and the ordering trap.** `schema.sql` is applied whole on every boot
(`db/index.ts:18`) and `CREATE UNIQUE INDEX` **throws** on existing duplicates — at module-import
time, so the node won't boot and every test file importing `../src/db` dies with it. Your own seed
violates it. So the dedupe goes in **`migrateBefore`** (which runs *before* `schema.sql`), above
its two existing early returns, guarded by `tableExists(db, "zone_camera")` because
`migrate.test.ts:155` calls it on a `:memory:` database with no such table. Keep the binding
somebody drew, then most recently touched, then lowest id — so two runs agree. Retire losers with
`active = 0`; never delete.

**Audit the detachment.** `migrate.ts` can't call `recordAction` (`l3/audit.ts` imports `../db`,
mid-construction — import cycle). Export the detachment list and emit one
`recordAction({ verb: "zone.camera.detach", actor: system })` per entry from `server.ts` right
after `seed()`. ~15 lines, and it keeps a change to what is being watched inside the hash chain.

**Seed.** `seed()` returns early once the org row exists, so a seed edit reaches no existing
database — the migration handles those, and the two must agree on which binding survives. Bind
`zone_patrol_road` to **`cam_garden`**, which `media/cameras.yml:108` declares but `seed.ts` never
seeds — a pre-existing bug (§14: an unseeded `camera_id` has every durable event rejected, so that
worker currently produces none). Fixes a real bug on the way past and keeps `zone_fence_line`'s two
cameras, which three tests depend on.

**API guard.** Add `Conflict` to `backend/src/http.ts` mapped to **409** in `handled()` (:66-79) —
well-formed request, conflicting state. Add `requireFreeCameras` next to `requireCameras`
(`routes/zones.ts:88-98`), called at **both** write sites: `POST /api/zones` (:128) and
`POST /api/zones/:zoneId/cameras` (:276) — **including the re-activation branch at :283-291**, or
flipping `active = 1` throws a raw SQLite error and `handled()` returns a 500 with
`UNIQUE constraint failed` as the body. `createZone` must reject the **whole** call if any camera
is taken; creating the zone minus the offending camera would show success while leaving a camera
uncovered — the worst outcome for a coverage tool.

**Two interactions that won't show up until a demo:**
1. Deactivating a zone does **not** deactivate its bindings (`routes/zones.ts:211`). The index is
   on `zone_camera.active`, so a camera stays taken by a dead zone forever. Deactivate bindings in
   the same transaction; re-activating must then re-activate only bindings whose camera is still
   free, and report the rest.
2. You can't move a camera out of a single-camera zone — `routes/zones.ts:364-366` refuses to
   remove the last camera and the new guard refuses to add it elsewhere. **Relax `requireCameras`
   to allow zero active cameras**, labelled "declared, not watched". A zone with no camera is a real
   state; refusing it just forces delete-and-recreate.

**Survives unchanged:** `siblingCameras()` (`l3/cameras.ts:72-91`) and `crossReference()`
(`l3/events.ts:329-335`) both join *same zone, different camera* — zone → many cameras survives.
`resolveTargets`, `zone_target` overrides, `l2/fence.ts` and `modules/fence.py` all loop over
whatever they're given.

**Breaks five tests** in `backend/test/zones.test.ts` (:209, :228, :246, :265, :286) — all borrow
an already-bound seeded camera and the index throws inside `createZone`'s transaction. Fix each by
creating a throwaway camera via `createCamera(...)` first, ~6 lines each. They share one on-disk
database in file order, so a failure at :209 cascades.

**Console UX** — the client can't enforce (two supervisors, stale lists), so: make the impossible
choice un-offerable, say *why*, and handle rejection. Build the map from `useClient().cameras[].zones`
(already active-bindings-only). In `zones/screen.tsx:472-533` (`AddCamera`) and both lists in
`new-zone-dialog.tsx` (:236-251, :325-352), render taken cameras **disabled with "already in
{zone}" and a "Move it" link — do not filter them out.** A camera that vanishes from a picker reads
as a bug; a greyed-out one with the reason attached reads as the system working. This matches the
precedent at `new-zone-dialog.tsx:342-349`, where filtering was itself the bug. Also change the
`available.length === 0` branch (:491) from hiding the control to explaining it. Add
`isConflict` to `lib/api.ts` beside `needsReason`/`isForbidden`, and give both call sites a 409
branch with the holding zone named and a "Open that zone" action, then `reload()`.

**Update the comments in the same commit.** `schema.sql:53-61`, `l3/zones.ts:7-14` and
`seed.ts:10-12` all argue the current cardinality deliberately; CLAUDE.md's preamble forbids
silently overriding settled decisions. Rewrite all three precisely: zone → many cameras survives,
only camera → many zones dies.

**If the fortnight runs short, cut this to the API guard alone** — `Conflict` + `requireFreeCameras`
+ the picker UX. ~90 minutes, all 79 tests stay green, existing data untouched, and nobody can
create a double-bound camera through the console again. The index and migration are the other ten
hours and exist only to defend a path you just closed.

---

## Phase D — node-down zone cache (~3 h): a deliberate reversal of §15

§15 currently says the opposite in as many words: *"It does not guess, and it does not cache a
stale shape from a previous run."* Building this means **rewriting that paragraph, not working
around it.**

Keep `fetch_zones`'s promise literally intact — it still raises and still never returns a stale
shape. The cache lives in the caller:

- `main.py:refresh_zones` writes the last-good zone map to disk on every successful fetch, keyed by
  backend URL so pointing at a different node can't reuse it. Add the file to `ibvap/.gitignore`.
- On a failed fetch **at startup only**, load it and apply with every zone marked `stale: true`
  plus a wall-clock `cached_at`. On a mid-run failure, change nothing — the modules already hold
  live zones, which are fresher than the cache.
- `modules/fence.py:_intrusion` carries `stale` and `cached_at` alongside `provisional`; `main.py`
  says so on stdout once per outage, beside the existing `[zones] cannot read ...` line.
- `l4/vision.ts` treats a stale-zone crossing exactly like a provisional one — recorded, not
  alerted, `suppressed_reason = "zone_cache_stale"`. That is the honest position: the geometry may
  have been edited during the outage and the node cannot know which.
- State the 512-event `DurableSink` bound in the run summary.

**Rewrite `ibvap/CLAUDE.md` §15** in the same commit. The rule becomes: *never judge silently
against geometry it cannot verify — a cached shape is used only at startup, only when the node is
unreachable, and every event it produces is marked stale and never alerted.* The audit guarantee
§15 was protecting survives; what changes is that a blind detector degrades to a recording one
instead of to nothing.

---

## Phase E — plate location, tests, docs (~5 h)

**E1. Plate reads record where they happened.** `l4/vision.ts:286-305` calls
`processVehicleAndPlateDetection` with no `zoneId`, so every genuine plate read stores
`zone_id = NULL` while the seeded demo rows all have one. Column, input field, INSERT bind and
`LEFT JOIN zone` all exist — only the caller is missing. Resolve from the camera's binding,
honouring `data.zone_id` **only if it matches a live binding** (the defensive rule
`ingestIntrusion` already uses at :206-207). **Non-obvious cost:** `l3/watchlist.ts:508` picks its
group key on whether `zoneId` is set, so populating it flips every plate read onto the *same* key
`ingestIntrusion` uses — a watchlist hit and a person crossing on one camera within 300 s would
merge into one incident. Fix in the same commit:
`` groupKey: `${input.cameraId}:${input.zoneId ?? "site"}:plate:${formattedPlate}` ``.

**Do not add scope columns to `watchlist_entry`.** The vision service never sees a watchlist —
matching happens on the node *after* the read arrives, so scoping buys zero CPU and zero bandwidth;
it only suppresses a match already computed. A plate BOLO is intrinsically global, and the first
real failure of per-zone scoping is a hit missed at the one camera nobody ticked. `watchlist_entry`
also has no UNIQUE on `plate_number`, so scope columns without a uniqueness rule create "two rows
for one plate, which severity wins?" — the exact ambiguity `zone_target_unique` exists to prevent.
The honest v2, if ever wanted: nullable `zone_id` meaning *NULL = everywhere* plus
`UNIQUE(org_id, plate_number, IFNULL(zone_id,''))`, the same shape as `zone_target`.

**E2. The pytest suite.** §11 names `geometry.py` and `fence.py` as the two worth testing first;
both are pure arithmetic and `FenceModule.process()` never dereferences `frame`, so
`process(None, detections, ctx)` runs with no OpenCV, no network, no weights. Add
`ibvap/tests/test_geometry.py` (ground point is bottom-centre; on-edge counts as inside; the
tri-state; inbound/outbound for a line drawn both ways; polyline kink; polygon enter/leave;
`direction_wanted`) and `ibvap/tests/test_fence.py` (clean walk confirms once; genuine flicker
still rejected; cooldown suppresses a repeat in the same direction and **not** the opposite;
`direction` filtering; too-few-points zone skipped; `provisional` in the payload; track lost
mid-crossing). **Both files carry the side-0 regression, named as such** — today it yields
`confirmed=0, rejected_flicker=1` and must yield `1, 0`.

§9 forbids a new `requirements.txt` line without justification, and a demo laptop should never
install a test runner the night before submission: put pytest in a new `ibvap/requirements-dev.txt`
and add a line to the existing "NOT listed, on purpose" section saying where it lives and why.

**E3. `ibvap/CLAUDE.md` corrections.** §12 task 2, §14's "Migration shim" and §10's LAYOUT all
describe `frontend/src/lib/boxes.ts` as live; it was deleted in `297ce5c` and replaced by
`lib/live.ts`. A source-of-truth document asserting a deleted file exists is one nobody trusts on
the second read. Mark task 2 done in place (do not renumber), strike the shim paragraph, fix the
layout block. Also: §11's "there is no Python test suite" becomes false with E2 — update it with
the runner command in the same commit. And add the §15 paragraph from Phase D plus the provisional
paragraph from A2, so the next reader doesn't "clean up" the flag and re-create the bug.

§7 still applies to the new suite: passing tests are evidence the geometry is right on the cases
written. They are **not** an accuracy figure and nothing in a slide may turn "25 tests pass" into a
detection-rate claim.

---

## Verification

1. **Backend** — `cd backend && bun test`. All 79 must stay green (five need the Phase C fix). New:
   `events.test.ts`, plus additions to `zones.test.ts` and `watchlist.test.ts`.
2. **Python** — `cd ibvap && python -m pytest tests/`. Under a second on a Ryzen 3, no network, no
   model download.
3. **End to end**, three terminals from the repo root (§11):
   ```powershell
   media/bin/mediamtx.exe media/mediamtx.yml
   bun run dev
   python ibvap/main.py --seconds 60
   ```
   - Create a zone with one camera. **Before drawing**, walk the clip: the tile shows the amber
     provisional zone, the events page shows the crossing recorded-not-alerted with reason
     `zone_not_placed`, and no alert fires.
   - Draw the area. Within `IBVAP_ZONE_REFRESH_SECONDS` (15) the same crossing alerts at the
     target's severity — no restart.
   - Click the event row → lands on its incident.
   - Add that camera to a second zone → **409** naming the zone that holds it.
   - Kill the node, restart the vision service: it loads the cache, says so on stdout, marks events
     stale. Bring the node back: queued events land, stale, not alerted.
4. **The side-0 regression** — a horizontal line zone at y = 0.50, `direction: "both"`, subject
   walking straight through: exactly one confirmed `inbound`, zero `rejected_flicker`.
5. **Letterbox** — point a camera at a non-16:9 clip; the zone drawn in the editor must sit in the
   same place on the fence page tile.

---

## For the demo video

The whole flow is one continuous take, and the wait in the middle is 15 s of dead air. Set
`IBVAP_ZONE_REFRESH_SECONDS=5` on the recording machine and **say so on camera** rather than
cutting — §7's honesty rules make a stated config a strength, and a jury that spots an invisible
cut assumes the worst.

Better: the provisional bug is the best narrative beat in the build. Show the amber provisional
tile, let a walker trip the default line, show the incident arrive flagged and deliberately *not*
alerting, then draw the real shape and show it go away. *"We found a way our own system could lie,
and we made it say so out loud"* is the §8 positioning demonstrated rather than claimed.
