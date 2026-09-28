import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ActivityIcon, CameraIcon, CarFrontIcon, CpuIcon, DatabaseIcon, ExternalLinkIcon, FlameIcon, HeartPulseIcon, LayersIcon, MapPinIcon, RefreshCwIcon, ScanLineIcon, ShieldAlertIcon, SirenIcon, UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { LiveDot } from "@/components/ibvap/live-dot";
import { SectorMap, type MapTarget } from "@/components/ibvap/sector-map";
import { SeverityBadge } from "@/components/ibvap/badges";
import { useVisionStatus } from "@/components/ibvap/vision-status";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { clockTime, humanise } from "@/lib/format";
import { onStream } from "@/lib/stream";
import type { HubCamera, IbvapEvent, Incident, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

type DetectionFilter = "all" | "vehicle" | "person" | "plate" | "fence" | "loitering";
type TrendKind = "people" | "vehicles" | "plates";
type AnalyticsRange = "24h" | "7d" | "30d";
const FILTERS: Array<{ id: DetectionFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "vehicle", label: "Vehicle" },
  { id: "person", label: "Person" }, { id: "plate", label: "Number Plate" },
  { id: "fence", label: "Fence" }, { id: "loitering", label: "Loitering" },
];
const severityColour: Record<Severity, string> = { CRITICAL: "#ef4444", WARNING: "#f59e0b", INFO: "#3b82f6" };

