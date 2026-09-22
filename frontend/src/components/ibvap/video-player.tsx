import { useCallback, useEffect, useRef, useState } from "react";
import {
  CameraIcon, ChevronDownIcon, MaximizeIcon, MinimizeIcon, PauseIcon, PlayIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraFeed, type FeedZone } from "@/components/ibvap/camera-feed";
import { cn } from "@/lib/utils";

/**
 * The camera picture with the controls an operator expects around it.
 *
 * WHY A WRAPPER AND NOT A REWRITE. `CameraFeed` already owns the hard parts:
 * the WHEP connection, the zone overlay drawn in the detector's own normalised
 * coordinates, the live boxes, and the aspect handling that keeps a click on
 * the frame meaning the same thing as a point in the geometry. None of that is
 * chrome. This adds only the chrome, so there is still exactly one place where
 * a picture and its overlay meet.
 *
 * PAUSE PAUSES THE PICTURE AND NOTHING ELSE. The detector keeps running, the
 * node keeps recording, and incidents keep arriving while this is paused --
 * because the whole point of pausing is to look hard at something that just
 * happened without the scene moving on. So the LIVE badge goes to PAUSED the
 * instant it is pressed: an operator must never be able to mistake a frozen
 * frame for a quiet one. That confusion is the single most dangerous thing a
 * video control can do in a control room.
 *
 * THE STILL IS A CONVENIENCE, NOT EVIDENCE. The button grabs what is on screen
 * into a PNG the browser downloads. It is untimestamped by the node, unsigned,
 * and outside the hash-chained log -- so it is for sticking in a radio message,
 * never for anything that has to hold up later. The real evidence is the
 * event's own thumbnail, cut by the vision service at the moment of confirming
 * and stored with the record.
 *
 * Generic on purpose: it takes a camera and some zones. Only the fence page
 * mounts it today.
 */

export interface VideoPlayerProps {
  cameraId: string;
  cameraName: string;
  whepBase?: string;
  zones?: FeedZone[];
  /** Which module's overlay to draw. `null` merges all of them. */
  module?: string | null;
  /** Shown under the name -- a grid reference, an area, wherever this is. */
  place?: string;
  className?: string;
}

export function VideoPlayer({
  cameraId,
  cameraName,
  whepBase,
  zones = [],
  module = null,
  place,
  className,
}: VideoPlayerProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [clock, setClock] = useState(() => new Date());

  // The wall clock burned into the corner, as a control room expects. One
  // second is the right cadence: this is for reading off during a radio call,
  // and anything faster is just work for the compositor.
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fullscreen can also be left with Escape or the browser's own control, so
  // the button's state has to follow the document rather than the last click.
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
      setPaused(false);
    } else {
      video.pause();
      setPaused(true);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen?.();
  }, []);

  /**
   * The frame as it looks right now, overlay included.
   *
   * Drawn from the <video> rather than the canvas so the picture is the
   * picture; the overlay canvas is composited on top afterwards, at the size
   * it is actually displayed. Grabbing only the canvas would produce boxes
   * floating on transparency, which is a diagram, not a still.
   */
  const grabStill = useCallback(() => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const overlay = shellRef.current?.querySelector("canvas");
    if (overlay) context.drawImage(overlay, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      link.download = `${cameraId}-${stamp}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [cameraId]);

  return (
    <div
      ref={shellRef}
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-black",
        fullscreen && "rounded-none border-0",
        className,
      )}
    >
      <CameraFeed
        cameraId={cameraId}
        whepBase={whepBase}
        zones={zones}
        module={module}
        showBoxes={showBoxes}
        onVideo={(element) => {
          videoRef.current = element;
        }}
        className="size-full"
      />

      {/* ── top: what am I looking at ─────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent p-3">
        <div className="min-w-0">
          <span className="inline-flex rounded-md bg-black/65 px-2.5 py-1 text-sm font-semibold text-white backdrop-blur-sm">
            {cameraName}
          </span>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white",
                paused ? "bg-amber-600" : "bg-red-600",
              )}
            >
              {!paused && <span className="size-1.5 animate-pulse rounded-full bg-white" />}
              {paused ? "Paused" : "Live"}
            </span>
            <span className="rounded bg-black/65 px-2 py-0.5 font-mono text-[11px] text-white/90 backdrop-blur-sm">
              {clock.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}
              {" · "}
              {clock.toLocaleTimeString([], { hour12: false })}
            </span>
            {place && (
              <span className="truncate rounded bg-black/65 px-2 py-0.5 text-[11px] text-white/80 backdrop-blur-sm">
                {place}
              </span>
            )}
          </div>
        </div>

        <div className="pointer-events-auto flex shrink-0 gap-1.5">
          <PlayerButton onClick={grabStill} label="Save a still of this frame">
            <CameraIcon className="size-4" />
          </PlayerButton>
          <PlayerButton
            onClick={toggleFullscreen}
            label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
          </PlayerButton>
        </div>
      </div>

      {/* ── bottom: what can I do about it ────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/75 to-transparent p-3">
        <div className="flex items-center gap-2">
          <PlayerButton onClick={togglePause} label={paused ? "Resume" : "Pause the picture"}>
            {paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
          </PlayerButton>
          <span className="inline-flex items-center gap-1.5 rounded bg-black/65 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
            <span
              className={cn(
                "size-2 rounded-full",
                paused ? "bg-amber-400" : "animate-pulse bg-emerald-400",
              )}
            />
            {paused ? "Picture paused — recording continues" : "Live"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowBoxes((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded bg-black/65 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/80"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                showBoxes ? "bg-sky-400" : "bg-white/30",
              )}
            />
            {showBoxes ? "Hide detections" : "Show detections"}
            <ChevronDownIcon className={cn("size-3.5 transition-transform", showBoxes && "rotate-180")} />
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="size-8 rounded bg-black/65 text-white backdrop-blur-sm hover:bg-black/80 hover:text-white"
    >
      {children}
    </Button>
  );
}
