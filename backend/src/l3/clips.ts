import { all, one } from "../db";

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
 * A CLIP IS EVIDENCE, THE EVENT IS THE RECORD. An event points at its clip
 * through `evidence.clipId`; the clip can be swept on retention and the event
 * still says what happened.
 *
 * WHY FRAME-PER-ROW. The manifest (every frame's time and boxes, no pixels) is
 * a cheap SELECT that never touches `jpeg`, and one frame is a primary-key
 * lookup.
 *
 * Only the read side lives on this branch. Storing and sweeping clips
 * (`storeClip`, `sweepClips`, `/hooks/ingress/clip`) are on main and arrive
 * with the merge.
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
