import { Router } from "express";
import { DEFAULT_ORG } from "../db/seed";
import { clipFrame, clipFrameRecord, clipManifest, clipUsage } from "../l3/clips";
import { BadRequest } from "../l4/hooks";
import { NotFound } from "../http";

/**
 * Evidence clips, read side: the filmstrip and the frames it points at.
 *
 * The door clips come in through (`/hooks/ingress/clip`) is on main and
 * arrives with the merge.
 */

export const clipRoutes = Router();

/** What clips are costing this node, for the settings page. */
clipRoutes.get("/api/clips", (_req, res) => {
  res.json(clipUsage(DEFAULT_ORG));
});

/** The filmstrip: timings and boxes, no pixels. */
clipRoutes.get("/api/clips/:clipId", (req, res) => {
  const manifest = clipManifest(req.params.clipId);
  if (!manifest) throw new NotFound(`no clip ${req.params.clipId}`);
  res.json(manifest);
});

/**
 * One frame, as an image -- or, asked for JSON, as data: its offset, its
 * boxes and the base64 JPEG as stored. An `<img>`, or anything that accepts
 * any type, still gets the image, so the console is unaffected.
 *
 * Cached hard: a clip is written once and never edited, so frame N of clip X
 * is the same bytes forever. `Vary` keeps the two forms from being served in
 * each other's place.
 */
clipRoutes.get("/api/clips/:clipId/frames/:seq", (req, res) => {
  const seq = Number(req.params.seq);
  if (!Number.isInteger(seq) || seq < 0) throw new BadRequest("seq must be a frame number");

  res.vary("Accept").set("cache-control", "public, max-age=31536000, immutable");

  if (req.accepts(["image/jpeg", "application/json"]) === "application/json") {
    const frame = clipFrameRecord(req.params.clipId, seq);
    if (!frame) throw new NotFound("no such frame");
    res.json(frame);
    return;
  }

  const encoded = clipFrame(req.params.clipId, seq);
  if (!encoded) throw new NotFound("no such frame");
  res.type("image/jpeg").send(Buffer.from(encoded, "base64"));
});
