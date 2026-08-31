import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The fence state machine, exercised against a throwaway database.
 *
 * Frame timestamps are supplied by the test, and the confirm delay is measured
 * in seconds off those timestamps -- so the whole wait-and-confirm behaviour is
 * testable without any real waiting.
 */

const DB_PATH = join(tmpdir(), `ibvap-test-${Date.now()}.db`);
process.env.IBVAP_DB = DB_PATH;

let fence: typeof import("../src/l2/fence");
let events: typeof import("../src/l3/events");
let audit: typeof import("../src/l3/audit");
let db: typeof import("../src/db");

beforeAll(async () => {
  db = await import("../src/db");
  const { seed } = await import("../src/db/seed");
  seed();
  fence = await import("../src/l2/fence");
  events = await import("../src/l3/events");
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

const ORG = "org_bsf";
const CAMERA = "cam_fence_north";
const ZONE = "zone_fence_line";

const SIZE: [number, number] = [0.045, 0.16];

/** Place a subject's feet at (x, y). */
function frameAt(
  seconds: number,
  className: string,
  trackRef: string,
  x: number,
  y: number,
) {
  return {
    camera_id: CAMERA,
    occurred_at: new Date(BASE + seconds * 1000).toISOString(),
    simulated: true,
    source_id: "test",
    detections: [
      {
        track_ref: trackRef,
        class: className,
        confidence: 0.9,
        bbox: [x - SIZE[0] / 2, y - SIZE[1], SIZE[0], SIZE[1]] as [number, number, number, number],
      },
    ],
  };
}

const BASE = Date.parse("2026-08-31T02:00:00.000Z");

/** Crossings recorded for one track, newest last. */
function crossingsFor(trackRef: string) {
  return events
    .queryEvents(ORG, { zoneId: ZONE, limit: 500 })
    .filter((e) => e.evidence?.trackRef === trackRef || e.rule === "zone.crossing.unconfirmed_track_lost")
    .reverse();
}

beforeEach(() => {
  fence.resetFenceMemory();
});

describe("virtual fence", () => {
  test("a person who crosses and stays across raises a confirmed critical alert", () => {
    const track = "t-intruder";
    // Far side, then across, then still across once the confirm delay has run.
    fence.processFrame(frameAt(0, "person", track, 0.5, 0.30));
    fence.processFrame(frameAt(1, "person", track, 0.5, 0.90));
    expect(crossingsFor(track)).toHaveLength(0); // held, deliberately

    fence.processFrame(frameAt(4, "person", track, 0.5, 0.92));

    const crossings = crossingsFor(track);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.rule).toBe("zone.crossing.confirmed");
    expect(crossings[0]!.direction).toBe("inbound");
    expect(crossings[0]!.severity).toBe("CRITICAL");
    expect(crossings[0]!.alertable).toBe(true);
  });

  test("the crossing carries the evidence needed to explain it", () => {
    const track = "t-evidence";
    fence.processFrame(frameAt(10, "person", track, 0.4, 0.30));
    fence.processFrame(frameAt(11, "person", track, 0.4, 0.90));
    fence.processFrame(frameAt(14, "person", track, 0.4, 0.92));

    const evidence = crossingsFor(track)[0]!.evidence;
    expect(evidence.zone.name).toBe("Fence line north");
    expect(evidence.path.length).toBeGreaterThan(1);
    expect(evidence.confirmSeconds).toBe(2);
    expect(evidence.heldSeconds).toBeGreaterThanOrEqual(2);
    expect(evidence.crossedAt).toBeDefined();
  });

  test("cattle crossing the same line is logged and never alerted", () => {
    const track = "t-cow";
    fence.processFrame(frameAt(20, "cattle", track, 0.7, 0.30));
    fence.processFrame(frameAt(21, "cattle", track, 0.7, 0.90));
    fence.processFrame(frameAt(24, "cattle", track, 0.7, 0.92));

    const crossings = crossingsFor(track);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.alertable).toBe(false);
    expect(crossings[0]!.severity).toBe("INFO");
    expect(crossings[0]!.suppressedReason).toBe("class_is_log_only");
  });

  test("a flicker across the line is rejected rather than shouted", () => {
    const track = "t-flicker";
    fence.processFrame(frameAt(30, "person", track, 0.6, 0.90));
    fence.processFrame(frameAt(30.5, "person", track, 0.6, 0.30)); // steps over
    fence.processFrame(frameAt(31, "person", track, 0.6, 0.90)); // and straight back

    const crossings = crossingsFor(track);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.rule).toBe("zone.crossing.flicker_rejected");
    expect(crossings[0]!.alertable).toBe(false);
  });

  test("a subject that never crosses produces nothing at all", () => {
    const track = "t-passerby";
    fence.processFrame(frameAt(40, "person", track, 0.2, 0.90));
    fence.processFrame(frameAt(41, "person", track, 0.5, 0.88));
    fence.processFrame(frameAt(44, "person", track, 0.8, 0.86));

    expect(crossingsFor(track)).toHaveLength(0);
  });

  test("a class the zone was not asked to watch is ignored entirely", () => {
    const track = "t-bird";
    fence.processFrame(frameAt(50, "bird", track, 0.5, 0.30));
    fence.processFrame(frameAt(51, "bird", track, 0.5, 0.90));
    fence.processFrame(frameAt(54, "bird", track, 0.5, 0.92));

    expect(crossingsFor(track)).toHaveLength(0);
  });

  test("crossings close together on one zone become a single piece of work", () => {
    for (const track of ["t-group-a", "t-group-b"]) {
      fence.processFrame(frameAt(60, "person", track, 0.45, 0.30));
      fence.processFrame(frameAt(61, "person", track, 0.45, 0.90));
      fence.processFrame(frameAt(64, "person", track, 0.45, 0.92));
      fence.resetFenceMemory();
    }

    const incidentIds = new Set(
      ["t-group-a", "t-group-b"].map((track) => crossingsFor(track)[0]!.incidentId),
    );
    // Two separate people, two crossings, one incident for the operator to work.
    expect(incidentIds.size).toBe(1);
  });

  test("a crossing beyond the grouping window opens a fresh incident", () => {
    fence.processFrame(frameAt(60, "person", "t-window-a", 0.45, 0.30));
    fence.processFrame(frameAt(61, "person", "t-window-a", 0.45, 0.90));
    fence.processFrame(frameAt(64, "person", "t-window-a", 0.45, 0.92));
    fence.resetFenceMemory();

    // Well past the 300s window, so this is not the same piece of work.
    fence.processFrame(frameAt(900, "person", "t-window-b", 0.45, 0.30));
    fence.processFrame(frameAt(901, "person", "t-window-b", 0.45, 0.90));
    fence.processFrame(frameAt(904, "person", "t-window-b", 0.45, 0.92));

    expect(crossingsFor("t-window-a")[0]!.incidentId).not.toBe(
      crossingsFor("t-window-b")[0]!.incidentId,
    );
  });
});

