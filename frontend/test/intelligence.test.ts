import { describe, expect, test, beforeAll } from "bun:test";
import { configureApi } from "../src/lib/api";
import {
  normalizePlate,
  extractPlate,
  resolveCameraId,
  resolveZoneId,
  toolGetCameraLocation,
  processIntelligenceQuery,
} from "../src/features/intelligence/intelligence-engine";

beforeAll(() => {
  configureApi("http://localhost:8000");
});

const mockMetadata = {
  cameras: [
    { id: "cam_fence_north", name: "BOP-01 Fence North" },
    { id: "cam_farm_gate", name: "BOP-02 Farm Gate" },
    { id: "cam_patrol_road", name: "BOP-03 Patrol Road" },
    { id: "cam_waterline", name: "BOP-04 Waterline" },
  ],
  zones: [
    { id: "zone_fence_line", name: "Fence line north" },
    { id: "zone_farm_gate", name: "Farm gate approach" },
    { id: "zone_patrol_road", name: "Patrol road verge" },
    { id: "zone_waterline", name: "Waterline" },
  ],
};

describe("Intelligence Engine Entity Resolution & Tools", () => {
  test("normalizes plate strings", () => {
    expect(normalizePlate("HR 01 AB 1224")).toBe("HR01AB1224");
    expect(normalizePlate("pb-02-ak-4821")).toBe("PB02AK4821");
    expect(normalizePlate("DL 1C AA 1111")).toBe("DL1CAA1111");
  });

  test("extracts a complete plate instead of adjacent query words", () => {
    expect(extractPlate("find BR 01 HX 4439")).toBe("BR 01 HX 4439");
    expect(extractPlate("Has DL 1C AA 1111 been seen?")).toBe("DL 1C AA 1111");
    expect(extractPlate("find BR 01")).toBeNull();
  });

  test("resolves camera aliases to correct camera IDs", () => {
    expect(resolveCameraId("CAM-01", mockMetadata.cameras)?.id).toBe("cam_fence_north");
    expect(resolveCameraId("CAM-03", mockMetadata.cameras)?.id).toBe("cam_patrol_road");
    expect(resolveCameraId("patrol road", mockMetadata.cameras)?.id).toBe("cam_patrol_road");
    expect(resolveCameraId("waterline", mockMetadata.cameras)?.id).toBe("cam_waterline");
  });

  test("resolves zone aliases to correct zone IDs", () => {
    expect(resolveZoneId("northern fence", mockMetadata.zones)?.id).toBe("zone_fence_line");
    expect(resolveZoneId("farm gate", mockMetadata.zones)?.id).toBe("zone_farm_gate");
    expect(resolveZoneId("waterline", mockMetadata.zones)?.id).toBe("zone_waterline");
  });

  test("toolGetCameraLocation returns surveyed WGS84 GPS coordinates and grid references", () => {
    const loc = toolGetCameraLocation("cam_fence_north", "BOP-01 Fence North");
    expect(loc.cameraId).toBe("cam_fence_north");
    expect(loc.coordinates).not.toBeNull();
    expect(loc.coordinates?.lat).toBe(31.633);
    expect(loc.coordinates?.lon).toBe(74.582);
    expect(loc.gridReference).toBeTruthy();
    expect(loc.bearing).toBe(260);
  });
});

describe("Intelligence Query Execution (against Edge Node)", () => {
  test("Query 1 & 2: Vehicle search & sightings check", async () => {
    const res = await processIntelligenceQuery("Has DL 1C AA 1111 been seen?", mockMetadata);
    expect(res.intent).toBe("search_vehicle");
    expect(res.toolUsed).toBe("searchVehicle()");
    expect(res.answer).toContain("DL 1C AA 1111");
  });

  test("Query 3 & 4: Where was PB 02 AK 4821 last seen? + Timeline", async () => {
    const res = await processIntelligenceQuery("Where was PB 02 AK 4821 last seen?", mockMetadata);
    expect(res.intent).toBe("search_vehicle");
    expect(res.result.kind).toBe("vehicle");
    expect(res.result.vehicle).toBeDefined();
    expect(res.result.vehicle?.formattedPlate).toBe("PB 02 AK 4821");
    expect(res.result.vehicle?.lastSeen).toBeDefined();
    expect(res.result.vehicle?.timeline.length).toBeGreaterThanOrEqual(1);
    expect(res.suggestedPrompts.length).toBeGreaterThan(0);
  });

  test("Query 5: What happened near the northern fence yesterday?", async () => {
    const res = await processIntelligenceQuery("What happened near the northern fence yesterday?", mockMetadata);
    expect(res.intent).toBe("search_zone");
    expect(res.toolUsed).toBe("searchZoneActivity()");
    expect(res.result.kind).toBe("zone");
    expect(res.result.zone?.zoneName).toContain("Fence");
  });

  test("Query 6: Show activity around CAM-04", async () => {
    const res = await processIntelligenceQuery("Show activity around CAM-04", mockMetadata);
    expect(res.intent).toBe("search_camera");
    expect(res.toolUsed).toBe("searchCameraActivity()");
    expect(res.result.kind).toBe("camera");
    expect(res.result.camera?.cameraId).toBe("cam_waterline");
  });

  test("Query 7 & 8: Incidents search", async () => {
    const res = await processIntelligenceQuery("Are there any open critical incidents?", mockMetadata);
    expect(res.intent).toBe("search_incidents");
    expect(res.toolUsed).toBe("searchIncidents()");

    // A busy night must not dump every record into the chat: the count is
    // spoken, the list is handed to the panel.
    if (res.result.kind === "multiple") {
      expect(res.answer).toContain("panel");
      const namedInChat = new Set(
        res.result.multiple!.items.map((item) => item.title).filter((title) => res.answer.includes(title)),
      );
      expect(namedInChat.size).toBeLessThanOrEqual(1);
    }
  });

  test("Query 9: Where is CAM-01 located?", async () => {
    const res = await processIntelligenceQuery("Where is CAM-01 located?", mockMetadata);
    expect(res.intent).toBe("get_camera_location");
    expect(res.toolUsed).toBe("getCameraLocation()");
    expect(res.result.camera?.coordinates).toBeDefined();
    expect(res.answer).toContain("Coordinates");
    expect(res.answer).toContain("Grid reference");
  });

  test("Query 10: Unknown vehicle gracefully handled without hallucinating or crashing", async () => {
    const res = await processIntelligenceQuery("Find vehicle HR 99 ZZ 9999", mockMetadata);
    expect(res.intent).toBe("search_vehicle");
    expect(res.result.kind).toBe("none");
    expect(res.answer).toContain("no record");
    expect(res.answer).toContain("HR 99 ZZ 9999");
  });

  test("no answer exposes how it was produced", async () => {
    // intent and toolUsed exist for debugging only. What the operator reads
    // must not name a tool, an endpoint, a query or a raw payload.
    const leaks = /searchVehicle|searchEvents|searchIncidents|getIncident|getCameraLocation|toolUsed|intent|Executed:|Tool call|\/api\/|\bSELECT\b|"kind":/i;

    for (const q of [
      "Has DL 1C AA 1111 been seen?",
      "Where was PB 02 AK 4821 last seen?",
      "What happened near the northern fence yesterday?",
      "Show activity around CAM-04",
      "Are there any open critical incidents?",
      "Where is CAM-01 located?",
      "How many active zones are there?",
      "Find vehicle HR 99 ZZ 9999",
    ]) {
      const res = await processIntelligenceQuery(q, mockMetadata);
      expect(res.answer).not.toMatch(leaks);
    }
  });
});
