import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The multi-camera zone model.
 *
 * The thing worth testing hardest is target resolution: a zone declares one
 * policy, a camera may state exceptions to it, and what the judgement layer
 * finally sees has to be the two merged in the right order. Getting that wrong
 * means a camera quietly watching for the wrong things.
 */

const DB_PATH = join(tmpdir(), `ibvap-zones-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.IBVAP_DB = DB_PATH;

let zones: typeof import("../src/l3/zones");
let fence: typeof import("../src/l2/fence");
let events: typeof import("../src/l3/events");

const ORG = "org_bsf";
const SITE = "site_bop_attari";
const ZONE = "zone_fence_line";

beforeAll(async () => {
  await import("../src/db");
  const { seed } = await import("../src/db/seed");
  seed();
  zones = await import("../src/l3/zones");
  fence = await import("../src/l2/fence");
  events = await import("../src/l3/events");
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

describe("a zone spanning cameras", () => {
  test("the seeded fence line is watched by two cameras", () => {
    const zone = zones.zoneDetail(ZONE)!;
    expect(zone.cameras.map((c) => c.cameraId).sort()).toEqual([
      "cam_fence_north",
      "cam_patrol_road",
    ]);
  });

  test("each camera keeps its own shape and its own patience", () => {
    const zone = zones.zoneDetail(ZONE)!;
    const north = zone.cameras.find((c) => c.cameraId === "cam_fence_north")!;
    const road = zone.cameras.find((c) => c.cameraId === "cam_patrol_road")!;

    // The same fence, seen from two places -- the shapes must not be shared.
    expect(north.points).not.toEqual(road.points);
    expect(north.direction).toBe("both");
    expect(road.direction).toBe("inbound");
    expect(road.confirmSeconds).toBe(3);
  });

  test("both cameras resolve the zone, each with its own geometry", () => {
    const north = zones.zonesForCamera("cam_fence_north").find((z) => z.id === ZONE)!;
    const road = zones.zonesForCamera("cam_patrol_road").find((z) => z.id === ZONE)!;

    expect(north.id).toBe(road.id); // one logical zone
    expect(north.bindingId).not.toBe(road.bindingId); // two bindings
    expect(north.points).not.toEqual(road.points);
  });
});

describe("target resolution", () => {
  test("with no override, a camera sees the zone's own policy", () => {
    const policy = zones.zoneTargets(ZONE).map((t) => t.class);
    const effective = zones.resolveTargets(ZONE, "cam_fence_north").map((t) => t.class);
    expect(effective).toEqual(policy);
  });

  test("targets come back in priority order", () => {
    const ranks = zones.resolveTargets(ZONE, "cam_fence_north").map((t) => t.priority);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(zones.resolveTargets(ZONE, "cam_fence_north")[0]!.class).toBe("person");
  });

  test("a camera override replaces the zone's rule for that class", () => {
    // On the patrol road camera, cattle matter -- herds move towards the river.
    zones.setTargets(ZONE, "cam_patrol_road", [
      { class: "cattle", severity: "WARNING", action: "alert" },
    ]);

    const road = zones.resolveTargets(ZONE, "cam_patrol_road");
    const cattle = road.find((t) => t.class === "cattle")!;
    expect(cattle.action).toBe("alert");
    expect(cattle.severity).toBe("WARNING");
    expect(cattle.overridden).toBe(true);

    // The other camera is untouched by that exception.
    const north = zones.resolveTargets(ZONE, "cam_fence_north");
    expect(north.find((t) => t.class === "cattle")!.action).toBe("log_only");
  });

  test("an override can add a class the zone never listed", () => {
    zones.setTargets(ZONE, "cam_patrol_road", [
      { class: "cattle", severity: "WARNING", action: "alert" },
      { class: "boat", severity: "CRITICAL", action: "alert" },
    ]);

    const classes = zones.resolveTargets(ZONE, "cam_patrol_road").map((t) => t.class);
    expect(classes).toContain("boat");
    expect(zones.resolveTargets(ZONE, "cam_fence_north").map((t) => t.class)).not.toContain("boat");
  });

  test("the merged list is renumbered so no two targets share a rank", () => {
    zones.setTargets(ZONE, "cam_patrol_road", [
      { class: "cattle", severity: "WARNING", action: "alert" },
      { class: "boat", severity: "CRITICAL", action: "alert" },
    ]);

    const ranks = zones.resolveTargets(ZONE, "cam_patrol_road").map((t) => t.priority);
    // Two scopes rank independently, so the raw rows collide on 1 and 2.
    expect(ranks).toEqual([...new Set(ranks)]);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
  });

  test("clearing the overrides puts the camera back on the zone policy", () => {
    zones.setTargets(ZONE, "cam_patrol_road", []);
    const cattle = zones.resolveTargets(ZONE, "cam_patrol_road").find((t) => t.class === "cattle")!;
    expect(cattle.action).toBe("log_only");
    expect(cattle.overridden).toBeFalsy();
  });

  test("priority is taken from list position, not from the caller", () => {
    zones.setTargets(ZONE, null, [
      { class: "vehicle", severity: "CRITICAL", action: "alert" },
      { class: "person", severity: "CRITICAL", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
    ]);

    const policy = zones.zoneTargets(ZONE);
    expect(policy.map((t) => t.class)).toEqual(["vehicle", "person", "cattle"]);
    expect(policy.map((t) => t.priority)).toEqual([1, 2, 3]);
  });
});

describe("judgement reads the targets", () => {
  const BASE = Date.parse("2026-09-06T02:00:00.000Z");
  const SIZE: [number, number] = [0.045, 0.16];

  const frameAt = (seconds: number, className: string, ref: string, x: number, y: number) => ({
    camera_id: "cam_fence_north",
    occurred_at: new Date(BASE + seconds * 1000).toISOString(),
    simulated: true,
    source_id: "test",
    detections: [
      {
        track_ref: ref,
        class: className,
        confidence: 0.9,
        bbox: [x - SIZE[0] / 2, y - SIZE[1], SIZE[0], SIZE[1]] as [number, number, number, number],
      },
    ],
  });

  test("a severity edited through the targets is what the event carries", () => {
    // Put person back, but at WARNING rather than the seeded CRITICAL.
    zones.setTargets(ZONE, null, [
      { class: "person", severity: "WARNING", action: "alert" },
      { class: "cattle", severity: "INFO", action: "log_only" },
    ]);
    fence.resetFenceMemory();

    const track = "t-severity";
    fence.processFrame(frameAt(0, "person", track, 0.5, 0.3));
    fence.processFrame(frameAt(1, "person", track, 0.5, 0.9));
    fence.processFrame(frameAt(4, "person", track, 0.5, 0.92));

    const crossing = events
      .queryEvents(ORG, { zoneId: ZONE, limit: 50 })
      .find((e) => e.evidence?.trackRef === track)!;

    expect(crossing.severity).toBe("WARNING");
    expect(crossing.alertable).toBe(true);
  });

  test("a class dropped from the targets stops producing anything", () => {
    zones.setTargets(ZONE, null, [{ class: "cattle", severity: "INFO", action: "log_only" }]);
    fence.resetFenceMemory();

    const track = "t-dropped";
    fence.processFrame(frameAt(20, "person", track, 0.5, 0.3));
    fence.processFrame(frameAt(21, "person", track, 0.5, 0.9));
    fence.processFrame(frameAt(24, "person", track, 0.5, 0.92));

    const found = events
      .queryEvents(ORG, { zoneId: ZONE, limit: 50 })
      .filter((e) => e.evidence?.trackRef === track);
    expect(found).toHaveLength(0);
  });
});

describe("listing order", () => {
  test("zones come back oldest first, so profile positions stay put", () => {
    const before = zones.listZones(SITE).map((z) => z.id);

    zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Ordering probe",
      kind: "fence_line",
      cameraIds: ["cam_waterline"],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    const after = zones.listZones(SITE).map((z) => z.id);
    // A new zone must land at the END. Newest-first would shift every existing
    // zone's index and silently re-map what a site profile rewrites.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });
});

describe("creating and changing zones", () => {
  test("a new zone joins its cameras with an unplaced placeholder shape", () => {
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Gate approach",
      kind: "gate",
      sector: "gate_approach",
      cameraIds: ["cam_farm_gate", "cam_waterline"],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    const zone = zones.zoneDetail(zoneId)!;
    expect(zone.cameras).toHaveLength(2);
    // Nothing may look positioned until somebody has positioned it.
    expect(zone.cameras.every((c) => c.placed === false)).toBe(true);
    expect(zone.sector).toBe("gate_approach");
    expect(zone.targets.map((t) => t.class)).toEqual(["person"]);
  });

  test("positioning a camera's shape marks it placed", () => {
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Jetty perimeter",
      kind: "perimeter",
      cameraIds: ["cam_waterline"],
      targets: [{ class: "boat", severity: "CRITICAL", action: "alert" }],
    });

    zones.updateBinding(zoneId, "cam_waterline", {
      points: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.7], [0.2, 0.7]],
    });

    const camera = zones.zoneDetail(zoneId)!.cameras[0]!;
    expect(camera.placed).toBe(true);
    expect(camera.points).toHaveLength(4);
  });

  test("removing a camera keeps its overrides for when it comes back", () => {
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Rejoin test",
      kind: "fence_line",
      cameraIds: ["cam_fence_north", "cam_farm_gate"],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    zones.setTargets(zoneId, "cam_farm_gate", [
      { class: "tractor", severity: "INFO", action: "log_only" },
    ]);
    zones.removeCamera(zoneId, "cam_farm_gate");

    // Gone from what the camera watches...
    expect(zones.zonesForCamera("cam_farm_gate").map((z) => z.id)).not.toContain(zoneId);
    // ...but the exception somebody set up is still on record.
    expect(zones.cameraOverrides(zoneId, "cam_farm_gate").map((t) => t.class)).toEqual(["tractor"]);
  });

  test("a deactivated zone stops being judged", () => {
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Temporary",
      kind: "fence_line",
      cameraIds: ["cam_farm_gate"],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    expect(zones.zonesForCamera("cam_farm_gate").map((z) => z.id)).toContain(zoneId);
    zones.updateZone(zoneId, { active: false });
    expect(zones.zonesForCamera("cam_farm_gate").map((z) => z.id)).not.toContain(zoneId);
  });
});

describe("cameras", () => {
  let cameras: typeof import("../src/l3/cameras");

  test("a camera knows the other cameras watching its zones", async () => {
    cameras = await import("../src/l3/cameras");
    // The seeded fence line spans BOP-01 and BOP-03.
    const siblings = cameras.siblingCameras("cam_fence_north");
    expect(siblings.map((s) => s.cameraId)).toContain("cam_patrol_road");
    expect(siblings[0]!.zoneName).toBe("Fence line north");
  });

  test("taking a feed out of service stops it being judged", async () => {
    cameras = await import("../src/l3/cameras");
    const BASE = Date.parse("2026-09-06T04:00:00.000Z");
    const SIZE: [number, number] = [0.045, 0.16];
    const frame = (seconds: number, ref: string, y: number) => ({
      camera_id: "cam_fence_north",
      occurred_at: new Date(BASE + seconds * 1000).toISOString(),
      simulated: true,
      source_id: "test",
      detections: [
        {
          track_ref: ref,
          class: "person",
          confidence: 0.9,
          bbox: [0.5 - SIZE[0] / 2, y - SIZE[1], SIZE[0], SIZE[1]] as [number, number, number, number],
        },
      ],
    });

    // Put a person-alerting policy back after the earlier tests changed it.
    zones.setTargets(ZONE, null, [{ class: "person", severity: "CRITICAL", action: "alert" }]);
    cameras.updateCamera("cam_fence_north", { enabled: false });
    fence.resetFenceMemory();

    const before = events.queryEvents(ORG, { cameraId: "cam_fence_north", limit: 500 }).length;
    fence.processFrame(frame(0, "t-disabled", 0.3));
    fence.processFrame(frame(1, "t-disabled", 0.9));
    const result = fence.processFrame(frame(4, "t-disabled", 0.92));

    expect(result.skipped).toBe("camera_disabled");
    expect(events.queryEvents(ORG, { cameraId: "cam_fence_north", limit: 500 })).toHaveLength(before);

    // And it starts again when the feed is put back.
    cameras.updateCamera("cam_fence_north", { enabled: true });
    fence.resetFenceMemory();
    fence.processFrame(frame(20, "t-restored", 0.3));
    fence.processFrame(frame(21, "t-restored", 0.9));
    fence.processFrame(frame(24, "t-restored", 0.92));

    expect(
      events.queryEvents(ORG, { cameraId: "cam_fence_north", limit: 500 }).length,
    ).toBeGreaterThan(before);
  });

  test("the camera list carries the same fields as the detail view", async () => {
    const cameras = await import("../src/l3/cameras");
    const listed = cameras.listCameras(SITE);
    const detail = cameras.cameraDetail("cam_fence_north")!;

    // A list returning a subset of the detail shape is invisible to the
    // compiler across HTTP and shows up as a crash in the browser instead.
    expect(Object.keys(listed[0]!).sort()).toEqual(Object.keys(detail).sort());
    expect(listed.every((c) => c.incidents !== undefined && c.siblings !== undefined)).toBe(true);
  });

  test("an incident cross-references the other cameras on its zone", () => {
    const incident = events.listIncidents(ORG, { cameraId: "cam_fence_north", limit: 1 })[0]!;
    const cross = events.crossReference(incident.id);

    expect(cross.zone?.name).toBe("Fence line north");
    // Both cameras on the zone are listed, and the source is marked.
    expect(cross.cameras.map((c: any) => c.cameraId).sort()).toEqual([
      "cam_fence_north",
      "cam_patrol_road",
    ]);
    expect(cross.cameras.find((c: any) => c.isSource)?.cameraId).toBe("cam_fence_north");
  });
});
