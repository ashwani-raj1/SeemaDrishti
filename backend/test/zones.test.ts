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
const ZONE = "zone_perimeter";

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


/**
 * A camera of this test's own.
 *
 * A camera now belongs to exactly one zone, so borrowing a seeded one means
 * colliding with the zone the seed already put it in. Each test that creates a
 * zone gets a fresh camera instead -- and these files share one database in
 * file order, so a collision here cascades into every test after it.
 */
let spare = 0;
async function freeCamera(): Promise<string> {
  const { createCamera } = await import("../src/l3/cameras");
  const id = `cam_test_spare_${++spare}`;
  createCamera({ id, siteId: SITE, name: `Spare test camera ${spare}` });
  return id;
}

describe("a zone spanning cameras", () => {
  test("the seeded zone is watched by every camera on the post", () => {
    // One zone, every camera: a zone spans cameras while a camera belongs to
    // exactly one zone, so this is the simplest configuration the schema can
    // express -- and the one the seed now starts from.
    const zone = zones.zoneDetail(ZONE)!;
    expect(zone.cameras.map((c) => c.cameraId).sort()).toEqual([
      "cam_farm_gate",
      "cam_fence_north",
      "cam_garden",
      "cam_patrol_road",
      "cam_waterline",
    ]);
  });

  test("each camera keeps its own shape and its own patience", () => {
    const zone = zones.zoneDetail(ZONE)!;
    const north = zone.cameras.find((c) => c.cameraId === "cam_fence_north")!;
    const gate = zone.cameras.find((c) => c.cameraId === "cam_farm_gate")!;

    // One place seen from two positions. Geometry drawn in one camera's frame
    // means nothing in another's, so shape, direction and patience all live on
    // the binding rather than on the zone.
    expect(north.points).not.toEqual(gate.points);
    expect(north.direction).toBe("both");
    expect(gate.direction).toBe("inbound");
    expect(gate.confirmSeconds).toBe(3);
    expect(north.confirmSeconds).toBe(2);
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
    // `drone` is deliberately absent from the zone policy -- picking a class
    // the zone already names would prove nothing about ADDING one.
    zones.setTargets(ZONE, "cam_patrol_road", [
      { class: "cattle", severity: "WARNING", action: "alert" },
      { class: "drone", severity: "CRITICAL", action: "alert" },
    ]);

    const classes = zones.resolveTargets(ZONE, "cam_patrol_road").map((t) => t.class);
    expect(classes).toContain("drone");
    expect(zones.resolveTargets(ZONE, "cam_fence_north").map((t) => t.class)).not.toContain("drone");
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

describe("a shape nobody drew is recorded, never alerted", () => {
  // The placeholder handed out when a camera joins a zone is a stock line
  // across the middle of the frame. Somebody really does cross it -- but
  // nobody chose where it sits, so severity would be a claim about a place
  // no operator picked. It is evidence, not an alarm, until it is drawn.
  const BASE = Date.parse("2026-09-06T04:00:00.000Z");
  const SIZE: [number, number] = [0.045, 0.16];
  // Its own camera, not a seeded one. These walks raise incidents, and a test
  // elsewhere in this file reads "the most recent incident on cam_fence_north"
  // -- borrowing that camera made this block silently rewrite that test's
  // subject. The files share one database in file order, so pollution travels.
  const CAM = "cam_test_provisional";

  beforeAll(async () => {
    const { createCamera } = await import("../src/l3/cameras");
    createCamera({ id: CAM, siteId: SITE, name: "Provisional test camera" });
  });

  const frameAt = (seconds: number, ref: string, y: number) => ({
    camera_id: CAM,
    occurred_at: new Date(BASE + seconds * 1000).toISOString(),
    simulated: true,
    source_id: "test",
    detections: [
      {
        track_ref: ref,
        class: "person",
        confidence: 0.9,
        bbox: [0.5 - SIZE[0] / 2, y - SIZE[1], SIZE[0], SIZE[1]] as
          [number, number, number, number],
      },
    ],
  });

  // The placeholder for a fence_line is y = 0.6, so 0.3 -> 0.9 crosses it.
  const walk = (zoneId: string, ref: string, at: number) => {
    fence.resetFenceMemory();
    fence.processFrame(frameAt(at, ref, 0.3));
    fence.processFrame(frameAt(at + 1, ref, 0.9));
    fence.processFrame(frameAt(at + 4, ref, 0.92));
    return events
      .queryEvents(ORG, { zoneId, limit: 50 })
      .find((e) => e.evidence?.trackRef === ref);
  };

  // A zone per camera: CAM is reused for the walk, so each test that needs a
  // second zone needs a second camera to hang it on.
  const freshZoneOn = (name: string, cameraId: string) =>
    zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name,
      kind: "fence_line",
      cameras: [{ cameraId: cameraId }],
      targets: [{ class: "person", severity: "CRITICAL", action: "alert" }],
      confirmSeconds: 2,
    });

  test("zonesForCamera carries `placed` -- judgement's only way in", async () => {
    const cam = await freeCamera();
    const zoneId = freshZoneOn("undrawn reachability", cam);
    const zone = zones.zonesForCamera(cam).find((z) => z.id === zoneId)!;
    expect(zone.placed).toBe(false);
  });

  test("a crossing of an undrawn shape is recorded but not alerted", () => {
    const zoneId = freshZoneOn("undrawn suppression", CAM);

    const crossing = walk(zoneId, "t-provisional", 0)!;
    expect(crossing).toBeDefined();
    expect(crossing.alertable).toBe(false);
    expect(crossing.suppressedReason).toBe("zone_not_placed");
    // Suppressed, not hidden: it is still a stored, queryable, grouped event.
    expect(crossing.incidentId).toBeTruthy();
  });

  test("drawing the shape turns the alarm on, with no other change", () => {
    // Reuses the zone the previous test put on CAM rather than making a
    // second one: a camera belongs to exactly one zone now.
    const zoneId = zones.zonesForCamera(CAM)[0]!.id;
    expect(walk(zoneId, "t-before-draw", 100)!.alertable).toBe(false);

    zones.updateBinding(zoneId, CAM, {
      points: [[0.05, 0.6], [0.95, 0.6]],
    });

    const after = walk(zoneId, "t-after-draw", 200)!;
    expect(after.alertable).toBe(true);
    expect(after.severity).toBe("CRITICAL");
    expect(after.suppressedReason).toBeNull();
  });

  test("changing a setting does not claim the shape was drawn", async () => {
    // This was the decay path: `placed` used to be set unconditionally, so a
    // supervisor nudging the confirm window marked the stock line positioned
    // and silently armed a fence nobody had aimed.
    const cam = await freeCamera();
    const zoneId = freshZoneOn("settings only", cam);
    zones.updateBinding(zoneId, cam, { confirmSeconds: 5 });

    const zone = zones.zonesForCamera(cam).find((z) => z.id === zoneId)!;
    expect(zone.placed).toBe(false);
    expect(zone.confirm_seconds).toBe(5);
  });
});

describe("listing order", () => {
  test("zones come back oldest first, so profile positions stay put", async () => {
    const before = zones.listZones(SITE).map((z) => z.id);

    zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Ordering probe",
      kind: "fence_line",
      cameras: [{ cameraId: await freeCamera() }],
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
  test("a new zone joins its cameras with an unplaced placeholder shape", async () => {
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Gate approach",
      kind: "gate",
      area: "Farm gate approach",
      // A zone may still SPAN cameras -- that direction is unchanged. What is
      // no longer allowed is one camera in two zones, so these are fresh.
      cameras: [{ cameraId: await freeCamera() }, { cameraId: await freeCamera() }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    const zone = zones.zoneDetail(zoneId)!;
    expect(zone.cameras).toHaveLength(2);
    // Nothing may look positioned until somebody has positioned it.
    expect(zone.cameras.every((c) => c.placed === false)).toBe(true);
    expect(zone.area).toBe("Farm gate approach");
    expect(zone.targets.map((t) => t.class)).toEqual(["person"]);
  });

  test("positioning a camera's shape marks it placed", async () => {
    const cam = await freeCamera();
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Jetty perimeter",
      kind: "perimeter",
      cameras: [{ cameraId: cam }],
      targets: [{ class: "boat", severity: "CRITICAL", action: "alert" }],
    });

    zones.updateBinding(zoneId, cam, {
      points: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.7], [0.2, 0.7]],
    });

    const camera = zones.zoneDetail(zoneId)!.cameras[0]!;
    expect(camera.placed).toBe(true);
    expect(camera.points).toHaveLength(4);
  });

  // The console draws every camera BEFORE the zone exists, so the shapes
  // arrive with the create call. A zone half-written by a wizard somebody
  // abandoned is the failure this path exists to make impossible.
  test("a camera created with points is placed, one without is not", async () => {
    const drawn = await freeCamera();
    const undrawn = await freeCamera();

    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Drawn on arrival",
      kind: "fence_line",
      cameras: [
        {
          cameraId: drawn,
          geometry: "line",
          points: [[0.1, 0.5], [0.9, 0.55]],
          direction: "inbound",
          confirmSeconds: 3,
        },
        { cameraId: undrawn },
      ],
      targets: [{ class: "person", severity: "CRITICAL", action: "alert" }],
    });

    const zone = zones.zoneDetail(zoneId)!;
    const placed = zone.cameras.find((c) => c.cameraId === drawn)!;
    const placeholder = zone.cameras.find((c) => c.cameraId === undrawn)!;

    expect(placed.placed).toBe(true);
    expect(placed.points).toEqual([[0.1, 0.5], [0.9, 0.55]]);
    expect(placed.direction).toBe("inbound");
    expect(placed.confirmSeconds).toBe(3);

    // Unchanged behaviour, and deliberately so: a camera with no picture to
    // draw on must still be able to join, carrying the flag that stops the
    // detector alerting on a shape nobody chose.
    expect(placeholder.placed).toBe(false);
  });

  test("per-camera targets can be set at create time", async () => {
    const cam = await freeCamera();
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Exception on arrival",
      kind: "gate",
      cameras: [
        {
          cameraId: cam,
          points: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]],
          geometry: "polygon",
          targets: [{ class: "person", severity: "INFO", action: "log_only" }],
        },
      ],
      targets: [{ class: "person", severity: "CRITICAL", action: "alert" }],
    });

    const camera = zones.zoneDetail(zoneId)!.cameras[0]!;
    // The zone still says CRITICAL; this camera's exception overrides it,
    // which is the whole point of setting severity per camera in the wizard.
    expect(camera.effectiveTargets[0]!.severity).toBe("INFO");
    expect(camera.overrides).toHaveLength(1);
  });

  test("areas are whatever the live zones carry", async () => {
    zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Area probe",
      kind: "fence_line",
      area: "Waterline south",
      cameras: [{ cameraId: await freeCamera() }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    const areas = zones.listAreas(SITE);
    expect(areas).toContain("Waterline south");
    // Derived from DISTINCT, so a label used twice is offered once.
    expect(new Set(areas).size).toBe(areas.length);
  });

  test("removing a camera keeps its overrides for when it comes back", async () => {
    const keep = await freeCamera();
    const leaving = await freeCamera();
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Rejoin test",
      kind: "fence_line",
      cameras: [{ cameraId: keep }, { cameraId: leaving }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    zones.setTargets(zoneId, leaving, [
      { class: "tractor", severity: "INFO", action: "log_only" },
    ]);
    zones.removeCamera(zoneId, leaving);

    // Gone from what the camera watches...
    expect(zones.zonesForCamera(leaving).map((z) => z.id)).not.toContain(zoneId);
    // ...but the exception somebody set up is still on record.
    expect(zones.cameraOverrides(zoneId, leaving).map((t) => t.class)).toEqual(["tractor"]);
  });

  test("a retired binding frees its camera for another zone", async () => {
    // The whole reason the unique index is partial on `active`. Without this
    // a camera that had ever left a zone could never join one again.
    const cam = await freeCamera();
    const first = zones.createZone({
      orgId: ORG, siteId: SITE, name: "First home", kind: "fence_line",
      cameras: [{ cameraId: cam }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });
    zones.removeCamera(first, cam);

    const second = zones.createZone({
      orgId: ORG, siteId: SITE, name: "Second home", kind: "fence_line",
      cameras: [{ cameraId: cam }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });
    expect(zones.zonesForCamera(cam).map((z) => z.id)).toEqual([second]);
  });

  test("a deactivated zone stops being judged", async () => {
    const cam = await freeCamera();
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Temporary",
      kind: "fence_line",
      cameras: [{ cameraId: cam }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    expect(zones.zonesForCamera(cam).map((z) => z.id)).toContain(zoneId);
    zones.updateZone(zoneId, { active: false });
    expect(zones.zonesForCamera(cam).map((z) => z.id)).not.toContain(zoneId);
  });
});

describe("cameras", () => {
  let cameras: typeof import("../src/l3/cameras");

  test("a camera knows the other cameras watching its zones", async () => {
    cameras = await import("../src/l3/cameras");
    // One zone now holds every camera, so every camera is a sibling of the rest.
    const siblings = cameras.siblingCameras("cam_fence_north");
    expect(siblings.map((s) => s.cameraId)).toContain("cam_patrol_road");
    expect(siblings[0]!.zoneName).toBe("BOP perimeter");
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

    expect(cross.zone?.name).toBe("BOP perimeter");
    // Every camera on the zone is listed, and the source is marked. With one
    // zone holding the whole post, "what else could have seen this" is the
    // whole post -- which is exactly the question an investigator asks.
    expect(cross.cameras.map((c: any) => c.cameraId).sort()).toEqual([
      "cam_farm_gate",
      "cam_fence_north",
      "cam_garden",
      "cam_patrol_road",
      "cam_waterline",
    ]);
    expect(cross.cameras.find((c: any) => c.isSource)?.cameraId).toBe("cam_fence_north");
  });
});

describe("replacing a zone wholesale", () => {
  test("one call moves shapes, swaps cameras, and rewrites the policy", async () => {
    const keep = await freeCamera();
    const leaving = await freeCamera();
    const joining = await freeCamera();

    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Before",
      kind: "fence_line",
      area: "Old area",
      cameras: [
        { cameraId: keep, points: [[0.1, 0.5], [0.9, 0.5]], geometry: "line" },
        { cameraId: leaving },
      ],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    const after = zones.replaceZone(zoneId, {
      name: "After",
      kind: "gate",
      area: "New area",
      cameras: [
        // Same camera, shape moved.
        { cameraId: keep, geometry: "line", points: [[0.2, 0.7], [0.8, 0.7]] },
        // New camera, no shape -- joins on the placeholder, unplaced.
        { cameraId: joining },
      ],
      targets: [
        { class: "person", severity: "CRITICAL", action: "alert" },
        { class: "cattle", severity: "INFO", action: "log_only" },
      ],
    })!;

    expect(after.name).toBe("After");
    expect(after.kind).toBe("gate");
    expect(after.area).toBe("New area");

    const active = after.cameras.filter((c) => c.active).map((c) => c.cameraId);
    expect(active).toContain(keep);
    expect(active).toContain(joining);
    // Retired, not deleted: past events still point at this binding.
    expect(active).not.toContain(leaving);
    expect(after.cameras.some((c) => c.cameraId === leaving)).toBe(true);

    const moved = after.cameras.find((c) => c.cameraId === keep)!;
    expect(moved.points).toEqual([[0.2, 0.7], [0.8, 0.7]]);
    expect(moved.placed).toBe(true);

    const fresh = after.cameras.find((c) => c.cameraId === joining)!;
    expect(fresh.placed).toBe(false);

    expect(after.targets.map((t) => t.class)).toEqual(["person", "cattle"]);
  });

  test("a camera sent without points keeps the shape it already had", async () => {
    const cam = await freeCamera();
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Keeps its shape",
      kind: "fence_line",
      cameras: [{ cameraId: cam, geometry: "line", points: [[0.1, 0.4], [0.9, 0.45]] }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    });

    // Renaming the zone must not un-draw every camera in it.
    const after = zones.replaceZone(zoneId, {
      name: "Renamed only",
      kind: "fence_line",
      cameras: [{ cameraId: cam }],
      targets: [{ class: "person", severity: "WARNING", action: "alert" }],
    })!;

    const camera = after.cameras[0]!;
    expect(camera.points).toEqual([[0.1, 0.4], [0.9, 0.45]]);
    expect(camera.placed).toBe(true);
  });

  test("an empty override list puts a camera back on the zone policy", async () => {
    const cam = await freeCamera();
    const zoneId = zones.createZone({
      orgId: ORG,
      siteId: SITE,
      name: "Exception then not",
      kind: "fence_line",
      cameras: [
        {
          cameraId: cam,
          points: [[0.1, 0.5], [0.9, 0.5]],
          targets: [{ class: "person", severity: "INFO", action: "log_only" }],
        },
      ],
      targets: [{ class: "person", severity: "CRITICAL", action: "alert" }],
    });

    expect(zones.zoneDetail(zoneId)!.cameras[0]!.overrides).toHaveLength(1);

    const after = zones.replaceZone(zoneId, {
      name: "Exception then not",
      kind: "fence_line",
      cameras: [{ cameraId: cam }],
      targets: [{ class: "person", severity: "CRITICAL", action: "alert" }],
    })!;

    expect(after.cameras[0]!.overrides).toHaveLength(0);
    expect(after.cameras[0]!.effectiveTargets[0]!.severity).toBe("CRITICAL");
  });
});
