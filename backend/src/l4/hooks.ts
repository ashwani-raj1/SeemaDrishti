import { one } from "../db";
import { nowIso } from "../core/ids";
import type { DetectionFrame, Severity } from "../core/types";
import { processFrame, type FrameResult } from "../l2/fence";
import { recordEvent } from "../l3/events";

/**
 * L4 -- the doorway. Everything that enters the system comes through here,
 * and becomes the same kind of object once it does.
 *
 * Two directions in, and they enter at different depths on purpose:
 *
 *   detections   -> L2, because they still need judging against the zones
 *   sensor alerts -> L3, skipping the camera pipeline entirely
 *
 * That second one is the whole reason an anti-drone radio detector can be
 * absorbed without any part of the video path knowing it exists.
 */

export class BadRequest extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequest(`${field} is required`);
  return value;
}

/** Validate an incoming detection frame before it reaches the fence. */
export function parseDetectionFrame(body: unknown): DetectionFrame {
  if (!body || typeof body !== "object") throw new BadRequest("body must be an object");
  const raw = body as Record<string, any>;

  const cameraId = requireString(raw.camera_id, "camera_id");
  if (!Array.isArray(raw.detections)) throw new BadRequest("detections must be an array");

  const detections = raw.detections.map((item: any, index: number) => {
    if (!item || typeof item !== "object") throw new BadRequest(`detections[${index}] must be an object`);
    const bbox = item.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n: any) => typeof n !== "number" || !Number.isFinite(n))) {
      throw new BadRequest(`detections[${index}].bbox must be four finite numbers`);
    }
    return {
      track_ref: requireString(item.track_ref, `detections[${index}].track_ref`),
      class: requireString(item.class, `detections[${index}].class`),
      confidence: typeof item.confidence === "number" ? item.confidence : 1,
      bbox: bbox as [number, number, number, number],
    };
  });

  const occurredAt = typeof raw.occurred_at === "string" ? raw.occurred_at : nowIso();
  if (Number.isNaN(Date.parse(occurredAt))) throw new BadRequest("occurred_at is not a valid timestamp");

  return {
    camera_id: cameraId,
    occurred_at: occurredAt,
    // Flagged at the adapter, once, so it cannot be forgotten downstream.
    simulated: raw.simulated === true,
    source_id: typeof raw.source_id === "string" ? raw.source_id : cameraId,
    detections,
  };
}

/**
 * The single entry point for detections. The simulator and a real detector
 * both land here, so nothing built on top of it has to be reworked later.
 */
export function ingestDetections(frame: DetectionFrame): FrameResult {
  return processFrame(frame);
}

export interface SensorContact {
  siteId: string;
  sensorId: string;
  sensorType: string;
  contact: string;
  severity: Severity;
  simulated: boolean;
  occurredAt: string;
  cameraId?: string | null;
  zoneId?: string | null;
  grid?: string | null;
  detail?: unknown;
}

/**
 * An alert from equipment that can see what a ground camera cannot.
 *
 * It enters at L3 as an ordinary event. If it names a zone, it uses that
 * zone's group key -- so a radio contact and a camera crossing minutes later
 * stitch into one incident rather than two unrelated ones.
 */
export function ingestSensorContact(input: SensorContact) {
  const site = one<{ org_id: string }>("SELECT org_id FROM site WHERE id = $id", { $id: input.siteId });
  if (!site) throw new BadRequest(`unknown site ${input.siteId}`);

  const groupKey =
    input.cameraId && input.zoneId
      ? `${input.cameraId}:${input.zoneId}`
      : `${input.siteId}:grid:${input.grid ?? "unknown"}`;

  return recordEvent({
    orgId: site.org_id,
    siteId: input.siteId,
    kind: "sensor_contact",
    sourceType: "external_sensor",
    sourceId: input.sensorId,
    simulated: input.simulated,
    cameraId: input.cameraId ?? null,
    zoneId: input.zoneId ?? null,
    class: input.sensorType,
    rule: `sensor.${input.sensorType}.contact`,
    severity: input.severity,
    alertable: true,
    occurredAt: input.occurredAt,
    evidence: { contact: input.contact, grid: input.grid ?? null, detail: input.detail ?? {} },
    groupKey,
    title: `${input.sensorType} contact ${input.contact}`,
  });
}

export function parseSensorContact(body: unknown): SensorContact {
  if (!body || typeof body !== "object") throw new BadRequest("body must be an object");
  const raw = body as Record<string, any>;

  const severity = (raw.severity ?? "WARNING") as Severity;
  if (!["INFO", "WARNING", "CRITICAL"].includes(severity)) {
    throw new BadRequest("severity must be INFO, WARNING or CRITICAL");
  }

  return {
    siteId: requireString(raw.site_id, "site_id"),
    sensorId: requireString(raw.sensor_id, "sensor_id"),
    sensorType: requireString(raw.sensor_type, "sensor_type"),
    contact: typeof raw.contact === "string" ? raw.contact : "contact",
    severity,
    simulated: raw.simulated === true,
    occurredAt: typeof raw.occurred_at === "string" ? raw.occurred_at : nowIso(),
    cameraId: raw.camera_id ?? null,
    zoneId: raw.zone_id ?? null,
    grid: raw.grid ?? null,
    detail: raw.detail,
  };
}
