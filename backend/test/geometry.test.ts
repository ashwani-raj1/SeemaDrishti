import { describe, expect, test } from "bun:test";
import {
  crossingOf,
  groundPoint,
  pointInPolygon,
  segmentsCross,
  sideForZone,
  validateZonePoints,
} from "../src/l2/geometry";
import type { Zone } from "../src/core/types";

const zone = (over: Partial<Zone>): Zone => ({
  id: "z",
  bindingId: "zc",
  camera_id: "c",
  org_id: "o",
  site_id: "s",
  name: "test",
  kind: "fence_line",
  geometry: "line",
  points: [
    [0.0, 0.5],
    [1.0, 0.5],
  ],
  direction: "both",
  confirm_seconds: 2,
  targets: [
    { class: "person", severity: "CRITICAL", action: "alert", priority: 1 },
    { class: "cattle", severity: "INFO", action: "log_only", priority: 2 },
  ],
  active: true,
  ...over,
});

describe("groundPoint", () => {
  test("is the bottom centre of the box, not its middle", () => {
    // Using the centre would make a tall person cross a line half a body early.
    expect(groundPoint([0.2, 0.1, 0.1, 0.4])).toEqual([0.25, 0.5]);
  });
});

describe("segmentsCross", () => {
  test("detects a proper crossing", () => {
    expect(segmentsCross([0, 0], [1, 1], [0, 1], [1, 0])).toBe(true);
  });

  test("parallel segments never cross", () => {
    expect(segmentsCross([0, 0], [1, 0], [0, 1], [1, 1])).toBe(false);
  });

  test("segments that stop short do not cross", () => {
    expect(segmentsCross([0, 0], [0.4, 0], [0.5, -1], [0.5, 1])).toBe(false);
  });
});

describe("pointInPolygon", () => {
  const square: Array<[number, number]> = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ];

  test("inside", () => expect(pointInPolygon(square, [0.5, 0.5])).toBe(true));
  test("outside", () => expect(pointInPolygon(square, [0.9, 0.5])).toBe(false));
  test("outside on the far side", () => expect(pointInPolygon(square, [0.1, 0.1])).toBe(false));
});

describe("crossingOf, line zone", () => {
  const fence = zone({});

  test("inbound is towards the right-hand side of the line as drawn", () => {
    // Line runs left to right at y = 0.5; the right-hand side is the larger y,
    // which on screen is nearer the camera. Coming from the far side is inbound.
    expect(crossingOf(fence, [0.5, 0.2], [0.5, 0.8])).toBe("inbound");
  });

  test("outbound is the reverse", () => {
    expect(crossingOf(fence, [0.5, 0.8], [0.5, 0.2])).toBe("outbound");
  });

  test("movement that stays on one side is not a crossing", () => {
    expect(crossingOf(fence, [0.2, 0.8], [0.9, 0.7])).toBeNull();
  });

  test("movement parallel and close to the line is not a crossing", () => {
    expect(crossingOf(fence, [0.1, 0.49], [0.9, 0.49])).toBeNull();
  });

  test("a polyline fence with a kink still resolves direction", () => {
    const kinked = zone({
      points: [
        [0.0, 0.5],
        [0.5, 0.2],
        [1.0, 0.5],
      ],
    });
    expect(crossingOf(kinked, [0.5, 0.05], [0.5, 0.6])).toBe("inbound");
  });
});

describe("crossingOf, polygon zone", () => {
  const area = zone({
    geometry: "polygon",
    kind: "restricted_area",
    points: [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.7, 0.7],
      [0.3, 0.7],
    ],
  });

  test("entering is inbound", () => {
    expect(crossingOf(area, [0.1, 0.5], [0.5, 0.5])).toBe("inbound");
  });

  test("leaving is outbound", () => {
    expect(crossingOf(area, [0.5, 0.5], [0.9, 0.5])).toBe("outbound");
  });

  test("staying inside is not a crossing", () => {
    expect(crossingOf(area, [0.4, 0.4], [0.6, 0.6])).toBeNull();
  });

  test("passing by outside is not a crossing", () => {
    expect(crossingOf(area, [0.1, 0.9], [0.9, 0.9])).toBeNull();
  });
});

describe("sideForZone", () => {
  test("polygon reports inside as 1", () => {
    const area = zone({
      geometry: "polygon",
      points: [
        [0.3, 0.3],
        [0.7, 0.3],
        [0.7, 0.7],
        [0.3, 0.7],
      ],
    });
    expect(sideForZone(area, [0.5, 0.5])).toBe(1);
    expect(sideForZone(area, [0.1, 0.1])).toBe(-1);
  });
});

describe("validateZonePoints", () => {
  test("a line needs two points", () => {
    expect(validateZonePoints("line", [[0.1, 0.1]])).toMatch(/at least 2/);
  });

  test("a polygon needs three", () => {
    expect(validateZonePoints("polygon", [[0.1, 0.1], [0.2, 0.2]])).toMatch(/at least 3/);
  });

  test("points must be normalised", () => {
    expect(validateZonePoints("line", [[0.1, 0.1], [1.4, 0.2]])).toMatch(/between 0 and 1/);
  });

  test("points must be numbers", () => {
    expect(validateZonePoints("line", [[0.1, 0.1], ["a", 0.2]])).toMatch(/finite numbers/);
  });

  test("a valid line passes", () => {
    expect(validateZonePoints("line", [[0.1, 0.1], [0.9, 0.2]])).toBeNull();
  });
});
