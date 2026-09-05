# Code guidelines

## The three rules

**1. Layers only go up.** `L2 fence → L3 events/audit → L4 hooks/bus`. Nothing calls
downward, nothing skips a layer. One exception, on purpose: a sensor alert enters at L3,
skipping the camera pipeline — that's how new sensor types get absorbed.

**2. Nothing force-specific in code.** A fence line and a jetty perimeter are the same
primitive with a different `kind`. If you write `if (force === "navy")`, the platform
claim is gone. Force-specific facts are data: `backend/src/db/seed.ts`,
`frontend/client.json`, `frontend/src/client/{geography,profiles}.ts`.

**3. No state change without an audit row.** `event` and `action` are append-only (SQLite
triggers). An incident has no `status` column — it's derived from the audit log by the
`incident_state` view. Don't add one.

## Backend

- Ids: `id("evt")`, `id("inc")`… the prefix makes a raw row readable.
- Times: ISO strings via `nowIso()`. `occurred_at` = when it happened, `received_at` = when we heard.
- SQL: only through `all` / `one` / `run` / `transact`, always `$named` params.
- Booleans round-trip as 0/1 — convert with `bool()` / `int()`, don't leak a `1` outward.
- `snake_case` in the DB and on the wire, `camelCase` in TS. Translate in one place per
  object: `shapeEvent`, `shape`, `zoneView`, `getIncident`.
- Throw, don't return errors: `BadRequest` 400, `Forbidden` 403, `NotFound` 404,
  `ReasonRequired` 422. The console branches on these.

**New route:** wrap in `handled()` → `actorOf(req)` if it writes → `requireRole` if
restricted → validate the body here, not in L2 → `recordAction()` if a human decided
something → `publish()` → return `json()`.

Everything ingests through `src/l4/hooks.ts`. `simulated` is set once at the adapter and
travels with the event.

## Frontend

- `@/` is `src/`. No `../../..`.
- All HTTP through `src/lib/api.ts` — it attaches `x-ibvap-actor`. A stray `fetch` is an
  anonymous write.
- One `EventSource` for the app, in `src/lib/stream.ts`. Subscribe with `onStream(kind, fn)`.
- Fetching is `useResource` / `usePoll`. No query library; the node pushes.
- `cn` comes from `@/lib/utils`. Files under `components/ui/` importing it from the `cn`
  package are CLI drift — don't copy that.
- `src/lib/types.ts` mirrors the backend by hand on purpose; the backend is the authority.

**New section:** add `features/<name>/screen.tsx` in a `<PageShell>`, then one entry in
`features/registry.tsx` — the sidebar and router both read it, so they can't drift. No
endpoint yet? `backed: false` and render `<NotWired>`. Never invent plausible data.

## Tests

`bun test`, no framework. Backend tests point `IBVAP_DB` at a tmpdir file before
importing anything. Test the load-bearing logic — geometry, the fence state machine, the
hash chain, the role ladder — not every function.

## Comments

Explain *why*. `#13` / `Plate 07` reference the brief in `plans/` — keep them when moving
code. A `ponytail:` comment is a deliberate shortcut with its upgrade path named.

## Done means

- [ ] `bun test` passes in both packages
- [ ] Survives the node being unreachable and the stream dying
- [ ] Human decisions leave an `action` row, with a reason where required
- [ ] Simulated data still says SIMULATED everywhere it surfaces
