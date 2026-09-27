import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The searchable log.
 *
 * `queryEvents` is the one door onto the record for both `/api/events` and the
 * audited `/api/history`, so a filter that is wrong here is wrong on the
 * operator's screen and in the retrospective search at the same time.
 *
 * The filter worth testing hardest is the tri-state `alertable`. After the
 * provisional-zone work, "what did we record and deliberately not shout about"
 * is a real operator question, and a boolean that can only ask for
 * `alertable = 1` cannot express it.
 */

const DB_PATH = join(tmpdir(), `ibvap-events-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.IBVAP_DB = DB_PATH;

let events: typeof import("../src/l3/events");

const ORG = "org_bsf";
const SITE = "site_bop_attari";
const CAM = "cam_fence_north";

beforeAll(async () => {
  await import("../src/db");
  const { seed } = await import("../src/db/seed");
  seed();
  events = await import("../src/l3/events");

  const base = Date.parse("2026-09-07T01:00:00.000Z");
  const at = (n: number) => new Date(base + n * 60_000).toISOString();

  // An alerted crossing, a suppressed one, and a different kind entirely --
  // enough for every filter below to be able to pick the wrong rows.
  events.recordEvent({
    orgId: ORG, siteId: SITE, kind: "zone_crossing",
    sourceType: "camera", sourceId: "test", simulated: false,
    cameraId: CAM, zoneId: "zone_perimeter", trackedThingId: null,
    class: "person", direction: "inbound", rule: "zone.crossing.confirmed",
    confidence: 0.9, severity: "CRITICAL", alertable: true, suppressedReason: null,
    occurredAt: at(0), title: "person crossed", evidence: { marker: "alerted" },
    groupKey: `${CAM}:zone_perimeter:alerted`,
  });

  events.recordEvent({
    orgId: ORG, siteId: SITE, kind: "zone_crossing",
    sourceType: "camera", sourceId: "test", simulated: false,
    cameraId: CAM, zoneId: "zone_perimeter", trackedThingId: null,
    class: "person", direction: "inbound", rule: "zone.crossing.confirmed",
    confidence: 0.9, severity: "INFO", alertable: false,
    suppressedReason: "zone_not_placed",
    occurredAt: at(1), title: "person crossed an undrawn shape",
    evidence: { marker: "provisional" },
    groupKey: `${CAM}:zone_perimeter:provisional`,
  });

  events.recordEvent({
    orgId: ORG, siteId: SITE, kind: "camera_health",
    sourceType: "camera", sourceId: "test", simulated: true,
    cameraId: CAM, zoneId: null, trackedThingId: null,
    class: "camera", direction: null, rule: "camera.degraded",
    confidence: 1, severity: "WARNING", alertable: false,
    suppressedReason: null,
    occurredAt: at(2), title: "camera degraded", evidence: { marker: "health" },
    groupKey: `${CAM}:health`,
  });
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

const markersOf = (rows: Array<{ evidence?: any }>) =>
  rows.map((r) => r.evidence?.marker).filter(Boolean).sort();

describe("filtering the record", () => {
  test("by kind", () => {
    const found = events.queryEvents(ORG, { kind: "camera_health", limit: 50 });
    expect(markersOf(found)).toEqual(["health"]);
  });

  test("alertable=false returns the suppressed rows and excludes the alerted one", () => {
    const suppressed = events.queryEvents(ORG, { alertable: false, cameraId: CAM, limit: 50 });
    expect(markersOf(suppressed)).toEqual(["health", "provisional"]);
    expect(markersOf(suppressed)).not.toContain("alerted");
  });

  test("alertable=true is still the alerted rows only", () => {
    const alerted = events.queryEvents(ORG, { alertable: true, cameraId: CAM, limit: 50 });
    expect(markersOf(alerted)).toEqual(["alerted"]);
  });

  test("omitting alertable returns both -- the tri-state's whole point", () => {
    const all = events.queryEvents(ORG, { cameraId: CAM, kind: "zone_crossing", limit: 50 });
    expect(markersOf(all)).toEqual(["alerted", "provisional"]);
  });

  test("by suppressed reason -- what fired against a shape nobody drew", () => {
    const found = events.queryEvents(ORG, { suppressedReason: "zone_not_placed", limit: 50 });
    expect(markersOf(found)).toEqual(["provisional"]);
  });

  test("by simulated", () => {
    expect(markersOf(events.queryEvents(ORG, { simulated: true, cameraId: CAM, limit: 50 })))
      .toEqual(["health"]);
  });

  test("by incident, so an events row can be followed to its incident", () => {
    const alerted = events.queryEvents(ORG, { alertable: true, cameraId: CAM, limit: 50 })[0]!;
    expect(alerted.incidentId).toBeTruthy();

    const siblings = events.queryEvents(ORG, { incidentId: alerted.incidentId!, limit: 50 });
    expect(siblings.map((e) => e.id)).toContain(alerted.id);
  });

  test("a suppressed event still gets an incident -- it is recorded, not hidden", () => {
    const provisional = events
      .queryEvents(ORG, { suppressedReason: "zone_not_placed", limit: 50 })[0]!;
    expect(provisional.incidentId).toBeTruthy();
    expect(provisional.alertable).toBe(false);
  });

  test("limit is clamped, so one query cannot pull the whole table", () => {
    // The clamp is 2000; asking for more must not widen it.
    const rows = events.queryEvents(ORG, { limit: 99_999 });
    expect(rows.length).toBeLessThanOrEqual(2000);
  });

  test("the deprecated alertableOnly still works for callers not yet moved", () => {
    const rows = events.queryEvents(ORG, { alertableOnly: true, cameraId: CAM, limit: 50 });
    expect(markersOf(rows)).toEqual(["alerted"]);
  });
});
