import { Router } from "express";
import { shapeEvent } from "../l3/events";
import {
  ingestDetections,
  ingestSensorContact,
  parseDetectionFrame,
  parseSensorContact,
} from "../l4/hooks";
import { ingestVisionEvent, parseVisionEvent } from "../l4/vision";
import { readJson } from "../http";

/**
 * The doors machines come in through. Each body is handed to its own parser
 * in l4/, which owns the wire format and refuses anything malformed, so the
 * routes here only choose the door and the status.
 */

export const ingressRoutes = Router();

/**
 * Raw per-frame detections, judged here by the fence (l2/fence.ts).
 * The simulator posts through this door.
 */
ingressRoutes.post("/hooks/ingress/detections", (req, res) => {
  const frame = parseDetectionFrame(readJson(req));
  res.status(202).json(ingestDetections(frame));
});

/**
 * Already-confirmed events from the vision service, which runs fence
 * geometry and plate OCR itself. It sends a FACT ("person crossed zone_3
 * inbound, held 1.4s"); this node applies the POLICY (severity, whether a
 * human is woken), because that policy lives in operator-editable zone
 * targets and is audited here. See l4/vision.ts for why that line is drawn
 * where it is.
 */
ingressRoutes.post("/hooks/ingress/events", (req, res) => {
  const event = parseVisionEvent(readJson(req));
  res.status(202).json(ingestVisionEvent(event));
});

ingressRoutes.post("/hooks/ingress/sensor", (req, res) => {
  const contact = parseSensorContact(readJson(req));
  const event = ingestSensorContact(contact);
  res.status(202).json(shapeEvent(event));
});
