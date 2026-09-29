import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ClipManifest } from "@/lib/types";

/**
 * The seconds either side of a crossing, as the frames the detector judged.
 *
 * NOT A VIDEO PLAYER, and the difference is the point. `vision-service/core/clip.py`
 * keeps a short ring of the frames that actually went through detection and
 * cuts the window around a confirmed crossing out of it. So every frame here
 * is a frame a decision was made from -- which is a stronger claim than
 * "footage from around that time", and the reason the rate is printed on the
 * face of it rather than hidden.
 *
 * At roughly six frames a second this is not smooth, and it must not pretend to
 * be. An operator who thinks they are watching video will read the gaps as the
 * subject moving in jumps; one who knows they are stepping through judged
 * frames reads them correctly.
 *
 * WHY THE SCRUBBER IS A FRAME INDEX and not a time slider. The frames are not
 * evenly spaced -- a worker under load drops to four a second and back up --
 * so a time slider would move at an honest-looking constant rate over
 * dishonestly spaced data. Stepping by frame means one notch is always exactly
 * one thing the detector looked at, and the offset beside it says when that
 * was.
 *
 * BOXES COME FROM THE MANIFEST, per frame. Drawing one bbox on every frame
 * would put the subject where it was at the crossing for the whole clip, which
 * looks like tracking and is the opposite of evidence.
 */

/** Playback steps at the clip's own rate, floored so it stays watchable. */
const MIN_STEP_MS = 90;

export function ClipPlayer({
  clipId,
  className,
}: {
  clipId: string;
  className?: string;
}) {
  const [manifest, setManifest] = useState<ClipManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setError(null);
    setIndex(0);
    setPlaying(false);

    api
      .clip(clipId)
      .then((body) => {
        if (cancelled) return;
        setManifest(body);
        // Open on the crossing itself, not on the first frame. The pre-roll is
        // context; the moment it fired is what somebody came here to see.
        const crossing = body.frames.reduce(
          (best, frame, i) =>
            Math.abs(frame.offset) < Math.abs(body.frames[best]!.offset) ? i : best,
          0,
        );
        setIndex(crossing);
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [clipId]);

  const frames = manifest?.frames ?? [];
  const current = frames[index];

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setIndex((at) => Math.min(frames.length - 1, Math.max(0, at + delta)));
    },
    [frames.length],
  );

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (!playing || frames.length === 0) return;

    const interval = Math.max(MIN_STEP_MS, 1000 / Math.max(manifest?.fps || 6, 1));
    timer.current = setInterval(() => {
      setIndex((at) => {
        if (at >= frames.length - 1) {
          setPlaying(false);
          return at;
        }
        return at + 1;
      });
    }, interval);

    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, frames.length, manifest?.fps]);

  /**
   * Every frame is prefetched once the manifest lands.
   *
   * The node serves them immutable, so this costs one request each for the
   * life of the page and makes scrubbing instant. A clip is a few dozen frames
   * of a few tens of kilobytes -- the same order as one photograph.
   */
  useEffect(() => {
    if (!manifest) return;
    for (const frame of manifest.frames) {
      const image = new Image();
      image.src = api.clipFrameUrl(manifest.id, frame.seq);
    }
  }, [manifest]);

  const duration = useMemo(() => {
    if (frames.length < 2) return 0;
    return frames[frames.length - 1]!.offset - frames[0]!.offset;
  }, [frames]);

  if (error) {
    return (
      <div className={cn("rounded-md border border-dashed p-6 text-center", className)}>
        <p className="text-sm font-medium">No clip for this crossing</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {/* Said precisely. A clip is evidence, not the record: the worker may
              not have had clips enabled, the clip may have been shed under
              load, or retention may have taken it. None of those change what
              the event says happened. */}
          {error}. The event itself is unaffected — clips are kept for a shorter
          window than the record.
        </p>
      </div>
    );
  }

  if (!manifest || !current) {
    return (
      <div className={cn("aspect-video animate-pulse rounded-md bg-muted", className)} />
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* ── the frame ─────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-md border bg-black">
        <img
          src={api.clipFrameUrl(manifest.id, current.seq)}
          alt={`Frame ${current.seq} at ${current.offset.toFixed(2)}s`}
          className="aspect-video w-full object-contain"
        />

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full"
        >
          {current.boxes.map((box, i) => {
            if (!box.bbox) return null;
            const [x1, y1, x2, y2] = box.bbox;
            return (
              <rect
                key={i}
                x={x1 * 100}
                y={y1 * 100}
                width={Math.max(0, (x2 - x1) * 100)}
                height={Math.max(0, (y2 - y1) * 100)}
                fill="none"
                stroke="#dc2626"
                strokeWidth="0.4"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        <div className="absolute left-2 top-2 flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-black/70 px-2 py-0.5 font-mono text-[11px] text-white backdrop-blur-sm">
            {current.offset > 0 ? "+" : ""}
            {current.offset.toFixed(2)}s
          </span>
          {/* Zero is the crossing. Labelled because "0.00s" alone does not say
              that this is the frame the decision was made on. */}
          {Math.abs(current.offset) < 0.001 && (
            <span className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              crossing
            </span>
          )}
          {manifest.simulated && (
            <span className="rounded bg-amber-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              simulated
            </span>
          )}
        </div>

        {current.boxes[0]?.class && (
          <span className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
            {current.boxes[0].class}
            {current.boxes[0].confidence != null &&
              ` ${Math.round(current.boxes[0].confidence * 100)}%`}
          </span>
        )}
      </div>

      {/* ── transport ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" className="size-8" onClick={() => step(-1)}>
          <SkipBackIcon className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          onClick={() => {
            // Replaying from the end should start over rather than sit still.
            if (index >= frames.length - 1) setIndex(0);
            setPlaying((on) => !on);
          }}
        >
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </Button>
        <Button size="icon" variant="outline" className="size-8" onClick={() => step(1)}>
          <SkipForwardIcon className="size-4" />
        </Button>

        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={index}
          onChange={(event) => {
            setPlaying(false);
            setIndex(Number(event.target.value));
          }}
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-destructive"
          aria-label="Frame"
        />

        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {index + 1}/{frames.length}
        </span>
      </div>

      {/* ── filmstrip ─────────────────────────────────────────────────── */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {frames.map((frame, i) => (
          <button
            key={frame.seq}
            type="button"
            onClick={() => {
              setPlaying(false);
              setIndex(i);
            }}
            className={cn(
              "shrink-0 overflow-hidden rounded border-2 transition-colors",
              i === index ? "border-destructive" : "border-transparent hover:border-muted-foreground/40",
            )}
          >
            <img
              src={api.clipFrameUrl(manifest.id, frame.seq)}
              alt=""
              loading="lazy"
              className="h-12 w-[68px] object-cover"
            />
            <span className="block bg-muted/60 px-1 text-center font-mono text-[9px] tabular-nums">
              {frame.offset > 0 ? "+" : ""}
              {frame.offset.toFixed(1)}
            </span>
          </button>
        ))}
      </div>

      {/* The honesty line. Section 7: no figure that was not measured, and this
          one IS measured -- it is the rate these particular frames arrived at,
          not the configured target. */}
      <p className="text-[11px] text-muted-foreground">
        {manifest.frameCount} frames over {duration.toFixed(1)}s at{" "}
        <Badge variant="secondary" className="h-4 px-1 font-mono text-[10px]">
          {manifest.fps.toFixed(1)} fps
        </Badge>{" "}
        — the rate this camera was actually judged at. Not video: these are the
        frames the detector looked at.
      </p>
    </div>
  );
}
