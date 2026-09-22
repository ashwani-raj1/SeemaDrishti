import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The grouping window, now that it is a setting rather than a constant.
 *
 * The test that matters is not "the number round-trips" -- it is that changing
 * the number changes what an operator sees, because the whole point of moving
 * it out of `l3/events.ts` was that a post can retune grouping without a
 * deploy. So every case below asserts on incident identity, not on the column.
 */

const DB_PATH = join(tmpdir(), `ibvap-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.IBVAP_DB = DB_PATH;

let events: typeof import("../src/l3/events");
let settings: typeof import("../src/l3/settings");
let audit: typeof import("../src/l3/audit");

const ORG = "org_bsf";
const SITE = "site_bop_attari";
const CAM = "cam_fence_north";

const SUPERVISOR = { id: "usr_supervisor", name: "Shift Supervisor", role: "supervisor" as const };

/** One crossing, at a stated moment, on a stated group key. */
const crossing = (occurredAt: string, groupKey: string) =>
  events.recordEvent({
    orgId: ORG, siteId: SITE, kind: "zone_crossing",
    sourceType: "camera", sourceId: "test", simulated: false,
    cameraId: CAM, zoneId: "zone_perimeter", trackedThingId: null,
    class: "person", direction: "inbound", rule: "zone.crossing.confirmed",
    confidence: 0.9, severity: "WARNING", alertable: true, suppressedReason: null,
    occurredAt, title: "person crossed", evidence: {}, groupKey,
  });

const base = Date.parse("2026-09-07T01:00:00.000Z");
/** `n` seconds after the base moment. */
const at = (n: number) => new Date(base + n * 1000).toISOString();

beforeAll(async () => {
  await import("../src/db");
  const { seed } = await import("../src/db/seed");
  seed();
  events = await import("../src/l3/events");
  settings = await import("../src/l3/settings");
  audit = await import("../src/l3/audit");
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

describe("the window in force", () => {
  test("a fresh node keeps the value that used to be hardcoded", () => {
    expect(settings.getSettings(ORG).groupingWindowSeconds).toBe(300);
  });

  test("an unknown org falls back rather than throwing", () => {
    // A settings read must never be the reason an intrusion fails to record.
    expect(settings.groupingWindowSeconds("org_that_does_not_exist")).toBe(300);
  });
});

describe("grouping obeys the setting", () => {
  test("inside the window, two crossings are one incident", () => {
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 300 });

    const first = crossing(at(0), `${CAM}:inside`);
    const second = crossing(at(120), `${CAM}:inside`);
    expect(second.incident_id).toBe(first.incident_id!);
  });

  test("past the window, the same key opens a second incident", () => {
    const first = crossing(at(0), `${CAM}:outside`);
    const second = crossing(at(301), `${CAM}:outside`);
    expect(second.incident_id).not.toBe(first.incident_id);
  });

  test("narrowing the window splits what used to group", () => {
    // 120s apart grouped at 300. Nothing about the events changes here -- only
    // the setting -- and they must now be two separate pieces of work.
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 60 });

    const first = crossing(at(0), `${CAM}:narrowed`);
    const second = crossing(at(120), `${CAM}:narrowed`);
    expect(second.incident_id).not.toBe(first.incident_id);
  });

  test("widening the window joins what used to split", () => {
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 1800 });

    const first = crossing(at(0), `${CAM}:widened`);
    const second = crossing(at(900), `${CAM}:widened`);
    expect(second.incident_id).toBe(first.incident_id!);
  });

  test("the window slides off the last event, not off the first", () => {
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 300 });

    // Three crossings, each 200s after the one before. The third is 400s after
    // the first -- past the window if it were measured from when the incident
    // opened -- and must still join, because a subject who keeps moving keeps
    // one incident alive.
    const first = crossing(at(0), `${CAM}:sliding`);
    crossing(at(200), `${CAM}:sliding`);
    const third = crossing(at(400), `${CAM}:sliding`);
    expect(third.incident_id).toBe(first.incident_id!);
  });
});

describe("changing it is a decision, and is recorded", () => {
  test("an audit row carries the before and the after", () => {
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 300 });
    settings.updateSettings({
      actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 420,
      reason: "vehicles queue at the gate for longer than five minutes",
    });

    const rows = audit.queryActions(ORG, { verb: "settings.update", limit: 1 });
    expect(rows.length).toBe(1);
    // `shape()` has already parsed the JSON columns, so these are objects.
    expect(rows[0]!.before).toEqual({ groupingWindowSeconds: 300 });
    expect(rows[0]!.after).toEqual({ groupingWindowSeconds: 420 });
    expect(rows[0]!.reason).toBe("vehicles queue at the gate for longer than five minutes");
  });

  test("saving the value already in force records nothing", () => {
    const before = audit.queryActions(ORG, { verb: "settings.update", limit: 100 }).length;
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 420 });
    const after = audit.queryActions(ORG, { verb: "settings.update", limit: 100 }).length;
    expect(after).toBe(before);
  });

  test("a value outside the bounds is clamped, never stored raw", () => {
    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: 99_999 });
    expect(settings.getSettings(ORG).groupingWindowSeconds)
      .toBe(settings.MAX_GROUPING_WINDOW_SECONDS);

    settings.updateSettings({ actor: SUPERVISOR, orgId: ORG, groupingWindowSeconds: -5 });
    expect(settings.getSettings(ORG).groupingWindowSeconds)
      .toBe(settings.MIN_GROUPING_WINDOW_SECONDS);
  });
});
