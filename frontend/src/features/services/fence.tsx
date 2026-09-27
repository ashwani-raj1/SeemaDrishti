import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CarIcon, ClockIcon, PersonStandingIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { LoadingRows, NothingHere } from "@/components/ibvap/states";
import { StatCard } from "@/components/ibvap/stat-card";
import { VideoPlayer } from "@/components/ibvap/video-player";
import { LiveDetections } from "@/components/ibvap/live-detections";
import type { FeedZone } from "@/components/ibvap/camera-feed";
import { useClient } from "@/client/context";
import { rememberedCamera, useConsoleStore } from "@/client/console-store";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { onVisionStatus, visionStatus } from "@/lib/live";
import { useResource } from "@/lib/use-resource";
import { SEVERITY_RANK, type IbvapEvent, type Incident } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ActiveAlert, IntrusionTimeline, RecentEvents, UserNotes, ZoneList,
} from "./fence-panels";

/**
 * The virtual fence, as one camera sees it.
 *
 * The zones drawn on the picture are the SAME normalised 0..1 points the
 * detector judges against -- not a decorative approximation. That is the whole
 * reason a shape is drawn in image space rather than on a map: what an operator
 * sees on this frame is literally the geometry that fires.
 *
 * THE PAGE IS ORGANISED BY HOW MUCH A THING HAS BEEN DECIDED, left to right and
 * top to bottom. The picture and the live detections panel are the detector's
 * opinion about this instant -- unconfirmed, ephemeral, never actionable. The
 * numbers beneath are the record, counted. The right column is the record
 * demanding a decision. An operator acts on the right column and never on the
 * left, and the layout is what teaches that without a legend.
 *
 * ONE FETCH, MANY PANELS. The stat cards, the timeline and the recent events
 * list are four views of the same 24 hours of events, so the page loads them
 * once and hands them down. Each panel fetching for itself would be four
 * identical queries and four different ideas of "now".
 */

const WINDOW_HOURS = 24;

