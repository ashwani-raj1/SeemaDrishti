import { all, db, one, run } from "../db";
import { nowIso } from "../core/ids";
import { clipRetentionDays } from "./settings";

/**
 * Evidence clips: the frames a crossing was judged from.
 *
 * WHAT A CLIP IS. Not video. `ibvap/core/clip.py` keeps a short ring of the
 * frames the detector actually processed and cuts the seconds either side of a
 * confirmed crossing out of it. So every frame here is a frame that was
 * judged -- which is a stronger claim than "footage from around that time",
 * and the reason the console labels it with its real (low) frame rate rather
 * than dressing it up as 30 fps.
 *
 * A CLIP IS EVIDENCE, THE EVENT IS THE RECORD. That distinction decides
 * everything in this file. The event log is append-only and never swept; clips
 * are swept on a retention window, because a megabyte per crossing fills a BOP
 * disk and the event survives to say what happened either way. A missing clip
 * degrades an incident. A missing event loses it.
 *
 * WHY FRAME-PER-ROW. The console needs a filmstrip (every frame's time, no
 * pixels) and a scrubber (one frame, now). Rows give both for free: the
 * manifest is a cheap SELECT that never touches `jpeg`, and a frame is a
 * primary-key lookup. Storing one blob per clip would mean shipping the whole
 * megabyte to show a thumbnail strip.
 */

export interface ClipFrameInput {
  /** Seconds relative to the crossing; negative before, positive after. */
  offset: number;
  /** base64 JPEG, as the worker encoded it. Never re-encoded here. */
  jpeg: string;
  boxes?: unknown[];
}

export interface StoreClipInput {
  clipId: string;
  orgId: string;
  cameraId: string | null;
  /** The crossing moment, ISO. */
  at: string;
  fps: number;
  simulated: boolean;
  frames: ClipFrameInput[];
}

/**
 * Write one clip and its frames.
 *
 * IDEMPOTENT BY ID. `DurableSink` retries with backoff, so a clip whose POST
 * succeeded on the node but timed out on the wire will arrive again. Without
 * the delete-first the second copy would double every frame's `seq` and the
 * scrubber would play the clip twice.
 *
 * Frames are stored EXACTLY as sent. The worker already chose the size and the
 * JPEG quality with the CPU budget in mind (section 3); re-encoding here would
 * spend the node's cycles to make the evidence worse.
 */
export function storeClip(input: StoreClipInput): { frames: number; bytes: number } {
  const at = nowIso();
  // Totalled before anything is written, because the parent row has to go in
  // FIRST -- `clip_frame.clip_id` is a foreign key, and inserting frames ahead
  // of the clip they belong to fails the constraint.
  const bytes = input.frames.reduce((total, frame) => total + frame.jpeg.length, 0);

  db.transaction(() => {
    // Replace, do not append. `DurableSink` retries with backoff, so a clip
    // whose POST reached the node but timed out on the wire arrives again --
    // and without this the second copy would double every frame and the
    // scrubber would play the crossing twice.
    run("DELETE FROM clip_frame WHERE clip_id = $id", { $id: input.clipId });
    run("DELETE FROM clip WHERE id = $id", { $id: input.clipId });

    run(
      `INSERT INTO clip (id, org_id, camera_id, at, fps, frame_count, bytes, simulated, created_at)
       VALUES ($id, $org, $camera, $at, $fps, $count, $bytes, $sim, $created)`,
      {
        $id: input.clipId,
        $org: input.orgId,
        $camera: input.cameraId,
        $at: input.at,
        $fps: input.fps,
        $count: input.frames.length,
        $bytes: bytes,
        $sim: input.simulated ? 1 : 0,
        $created: at,
      },
    );

    input.frames.forEach((frame, index) => {
      run(
        `INSERT INTO clip_frame (clip_id, seq, offset_s, jpeg, boxes)
         VALUES ($clip, $seq, $offset, $jpeg, $boxes)`,
        {
          $clip: input.clipId,
          $seq: index,
          $offset: frame.offset,
          $jpeg: frame.jpeg,
          $boxes: JSON.stringify(frame.boxes ?? []),
        },
      );
    });
  })();

  return { frames: input.frames.length, bytes };
}

/**
 * The filmstrip: every frame's time and boxes, and no pixels.
 *
 * `jpeg` is deliberately absent from this query. A 40-frame clip would be a
 * megabyte of base64 in a JSON response the console only wants timings from,
 * and it would arrive on every render of the incident page.
 */