export function DashboardScreen() {
  const navigate = useNavigate();
  const { cameras: configuredCameras, media } = useClient();
  const vision = useVisionStatus();
  const [hubCameras, setHubCameras] = useState<HubCamera[]>([]);
  const [hubReachable, setHubReachable] = useState<boolean | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [events, setEvents] = useState<IbvapEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [priorityFilter, setPriorityFilter] = useState<DetectionFilter>("all");
  const [activityFilter, setActivityFilter] = useState<DetectionFilter>("all");
  const [dataError, setDataError] = useState<string | null>(null);
  const [trendKind, setTrendKind] = useState<TrendKind>("people");
  const [layout, setLayout] = useState<2 | 4 | 6 | 8>(6);
  const [showZones, setShowZones] = useState(true);

  const load = useCallback(async () => {
    setDataError(null);
    try {
      // Keep the longest dashboard window in memory. The analytics controls
      // filter this same record instantly, without a misleading fake redraw.
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [hub, incidentRows, eventRows] = await Promise.all([
        api.mediaCameras(), api.incidents({ limit: 200 }), api.events({ since, limit: 500 }),
      ]);
      setHubCameras(hub.cameras); setHubReachable(hub.hub.reachable); setIncidents(incidentRows); setEvents(eventRows);
    } catch (cause) {
      setDataError((cause as Error).message || "Dashboard data could not be loaded");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const offIncident = onStream("incident", () => void load());
    const offEvent = onStream("event", () => void load());
    return () => { offIncident(); offEvent(); };
  }, [load]);

  const cameraNames = useMemo(() => new Map([
    ...configuredCameras.map((camera) => [camera.id, camera.name] as const),
    ...hubCameras.map((camera) => [camera.id, camera.name] as const),
  ]), [configuredCameras, hubCameras]);
  const openIncidents = useMemo(() => incidents
    .filter((row) => row.status === "OPEN" || row.status === "ACKNOWLEDGED")
    .sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt)), [incidents]);
  // Priority is the operator queue: recorded-only incidents belong in the
  // activity record, but must not pretend that they need action here.
  const priorityIncidents = openIncidents.filter((row) => row.alertable !== false);
  const filteredIncidents = priorityIncidents.filter((row) => matchesFilter(row, priorityFilter));
  const filteredEvents = events.filter((row) => matchesEventFilter(row, activityFilter));
  const incidentById = useMemo(() => new Map(incidents.map((row) => [row.id, row])), [incidents]);
  const connected = hubCameras.filter((camera) => camera.ready).length;
  const recentEvents = events.filter((row) => Date.parse(row.occurredAt) >= Date.now() - 86_400_000);
  const peopleDetected = distinctDetections(recentEvents.filter((row) => row.class === "person" || row.class === "human"));
  const vehiclesDetected = distinctDetections(recentEvents.filter((row) => isVehicleClass(row.class?.toLowerCase() ?? "")));
  const openMapTarget = (target: MapTarget) => {
    if (target.kind === "incident") navigate(`/incidents/${target.id}`);
    if (target.kind === "camera") navigate(`/cameras/${target.id}`);
    if (target.kind === "zone") navigate(`/zones?zone=${target.id}`);
  };

  return <div className="flex min-w-0 flex-col gap-3 bg-slate-50/70 p-3 dark:bg-slate-950/30 sm:p-4">
    <DashboardStats
      connected={connected}
      cameraCount={hubCameras.length}
      openIncidents={openIncidents.length}
      peopleDetected={peopleDetected}
      vehiclesDetected={vehiclesDetected}
      hubReachable={hubReachable}
      visionUp={vision.up}
      visionCameras={vision.status?.cameras.length ?? 0}
      loading={loading}
    />
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,2.15fr)_minmax(310px,0.85fr)]">
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold"><LiveDot /> Live Cameras <span className="text-muted-foreground">({connected} Connected)</span></CardTitle>
          <div className="flex items-center gap-1.5"><span className="hidden text-[11px] text-muted-foreground sm:inline">Camera Layout</span>
            {([2, 4, 6, 8] as const).map((count) => <button key={count} type="button" onClick={() => setLayout(count)} className={cn("size-7 rounded-md text-xs font-semibold", layout === count ? "bg-blue-600 text-white" : "text-muted-foreground hover:bg-muted")}>{count}</button>)}
            <Button asChild variant="outline" size="sm" className="ml-1 h-8 gap-1.5"><Link to="/services/health"><HeartPulseIcon className="size-3.5" /> Health</Link></Button>
          </div>
        </CardHeader>
        <CardContent className="p-3">
          {loading && <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">Loading camera wall…</div>}
          {!loading && hubCameras.length === 0 && <div className="grid min-h-72 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">No camera feeds are configured.</div>}
          <div className={cn("grid gap-2", layout === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3")}>
            {hubCameras.slice(0, layout).map((camera) => <div key={camera.id} className="min-w-0 overflow-hidden rounded-lg border bg-card">
              <div className="flex h-8 items-center justify-between gap-2 px-2.5 text-[11px]"><span className="flex min-w-0 items-center gap-1.5 font-semibold"><CameraIcon className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{camera.name}</span></span><span className={cn("flex shrink-0 items-center gap-1 font-medium", camera.ready ? "text-emerald-600" : "text-red-500")}><span className={cn("size-1.5 rounded-full", camera.ready ? "bg-emerald-500" : "bg-red-500")} />{camera.ready ? "Live" : "Offline"}</span></div>
              <CameraFeed cameraId={camera.id} streamPath={camera.id} whepBase={media?.whepBase} module={null} showBoxes={false} fit="cover" className="rounded-none border-x-0 border-b-0" />
            </div>)}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="border-b px-4 py-3"><div className="flex items-center justify-between gap-2"><CardTitle className="flex items-center gap-2 text-sm font-semibold"><FlameIcon className="size-4 text-red-500" /> Priority Detections</CardTitle><div className="flex items-center gap-1"><Badge variant="outline" className="font-mono text-[10px]">{filteredIncidents.length} need action</Badge><Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => void load()} title="Refresh priority detections"><RefreshCwIcon className="size-3.5" /></Button></div></div><FilterTabs value={priorityFilter} onChange={setPriorityFilter} /></CardHeader>
        <CardContent className="max-h-[430px] space-y-2 overflow-y-auto p-3">
          {dataError && <DataError message={dataError} onRetry={load} />}
          {!loading && filteredIncidents.length === 0 && <EmptyState icon={ShieldAlertIcon} label="No active priority detections" />}
          {filteredIncidents.slice(0, 8).map((incident) => <Link key={incident.id} to={`/incidents/${incident.id}`} className="flex items-center gap-2.5 rounded-lg border p-2.5 hover:bg-muted/60">
            <span className="grid size-10 shrink-0 place-items-center rounded-md border-2 border-amber-500/60 bg-slate-900 text-blue-400">{iconForIncident(incident)}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{incident.title}</span><span className="block truncate text-[10px] text-blue-600">Incident #{incident.number ?? incident.id.slice(-6)}</span><span className="block truncate text-[10px] text-muted-foreground">{incident.cameraId ? cameraNames.get(incident.cameraId) ?? incident.cameraId : "Unknown camera"} · {incident.eventCount} event(s)</span></span>
            <span className="flex shrink-0 flex-col items-end gap-1"><SeverityBadge severity={incident.severity} /><span className="font-mono text-[9px] text-muted-foreground">{clockTime(incident.lastEventAt)}</span></span>
          </Link>)}
        </CardContent>
      </Card>
    </div>

    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,1fr)]">
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3"><CardTitle className="flex items-center gap-2 text-sm font-semibold"><MapPinIcon className="size-4 text-blue-600" /> Sector Map</CardTitle><div className="flex gap-2"><Button variant={showZones ? "secondary" : "outline"} size="sm" className="h-8" onClick={() => setShowZones((value) => !value)}>{showZones ? "Hide Zones" : "Show Zones"}</Button><Button asChild variant="outline" size="sm" className="h-8 gap-1"><Link to="/map">Full Map <ExternalLinkIcon className="size-3" /></Link></Button></div></CardHeader>
        <CardContent className="p-0"><SectorMap incidents={openIncidents} onOpen={openMapTarget} showZones={showZones} className="h-[390px] rounded-none border-0" /></CardContent>
      </Card>
      <Card className="min-w-0 overflow-hidden shadow-sm">
        <CardHeader className="border-b px-4 py-3"><div className="flex items-center justify-between gap-2"><CardTitle className="flex items-center gap-2 text-sm font-semibold"><ActivityIcon className="size-4 text-blue-600" /> Activity Log</CardTitle><div className="flex items-center gap-1"><Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => void load()} title="Refresh activity"><RefreshCwIcon className="size-3.5" /></Button><Button asChild variant="link" size="sm" className="h-7 px-0 text-xs"><Link to="/history">View all →</Link></Button></div></div><FilterTabs value={activityFilter} onChange={setActivityFilter} /></CardHeader>
        <CardContent className="max-h-[390px] overflow-y-auto p-0">
          <div className="sticky top-0 z-10 grid grid-cols-[58px_24px_minmax(0,1fr)_auto] items-center gap-2 border-b bg-card px-3 py-2 text-[10px] font-medium text-muted-foreground">
            <span>Time</span><span className="text-center">Type</span><span>Event details</span><span className="text-right">Status</span>
          </div>
          <div>
            {filteredEvents.slice(0, 12).map((event) => {
              const incident = event.incidentId ? incidentById.get(event.incidentId) : undefined;
              const cameraName = event.cameraId ? cameraNames.get(event.cameraId) ?? event.cameraId : "Unknown camera";
              const eventLabel = event.class ? humanise(event.class) : humanise(event.kind);
              const status = incident?.status ?? (event.alertable ? "ALERT" : "LOGGED");
              return <div
                key={event.id}
                role={event.incidentId ? "button" : undefined}
                onClick={() => event.incidentId && navigate(`/incidents/${event.incidentId}`)}
                onKeyDown={(keyEvent) => { if (event.incidentId && (keyEvent.key === "Enter" || keyEvent.key === " ")) navigate(`/incidents/${event.incidentId}`); }}
                tabIndex={event.incidentId ? 0 : undefined}
                className={cn("grid min-h-14 grid-cols-[58px_24px_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-2 text-[10px] last:border-0 hover:bg-muted/40", event.incidentId && "cursor-pointer focus:bg-muted/60 focus:outline-none")}
                title={event.incidentId ? "Open related incident" : undefined}
              >
                <span className="whitespace-nowrap font-mono text-muted-foreground">{clockTime(event.occurredAt)}</span>
                <span className="grid place-items-center"><EventIcon event={event} /></span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <i className="size-2 shrink-0 rounded-full" style={{ background: severityColour[event.severity] }} title={humanise(event.severity)} />
                    <strong className="truncate text-[11px] font-semibold" title={`${eventLabel}${event.direction ? ` · ${humanise(event.direction)}` : ""}`}>{eventLabel}{event.direction ? ` · ${humanise(event.direction)}` : ""}</strong>
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground" title={`${cameraName} · ${humanise(event.kind)}`}>{cameraName} · {humanise(event.kind)}</span>
                </span>
                <Badge variant="outline" className={cn("justify-self-end px-1.5 py-0 text-[8px]", status === "OPEN" && "border-red-200 bg-red-50 text-red-600", status === "ACKNOWLEDGED" && "border-amber-200 bg-amber-50 text-amber-700", status === "LOGGED" && "text-muted-foreground")}>{status}</Badge>
              </div>;
            })}
          </div>
          {dataError && <div className="p-3"><DataError message={dataError} onRetry={load} /></div>}
          {!loading && !dataError && filteredEvents.length === 0 && <EmptyState icon={ActivityIcon} label="No activity in this filter" />}
        </CardContent>
      </Card>
    </div>
    <AnalyticsPanel incidents={incidents} events={events} cameras={hubCameras} trendKind={trendKind} onTrendKind={setTrendKind} />
  </div>;
}