export function FenceScreen() {
  const { cameras: known, media } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);

  const cameraByModule = useConsoleStore((state) => state.cameraByModule);
  const setCameraFor = useConsoleStore((state) => state.setCameraFor);
  const [cameraId, setLocalCameraId] = useState<string | null>(null);

  const hubCameras = hub.data?.cameras ?? [];

  const pick = useCallback(
    (next: string) => {
      setLocalCameraId(next);
      setCameraFor("fence", next);
    },
    [setCameraFor],
  );

  // Restore what this seat was last watching, else the first camera actually
  // serving frames -- opening on a dead feed reads as a broken console rather
  // than a stopped camera.
  useEffect(() => {
    if (cameraId || hubCameras.length === 0) return;
    const remembered = rememberedCamera(cameraByModule, "fence", hubCameras);
    if (remembered) {
      setLocalCameraId(remembered);
      return;
    }
    const first = hubCameras.find((camera) => camera.ready) ?? hubCameras[0];
    if (first) pick(first.id);
  }, [hubCameras, cameraId, cameraByModule, pick]);

  const hubCamera = hubCameras.find((entry) => entry.id === cameraId) ?? null;
  const nodeCamera = known.find((entry) => entry.id === cameraId) ?? null;
  const zones = nodeCamera?.zones ?? [];

  const zoneNames = useMemo(
    () => new Map(zones.map((zone) => [zone.id, zone.name])),
    [zones],
  );

  const feedZones: FeedZone[] = useMemo(
    () =>
      zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        geometry: zone.geometry,
        points: zone.points,
        severity: zone.severity,
        provisional: zone.provisional,
      })),
    [zones],
  );

  // ── the record, for every panel below the picture ───────────────────
  const [events, setEvents] = useState<IbvapEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);

  const load = useCallback(async () => {
    if (!cameraId) return;
    // Two windows: the last 24 hours for the panels, and the one before it so
    // every stat can say which way it is moving. A number with no direction is
    // a number nobody can act on.
    const since = new Date(Date.now() - 2 * WINDOW_HOURS * 3600_000).toISOString();
    try {
      const [rows, open] = await Promise.all([
        api.events({ camera_id: cameraId, since, limit: 500 }),
        api.incidents({ camera_id: cameraId, limit: 50 }),
      ]);
      setEvents(rows);
      setIncidents(open);
    } finally {
      setLoading(false);
    }
  }, [cameraId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The node pushes; this screen does not poll. A crossing confirmed two
  // seconds ago must be on screen without a refresh.
  useEffect(() => {
    const offEvent = onStream("event", () => void load());
    const offIncident = onStream("incident", () => void load());
    return () => {
      offEvent();
      offIncident();
    };
  }, [load]);

  const stats = useMemo(() => summarise(events), [events]);

  /**
   * Which incidents actually raised an alert.
   *
   * An incident exists for EVERY event, alertable or not (`l3/events.ts`:
   * "non-alertable events still get an incident"). So an incident whose events
   * were all `log_only` or all lost before confirming is a record, not an
   * alarm -- and it carries the severity its targets say, which is why a
   * crossing nobody was told about can arrive here reading CRITICAL.
   *
   * Putting one of those under a red "Active Alert" banner is the exact
   * confusion this console exists to prevent: it says a human is needed where
   * the system deliberately decided no human was. So alerting incidents win,
   * and a non-alerting one is shown as what it is.
   */
  const alerting = useMemo(() => {
    const raised = new Set(
      events.filter((event) => event.alertable && event.incidentId).map((event) => event.incidentId!),
    );
    return raised;
  }, [events]);

  const active = useMemo(
    () =>
      incidents
        .filter((incident) => incident.status === "OPEN" || incident.status === "ACKNOWLEDGED")
        .sort(
          (a, b) =>
            // An incident that woke somebody outranks one that never did,
            // whatever their severities say.
            Number(alerting.has(b.id)) - Number(alerting.has(a.id)) ||
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt),
        )[0] ?? null,
    [incidents, alerting],
  );

  /**
   * The picture for the alert panel.
   *
   * The newest event in an incident is often the one that was LOST -- and a
   * lost track is exactly the case with the weakest evidence. Preferring one
   * that has a picture means the panel shows the best look at the subject the
   * system ever got, rather than whichever moment happened to be last.
   */
  const activeEvent = useMemo(() => {
    if (!active) return null;
    const mine = events.filter((event) => event.incidentId === active.id);
    return mine.find((event) => event.hasThumbnail) ?? mine[0] ?? null;
  }, [active, events]);

  const decide = async (incident: Incident, decision: "acknowledge" | "escalate") => {
    setDeciding(true);
    try {
      await api.decide(incident.id, decision, decision === "escalate" ? "escalated from the fence console" : undefined);
      toast.success(decision === "escalate" ? "Escalated" : "Acknowledged");
      void load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <PageShell
      title="Virtual fence"
      description="Zone intrusion and line crossing, judged on the camera's own frame."
      actions={
        <Select value={cameraId ?? undefined} onValueChange={pick}>
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="Choose a camera" />
          </SelectTrigger>
          <SelectContent>
            {hubCameras.map((entry) => (
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
            {hub.data.hub.url} — {hub.data.hub.error}. No camera will show a
            picture until it is back; the record below is unaffected.
          </AlertDescription>
        </Alert>
      )}

      {hub.loading && <LoadingRows rows={3} />}

      {!hub.loading && hubCameras.length === 0 && (
        <NothingHere
          icon={ShieldAlertIcon}
          title="No cameras"
          description="The media hub is serving nothing and the node has no cameras on record."
        />
      )}

      {hubCamera && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* ── left: what is happening, and what has happened ───────── */}
          <div className="space-y-4">
            <CameraHeader
              name={hubCamera.name}
              cameraId={hubCamera.id}
              width={hubCamera.width}
              height={hubCamera.height}
              codec={hubCamera.codec}
              ready={hubCamera.ready}
            />

            <VideoPlayer
              cameraId={hubCamera.id}
              cameraName={hubCamera.name}
              whepBase={media?.whepBase}
              zones={feedZones}
              module="fence"
              place={hubCamera.seeded ? undefined : "not seeded in the node"}
              className="aspect-video w-full"
            />

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                icon={ShieldAlertIcon}
                label="Intrusions"
                value={String(stats.intrusions.total)}
                caption={`in last ${WINDOW_HOURS} hours`}
                delta={stats.intrusions.delta}
                better="down"
                series={stats.intrusions.series}
                tone="text-destructive"
              />
              <StatCard
                icon={PersonStandingIcon}
                label="People detected"
                value={String(stats.people.total)}
                caption={`in last ${WINDOW_HOURS} hours`}
                delta={stats.people.delta}
                better="down"
                series={stats.people.series}
              />
              <StatCard
                icon={CarIcon}
                label="Vehicles detected"
                value={String(stats.vehicles.total)}
                caption={`in last ${WINDOW_HOURS} hours`}
                delta={stats.vehicles.delta}
                better="down"
                series={stats.vehicles.series}
                tone="text-emerald-600 dark:text-emerald-400"
              />
              {/* The only stat here that is NOT a count of the record: it is
                  how long a crossing waited before it was allowed to be one.
                  Named for what it measures rather than "response time", which
                  would imply somebody's reaction and this is the detector's. */}
              <StatCard
                icon={ClockIcon}
                label="Avg. confirm hold"
                value={stats.hold.label}
                caption="before a crossing counted"
                series={stats.hold.series}
                shape="line"
                tone="text-violet-600 dark:text-violet-400"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <ZoneList zones={zones} />
              <IntrusionTimeline events={events} zones={zones} zoneNames={zoneNames} />
            </div>

            <LiveDetections cameraId={hubCamera.id} module="fence" />
          </div>

          {/* ── right: what wants a decision ─────────────────────────── */}
          <div className="space-y-4">
            <ActiveAlert
              incident={active}
              raised={active ? alerting.has(active.id) : false}
              event={activeEvent}
              zoneName={active?.zoneId ? zoneNames.get(active.zoneId) : undefined}
              cameraName={hubCamera.name}
              pending={deciding}
              onDecide={decide}
            />
            {loading && events.length === 0 ? (
              <LoadingRows rows={4} />
            ) : (
              <RecentEvents
                events={events.filter((event) => event.kind === "zone_crossing")}
                zoneNames={zoneNames}
                cameraId={hubCamera.id}
              />
            )}
            <UserNotes cameraId={hubCamera.id} />
          </div>
        </div>
      )}
    </PageShell>
  );
}

/**
 * Resolution, codec and the rate this camera is ACTUALLY processed at.
 *
 * The frame rate comes from the vision service's own status message, not from
 * the stream and not from the configured target. Those three numbers differ --
 * a 25 fps stream processed at a 6 fps cap on a laptop that manages 5.7 -- and
 * the only one that describes what is being judged is the last.
 */
function CameraHeader({
  name, cameraId, width, height, codec, ready,
}: {
  name: string;
  cameraId: string;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
  ready: boolean;
}) {
  const [worker, setWorker] = useState(() => workerFor(cameraId));
  useEffect(() => {
    setWorker(workerFor(cameraId));
    return onVisionStatus(() => setWorker(workerFor(cameraId)));
  }, [cameraId]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="flex items-center gap-2.5">
        <h2 className="text-lg font-semibold">{name}</h2>
        <Badge
          variant={ready ? "secondary" : "destructive"}
          className={cn("gap-1.5", ready && "text-emerald-600 dark:text-emerald-400")}
        >
          <span className={cn("size-1.5 rounded-full", ready ? "bg-emerald-500" : "bg-destructive")} />
          {ready ? "Live" : "No feed"}
        </Badge>
      </div>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        <Fact label="Resolution" value={width && height ? `${width}×${height}` : "—"} />
        <Fact label="Codec" value={codec ?? "—"} />
        <Fact
          label="Processed"
          value={worker ? `${worker.fps.toFixed(1)} fps` : "—"}
          hint={worker ? `${worker.detector_ms.toFixed(0)} ms per detection pass` : undefined}
        />
        <Fact
          label="Worker uptime"
          value={worker ? humaniseUptime(worker.uptime) : "—"}
          hint="How long the vision service has been running, not the camera."
        />
      </dl>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function workerFor(cameraId: string) {
  const status = visionStatus();
  const camera = status?.cameras?.find((entry) => entry.camera_id === cameraId);
  if (!camera) return null;
  return {
    fps: camera.fps,
    detector_ms: camera.detector_ms,
    uptime: status?.uptime_s ?? 0,
  };
}

function humaniseUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ── counting the record ──────────────────────────────────────────────────

interface Bucketed {
  total: number;
  series: number[];
  delta?: { value: string; direction: "up" | "down" };
}

/**
 * The four numbers under the picture, from one pass over the events.
 *
 * WHAT COUNTS AS AN INTRUSION here is `alertable` crossings only. A cow on the
 * fence line is a crossing and is in the record, but calling it an intrusion on
 * a headline card would inflate the number an operator is being asked to judge
 * the night by -- which is precisely the alert fatigue this system exists to
 * avoid. People and vehicles count every crossing, alerted or not, because
 * those cards are about traffic rather than alarm.
 */
function summarise(events: IbvapEvent[]): {
  intrusions: Bucketed;
  people: Bucketed;
  vehicles: Bucketed;
  hold: { label: string; series: number[] };
} {
  const now = Date.now();
  const windowMs = WINDOW_HOURS * 3600_000;
  const start = now - windowMs;
  const previous = start - windowMs;

  const crossings = events.filter((event) => event.kind === "zone_crossing");

  const count = (match: (event: IbvapEvent) => boolean): Bucketed => {
    const recent: IbvapEvent[] = [];
    let before = 0;
    for (const event of crossings) {
      if (!match(event)) continue;
      const at = Date.parse(event.occurredAt);
      if (at >= start) recent.push(event);
      else if (at >= previous) before += 1;
    }

    // One bucket per hour, oldest first, so the sparkline reads left to right
    // like every other timeline on this page.
    const series = new Array(WINDOW_HOURS).fill(0) as number[];
    for (const event of recent) {
      const index = Math.min(
        WINDOW_HOURS - 1,
        Math.floor((Date.parse(event.occurredAt) - start) / 3600_000),
      );
      if (index >= 0) series[index] = (series[index] ?? 0) + 1;
    }

    const total = recent.length;
    // No delta against an empty previous window: "+100%" from a standing start
    // is arithmetic, not information.
    const delta =
      before === 0
        ? undefined
        : {
            value: `${Math.abs(Math.round(((total - before) / before) * 100))}%`,
            direction: (total >= before ? "up" : "down") as "up" | "down",
          };

    return { total, series, delta };
  };

  const held = crossings
    .filter((event) => Date.parse(event.occurredAt) >= start)
    .map((event) => event.evidence?.heldSeconds)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    intrusions: count((event) => event.alertable),
    people: count((event) => event.class === "person"),
    vehicles: count((event) => event.class === "vehicle"),
    hold: {
      label: held.length
        ? `${(held.reduce((sum, value) => sum + value, 0) / held.length).toFixed(1)}s`
        : "—",
      series: held.slice(-24),
    },
  };
}