export function clipManifest(clipId: string) {
  const clip = one<{
    id: string;
    camera_id: string | null;
    at: string;
    fps: number;
    frame_count: number;
    bytes: number;
    simulated: number;
    created_at: string;
  }>("SELECT * FROM clip WHERE id = $id", { $id: clipId });
  if (!clip) return null;

  const frames = all<{ seq: number; offset_s: number; boxes: string }>(
    "SELECT seq, offset_s, boxes FROM clip_frame WHERE clip_id = $id ORDER BY seq",
    { $id: clipId },
  );

  return {
    id: clip.id,
    cameraId: clip.camera_id,
    at: clip.at,
    fps: clip.fps,
    frameCount: clip.frame_count,
    bytes: clip.bytes,
    simulated: clip.simulated === 1,
    createdAt: clip.created_at,
    frames: frames.map((frame) => ({
      seq: frame.seq,
      offset: frame.offset_s,
      boxes: JSON.parse(frame.boxes) as unknown[],
    })),
  };
}

/** One frame's base64 JPEG, or null. The only place `jpeg` is ever read. */
export function clipFrame(clipId: string, seq: number): string | null {
  const row = one<{ jpeg: string }>(
    "SELECT jpeg FROM clip_frame WHERE clip_id = $id AND seq = $seq",
    { $id: clipId, $seq: seq },
  );
  return row?.jpeg ?? null;
}

/**
 * One frame whole: where it sits in the clip, what was boxed in it, and the
 * JPEG exactly as stored. For readers that want the frame as data rather than
 * as an image -- the MCP server hands the base64 straight to a model, so
 * decoding it here only for the caller to re-encode would be wasted work.
 */
export function clipFrameRecord(clipId: string, seq: number) {
  const row = one<{ seq: number; offset_s: number; boxes: string; jpeg: string }>(
    "SELECT seq, offset_s, boxes, jpeg FROM clip_frame WHERE clip_id = $id AND seq = $seq",
    { $id: clipId, $seq: seq },
  );
  if (!row) return null;

  return {
    clipId,
    seq: row.seq,
    offset: row.offset_s,
    boxes: JSON.parse(row.boxes) as unknown[],
    jpeg: row.jpeg,
  };
}

export interface ClipUsage {
  clips: number;
  frames: number;
  bytes: number;
  oldest: string | null;
}

export function clipUsage(orgId: string): ClipUsage {
  const row = one<{ clips: number; frames: number; bytes: number; oldest: string | null }>(
    `SELECT COUNT(*) AS clips,
            COALESCE(SUM(frame_count), 0) AS frames,
            COALESCE(SUM(bytes), 0) AS bytes,
            MIN(created_at) AS oldest
       FROM clip WHERE org_id = $org`,
    { $org: orgId },
  );
  return row ?? { clips: 0, frames: 0, bytes: 0, oldest: null };
}

/**
 * Delete clips past the retention window. Returns how many went.
 *
 * WHY THIS EXISTS AT ALL, stated plainly: `organisation.retention_days` has
 * been in the schema since the beginning and nothing has ever read it. Nothing
 * needed to -- an event is a few hundred bytes and a thumbnail fifteen
 * kilobytes, so the database grew slowly enough that "later" was a fair
 * answer. A clip is about a megabyte. At fifty crossings a day that is fifty
 * megabytes a day, forever, on a post with no operator and often no spare
 * disk. Retention stopped being optional the moment clips landed.
 *
 * ONLY CLIPS. Events, incidents and the audit log are untouched and are meant
 * to be: they are the record, they are small, and section 8's tamper-evident
 * claim depends on them not being quietly pruned. A supervisor who wants those
 * gone has the developer-node reset, which is audited and says so.
 *
 * Called after each insert rather than on a timer. The work is bounded (one
 * indexed DELETE), it cannot drift out of step with the setting, and a node
 * that never records a crossing never needs to sweep.
 */
export function sweepClips(orgId: string, now: Date = new Date()): number {
  const days = clipRetentionDays(orgId);
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();

  const doomed = all<{ id: string }>(
    "SELECT id FROM clip WHERE org_id = $org AND created_at < $cutoff",
    { $org: orgId, $cutoff: cutoff },
  );
  if (doomed.length === 0) return 0;

  db.transaction(() => {
    for (const clip of doomed) {
      run("DELETE FROM clip_frame WHERE clip_id = $id", { $id: clip.id });
      run("DELETE FROM clip WHERE id = $id", { $id: clip.id });
    }
  })();

  return doomed.length;
}
