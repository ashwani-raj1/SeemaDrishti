import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  onLiveState, onVisionStatus, type LiveState, type VisionStatus,
} from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * Is the detector running, and what is it actually managing?
 *
 * THE FAILURE THIS PREVENTS: observations only arrive when a camera produces
 * frames, so an empty overlay could mean a quiet border or a crashed detector.
 * Those look identical on screen and need opposite responses. The vision
 * service therefore says it is alive every two seconds whether or not anything
 * moved, and this is where that is read.
 *
 * IT SHOWS THE NUMBERS, NOT A GREEN TICK. A service technically running at one
 * frame every four seconds is not healthy, and "ok" would hide that. fps and
 * detector milliseconds are the same figures the run summary prints at exit --
 * one set of numbers, so neither can quietly disagree with the other.
 *
 * SEPARATE FROM THE NODE'S DOT. `live-dot.tsx` reports the edge node's SSE
 * stream. These are two independent links: the node going quiet means the
 * record stopped, the detector going quiet means only the overlay did. Showing
 * one where the other is meant sends somebody to restart the wrong process.
 */

/** Beyond this, a heartbeat is old enough to distrust. It arrives every 2s. */
const STALE_AFTER_MS = 8000;

export function useVisionStatus() {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [link, setLink] = useState<LiveState>("connecting");
  const [, tick] = useState(0);

  useEffect(() => onVisionStatus(setStatus), []);
  useEffect(() => onLiveState(setLink), []);
  useEffect(() => {
    // Re-render on a timer so "last seen 9s ago" goes stale on screen even
    // when nothing arrives -- silence is the signal here, and a card that only
    // updates on a message could never show it.
    const timer = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  const stale = status ? Date.now() - status.receivedAt > STALE_AFTER_MS : false;
  const up = link === "live" && status !== null && !stale;
  return { status, link, stale, up };
}

export function VisionStatusCard({ className }: { className?: string }) {
  const { status, link, stale, up } = useVisionStatus();

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm font-medium">Vision service</CardTitle>
        <Badge variant={up ? "secondary" : "destructive"}>
          {up ? "running" : link === "connecting" ? "connecting" : "not reporting"}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!status && (
          <p className="text-muted-foreground">
            {link === "live"
              ? "Connected, but the service has not identified itself yet."
              : "No connection to the detector. Video and the record are unaffected — only the overlay is."}
          </p>
        )}

        {status && (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Run</span>
              <span className="font-mono text-xs">{status.run_id}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Uptime</span>
              <span className="font-mono">{formatUptime(status.uptime_s)}</span>
            </div>
            {stale && (
              <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                Last heartbeat {Math.round((Date.now() - status.receivedAt) / 1000)}s
                ago. The detector has stopped reporting.
              </p>
            )}

            <div className="flex flex-col gap-1 border-t pt-2">
              {status.cameras.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Running, but managing no cameras — check IBVAP_WORKER_CAMERAS.
                </p>
              )}
              {status.cameras.map((camera) => (
                <div key={camera.camera_id} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      camera.feed === "live" ? "bg-emerald-500" : "bg-destructive",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {camera.camera_id}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {camera.fps.toFixed(1)} fps
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {camera.detector_ms.toFixed(0)} ms
                  </span>
                </div>
              ))}
            </div>

            {status.durable && (
              <div className="flex items-baseline justify-between border-t pt-2 text-xs">
                <span className="text-muted-foreground">Events to the node</span>
                <span className="font-mono">
                  {status.durable.sent} sent
                  {status.durable.failed > 0 && (
                    <span className="text-destructive"> · {status.durable.failed} failed</span>
                  )}
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
