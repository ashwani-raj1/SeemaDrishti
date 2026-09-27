import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point this process at a throwaway database, as a side effect of being
 * imported.
 *
 * WHY A MODULE AND NOT A LINE IN THE TEST FILE: `import` statements are
 * hoisted and run before any statement in the module body, so
 * `process.env.IBVAP_DB = ...` written at the top of a test file executes
 * AFTER `../src/db` has already opened whatever database it found. The
 * assignment looks like it works and does nothing. Importing this first works
 * because static imports run in source order.
 *
 * Test files that use `await import()` inside `beforeAll` sidestep the problem
 * a different way; either is fine, but a test must never write to
 * `backend/ibvap.db`. One that does passes or fails according to what somebody
 * last clicked in the console.
 */
export const TEMP_DB = join(
  tmpdir(),
  `ibvap-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

process.env.IBVAP_DB = TEMP_DB;

export function removeTempDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(TEMP_DB + suffix);
    } catch {
      /* nothing to clean up */
    }
  }
}
