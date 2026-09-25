import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { WATCHLIST_TEST_DB } from "./watchlist-env";
import { DEFAULT_ORG, seed } from "../src/db/seed";
import {
  createWatchlistEntry,
  deleteWatchlistEntry,
  findWatchlistMatch,
  formatPlate,
  getVehicleTraffic,
  getWatchlistEntry,
  getWatchlistStats,
  listWatchlist,
  normalizePlate,
  platesMatch,
  processVehicleAndPlateDetection,
  queryPlateDetections,
  updateWatchlistEntry,
} from "../src/l3/watchlist";
import { actionsFor } from "../src/l3/audit";
import { queryEvents } from "../src/l3/events";
import { ingestVisionEvent, parseVisionEvent } from "../src/l4/vision";

const SUPERVISOR = { id: "usr_supervisor", name: "Shift Supervisor", role: "supervisor" as const };
const OPERATOR = { id: "usr_operator", name: "Duty Operator", role: "operator" as const };

seed();

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(WATCHLIST_TEST_DB + suffix);
    } catch {
      /* already removed */
    }
  }
});

describe("plate normalization and matching", () => {
  test("normalizes plates by trimming and removing separators", () => {
    expect(normalizePlate("pb-02-ak-4821")).toBe("PB02AK4821");
    expect(normalizePlate("  HR 26 DQ 5512 ")).toBe("HR26DQ5512");
  });

  test("formats standard Indian vehicle plates", () => {
    expect(formatPlate("PB02AK4821")).toBe("PB 02 AK 4821");
    expect(formatPlate("HR26DQ5512")).toBe("HR 26 DQ 5512");
  });

  test("exact match comparison", () => {
    const res = platesMatch("PB 02 AK 4821", "PB02AK4821");
    expect(res.match).toBe(true);
    expect(res.exact).toBe(true);
    expect(res.confidence).toBe(1.0);
  });

  test("fuzzy match handles common OCR character confusion (0 vs O, 8 vs B, 1 vs I)", () => {
    const res = platesMatch("PB O2 AK 4821", "PB 02 AK 4821");
    expect(res.match).toBe(true);
    expect(res.exact).toBe(false);
    expect(res.confidence).toBeGreaterThan(0.85);
  });

  test("does not match incomplete plate fragments", () => {
    const res = platesMatch("PB 02 AK 482", "PB 02 AK 4821");
    expect(res.match).toBe(false);
  });

  test("does not alarm on two simultaneous OCR substitutions", () => {
    const res = platesMatch("P8 O2 AK 4821", "PB 02 AK 4821");
    expect(res.match).toBe(false);
  });
});

describe("watchlist CRUD and audit accountability", () => {
  test("creates a new watchlist entry and records audit action", () => {
    const entry = createWatchlistEntry(
      {
        orgId: DEFAULT_ORG,
        plateNumber: "RJ 14 XY 9999",
        vehicleType: "truck",
        makeModel: "Ashok Leyland 1618",
        color: "Yellow",
        severity: "CRITICAL",
        flagReason: "Smuggling suspect — Rajasthan border route",
        notes: "Intercept at Checkpoint A",
      },
      SUPERVISOR,
    );

    expect(entry.id).toBeDefined();
    expect(entry.plate_number).toBe("RJ 14 XY 9999");
    expect(entry.severity).toBe("CRITICAL");
    expect(entry.active).toBe(true);

    const auditActions = actionsFor("watchlist", entry.id);
    expect(auditActions.length).toBeGreaterThan(0);
    const latestAction = auditActions[auditActions.length - 1];
    expect(latestAction.verb).toBe("watchlist.add");
    expect(latestAction.actor.name).toBe("Shift Supervisor");
  });

  test("updates an existing watchlist entry with audit record", () => {
    const entry = createWatchlistEntry(
      {
        orgId: DEFAULT_ORG,
        plateNumber: "PB 10 Z 1234",
        vehicleType: "car",
        flagReason: "Temporary surveillance",
      },
      SUPERVISOR,
    );

    const updated = updateWatchlistEntry(
      entry.id,
      {
        severity: "CRITICAL",
        notes: "Escalated priority after informant report",
        reason: "Intelligence update",
      },
      SUPERVISOR,
    );

    expect(updated.severity).toBe("CRITICAL");
    expect(updated.notes).toBe("Escalated priority after informant report");

    const auditActions = actionsFor("watchlist", entry.id);
    const latestAction = auditActions[auditActions.length - 1];
    expect(latestAction.verb).toBe("watchlist.update");
    expect(latestAction.reason).toBe("Intelligence update");
  });

  test("deletes a watchlist entry with required reason", () => {
    const entry = createWatchlistEntry(
      {
        orgId: DEFAULT_ORG,
        plateNumber: "PB 01 A 0001",
        flagReason: "VIP escort flag",
      },
      SUPERVISOR,
    );

    deleteWatchlistEntry(entry.id, "Escort mission concluded", SUPERVISOR);
    expect(getWatchlistEntry(entry.id)).toBeNull();

    const auditActions = actionsFor("watchlist", entry.id);
    const latestAction = auditActions[auditActions.length - 1];
    expect(latestAction.verb).toBe("watchlist.delete");
    expect(latestAction.reason).toBe("Escort mission concluded");
  });
});

