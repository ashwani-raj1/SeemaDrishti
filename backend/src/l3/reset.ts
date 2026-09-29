import { all, db, one, run } from "../db";

/**
 * Emptying the operational record.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * `schema.sql` carries two triggers that exist precisely to stop this:
 *
 *   CREATE TRIGGER event_no_delete BEFORE DELETE ON event
 *   BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;
 *
 * That is not an oversight to work around -- it is the tamper-evident event log
 * this project claims as a differentiator (vision-service/CLAUDE.md section 8), and a
 * DELETE that quietly slipped past it would make the claim false. So this
 * module does the one thing that keeps the claim true: it drops the guard,
 * deletes, and puts the guard back, all inside one transaction, and the CALLER
 * is required to have written an audit row first.
 *
 * WHAT SURVIVES, AND WHY EACH ONE
 *
 *   action        The audit log. NEVER cleared, and this is the whole design:
 *                 the record can be emptied, but the FACT that somebody
 *                 emptied it cannot. Its rows are hash-chained to each other,
 *                 not to events, so removing events leaves the chain intact
 *                 and `verifyChain()` still passes. An operator arriving at an
 *                 empty console can still find out who emptied it and why.
 *   zone, camera  Configuration somebody drew and positioned. A "clear the
 *                 demo data" button that also threw away an afternoon of zone
 *                 drawing would be used exactly once.
 *   app_user,
 *   watchlist     Same reasoning: configuration, not observation.
 *
 * WHAT GOES, in foreign-key order
 *
 *   alert           child of incident
 *   event           the record itself
 *   incident        the grouping
 *   tracked_thing   subjects that only ever existed to be pointed at by events
 *   plate_detection observations, same class of thing as events
 *
 * THIS IS FOR A DEMO OR A DEV BOX. On a deployed post, a supervisor wanting a
 * clean slate wants a new retention window, not a wipe -- and that is a
 * different feature with a different shape.
 */

export interface ResetCounts {
  events: number;
  incidents: number;
  alerts: number;
  trackedThings: number;
  plateDetections: number;
}

/** What a reset WOULD remove, without removing it. */
export function resetPreview(): ResetCounts {
  const count = (table: string): number =>
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;

  return {
    events: count("event"),
    incidents: count("incident"),
    alerts: count("alert"),
    trackedThings: count("tracked_thing"),
    plateDetections: count("plate_detection"),
  };
}

/**
 * The triggers guarding the event log, so they can be put back exactly.
 *
 * Read from `sqlite_master` rather than hardcoded here: two copies of the same
 * DDL is how a guard comes back subtly weaker than it went away, and this is
 * the one function in the codebase where that would be invisible.
 */
function eventGuards(): Array<{ name: string; sql: string }> {
  return all<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'event' AND sql IS NOT NULL`,
  );
}

/**
 * Clear the operational record. Returns what was actually removed.
 *
 * The caller MUST have recorded an audit action before calling this, and the
 * route does. Doing it the other way round would mean a crash between the
 * delete and the audit row leaves a console that has forgotten everything with
 * nothing saying why -- which is indistinguishable from the tampering these
 * triggers exist to make impossible.
 */
export function resetOperationalData(): ResetCounts {
  const removed = resetPreview();
  const guards = eventGuards();

  db.transaction(() => {
    // SQLite has no "disable trigger". Dropping and recreating is the only
    // way, which is exactly why it happens here, in one place, in one
    // transaction -- a failure anywhere in this block rolls back the deletes
    // AND the dropped guards together.
    for (const guard of guards) run(`DROP TRIGGER IF EXISTS ${guard.name}`);

    run("DELETE FROM alert");
    run("DELETE FROM event");
    run("DELETE FROM incident");
    run("DELETE FROM tracked_thing");
    run("DELETE FROM plate_detection");

    for (const guard of guards) run(guard.sql);
  })();

  // Belt and braces: if the guards did not come back, the log is no longer
  // append-only and every claim made about it is false. Louder than a silent
  // return, because nothing downstream would notice.
  const restored = eventGuards().length;
  if (restored < guards.length) {
    throw new Error(
      `event log guards were not restored (${restored} of ${guards.length}); ` +
        "the append-only rule is not in force - restore from backup",
    );
  }

  return removed;
}