describe("audit log", () => {
  const supervisor = { id: "usr_supervisor", name: "Shift Supervisor", role: "supervisor" as const };

  test("an incident's status comes from the recorded decision, not a column", () => {
    const incidents = events.listIncidents(ORG, { limit: 1 });
    const target = incidents[0]!;
    expect(target.status).toBe("OPEN");

    audit.recordAction({
      actor: supervisor,
      orgId: ORG,
      verb: "incident.escalate",
      targetType: "incident",
      targetId: target.id,
      reason: "movement confirmed on the patrol road",
    });

    expect(events.getIncident(target.id)!.status).toBe("ESCALATED");
  });

  test("escalating without a reason is refused", () => {
    const target = events.listIncidents(ORG, { limit: 1 })[0]!;
    expect(() =>
      audit.recordAction({
        actor: supervisor,
        orgId: ORG,
        verb: "incident.escalate",
        targetType: "incident",
        targetId: target.id,
      }),
    ).toThrow(/requires a stated reason/);
  });

  test("the hash chain verifies", () => {
    const verdict = audit.verifyChain();
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBeGreaterThan(0);
  });

  test("the log is append-only", () => {
    expect(() => db.run("UPDATE action SET reason = 'edited' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM action WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.run("UPDATE event SET severity = 'INFO' WHERE seq = 1")).toThrow(/append-only/);
  });

  test("tampering with a row breaks the chain from that point", () => {
    // The triggers make this impossible through the app, so reach past them to
    // prove the chain actually detects it.
    db.db.exec("DROP TRIGGER action_no_update");
    db.run("UPDATE action SET reason = 'quietly rewritten' WHERE seq = 1");

    const verdict = audit.verifyChain();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt?.seq).toBe(1);
  });
});