describe("vehicle and license plate detection processing", () => {
  test("counts one stable Vision track once even when delivery is retried", () => {
    const before = getVehicleTraffic(DEFAULT_ORG, { days: 1 }).total;
    const event = parseVisionEvent({
      camera_id: "cam_fence_north",
      module: "anpr",
      event_type: "vehicle_detection",
      track_id: 42,
      source_id: `vision-test-${Date.now()}`,
      simulated: false,
      occurred_at: new Date().toISOString(),
      data: {
        track_ref: "run-test:42",
        vehicle_type: "sedan",
        confidence: 0.91,
        bbox: [0.2, 0.3, 0.4, 0.5],
      },
    });

    expect(ingestVisionEvent(event).vehicleTraffic.recorded).toBe(true);
    expect(ingestVisionEvent(event).vehicleTraffic.recorded).toBe(false);
    expect(getVehicleTraffic(DEFAULT_ORG, { days: 1 }).total).toBe(before + 1);
  });

  test("refuses to invent a plate when OCR returned no registration", () => {
    expect(() => processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: "",
      vehicleType: "car",
      simulated: false,
    })).toThrow("plateNumber is required");
  });

  test("processes an unlisted vehicle scan as CLEAR", () => {
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: "PB 02 UN 8888",
      vehicleType: "car",
      confidence: 0.95,
      plateConfidence: 0.96,
      simulated: false,
    });

    expect(detection.id).toBeDefined();
    expect(detection.match_status).toBe("CLEAR");
    expect(detection.matched_watchlist_id).toBeNull();
    expect(detection.severity).toBe("INFO");
  });

  test("processes a flagged vehicle scan as MATCHED and sets severity", () => {
    const plate = `HP 09 QA ${String(Date.now()).slice(-4)}`;
    createWatchlistEntry({
      orgId: DEFAULT_ORG,
      plateNumber: plate,
      vehicleType: "suv",
      severity: "CRITICAL",
      flagReason: "Detection processing fixture",
    }, SUPERVISOR);
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      zoneId: "zone_fence_line",
      plateNumber: plate,
      vehicleType: "suv",
      confidence: 0.97,
      plateConfidence: 0.98,
      simulated: false,
    });

    expect(detection.match_status).toBe("MATCHED");
    expect(detection.matched_watchlist_id).toBeDefined();
    expect(detection.severity).toBe("CRITICAL");

    const event = queryEvents(DEFAULT_ORG, { cameraId: detection.camera_id, limit: 100 })
      .find((candidate) => candidate.evidence.detectionId === detection.id);
    expect(event).toBeDefined();
    expect(event?.evidence.type).toBe("watchlist_hit");
    expect(event?.evidence.plateNumber).toBe(detection.plate_number);
    expect(event?.evidence.cameraName).toBeDefined();
    expect(event?.evidence.flagReason).toBeDefined();
    expect(event?.evidence.plateConfidence).toBe(0.98);
  });

  test("keeps a low-confidence fuzzy read clear", () => {
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: "PB O2 AK 4821",
      vehicleType: "suv",
      confidence: 0.91,
      plateConfidence: 0.42,
      simulated: true,
    });
    expect(detection.match_status).toBe("CLEAR");
    expect(detection.matched_watchlist_id).toBeNull();
  });

  test("collapses duplicate delivery of the same camera read", () => {
    const occurredAt = new Date().toISOString();
    const input = {
      orgId: DEFAULT_ORG,
      cameraId: "cam_patrol_road",
      plateNumber: `GJ 01 QA ${String(Date.now()).slice(-4)}`,
      vehicleType: "sedan",
      confidence: 0.82,
      plateConfidence: 0.76,
      simulated: false,
      occurredAt,
    };
    const first = processVehicleAndPlateDetection(input);
    const duplicate = processVehicleAndPlateDetection({
      ...input,
      confidence: 0.94,
      plateConfidence: 0.91,
      imageSnapshot: "data:image/jpeg;base64,evidence",
      occurredAt: new Date(Date.parse(occurredAt) + 2_000).toISOString(),
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.confidence).toBe(0.94);
    expect(duplicate.plate_confidence).toBe(0.91);
    expect(duplicate.image_snapshot).toBe("data:image/jpeg;base64,evidence");
  });

  test("keeps different flagged plates in separate incidents on the same camera", () => {
    const occurredAt = new Date().toISOString();
    const suffix = Number(String(Date.now()).slice(-4));
    const firstPlate = `JK 08 QA ${String(suffix).padStart(4, "0")}`;
    const secondPlate = `JK 08 QA ${String((suffix + 1) % 10_000).padStart(4, "0")}`;
    createWatchlistEntry({
      orgId: DEFAULT_ORG,
      plateNumber: firstPlate,
      vehicleType: "suv",
      severity: "CRITICAL",
      flagReason: "Grouping regression fixture A",
    }, SUPERVISOR);
    createWatchlistEntry({
      orgId: DEFAULT_ORG,
      plateNumber: secondPlate,
      vehicleType: "suv",
      severity: "CRITICAL",
      flagReason: "Grouping regression fixture B",
    }, SUPERVISOR);
    const first = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: firstPlate,
      vehicleType: "suv",
      occurredAt,
      simulated: false,
    });
    const second = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: secondPlate,
      vehicleType: "suv",
      occurredAt,
      simulated: false,
    });
    const events = queryEvents(DEFAULT_ORG, { cameraId: "cam_fence_north", limit: 200 });
    const firstEvent = events.find((event) => event.evidence.detectionId === first.id);
    const secondEvent = events.find((event) => event.evidence.detectionId === second.id);

    expect(first.match_status).toBe("MATCHED");
    expect(second.match_status).toBe("MATCHED");
    expect(firstEvent?.incidentId).toBeDefined();
    expect(secondEvent?.incidentId).toBeDefined();
    expect(firstEvent?.incidentId).not.toBe(secondEvent?.incidentId);
  });

  test("creates an incident and screen alert for an active INFO watchlist hit", () => {
    const suffix = String(Date.now()).slice(-4);
    const plate = `DL 01 QA ${suffix}`;
    createWatchlistEntry({
      orgId: DEFAULT_ORG,
      plateNumber: plate,
      vehicleType: "car",
      severity: "INFO",
      flagReason: "Observe and report",
    }, SUPERVISOR);
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: plate,
      vehicleType: "car",
      simulated: false,
    });
    const event = queryEvents(DEFAULT_ORG, { cameraId: detection.camera_id, limit: 200 })
      .find((candidate) => candidate.evidence.detectionId === detection.id);

    expect(detection.match_status).toBe("MATCHED");
    expect(event?.incidentId).toBeDefined();
    expect(event?.alertable).toBe(true);
  });

  test("keeps simulated detections out of the operational feed and stats", () => {
    const before = getWatchlistStats(DEFAULT_ORG);
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: "TS 09 ZZ 1001",
      vehicleType: "car",
      confidence: 0.99,
      plateConfidence: 0.99,
      simulated: true,
    });

    expect(queryPlateDetections(DEFAULT_ORG, { plateNumber: "TS09ZZ1001" })).toHaveLength(0);
    expect(queryPlateDetections(DEFAULT_ORG, { plateNumber: "TS09ZZ1001", includeSimulated: true })[0]?.id).toBe(detection.id);
    expect(getWatchlistStats(DEFAULT_ORG).scans24h).toBe(before.scans24h);
  });

  test("computes stats properly", () => {
    const stats = getWatchlistStats(DEFAULT_ORG);
    expect(stats.totalWatchlist).toBeGreaterThan(0);
    expect(stats.activeWatchlist).toBeGreaterThan(0);
    expect(stats.readRate).toBeGreaterThan(0);
    expect(stats.readRate).toBeLessThanOrEqual(100);
  });
});
