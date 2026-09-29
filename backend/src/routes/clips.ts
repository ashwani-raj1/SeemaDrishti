import { Router } from "express";
import { DEFAULT_ORG } from "../db/seed";
import { clipFrame, clipFrameRecord, clipManifest, clipUsage, storeClip, sweepClips } from "../l3/clips";
import { BadRequest } from "../l4/hooks";
import { NotFound, readJson } from "../http";

/**
 * Evidence clips: one door in from the worker, two doors out to the console.
 *
 * IN is `/hooks/ingress/clip`, beside the other ingress hooks and
 * unauthenticated for the same reason they are -- the worker is a process on
 * the same post, not a user, and `source_id` is how an event says which worker
 * it came from.
 *
 * OUT is deliberately split. The manifest carries every frame's time and boxes
 * and NO pixels, so the console can draw a filmstrip and a scrubber from one
 * cheap request; the frames come one at a time, as images the browser caches
 * like any other. Putting the base64 in the manifest would mean shipping a
 * megabyte on every render of an incident page to show a strip of timings.
 *
 * A clip is about a megabyte. It rides the app-wide JSON body limit in
 * `app.ts`, which is sized for plate snapshots and clips alike.
 */

/** POST /hooks/ingress/clip */
export interface ClipBody {
  clip_id?: string;
  camera_id?: string;
  occurred_at?: string;
  fps?: number;
  simulated?: boolean;
  frames?: unknown;
}

/** Frames as the worker sends them: an offset, a base64 JPEG, and its boxes. */
function parseFrames(raw: unknown): Array<{ offset: number; jpeg: string; boxes: unknown[] }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequest("a clip needs at least one frame");
  }
  return raw.map((entry: any, index: number) => {
    if (!entry || typeof entry !== "object") {
      throw new BadRequest(`frames[${index}] must be an object`);
    }
    if (typeof entry.jpeg !== "string" || !entry.jpeg) {
      throw new BadRequest(`frames[${index}].jpeg is required`);
    }
    const offset = Number(entry.offset);
    if (!Number.isFinite(offset)) {
      throw new BadRequest(`frames[${index}].offset must be a number of seconds`);
    }
    return {
      offset,
      jpeg: entry.jpeg,
      boxes: Array.isArray(entry.boxes) ? entry.boxes : [],
    };
  });
}

export const clipRoutes = Router();

/**
 * A clip arrives, seconds after the event it belongs to.
 *
 * The delay is by design: the event goes the instant a crossing confirms,
 * and the clip waits for its post-roll (`vision-service/core/clip.py`). So this route
 * is never on the path of telling somebody an intrusion happened -- it is
 * only ever attaching the picture afterwards.
 *
 * The sweep runs here, after the insert, rather than on a timer: the work is
 * one indexed DELETE, it cannot drift out of step with the retention
 * setting, and a node that never records a crossing never sweeps.
 */
clipRoutes.post("/hooks/ingress/clip", (req, res) => {
  const body = readJson<ClipBody>(req);

  const clipId = body.clip_id;
  if (typeof clipId !== "string" || !clipId) {
    throw new BadRequest("clip_id is required");
  }

  const frames = parseFrames(body.frames);
  const stored = storeClip({
    clipId,
    orgId: DEFAULT_ORG,
    cameraId: typeof body.camera_id === "string" ? body.camera_id : null,
    // The worker's monotonic clock means nothing here, so the crossing is
    // stamped with the node's own time of receipt when the worker did not
    // send a wall-clock one. Off by the post-roll at worst, and the
    // per-frame offsets carry the real relative timing regardless.
    at: typeof body.occurred_at === "string" ? body.occurred_at : new Date().toISOString(),
    fps: Number.isFinite(Number(body.fps)) ? Number(body.fps) : 0,
    simulated: body.simulated === true,
    frames,
  });

  const swept = sweepClips(DEFAULT_ORG);
  res.json({ ok: true, ...stored, swept });
});

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
 * Cached hard for the same reason event thumbnails are: a clip is written
 * once and never edited, so frame N of clip X is the same bytes forever.
 * That is what makes scrubbing back and forth cost one fetch per frame
 * rather than one per scrub. `Vary` keeps the two forms from being served
 * in each other's place.
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
