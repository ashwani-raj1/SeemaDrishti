import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CctvIcon, CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageShell } from "@/components/ibvap/page-shell";
import { CameraFeed, type FeedZone } from "@/components/ibvap/camera-feed";
import { SeverityBadge } from "@/components/ibvap/badges";
import { ReasonDialog } from "@/components/ibvap/reason-dialog";
import { LoadingRows, NothingHere } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { HistoryLink } from "@/components/ibvap/history-link";
import { ATTARI_SECTOR, formatLatLon, gridRef } from "@/client/geography";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { relative } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { SEVERITY_RANK, type HubCamera, type Incident } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LiveConsole } from "./live-console";
import { useDecide } from "./use-decide";

/**
 * The frame every service page sits in.
 *
 * One page per detection module, and each one answers the same four questions
 * in the same order, because an operator moving between them should not have to
 * relearn the layout:
 *
 *   what is the camera seeing      the picture, with this module's overlay
 *   where is that                  the ground, so a radio call has a grid ref
 *   what is happening right now    the live console -- unconfirmed, ephemeral
 *   what needs a decision          incidents -- durable, from the node
 *
 * THE TOP HALF AND THE BOTTOM HALF ARE DIFFERENT KINDS OF TRUE, and the layout
 * says so. Everything above the console is the vision service's opinion about
 * this instant; everything in the incidents panel is the node's record, already
 * persisted and already audited. An operator acts on the second, never the
 * first. That is why there is no action button anywhere near the live feed.
 *
 * The camera list comes from the media hub, so a camera appears here when it
 * starts serving and disappears when it stops -- rather than from a hardcoded
 * list that keeps showing a feed nobody is publishing.
 */

export interface ServiceShellProps {
  title: string;
  description: string;
  /** The vision module this page is the face of. */
  module: string;
  /** Which durable event kinds belong to this service. */
  eventKinds: string[];
  /** Drawn over the picture, when the module cares about zones. */
  zonesFor?: (cameraId: string) => FeedZone[];
  /** Extra panels under the console, specific to one service. */
  children?: (camera: HubCamera) => ReactNode;
  /** Shown when the hub has cameras but none run this module. */
  emptyHint?: string;
}

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-destructive/10 text-destructive border-destructive/30",
  ACKNOWLEDGED: "bg-muted text-muted-foreground",
  ESCALATED: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
  DISMISSED: "bg-muted text-muted-foreground line-through",
};

