import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CctvIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { CameraStatusPill } from "@/components/ibvap/badges";
import { VisionStatusCard } from "@/components/ibvap/vision-status";
import { LoadingRows, NothingHere } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { relative } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { CameraStatus, HubCamera, IbvapEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * What we can currently see, and what we are blind to.
 *
 * THE FAILURE THIS PAGE EXISTS TO PREVENT is silent capability loss. A camera
 * that stopped sending frames looks exactly like a quiet night: no detections,
 * no incidents, nothing on screen. Existing systems lose capability quietly and
 * nobody finds out until somebody asks for footage that was never recorded.
 *
 * TWO STATES, KEPT APART ON PURPOSE, because they need different people:
 *
 *   status    OBSERVED. Written by the vision service from what it can
 *             actually see. FULL / DEGRADED / MOTION_ONLY / RECORD_ONLY / DEAD.
 *             A DEAD camera means send somebody to look at it.
 *   enabled   DECIDED. A person took the feed out of service, for maintenance
 *             or because it points at nothing useful. Nobody needs to go and
 *             check a camera that was switched off on purpose.
 *
 * Collapsing them into one "offline" would make "we are blind here" look
 * identical to "we stopped looking here", and only one of those needs a patrol.
 *
 * The hub column is a third fact again: whether the media server has the path
 * at all. A camera seeded in the node but absent from the hub is a
 * configuration mistake, not a dead camera.
 */

const LADDER: Array<{ status: CameraStatus; meaning: string }> = [
  { status: "FULL", meaning: "Detection and recording" },
  { status: "DEGRADED", meaning: "Reduced — poor light, weather or bandwidth" },
  { status: "MOTION_ONLY", meaning: "Movement seen, no classification" },
  { status: "RECORD_ONLY", meaning: "Recording, nothing analysed" },
  { status: "DEAD", meaning: "No frames arriving" },
];

export function CameraHealthScreen() {
  const { media } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);
  const [events, setEvents] = useState<IbvapEvent[] | null>(null);

  const loadEvents = useCallback(async () => {
    // class "camera" is what l4/vision.ts records a camera_health event under.
    setEvents(await api.events({ class: "camera", limit: 25 }));
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const off = onStream("event", () => {
      void loadEvents();
      hub.reload();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEvents]);

  const cameras = hub.data?.cameras ?? [];
  const blind = cameras.filter((camera) => !camera.ready && camera.enabled !== false);

  return (
    <PageShell
      title="Camera health"
      description="What each feed can currently see, and what it cannot."
    >
      {hub.data && !hub.data.hub.reachable && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>The media hub is not answering</AlertTitle>
          <AlertDescription>
            {hub.data.hub.url} — {hub.data.hub.error}. Every camera below is
            shown from the node's records; none of them is being checked against
            a live feed right now.
          </AlertDescription>
        </Alert>
      )}

      {blind.length > 0 && hub.data?.hub.reachable && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            {blind.length} camera{blind.length === 1 ? "" : "s"} not sending frames
          </AlertTitle>
          <AlertDescription>
            {blind.map((camera) => camera.name).join(", ")} — in service but no
            video arriving. This is blindness, not a quiet night.
          </AlertDescription>
        </Alert>
      )}

      {hub.loading && <LoadingRows rows={4} />}

      {!hub.loading && cameras.length === 0 && (
        <NothingHere
          icon={CctvIcon}
          title="No cameras"
          description="Neither the hub nor the node has any."
        />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cameras.map((camera) => (
          <HealthCard key={camera.id} camera={camera} whepBase={media?.whepBase} />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <VisionStatusCard />
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">
              Recent health changes
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events === null && <LoadingRows rows={3} />}
            {events?.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No camera has changed state since the node started.
              </p>
            )}
            <div className="flex flex-col gap-2">
              {events?.map((event) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {String((event.evidence as Record<string, unknown>)?.camera ?? event.cameraId)}
                    {" — "}
                    <span className="font-mono text-xs">{event.rule}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relative(event.occurredAt)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">The blindness ladder</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {LADDER.map((rung) => (
              <div key={rung.status} className="flex items-start justify-between gap-3">
                <CameraStatusPill status={rung.status} />
                <span className="flex-1 text-right text-xs text-muted-foreground">
                  {rung.meaning}
                </span>
              </div>
            ))}
            <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
              Observed by the vision service, never set by hand. A camera taken
              out of service by a person shows as <strong>disabled</strong>
              instead — that is a decision, not blindness.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function HealthCard({ camera, whepBase }: { camera: HubCamera; whepBase?: string }) {
  const offService = camera.enabled === false;

  return (
    <Card className={cn(offService && "opacity-60")}>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate text-sm font-medium">{camera.name}</CardTitle>
          <span className="font-mono text-[10px] text-muted-foreground">{camera.id}</span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {camera.status && <CameraStatusPill status={camera.status} />}
          {offService && (
            <Badge variant="outline" className="text-[10px]">disabled</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* showBoxes off: this page is about whether a picture arrives at all,
            and overlaying detections would make a live-but-undetected feed
            look like a dead one. */}
        <CameraFeed
          cameraId={camera.id}
          whepBase={whepBase}
          showBoxes={false}
          module={null}
        />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Hub</dt>
          <dd className="text-right">
            {camera.ready ? (
              <span className="text-emerald-600 dark:text-emerald-400">serving</span>
            ) : (
              <span className="text-destructive">no feed</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Format</dt>
          <dd className="text-right font-mono">
            {camera.width ? `${camera.width}×${camera.height} ${camera.codec ?? ""}` : "—"}
          </dd>
          <dt className="text-muted-foreground">Readers</dt>
          <dd className="text-right font-mono">{camera.readers}</dd>
          <dt className="text-muted-foreground">Up since</dt>
          <dd className="text-right">
            {camera.readySince ? relative(camera.readySince) : "—"}
          </dd>
        </dl>
        {!camera.seeded && (
          // The one state that looks fine and is not: video arrives, nothing is
          // ever recorded from it, and no incident can open.
          <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            Serving video but not registered with the node — every detection
            from this camera is rejected. Add it on the Cameras page.
          </p>
        )}
        <Link
          to={`/cameras/${camera.id}`}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Camera settings
        </Link>
      </CardContent>
    </Card>
  );
}
