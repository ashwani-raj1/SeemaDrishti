import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Emptying the operational record.
 *
 * The thing worth testing hardest is not that the rows go -- it is that the
 * append-only GUARD comes back. `resetOperationalData` drops two triggers to do
 * its work, and a reset that left them off would turn the tamper-evident event
 * log into an ordinary table, silently, with every claim made about it still on
 * the slides.
 */

const DB_PATH = join(tmpdir(), `ibvap-reset-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.IBVAP_DB = DB_PATH;

let db: typeof import("../src/db");
let events: typeof import("../src/l3/events");
let audit: typeof import("../src/l3/audit");
let reset: typeof import("../src/l3/reset");

const ORG = "org_bsf";
const SITE = "site_bop_attari";

beforeAll(async () => {
  db = await import("../src/db");
  const { seed } = await import("../src/db/seed");
  seed();
  events = await import("../src/l3/events");
  audit = await import("../src/l3/audit");
  reset = await import("../src/l3/reset");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_PATH + suffix);
    } catch {
      /* nothing to clean up */
    }
  }
});

const guardCount = () =>
  db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'event'",
  ).length;

function anEvent(className = "person") {
  return events.recordEvent({
    orgId: ORG,
    siteId: SITE,
    kind: "zone_crossing",
    sourceType: "camera",
    sourceId: "test",
    simulated: true,
    cameraId: "cam_fence_north",
    class: className,
    severity: "CRITICAL",
    alertable: true,
    occurredAt: new Date().toISOString(),
    groupKey: `test:${className}:${Math.random()}`,
    title: `${className} crossed`,
  } as any);
}

describe("resetting the operational record", () => {
  test("the event log refuses a plain delete", () => {
    anEvent();
    // The guard this whole module exists to work around, proven to be real
    // before anything claims to have handled it.
    expect(() => db.run("DELETE FROM event")).toThrow(/append-only/);
  });

  test("it reports what it would remove without removing it", () => {
    const before = reset.resetPreview();
    expect(before.events).toBeGreaterThan(0);
    expect(reset.resetPreview().events).toBe(before.events);
  });

  test("it clears events, incidents and alerts", () => {
    anEvent("vehicle");
    const removed = reset.resetOperationalData();

    expect(removed.events).toBeGreaterThan(0);
    const after = reset.resetPreview();
    expect(after.events).toBe(0);
    expect(after.incidents).toBe(0);
    expect(after.alerts).toBe(0);
    expect(after.trackedThings).toBe(0);
  });

  test("the append-only guard is back afterwards", () => {
    // The whole point. A reset that leaves the triggers off turns the
    // tamper-evident log into an ordinary table and nothing downstream notices.
    expect(guardCount()).toBe(2);
    anEvent();
    expect(() => db.run("DELETE FROM event")).toThrow(/append-only/);
  });

  test("the audit log survives and its chain still verifies", () => {
    // The record can be emptied; the fact that somebody emptied it cannot.
    // Actions are chained to each other rather than to events, so clearing
    // events must leave the chain whole.
    audit.recordAction({
      actor: { id: "usr_supervisor", name: "Test", role: "supervisor" },
      orgId: ORG,
      verb: "admin.reset",
      targetType: "site",
      targetId: SITE,
      reason: "test wipe",
    });

    const before = audit.queryActions(ORG, { limit: 200 }).length;
    // Captured rather than assumed true. `verifyChain()` walks EVERY action row
    // in the database, and under `bun test` the db module is a singleton shared
    // with whichever test file imported it first -- so the chain's state before
    // this test is not this test's business. What IS its business is that a
    // reset does not change it.
    const chainBefore = audit.verifyChain().ok;

    reset.resetOperationalData();
    const after = audit.queryActions(ORG, { limit: 200 });

    expect(after.length).toBe(before);
    expect(after.some((action) => action.verb === "admin.reset")).toBe(true);
    expect(audit.verifyChain().ok).toBe(chainBefore);
  });

  test("configuration is left alone", () => {
    // A "clear the demo data" button that also threw away an afternoon of zone
    // drawing would be used exactly once.
    const zones = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM zone")[0]!.n;
    const cameras = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM camera")[0]!.n;

    reset.resetOperationalData();

    expect(db.all<{ n: number }>("SELECT COUNT(*) AS n FROM zone")[0]!.n).toBe(zones);
    expect(db.all<{ n: number }>("SELECT COUNT(*) AS n FROM camera")[0]!.n).toBe(cameras);
  });
});