function DashboardStats({ connected, cameraCount, openIncidents, peopleDetected, vehiclesDetected, hubReachable, visionUp, visionCameras, loading }: { connected: number; cameraCount: number; openIncidents: number; peopleDetected: number; vehiclesDetected: number; hubReachable: boolean | null; visionUp: boolean; visionCameras: number; loading: boolean }) {
  return <section aria-label="Operational summary" className="grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-6">
    <OperationalStat icon={CameraIcon} label="Live feeds" value={loading ? "—" : `${connected} / ${cameraCount}`} detail={cameraCount > 0 && connected === cameraCount ? "All cameras online" : `${Math.max(0, cameraCount - connected)} feed(s) offline`} tone={cameraCount > 0 && connected === cameraCount ? "good" : "warn"} to="/services/health" />
    <OperationalStat icon={SirenIcon} label="Open incidents" value={loading ? "—" : String(openIncidents)} detail={openIncidents === 0 ? "No action pending" : "Require operator review"} tone={openIncidents > 0 ? "bad" : "good"} to="/incidents" />
    <OperationalStat icon={UserRoundIcon} label="People detected" value={loading ? "—" : String(peopleDetected)} detail="Unique tracks · last 24h" tone="neutral" to="/services/people" />
    <OperationalStat icon={CarFrontIcon} label="Vehicles detected" value={loading ? "—" : String(vehiclesDetected)} detail="Unique tracks · last 24h" tone="neutral" to="/watchlist" />
    <OperationalStat icon={DatabaseIcon} label="Media hub" value={hubReachable === null ? "Checking" : hubReachable ? "Online" : "Offline"} detail={hubReachable ? `Streaming ${connected} feed(s)` : "Video service unavailable"} tone={hubReachable ? "good" : hubReachable === null ? "neutral" : "bad"} to="/services/health" />
    <OperationalStat icon={CpuIcon} label="Vision service" value={visionUp ? "Running" : "Stopped"} detail={visionUp ? `Processing ${visionCameras} camera(s)` : "No detection heartbeat"} tone={visionUp ? "good" : "bad"} to="/services/health" />
  </section>;
}

