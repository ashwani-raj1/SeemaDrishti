import { DEFAULT_ORG } from "../db/seed";
import { clipFrame, clipManifest, clipUsage, storeClip, sweepClips } from "../l3/clips";
import { BadRequest } from "../l4/hooks";
import { CORS, handled, json, NotFound } from "../http";

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
 */

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

export const clipRoutes = {
  /**
   * A clip arrives, seconds after the event it belongs to.
   *
   * The delay is by design: the event goes the instant a crossing confirms,
   * and the clip waits for its post-roll (`ibvap/core/clip.py`). So this route
   * is never on the path of telling somebody an intrusion happened -- it is
   * only ever attaching the picture afterwards.
   *
   * The sweep runs here, after the insert, rather than on a timer: the work is
   * one indexed DELETE, it cannot drift out of step with the retention
   * setting, and a node that never records a crossing never sweeps.
   */
  "/hooks/ingress/clip": {
    POST: handled(async (req) => {
      const body = await readBody(req);

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
      return json({ ok: true, ...stored, swept });
    }),
  },

  /** The filmstrip: timings and boxes, no pixels. */
  "/api/clips/:clipId": handled(async (req: any) => {
    const manifest = clipManifest(req.params.clipId);
    if (!manifest) throw new NotFound(`no clip ${req.params.clipId}`);
    return json(manifest);
  }),

  /**
   * One frame, as an image.
   *
   * Cached hard for the same reason event thumbnails are: a clip is written
   * once and never edited, so frame N of clip X is the same bytes forever.
   * That is what makes scrubbing back and forth cost one fetch per frame
   * rather than one per scrub.
   */
  "/api/clips/:clipId/frames/:seq": handled(async (req: any) => {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) throw new BadRequest("seq must be a frame number");

    const encoded = clipFrame(req.params.clipId, seq);
    if (!encoded) throw new NotFound("no such frame");

    return new Response(Buffer.from(encoded, "base64"), {
      headers: {
        ...CORS,
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }),

  /** What clips are costing this node, for the settings page. */
  "/api/clips": handled(async () => json(clipUsage(DEFAULT_ORG))),
};

/**
 * A clip is about a megabyte, so it does not go through `readJson`'s shared
 * path -- kept separate here so the size limit for evidence can move without
 * also raising it for every other POST on the node.
 */
async function readBody(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    throw new BadRequest("body must be JSON");
  }
}
