import { nowIso } from "../core/ids";
import type { Detection, DetectionFrame } from "../core/types";
import { ingestDetections } from "../l4/hooks";

/**
 * A stand-in for the detector, so the fence has something to cross today.
 *
 * It is not wired into anything special: it posts through `ingestDetections`,
 * the same function the HTTP ingress hook calls. When a real detector arrives
 * it points at that endpoint and this file is deleted -- nothing else changes.
 *
 * Everything it produces is flagged `simulated` in the event itself, set once
 * here rather than by remembering to mention it.
 */

const TICK_MS = 250;
const SOURCE_ID = "sim.detector";

interface Walker {
  trackRef: string;
  cameraId: string;
  className: string;
  /** Waypoints in ground coordinates, walked in order. */
  legs: Array<[number, number]>;
  /** Normalised frame-widths per second. */
  speed: number;
  size: [number, number];
  confidence: number;
  /** Seconds to stand still on reaching each waypoint. */
  dwell: number;

  leg: number;
  progress: number;
  waiting: number;
  done: boolean;
}

let walkers: Walker[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let ambient = false;
let counter = 0;
let lastTick = 0;

const nextRef = (label: string) => `sim-${label}-${++counter}`;

function position(walker: Walker): [number, number] {
  const from = walker.legs[walker.leg]!;
  const to = walker.legs[walker.leg + 1] ?? from;
  return [
    from[0] + (to[0] - from[0]) * walker.progress,
    from[1] + (to[1] - from[1]) * walker.progress,
  ];
}

function toDetection(walker: Walker): Detection {
  const [x, y] = position(walker);
  const [w, h] = walker.size;
  return {
    track_ref: walker.trackRef,
    class: walker.className,
    confidence: walker.confidence,
    bbox: [x - w / 2, y - h, w, h],
  };
}

function advance(walker: Walker, deltaSeconds: number): void {
  if (walker.done) return;

  if (walker.waiting > 0) {
    walker.waiting -= deltaSeconds;
    return;
  }

  const from = walker.legs[walker.leg]!;
  const to = walker.legs[walker.leg + 1];
  if (!to) {
    walker.done = true;
    return;
  }

  const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1e-6;
  walker.progress += (walker.speed * deltaSeconds) / length;

  while (walker.progress >= 1) {
    walker.progress -= 1;
    walker.leg += 1;
    walker.waiting = walker.dwell;
    if (walker.leg >= walker.legs.length - 1) {
      walker.done = true;
      walker.progress = 0;
      return;
    }
    if (walker.dwell > 0) {
      walker.progress = 0;
      break;
    }
  }
}

function tick(): void {
  const now = Date.now();
  const delta = lastTick ? (now - lastTick) / 1000 : TICK_MS / 1000;
  lastTick = now;

  for (const walker of walkers) advance(walker, delta);

  const byCamera = new Map<string, Walker[]>();
  for (const walker of walkers) {
    if (walker.done) continue;
    const list = byCamera.get(walker.cameraId) ?? [];
    list.push(walker);
    byCamera.set(walker.cameraId, list);
  }

  const occurredAt = nowIso();
  for (const [cameraId, group] of byCamera) {
    const frame: DetectionFrame = {
      camera_id: cameraId,
      occurred_at: occurredAt,
      simulated: true,
      source_id: SOURCE_ID,
      detections: group.map(toDetection),
    };
    try {
      ingestDetections(frame);
    } catch (error) {
      console.error(`[sim] frame rejected for ${cameraId}:`, (error as Error).message);
    }
  }

  walkers = walkers.filter((walker) => !walker.done);

  if (ambient && walkers.length < 2 && Math.random() < 0.08) {
    walkers.push(...scenarioWalkers(ambientPick()));
  }
}

// ------------------------------------------------------------------ scenarios

export type ScenarioName =
  | "intruder"
  | "cattle"
  | "flicker"
  | "farmer_gate"
  | "patrol_road"
  | "boat_waterline"
  | "drone_pickup";

const AMBIENT: ScenarioName[] = ["cattle", "flicker", "farmer_gate", "patrol_road"];
const ambientPick = (): ScenarioName => AMBIENT[Math.floor(Math.random() * AMBIENT.length)]!;

const base = (over: Partial<Walker> & Pick<Walker, "cameraId" | "className" | "legs">): Walker => ({
  trackRef: nextRef(over.className),
  speed: 0.06,
  size: [0.045, 0.16],
  confidence: 0.82,
  dwell: 0,
  leg: 0,
  progress: 0,
  waiting: 0,
  done: false,
  ...over,
});

/**
 * Each scenario is one situation the fence should get right. The interesting
 * ones are the negatives: cattle must be logged and never alerted, and a
 * flicker must be rejected rather than shouted.
 */
export function scenarioWalkers(name: ScenarioName): Walker[] {
  switch (name) {
    // Walks from the far side, over the fence, and keeps going. Confirms.
    case "intruder":
      return [base({
        cameraId: "cam_fence_north",
        className: "person",
        legs: [[0.30, 0.30], [0.34, 0.72], [0.40, 0.92]],
        speed: 0.075,
      })];

    // Crosses the same fence line. Logged, never alerted.
    case "cattle":
      return [base({
        cameraId: "cam_fence_north",
        className: "cattle",
        legs: [[0.72, 0.34], [0.68, 0.80]],
        speed: 0.05,
        size: [0.09, 0.10],
        confidence: 0.74,
      })];

    // Steps over the line and straight back. Must not raise an alarm.
    case "flicker":
      return [base({
        cameraId: "cam_fence_north",
        className: "person",
        legs: [[0.52, 0.72], [0.52, 0.52], [0.52, 0.75]],
        speed: 0.28,
      })];

    // Lawful daily traffic through the gate. A warning, not a critical.
    case "farmer_gate":
      return [base({
        cameraId: "cam_farm_gate",
        className: "tractor",
        legs: [[0.50, 0.98], [0.50, 0.60], [0.50, 0.20]],
        speed: 0.09,
        size: [0.14, 0.14],
      })];

    case "patrol_road":
      return [base({
        cameraId: "cam_patrol_road",
        className: "vehicle",
        legs: [[0.02, 0.70], [0.50, 0.68], [0.98, 0.66]],
        speed: 0.13,
        size: [0.12, 0.10],
      })];

    case "boat_waterline":
      return [base({
        cameraId: "cam_waterline",
        className: "boat",
        legs: [[0.20, 0.20], [0.30, 0.70]],
        speed: 0.06,
        size: [0.13, 0.07],
      })];

    // Out to an unusual spot, a pause, then back the same way -- the ground
    // signature of collecting a dropped consignment.
    case "drone_pickup":
      return [base({
        cameraId: "cam_patrol_road",
        className: "person",
        legs: [[0.50, 0.95], [0.55, 0.62], [0.50, 0.95]],
        speed: 0.09,
        dwell: 4,
      })];

    default:
      return [];
  }
}

// ------------------------------------------------------------------ control

export function runScenario(name: ScenarioName): number {
  const spawned = scenarioWalkers(name);
  walkers.push(...spawned);
  if (!timer) start(false);
  return spawned.length;
}

export function start(withAmbient = true): void {
  ambient = withAmbient;
  if (timer) return;
  lastTick = Date.now();
  timer = setInterval(tick, TICK_MS);
  console.log(`[sim] running${withAmbient ? " with ambient traffic" : ""}`);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ambient = false;
  walkers = [];
  console.log("[sim] stopped");
}

export const status = () => ({
  running: timer !== null,
  ambient,
  walkers: walkers.length,
  scenarios: [
    "intruder",
    "cattle",
    "flicker",
    "farmer_gate",
    "patrol_road",
    "boat_waterline",
    "drone_pickup",
  ] satisfies ScenarioName[],
});
