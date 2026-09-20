// MUST be the first import: it sets IBVAP_DB before ../src/db opens a handle.
// This file used to run against backend/ibvap.db -- the developer's REAL
// database -- writing entries, detections, events and audit rows into it on
// every run, and reading seeded ids back out. It surfaced when the seed's zone
// ids changed: the tests asked for a zone that existed only in the new seed
// while the live database still held the old one, and the insert died on a
// foreign key.
import { removeTempDb } from "./helpers/temp-db";
import { afterAll, describe, expect, test } from "bun:test";

import { DEFAULT_ORG, seed } from "../src/db/seed";
import {
  createWatchlistEntry,
  deleteWatchlistEntry,
  findWatchlistMatch,
  formatPlate,
  getWatchlistEntry,
  getWatchlistStats,
  listWatchlist,
  normalizePlate,
  platesMatch,
  processVehicleAndPlateDetection,
  queryPlateDetections,
  simulatePresetPlateDetection,
  updateWatchlistEntry,
} from "../src/l3/watchlist";
import { actionsFor } from "../src/l3/audit";

seed();

afterAll(removeTempDb);

const SUPERVISOR = { id: "usr_supervisor", name: "Shift Supervisor", role: "supervisor" as const };
const OPERATOR = { id: "usr_operator", name: "Duty Operator", role: "operator" as const };

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
  test("processes an unlisted vehicle scan as CLEAR", () => {
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      plateNumber: "PB 02 UN 8888",
      vehicleType: "car",
      confidence: 0.95,
      plateConfidence: 0.96,
      simulated: true,
    });

    expect(detection.id).toBeDefined();
    expect(detection.match_status).toBe("CLEAR");
    expect(detection.matched_watchlist_id).toBeNull();
    expect(detection.severity).toBe("INFO");
  });

  test("processes a flagged vehicle scan as MATCHED and sets severity", () => {
    // Seeded scorpio plate: PB 02 AK 4821
    const detection = processVehicleAndPlateDetection({
      orgId: DEFAULT_ORG,
      cameraId: "cam_fence_north",
      zoneId: "zone_perimeter",
      plateNumber: "PB 02 AK 4821",
      vehicleType: "suv",
      confidence: 0.97,
      plateConfidence: 0.98,
      simulated: true,
    });

    expect(detection.match_status).toBe("MATCHED");
    expect(detection.matched_watchlist_id).toBeDefined();
    expect(detection.severity).toBe("CRITICAL");
  });

  test("simulates preset detections cleanly", () => {
    const det = simulatePresetPlateDetection("flagged_scorpio", DEFAULT_ORG);
    expect(det.plate_number).toContain("PB 02 AK 4821");
    expect(det.match_status).toBe("MATCHED");
  });

  test("computes stats properly", () => {
    const stats = getWatchlistStats(DEFAULT_ORG);
    expect(stats.totalWatchlist).toBeGreaterThan(0);
    expect(stats.activeWatchlist).toBeGreaterThan(0);
    expect(stats.readRate).toBeGreaterThan(80);
  });
});