export function ServiceShell({
  title,
  description,
  module,
  zonesFor,
  children,
  emptyHint,
}: ServiceShellProps) {
  const { cameras: known, media } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);
  const [cameraId, setCameraId] = useState<string | null>(null);

  const cameras = hub.data?.cameras ?? [];
  // Pick the first camera actually serving frames. Defaulting to one that is
  // down would open every service page on a black rectangle and read as a
  // broken console rather than a stopped feed.
  useEffect(() => {
    if (cameraId || cameras.length === 0) return;
    const first = cameras.find((camera) => camera.ready) ?? cameras[0];
    if (first) setCameraId(first.id);
  }, [cameras, cameraId]);

  const camera = cameras.find((entry) => entry.id === cameraId) ?? null;

  // ── incidents on this camera ─────────────────────────────────────────
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loadingIncidents, setLoadingIncidents] = useState(true);

  const loadIncidents = useCallback(async () => {
    if (!cameraId) return;
    try {
      const list = await api.incidents({ camera_id: cameraId, limit: 50 });
      setIncidents(
        [...list].sort(
          (a, b) =>
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt),
        ),
      );
    } finally {
      setLoadingIncidents(false);
    }
  }, [cameraId]);

  useEffect(() => {
    setLoadingIncidents(true);
    void loadIncidents();
  }, [loadIncidents]);

  // The node pushes; this screen does not poll. An incident opened by the
  // detector two seconds ago must be on screen without a refresh.
  useEffect(() => {
    const offIncident = onStream("incident", () => void loadIncidents());
    const offEvent = onStream("event", () => void loadIncidents());
    return () => {
      offIncident();
      offEvent();
    };
  }, [loadIncidents]);

  const merge = useCallback((incoming: Incident) => {
    setIncidents((current) =>
      current.map((existing) => (existing.id === incoming.id ? incoming : existing)),
    );
  }, []);

  const { prompt, setPrompt, pending, reasonError, decide, act } = useDecide(merge);

  const open = useMemo(
    () => incidents.filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED"),
    [incidents],
  );

  const placement = cameraId ? ATTARI_SECTOR.cameras[cameraId] : undefined;
  const zones = camera && zonesFor ? zonesFor(camera.id) : [];

  return (
    <PageShell
      title={title}
      description={description}
      actions={
        <Select value={cameraId ?? undefined} onValueChange={setCameraId}>
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="Choose a camera" />
          </SelectTrigger>
          <SelectContent>
            {cameras.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      entry.ready ? "bg-emerald-500" : "bg-destructive",
                    )}
                  />
                  {entry.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {hub.data && !hub.data.hub.reachable && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>The media hub is not answering</AlertTitle>
          <AlertDescription>
            {hub.data.hub.url} — {hub.data.hub.error}. Cameras below are the ones
            the node has on record; none of them will show a picture until the
            hub is back.
          </AlertDescription>
        </Alert>
      )}

      {camera && !camera.seeded && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>This camera is not seeded in the edge node</AlertTitle>
          <AlertDescription>
            The hub is serving <code>{camera.id}</code>, but the node has no such
            camera, so it rejects every detection from it and no incident will
            ever open. Add it on the{" "}
            <Link to="/cameras" className="underline">Cameras page</Link>.
          </AlertDescription>
        </Alert>
      )}

      {hub.loading && <LoadingRows rows={3} />}

      {!hub.loading && cameras.length === 0 && (
        <NothingHere
          icon={CctvIcon}
          title="No cameras"
          description={
            emptyHint ??
            "The media hub is serving nothing and the node has no cameras on record."
          }
        />
      )}

      {camera && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            {/* what the camera is seeing */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-medium">{camera.name}</CardTitle>
                <div className="flex items-center gap-2">
                  {camera.width && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {camera.width}×{camera.height} {camera.codec}
                    </Badge>
                  )}
                  <Badge variant={camera.ready ? "secondary" : "destructive"}>
                    {camera.ready ? "serving" : "no feed"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <CameraFeed
                  cameraId={camera.id}
                  whepBase={media?.whepBase}
                  module={module}
                  zones={zones}
                />
              </CardContent>
            </Card>

            {/* where that is */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Position</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {placement ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="text-muted-foreground">Grid</span>
                      <span className="font-mono font-medium">
                        {gridRef(placement.at, ATTARI_SECTOR)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-muted-foreground">Position</span>
                      <span className="font-mono text-xs">{formatLatLon(placement.at)}</span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-muted-foreground">Bearing</span>
                      <span className="font-mono">{placement.bearing}°</span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-muted-foreground">Range</span>
                      <span className="font-mono">{placement.rangeM} m</span>
                    </div>
                    <Button asChild variant="outline" size="sm" className="mt-1">
                      <Link to="/map">Open on the sector map</Link>
                    </Button>
                  </>
                ) : (
                  // Said plainly rather than drawn at [0,0]. A camera with no
                  // surveyed position cannot be given a grid reference, and
                  // inventing one would put a patrol in the wrong field.
                  <p className="text-muted-foreground">
                    No surveyed position for this camera, so it has no grid
                    reference. Add it to <code>client/geography.ts</code>.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <LiveConsole cameraId={camera.id} module={module} />

            {/* what needs a decision */}
            <Card className="flex flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-medium">
                  Incidents on this camera
                </CardTitle>
                <div className="flex items-center gap-3">
                  <HistoryLink cameraId={cameraId} label="Search all events" />
                  <Badge variant={open.length ? "destructive" : "secondary"}>
                    {open.length} open
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                {loadingIncidents && <LoadingRows rows={3} />}
                {!loadingIncidents && incidents.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Nothing recorded on this camera.
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {incidents.slice(0, 8).map((incident) => (
                    <div
                      key={incident.id}
                      className="flex flex-col gap-2 rounded-md border p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <Link
                          to={`/incidents/${incident.id}`}
                          className="min-w-0 flex-1 text-sm font-medium hover:underline"
                        >
                          {incident.title}
                        </Link>
                        <SeverityBadge severity={incident.severity} />
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge
                            variant="outline"
                            className={cn("text-[10px]", STATUS_STYLE[incident.status])}
                          >
                            {incident.status}
                          </Badge>
                          {relative(incident.lastEventAt)}
                        </span>
                        {(incident.status === "OPEN" ||
                          incident.status === "ACKNOWLEDGED") && (
                          <div className="flex gap-1">
                            {incident.status === "OPEN" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => act(incident, "acknowledge")}
                              >
                                <CheckIcon /> Ack
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => act(incident, "escalate")}
                            >
                              <TriangleAlertIcon /> Escalate
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => act(incident, "dismiss")}
                            >
                              <XIcon />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {children?.(camera)}
        </>
      )}

      <ReasonDialog
        open={prompt !== null}
        title={prompt?.decision === "escalate" ? "Escalate incident" : "Dismiss incident"}
        description={
          prompt?.decision === "escalate"
            ? "Say what you are escalating and to whom. This is recorded against your name."
            : "Say why this is not a threat. Dismissing does not delete it — the event log keeps it."
        }
        confirmLabel={prompt?.decision === "escalate" ? "Escalate" : "Dismiss"}
        destructive={prompt?.decision === "dismiss"}
        pending={pending}
        error={reasonError}
        onConfirm={(reason) => prompt && void decide(prompt.incident, prompt.decision, reason)}
        onOpenChange={(next) => !next && setPrompt(null)}
      />
    </PageShell>
  );
}