function OperationalStat({ icon: Icon, label, value, detail, tone, to }: { icon: typeof CameraIcon; label: string; value: string; detail: string; tone: "good" | "warn" | "bad" | "neutral"; to: string }) {
  const colour = tone === "good" ? "text-emerald-600 bg-emerald-50 border-emerald-100 dark:bg-emerald-950/30" : tone === "warn" ? "text-amber-600 bg-amber-50 border-amber-100 dark:bg-amber-950/30" : tone === "bad" ? "text-red-600 bg-red-50 border-red-100 dark:bg-red-950/30" : "text-blue-600 bg-blue-50 border-blue-100 dark:bg-blue-950/30";
  return <Link to={to} className="group min-w-0 rounded-lg border bg-card p-3 shadow-xs transition-colors hover:bg-muted/30">
    <div className="flex items-start gap-3">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-md border", colour)}><Icon className="size-4.5" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-muted-foreground">{label}</span>
        <span className="mt-0.5 block truncate text-xl font-semibold tracking-tight tabular-nums">{value}</span>
        <span className={cn("mt-1 flex items-center gap-1 truncate text-[9px]", tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-muted-foreground")}>
          <i className={cn("size-1.5 shrink-0 rounded-full", tone === "good" ? "bg-emerald-500" : tone === "bad" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-slate-400")} />{detail}
        </span>
      </span>
    </div>
  </Link>;
}

function FilterTabs({ value, onChange }: { value: DetectionFilter; onChange: (value: DetectionFilter) => void }) {
  return <div className="flex gap-1 overflow-x-auto pt-2">{FILTERS.map((item) => <button key={item.id} type="button" onClick={() => onChange(item.id)} className={cn("whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-medium", value === item.id ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-muted text-muted-foreground hover:text-foreground")}>{item.label}</button>)}</div>;
}

function AnalyticsPanel({ incidents, events, cameras, trendKind, onTrendKind }: { incidents: Incident[]; events: IbvapEvent[]; cameras: HubCamera[]; trendKind: TrendKind; onTrendKind: (kind: TrendKind) => void }) {
  const { cameras: configured } = useClient();
  const [range, setRange] = useState<AnalyticsRange>("24h");
  const rangeDays = range === "24h" ? 1 : range === "7d" ? 7 : 30;
  const cutoff = Date.now() - rangeDays * 86_400_000;
  const periodIncidents = incidents.filter((row) => Date.parse(row.lastEventAt) >= cutoff);
  const periodEvents = events.filter((row) => Date.parse(row.occurredAt) >= cutoff);
  const zoneNames = useMemo(() => new Map(configured.flatMap((camera) => camera.zones.map((zone) => [zone.id, zone.name] as const))), [configured]);
  const zoneGroups = useMemo(() => {
    const grouped = new Map<string, { critical: number; warning: number; info: number; total: number }>();
    for (const row of periodIncidents) {
      const key = row.zoneId ? zoneNames.get(row.zoneId) ?? row.zoneId : "No zone assigned";
      const value = grouped.get(key) ?? { critical: 0, warning: 0, info: 0, total: 0 };
      value.total++;
      if (row.severity === "CRITICAL") value.critical++;
      if (row.severity === "WARNING") value.warning++;
      if (row.severity === "INFO") value.info++;
      grouped.set(key, value);
    }
    return [...grouped.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6);
  }, [periodIncidents, zoneNames]);
  const cameraGroups = cameras.slice(0, 6).map((camera) => {
    const rows = periodIncidents.filter((row) => row.cameraId === camera.id);
    return { camera, critical: rows.filter((row) => row.severity === "CRITICAL").length, warning: rows.filter((row) => row.severity === "WARNING").length, info: rows.filter((row) => row.severity === "INFO").length };
  });
  const trend = useMemo(() => makeTrend(periodEvents, trendKind, range), [periodEvents, trendKind, range]);
  const title = range === "24h" ? "Last 24 Hours" : range === "7d" ? "Last 7 Days" : "Last 30 Days";
  return <Card className="overflow-hidden shadow-sm">
    <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
      <CardTitle className="flex items-center gap-2 text-sm font-semibold"><ScanLineIcon className="size-4 text-blue-600" /> Analytics ({title})</CardTitle>
      <div className="flex rounded-lg bg-muted p-0.5 text-[11px]">{(["24h", "7d", "30d"] as const).map((item) => <button key={item} type="button" onClick={() => setRange(item)} className={cn("rounded-md px-4 py-1.5 font-semibold uppercase", range === item ? "bg-blue-600 text-white shadow-sm" : "text-muted-foreground hover:text-foreground")}>{item}</button>)}</div>
    </CardHeader>
    <CardContent className="grid gap-3 p-3 lg:grid-cols-3">
      <ChartCard title="Incidents by Zone" legend={<SeverityLegend includeTotal />}><ZoneBars rows={zoneGroups} /></ChartCard>
      <ChartCard title="Incidents by Camera" legend={<SeverityLegend />}><CameraBars rows={cameraGroups} /></ChartCard>
      <ChartCard title="Detection Trends" action={<div className="flex rounded-md bg-muted p-0.5">{(["people", "vehicles", "plates"] as const).map((kind) => <button key={kind} type="button" onClick={() => onTrendKind(kind)} className={cn("rounded px-2 py-1 text-[9px] capitalize", trendKind === kind && "bg-white font-semibold text-blue-600 shadow-sm dark:bg-slate-800")}>{kind}</button>)}</div>} legend={<span className="flex items-center gap-1 text-[9px] text-muted-foreground"><i className="h-0.5 w-5 bg-blue-600" /> {trendLabel(trendKind)} detections</span>}><TrendLine rows={trend} /></ChartCard>
    </CardContent>
  </Card>;
}

function ChartCard({ title, action, legend, children }: { title: string; action?: React.ReactNode; legend?: React.ReactNode; children: React.ReactNode }) { return <div className="min-w-0 rounded-lg border p-3"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold">{title}</h3>{action}</div>{legend && <div className="mt-1.5 flex min-h-4 flex-wrap items-center gap-3">{legend}</div>}<div className="mt-1">{children}</div></div>; }
function SeverityLegend({ includeTotal = false }: { includeTotal?: boolean }) { return <>{(["CRITICAL", "WARNING", "INFO"] as const).map((severity) => <span key={severity} className="flex items-center gap-1 text-[9px] text-muted-foreground"><i className="size-2 rounded-full" style={{ background: severityColour[severity] }} />{severity[0] + severity.slice(1).toLowerCase()}</span>)}{includeTotal && <span className="flex items-center gap-1 text-[9px] text-muted-foreground"><i className="size-2 rounded-full bg-slate-400" />Total</span>}</>; }
function ZoneBars({ rows }: { rows: Array<[string, { critical: number; warning: number; info: number; total: number }]> }) { const max = Math.max(1, ...rows.map(([, row]) => row.total)); if (!rows.length) return <EmptyChart />; return <div className="flex h-40 items-end justify-around gap-3 border-b border-l px-2 pt-5">{rows.map(([name, row]) => <div key={name} title={`${name}: ${row.total} total (${row.critical} critical, ${row.warning} warning, ${row.info} info)`} className="flex h-full min-w-0 flex-1 flex-col justify-end"><div className="flex flex-1 items-end justify-center gap-1"><Bar label="Critical" value={row.critical} max={max} colour={severityColour.CRITICAL} /><Bar label="Warning" value={row.warning} max={max} colour={severityColour.WARNING} /><Bar label="Info" value={row.info} max={max} colour={severityColour.INFO} /><Bar label="Total" value={row.total} max={max} colour="#94a3b8" /></div><span className="truncate pt-1 text-center text-[9px] font-medium text-muted-foreground" title={name}>{name}</span></div>)}</div>; }
function Bar({ label, value, max, colour }: { label: string; value: number; max: number; colour: string }) { return <span title={`${label}: ${value}`} className="relative w-3 rounded-t-sm transition-opacity hover:opacity-70" style={{ height: `${Math.max(value ? 10 : 1, (value / max) * 95)}%`, background: colour }}><span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[8px] font-semibold">{value}</span></span>; }
function CameraBars({ rows }: { rows: Array<{ camera: HubCamera; critical: number; warning: number; info: number }> }) { const max = Math.max(1, ...rows.map((row) => row.critical + row.warning + row.info)); if (!rows.length) return <EmptyChart />; return <div className="flex h-40 flex-col justify-center gap-2">{rows.map((row) => { const total = row.critical + row.warning + row.info; return <div key={row.camera.id} title={`${row.camera.name}: ${row.critical} critical, ${row.warning} warning, ${row.info} info`} className="grid grid-cols-[88px_1fr_24px] items-center gap-2 text-[9px]"><span className="truncate font-medium" title={row.camera.name}>{row.camera.name}</span><div className="flex h-3 overflow-hidden rounded-full bg-muted"><span title={`Critical: ${row.critical}`} style={{ width: `${row.critical / max * 100}%`, background: severityColour.CRITICAL }} /><span title={`Warning: ${row.warning}`} style={{ width: `${row.warning / max * 100}%`, background: severityColour.WARNING }} /><span title={`Info: ${row.info}`} style={{ width: `${row.info / max * 100}%`, background: severityColour.INFO }} /></div><span className="font-semibold">{total}</span></div>; })}</div>; }
function TrendLine({ rows }: { rows: Array<{ label: string; value: number }> }) { const max = Math.max(1, ...rows.map((row) => row.value)); const x = (index: number) => 18 + index * (272 / Math.max(1, rows.length - 1)); const y = (value: number) => 104 - value / max * 78; return <div className="h-40"><svg viewBox="0 0 300 132" className="size-full overflow-visible"><text x="2" y="28" fontSize="7" fill="currentColor" opacity=".6">{max}</text><text x="6" y="107" fontSize="7" fill="currentColor" opacity=".6">0</text>{[26, 65, 104].map((line) => <line key={line} x1="18" y1={line} x2="290" y2={line} stroke="currentColor" opacity=".1" />)}<polyline points={rows.map((row, index) => `${x(index)},${y(row.value)}`).join(" ")} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />{rows.map((row, index) => <g key={`${row.label}-${index}`}><circle cx={x(index)} cy={y(row.value)} r="3" fill="#2563eb"><title>{`${row.label}: ${row.value} detections`}</title></circle><text x={x(index)} y="124" textAnchor="middle" fontSize="7" fill="currentColor" opacity=".65">{index % 2 === 0 ? row.label : ""}</text></g>)}</svg></div>; }
function makeTrend(events: IbvapEvent[], kind: TrendKind, range: AnalyticsRange) { const count = range === "24h" ? 12 : range === "7d" ? 7 : 10; const unitMs = range === "24h" ? 2 * 3_600_000 : range === "7d" ? 86_400_000 : 3 * 86_400_000; const formatter = range === "24h" ? (date: Date) => `${String(date.getHours()).padStart(2, "0")}:00` : (date: Date) => date.toLocaleDateString(undefined, { day: "2-digit", month: "short" }); const start = Date.now() - count * unitMs; const buckets = Array.from({ length: count }, (_, index) => ({ label: formatter(new Date(start + (index + 1) * unitMs)), value: 0 })); for (const event of events) { if (!trendMatches(event, kind)) continue; const index = Math.min(count - 1, Math.max(0, Math.floor((Date.parse(event.occurredAt) - start) / unitMs))); buckets[index]!.value++; } return buckets; }
function trendLabel(kind: TrendKind) { return kind === "people" ? "People" : kind === "vehicles" ? "Vehicle" : "Number plate"; }
function DataError({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) { return <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[10px] text-red-700"><span className="truncate">{message}</span><Button type="button" variant="outline" size="sm" className="h-6 bg-white px-2 text-[10px]" onClick={() => void onRetry()}>Retry</Button></div>; }
function EmptyChart() { return <div className="grid h-36 place-items-center text-xs text-muted-foreground">No data in the last 24 hours</div>; }
function EmptyState({ icon: Icon, label }: { icon: typeof SirenIcon; label: string }) { return <div className="grid min-h-28 place-items-center text-center text-xs text-muted-foreground"><span className="flex flex-col items-center gap-2"><Icon className="size-6 opacity-50" />{label}</span></div>; }
function EventIcon({ event }: { event: IbvapEvent }) { const Icon = event.kind.includes("plate") || event.class === "vehicle" ? CarFrontIcon : event.class === "person" ? UserRoundIcon : event.kind.includes("zone") ? LayersIcon : ActivityIcon; return <Icon className="size-4 text-blue-600" />; }
function iconForIncident(incident: Incident) { if (incident.kind?.includes("plate") || incident.classes?.includes("vehicle")) return <CarFrontIcon className="size-5" />; if (incident.classes?.includes("person")) return <UserRoundIcon className="size-5" />; if (incident.kind?.includes("zone")) return <LayersIcon className="size-5" />; return <CameraIcon className="size-5" />; }
function isVehicleClass(value: string) { return ["car", "bus", "truck", "vehicle", "motorcycle", "motorbike", "two_wheeler", "auto", "van", "commercial"].includes(value); }
function distinctDetections(rows: IbvapEvent[]) { const keys = new Set(rows.map((row) => row.trackedThingId ?? row.evidence.trackRef ?? row.id)); return keys.size; }
function matchesFilter(row: Incident, filter: DetectionFilter) { if (filter === "all") return true; const kind = row.kind?.toLowerCase() ?? ""; const classes = row.classes?.map((value) => value.toLowerCase()) ?? []; if (filter === "vehicle") return classes.some(isVehicleClass); if (filter === "person") return classes.some((value) => value === "person" || value === "human") || kind.includes("reidentification") || kind.includes("face"); if (filter === "plate") return kind.includes("plate") || kind.includes("anpr"); if (filter === "fence") return kind.includes("zone") || kind.includes("fence") || kind.includes("crossing"); return kind.includes("loiter") || kind.includes("dwell"); }
function matchesEventFilter(row: IbvapEvent, filter: DetectionFilter) { if (filter === "all") return true; const kind = row.kind.toLowerCase(); const klass = row.class?.toLowerCase() ?? ""; if (filter === "vehicle") return isVehicleClass(klass); if (filter === "person") return klass === "person" || klass === "human" || kind.includes("reidentification") || kind.includes("face"); if (filter === "plate") return kind.includes("plate") || kind.includes("anpr"); if (filter === "fence") return kind.includes("zone") || kind.includes("fence") || kind.includes("crossing"); return kind.includes("loiter") || kind.includes("dwell"); }
function trendMatches(row: IbvapEvent, kind: TrendKind) { if (kind === "people") return row.class === "person" || row.class === "human" || row.kind.includes("reidentification") || row.kind.includes("face"); if (kind === "plates") return row.kind.includes("plate") || row.kind.includes("anpr"); return isVehicleClass(row.class?.toLowerCase() ?? ""); }
