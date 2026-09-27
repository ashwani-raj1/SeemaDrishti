import { useCallback, useState, useEffect } from "react";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BarChart3Icon,
  CarFrontIcon,
  CheckCircle2Icon,
  ClockIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanIcon,
  SearchIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TruckIcon,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageShell } from "@/components/ibvap/page-shell";
import { ErrorState, LoadingRows, NothingHere } from "@/components/ibvap/states";
import { SeverityBadge } from "@/components/ibvap/badges";
import { ReasonDialog } from "@/components/ibvap/reason-dialog";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import { useResource } from "@/lib/use-resource";
import { dateTime, formatPlate, relative } from "@/lib/format";
import type { PlateDetection, VehicleTrafficSummary, WatchlistEntry, WatchlistStats } from "@/lib/types";
import { useIncidents } from "@/features/incidents/use-incidents";
import { PlateScannerCanvas } from "./plate-scanner-canvas";
import { AddWatchlistDialog } from "./add-watchlist-dialog";

export function WatchlistScreen() {
  const [tab, setTab] = useState<"scanner" | "registry" | "logs">("scanner");
  const [search, setSearch] = useState("");
  const [logSearchInput, setLogSearchInput] = useState("");
  const [logSearchQuery, setLogSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  // Keep the initial range aligned with one of the visible range controls.
  const [trafficDays, setTrafficDays] = useState(7);
  const [trafficScope, setTrafficScope] = useState<{ cameraId: string | null; label: string }>({
    cameraId: null,
    label: "All cameras",
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<WatchlistEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WatchlistEntry | null>(null);

  // Scanner Workbench state
  const [latestDetection, setLatestDetection] = useState<PlateDetection | null>(null);

  // Load Watchlist Entries
  const {
    data: entries,
    error: entriesError,
    loading: entriesLoading,
    reload: reloadEntries,
  } = useResource(() => api.watchlist({ limit: 100 }), []);

  // Load Stats
  const {
    data: stats,
    reload: reloadStats,
  } = useResource(() => api.watchlistStats(), []);

  // Load Scan Logs
  const {
    data: logs,
    error: logsError,
    loading: logsLoading,
    reload: reloadLogs,
  } = useResource(() => api.plateDetections(), []);

  const {
    data: traffic,
    loading: trafficLoading,
    reload: reloadTraffic,
  } = useResource(
    () => api.vehicleTraffic({ days: trafficDays, camera_id: trafficScope.cameraId ?? undefined }),
    [trafficDays, trafficScope.cameraId],
  );

  const {
    data: todayTraffic,
    reload: reloadTodayTraffic,
  } = useResource(
    () => api.vehicleTraffic({ days: 1, camera_id: trafficScope.cameraId ?? undefined }),
    [trafficScope.cameraId],
  );

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayDetections = (logs ?? []).filter((detection) =>
    Date.parse(detection.occurred_at) >= todayStart.getTime());

  const handleVehicleCounted = useCallback(async (vehicle: {
    sourceKey: string;
    cameraId: string;
    vehicleType: string;
    occurredAt: string;
  }) => {
    try {
      await api.recordVehicleTraffic(vehicle);
      reloadTraffic();
      reloadTodayTraffic();
    } catch (cause) {
      console.warn("Unable to save vehicle traffic count", cause);
    }
  }, [reloadTodayTraffic, reloadTraffic]);

  const handleCameraScopeChange = useCallback((cameraId: string | null, label: string) => {
    setTrafficScope((current) =>
      current.cameraId === cameraId && current.label === label ? current : { cameraId, label });
  }, []);

  // Real-time stream updates
  useEffect(() => {
    const unsubDet = onStream("plate_detection", (data) => {
      const det = data as PlateDetection;
      setLatestDetection(det);
      reloadLogs();
      reloadStats();
      if (det.match_status === "MATCHED") {
        toast.error(`Watchlist Match: ${det.plate_number}`, {
          description: `Spotted on ${det.camera_name ?? det.camera_id} (${det.severity})`,
        });
      }
    });

    const unsubWl = onStream("watchlist_change", () => {
      reloadEntries();
      reloadStats();
    });

    const unsubTraffic = onStream("vehicle_traffic", () => {
      reloadTraffic();
      reloadTodayTraffic();
    });

    return () => {
      unsubDet();
      unsubWl();
      unsubTraffic();
    };
  }, [reloadEntries, reloadLogs, reloadStats, reloadTodayTraffic, reloadTraffic]);

  // A recovery/import changes the durable log without emitting a live stream
  // event. Keep the open page in sync as well as refreshing immediately when
  // the supervisor returns to this tab.
  useEffect(() => {
    const refreshHistory = () => {
      reloadLogs();
      reloadStats();
    };
    const timer = window.setInterval(refreshHistory, 10_000);
    window.addEventListener("focus", refreshHistory);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshHistory();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshHistory);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [reloadLogs, reloadStats]);

  // Set initial latest detection from logs if available
  useEffect(() => {
    if (logs && logs.length > 0 && !latestDetection) {
      setLatestDetection(logs[0]!);
    }
  }, [logs, latestDetection]);

  // Run Custom Manual Plate Scan
  const handleManualScan = async (detection: PlateDetection) => {
    try {
      const result = await api.detectVehicleAndPlate({
        plateNumber: detection.plate_number,
        vehicleType: detection.vehicle_type,
        cameraId: detection.camera_id,
        confidence: detection.confidence,
        plateConfidence: detection.plate_confidence,
        bbox: detection.bbox,
        plateBbox: detection.plate_bbox,
        imageSnapshot: detection.image_snapshot ?? null,
        simulated: false,
      });
      setLatestDetection(result);
      reloadLogs();
      reloadStats();
      // Alerts are emitted once from the real-time `plate_detection` stream.
      // Clear vehicles stay silent; duplicating the request result here caused
      // both repeated "not in active watchlist" notices and double hit alerts.
    } catch (cause) {
      toast.error((cause as Error).message);
    }
  };

  // Delete handler
  const handleDeleteConfirm = async (reason: string) => {
    if (!deleteTarget) return;
    try {
      await api.deleteWatchlistEntry(deleteTarget.id, reason);
      toast.success(`Removed ${deleteTarget.plate_number} from watchlist`);
      setDeleteTarget(null);
      reloadEntries();
      reloadStats();
    } catch (cause) {
      toast.error((cause as Error).message);
    }
  };

  // Filtered watchlist rows
  const filteredEntries = (entries ?? []).filter((entry) => {
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchPlate = entry.plate_number.toLowerCase().includes(q);
      const matchMake = (entry.make_model ?? "").toLowerCase().includes(q);
      const matchReason = entry.flag_reason.toLowerCase().includes(q);
      const matchNotes = (entry.notes ?? "").toLowerCase().includes(q);
      if (!matchPlate && !matchMake && !matchReason && !matchNotes) return false;
    }
    if (severityFilter !== "ALL" && entry.severity !== severityFilter) return false;
    if (statusFilter === "ACTIVE" && !entry.active) return false;
    if (statusFilter === "INACTIVE" && entry.active) return false;
    return true;
  });
  const normalizedLogQuery = logSearchQuery.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const filteredLogs = (logs ?? []).filter((scan) => {
    if (!normalizedLogQuery) return true;
    const plate = scan.plate_number.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    return plate.includes(normalizedLogQuery);
  });

  return (
    <PageShell
      title="Plate watchlist"
      description="Automated vehicle detection, ALPR optical plate scanning, and flagged vehicle matching (#36)."
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            onClick={() => {
              setEditingEntry(null);
              setDialogOpen(true);
            }}
          >
            <PlusIcon className="h-4 w-4" data-icon="inline-start" />
            Add to Watchlist
          </Button>
        </div>
      }
    >
      <div className="watchlist-workspace min-w-0 space-y-4 overflow-x-hidden">
      {/* Overview Stat Metric Cards */}
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <Card className="flex-row items-start gap-3 p-3 shadow-sm">
          <div className="rounded-lg bg-blue-500/10 p-2 text-blue-700"><CarFrontIcon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground">Flagged Vehicles</div>
            <div className="font-mono text-2xl font-bold tracking-tight text-foreground">
              {stats?.totalWatchlist ?? 0}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {stats?.activeWatchlist ?? 0} active in memory
            </div>
          </div>
        </Card>

        <Card className="flex-row items-start gap-3 border-red-500/20 bg-red-500/5 p-3 shadow-sm">
          <div className="rounded-lg bg-red-500/10 p-2 text-red-600"><ShieldAlertIcon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-red-600 dark:text-red-400">Critical Threats</div>
            <div className="font-mono text-2xl font-bold tracking-tight text-red-600 dark:text-red-400">
              {stats?.criticalCount ?? 0}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">High priority BOLO</div>
          </div>
        </Card>

        <Card className="flex-row items-start gap-3 p-3 shadow-sm">
          <div className="rounded-lg bg-slate-500/10 p-2 text-slate-700"><ScanIcon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground">Scans (24h)</div>
            <div className="font-mono text-2xl font-bold tracking-tight text-foreground">
              {stats?.scans24h ?? 0}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">Across all checkpoints</div>
          </div>
        </Card>

        <Card className="flex-row items-start gap-3 border-amber-500/20 bg-amber-500/5 p-3 shadow-sm">
          <div className="rounded-lg bg-amber-500/10 p-2 text-amber-600"><TruckIcon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Watchlist Hits</div>
            <div className="font-mono text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
              {stats?.matches24h ?? 0}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">Matched flagged plates</div>
          </div>
        </Card>

        <Card className="flex-row items-start gap-3 p-3 shadow-sm">
          <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600"><CheckCircle2Icon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground">Avg OCR confidence</div>
            <div className="font-mono text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
              {stats?.readRate ?? 0}%
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">Verified real reads only</div>
          </div>
        </Card>
      </div>

      {/* Main Tabs Navigation */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="space-y-4">
        <TabsList className="flex h-10 max-w-full justify-start overflow-x-auto rounded-lg bg-muted/60 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger value="scanner" className="text-xs font-semibold gap-1.5">
            <ScanIcon className="h-3.5 w-3.5" />
            Scanner Workbench
          </TabsTrigger>
          <TabsTrigger value="registry" className="text-xs font-semibold gap-1.5">
            <CarFrontIcon className="h-3.5 w-3.5" />
            Watchlist Database ({entries?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="logs" className="text-xs font-semibold gap-1.5">
            <ClockIcon className="h-3.5 w-3.5" />
            ANPR Logs ({logs?.length ?? 0})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: Live Vehicle & ANPR Scanner Workbench */}
        <TabsContent value="scanner" className="space-y-4">
          <PlateScannerCanvas
            detection={latestDetection}
            todayDetections={todayDetections}
            todayVehicleTotal={todayTraffic?.total ?? 0}
            todayVehicleTypes={todayTraffic?.byType ?? {}}
            onManualScan={handleManualScan}
            onVehicleCounted={handleVehicleCounted}
            onCameraScopeChange={handleCameraScopeChange}
            trafficPanel={
              <VehicleTrafficChart
                summary={traffic}
                loading={trafficLoading}
                days={trafficDays}
                scopeLabel={trafficScope.label}
                onDaysChange={setTrafficDays}
              />
            }
            incidentsPanel={<LiveIncidentsPanel />}
          />
        </TabsContent>

        {/* TAB 2: Watchlist Registry Management */}
        <TabsContent value="registry" className="space-y-4">
          <Card className="border">
            <CardHeader className="py-3 px-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative flex-1 max-w-sm">
                  <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by plate, vehicle model, or flag reason..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8 text-xs h-9"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Select value={severityFilter} onValueChange={setSeverityFilter}>
                    <SelectTrigger className="text-xs h-9 w-32">
                      <SelectValue placeholder="Severity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All Severities</SelectItem>
                      <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                      <SelectItem value="WARNING">WARNING</SelectItem>
                      <SelectItem value="INFO">INFO</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="text-xs h-9 w-28">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All Status</SelectItem>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {entriesLoading && <LoadingRows rows={4} />}
              {entriesError && <ErrorState error={entriesError} onRetry={reloadEntries} />}

              {entries && filteredEntries.length === 0 && (
                <NothingHere
                  icon={CarFrontIcon}
                  title="No watchlist vehicles found"
                  description="Add a license plate to the watchlist to trigger automatic alerts upon detection."
                />
              )}

              {entries && filteredEntries.length > 0 && (
                <div className="max-w-full overflow-x-auto">
                <Table className="min-w-[62rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-44">Plate Number</TableHead>
                      <TableHead className="w-36">Vehicle</TableHead>
                      <TableHead className="w-28">Severity</TableHead>
                      <TableHead>Flag Reason & Notes</TableHead>
                      <TableHead className="w-24">Status</TableHead>
                      <TableHead className="w-32">Added By</TableHead>
                      <TableHead className="w-24 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono font-bold text-sm">
                          <span className="inline-block rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-0.5 border border-amber-500/30">
                            {item.plate_number}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-semibold text-foreground">
                            {item.make_model ?? item.vehicle_type}
                          </div>
                          <div className="text-[11px] text-muted-foreground capitalize">
                            {item.color ? `${item.color} ` : ""}
                            {item.vehicle_type}
                          </div>
                        </TableCell>
                        <TableCell>
                          <SeverityBadge severity={item.severity} />
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-medium text-foreground">{item.flag_reason}</div>
                          {item.notes && (
                            <div className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate max-w-md">
                              {item.notes}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.active ? "default" : "secondary"} className="text-[10px]">
                            {item.active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.added_by ?? "Operator"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => {
                                setEditingEntry(item);
                                setDialogOpen(true);
                              }}
                            >
                              <PencilIcon className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                              onClick={() => setDeleteTarget(item)}
                            >
                              <Trash2Icon className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: ANPR Scan Logs */}
        <TabsContent value="logs" className="space-y-4">
          <Card className="border">
            <CardHeader className="px-4 py-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-sm font-semibold">ANPR Vehicle Detections Log</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Chronological stream of license plates recognized across perimeter cameras.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <form
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setLogSearchQuery(logSearchInput.trim());
                    }}
                  >
                    <div className="relative min-w-[12rem] flex-1 sm:w-72 sm:flex-none">
                      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={logSearchInput}
                        onChange={(event) => setLogSearchInput(event.target.value)}
                        placeholder="Enter vehicle plate number"
                        aria-label="Search logged vehicle by plate number"
                        className="h-9 pl-9 pr-3 font-mono text-xs uppercase tracking-wide"
                      />
                    </div>
                    <Button type="submit" size="sm" className="h-9 px-4" disabled={!logSearchInput.trim()}>
                      <SearchIcon className="h-3.5 w-3.5" data-icon="inline-start" />
                      Search
                    </Button>
                    {logSearchQuery && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9 px-2.5 text-xs"
                        onClick={() => {
                          setLogSearchInput("");
                          setLogSearchQuery("");
                        }}
                      >
                        Clear
                      </Button>
                    )}
                  </form>
                  <Button variant="outline" size="sm" className="h-9" onClick={() => reloadLogs()} disabled={logsLoading}>
                    <RefreshCwIcon className="h-3.5 w-3.5" data-icon="inline-start" />
                    Refresh Feed
                  </Button>
                </div>
              </div>
              {logSearchQuery && filteredLogs.length > 0 && (
                <div className="mt-3 flex items-center justify-between rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-[11px]">
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">
                    Vehicle logged — {filteredLogs.length} matching detection{filteredLogs.length === 1 ? "" : "s"} found
                  </span>
                  <span className="font-mono font-bold tracking-wide text-foreground">{logSearchQuery.toUpperCase()}</span>
                </div>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {logsLoading && <LoadingRows rows={5} />}
              {logsError && <ErrorState error={logsError} onRetry={reloadLogs} />}

              {logs && !logSearchQuery && logs.length === 0 && (
                <NothingHere
                  icon={ClockIcon}
                  title="No vehicle scans recorded"
                  description="Vehicle detection scans will appear here as they are processed by the edge node."
                />
              )}

              {logs && logSearchQuery && filteredLogs.length === 0 && (
                <NothingHere
                  icon={SearchIcon}
                  title="Vehicle not logged"
                  description={`No ANPR detection was found for “${logSearchQuery.toUpperCase()}” within the retained 15-day log history.`}
                />
              )}

              {filteredLogs.length > 0 && (
                <div className="max-w-full overflow-x-auto">
                <Table className="min-w-[60rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">Timestamp</TableHead>
                      <TableHead className="w-48">Camera / Checkpoint</TableHead>
                      <TableHead className="w-44">Plate Number</TableHead>
                      <TableHead className="w-32">Vehicle Type</TableHead>
                      <TableHead className="w-28">OCR Conf</TableHead>
                      <TableHead className="w-36">Match Status</TableHead>
                      <TableHead>Watchlist Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLogs.map((scan) => {
                      const isEstimate = scan.plate_verified === false;
                      const isHit = scan.match_status === "MATCHED";
                      return (
                        <TableRow
                          key={scan.id}
                          className={isHit ? "bg-red-500/5 hover:bg-red-500/10" : ""}
                        >
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {dateTime(scan.occurred_at)}
                          </TableCell>
                          <TableCell className="text-xs font-medium">
                            {scan.camera_name ?? scan.camera_id}
                          </TableCell>
                          <TableCell className="font-mono font-bold text-sm">
                            <span
                              className={`inline-block rounded px-2 py-0.5 border ${
                                isHit
                                  ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40"
                                  : "bg-slate-100 dark:bg-slate-800 text-foreground border-slate-300 dark:border-slate-700"
                              }`}
                            >
                              {scan.plate_number}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs capitalize text-muted-foreground">
                            {scan.vehicle_type}
                          </TableCell>
                          <TableCell className={`font-mono text-xs font-semibold ${isEstimate ? "text-amber-600" : "text-emerald-600 dark:text-emerald-400"}`}>
                            {isEstimate ? "AI estimate" : `${Math.round(scan.plate_confidence * 100)}%`}
                          </TableCell>
                          <TableCell>
                            {isHit ? (
                              <Badge variant="destructive" className="font-mono text-[10px] gap-1">
                                <ShieldAlertIcon className="h-3 w-3" />
                                WATCHLIST HIT
                              </Badge>
                            ) : isEstimate ? (
                              <Badge variant="outline" className="border-amber-500/30 text-[10px] text-amber-700">
                                UNVERIFIED
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-500/30">
                                CLEAR
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {isHit && scan.matched_entry ? (
                              <div className="space-y-0.5">
                                <span className="font-semibold text-red-600 dark:text-red-400">
                                  {scan.matched_entry.flag_reason}
                                </span>
                                {scan.matched_entry.make_model && (
                                  <span className="block text-[11px] text-muted-foreground">
                                    {scan.matched_entry.color} {scan.matched_entry.make_model}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">Unflagged vehicle</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add / Edit Watchlist Entry Dialog */}
      <AddWatchlistDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={editingEntry}
        onSuccess={() => {
          reloadEntries();
          reloadStats();
        }}
      />

      {/* Reason Dialog for Deleting Watchlist Item */}
      <ReasonDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.plate_number} from watchlist?`}
        description="Removing a vehicle from the watchlist stops automatic alerting. State a reason for the audit trail."
        confirmLabel="Remove from Watchlist"
        onConfirm={handleDeleteConfirm}
      />
      </div>
    </PageShell>
  );
}

function LiveIncidentsPanel() {
  const { incidents, loading, error } = useIncidents(false);
  // This panel belongs to Plate Watchlist, so it must not mix fence, camera
  // health or people incidents into the ANPR workflow.
  const watchlistIncidents = incidents.filter((incident) =>
    incident.title.startsWith("Flagged vehicle:"));
  const critical = watchlistIncidents.filter((incident) => incident.severity === "CRITICAL").length;
  const warning = watchlistIncidents.filter((incident) => incident.severity === "WARNING").length;
  const visibleIncidents = watchlistIncidents.slice(0, 5);

  return (
    <Card className="h-[22rem] min-w-0 gap-0 overflow-hidden border py-0 shadow-sm">
      <CardHeader className="border-b px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-500/10 text-red-600">
                <AlertTriangleIcon className="h-4 w-4" />
              </span>
              Live Incidents
            </CardTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">Priority events requiring supervisor attention</p>
          </div>
          <NavLink
            to="/incidents"
            className="flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold text-blue-600 transition hover:bg-blue-50 dark:hover:bg-blue-950/30"
          >
            View all <ArrowRightIcon className="h-3 w-3" />
          </NavLink>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-muted/30 px-2.5 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Open</div>
            <div className="mt-0.5 font-mono text-lg font-bold tabular-nums">{watchlistIncidents.length}</div>
          </div>
          <div className="rounded-lg bg-red-500/[0.07] px-2.5 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-red-600">Critical</div>
            <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-red-600">{critical}</div>
          </div>
          <div className="rounded-lg bg-amber-500/[0.08] px-2.5 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-amber-700">Warning</div>
            <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-amber-700">{warning}</div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 overflow-y-auto p-2.5 [scrollbar-gutter:stable]">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading incidents…</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-red-600">Unable to load incidents</div>
        ) : visibleIncidents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <CheckCircle2Icon className="h-5 w-5" />
            </span>
            <div className="text-sm font-semibold">No active incidents</div>
            <div className="text-[11px] text-muted-foreground">No active watchlist hits.</div>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleIncidents.map((incident) => (
              <NavLink
                key={incident.id}
                to={`/incidents/${incident.id}`}
                className="group flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5 transition hover:border-blue-300 hover:bg-blue-50/40 dark:hover:bg-blue-950/20"
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ring-4 ${
                  incident.severity === "CRITICAL"
                    ? "bg-red-500 ring-red-500/10"
                    : incident.severity === "WARNING"
                      ? "bg-amber-500 ring-amber-500/10"
                      : "bg-blue-500 ring-blue-500/10"
                }`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-foreground">{incident.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground">
                    <span>{relative(incident.lastEventAt)}</span>
                    <span>•</span>
                    <span>{incident.eventCount} event{incident.eventCount === 1 ? "" : "s"}</span>
                  </span>
                </span>
                <Badge
                  variant="outline"
                  className={`shrink-0 px-2 py-0.5 text-[9px] ${
                    incident.severity === "CRITICAL"
                      ? "border-red-300 bg-red-50 text-red-700 dark:bg-red-950/30"
                      : incident.severity === "WARNING"
                        ? "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/30"
                        : "border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/30"
                  }`}
                >
                  {incident.severity}
                </Badge>
                <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </NavLink>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VehicleTrafficChart({
  summary,
  loading,
  days,
  scopeLabel,
  onDaysChange,
}: {
  summary: VehicleTrafficSummary | null;
  loading: boolean;
  days: number;
  scopeLabel: string;
  onDaysChange: (days: number) => void;
}) {
  const points = summary?.points ?? [];
  const dailyPoints = points.map((point) => ({
    key: point.date,
    label: new Date(`${point.date}T00:00:00Z`).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }),
    total: point.total,
  }));
  const chartPoints = days >= 180
    ? [...points.reduce((months, point) => {
        const key = point.date.slice(0, 7);
        months.set(key, (months.get(key) ?? 0) + point.total);
        return months;
      }, new Map<string, number>())].map(([key, total]) => ({
        key,
        label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-IN", {
          month: "short",
          year: "2-digit",
          timeZone: "UTC",
        }),
        total,
      }))
    : dailyPoints;
  const max = Math.max(1, ...chartPoints.map((point) => point.total));
  const today = points.at(-1)?.total ?? 0;
  const hasPreviousDay = points.length > 1;
  const yesterday = hasPreviousDay ? points.at(-2)?.total ?? 0 : 0;
  const todayDelta = today - yesterday;
  const average = summary && summary.days > 0 ? summary.total / summary.days : 0;
  const peakPoint = dailyPoints.reduce<(typeof dailyPoints)[number] | null>(
    (peak, point) => (!peak || point.total > peak.total ? point : peak),
    null,
  );
  const periodDescription = days === 1 ? "Current day" : `Last ${days} days`;
  const plot = { left: 32, right: 316, top: 10, bottom: 100 };
  const lineCoordinates = chartPoints.map((point, index) => ({
    x: chartPoints.length === 1
      ? (plot.left + plot.right) / 2
      : plot.left + (index / Math.max(1, chartPoints.length - 1)) * (plot.right - plot.left),
    y: plot.bottom - (point.total / max) * (plot.bottom - plot.top),
  }));
  const linePath = lineCoordinates
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = linePath
    ? `${linePath} L${lineCoordinates.at(-1)?.x ?? plot.right},${plot.bottom} L${lineCoordinates[0]?.x ?? plot.left},${plot.bottom} Z`
    : "";
  const ranges = [
    { value: 1, label: "24H" },
    { value: 7, label: "7D" },
    { value: 30, label: "1M" },
    { value: 180, label: "6M" },
    { value: 365, label: "1Y" },
    { value: 730, label: "2Y" },
  ];

  return (
    <Card className="min-h-[22rem] gap-0 overflow-hidden border py-0 shadow-sm xl:h-[22rem]">
      <CardHeader className="space-y-3 px-4 pb-2.5 pt-3.5">
        <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <BarChart3Icon className="h-4 w-4 text-blue-600" />
              <span>Vehicle Traffic</span>
            </CardTitle>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {scopeLabel} · {periodDescription}
              {hasPreviousDay && (
                <span className={todayDelta > 0 ? "text-emerald-600" : todayDelta < 0 ? "text-amber-600" : ""}>
                  {` · ${todayDelta > 0 ? "+" : ""}${todayDelta} vs previous day`}
                </span>
              )}
            </div>
          </div>
          <div className="flex max-w-full items-center overflow-x-auto rounded-lg border bg-muted/20 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {ranges.map((range) => (
              <button
                key={range.value}
                type="button"
                onClick={() => onDaysChange(range.value)}
                className={`min-w-8 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                  days === range.value
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <div className="rounded-lg border border-transparent bg-muted/25 px-2 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Today</div>
            <div className="font-mono text-lg font-bold tabular-nums">{today}</div>
          </div>
          <div className="rounded-lg border border-transparent bg-muted/25 px-2 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Period total</div>
            <div className="font-mono text-lg font-bold tabular-nums">{summary?.total ?? 0}</div>
          </div>
          <div className="rounded-lg border border-transparent bg-muted/25 px-2 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Daily avg</div>
            <div className="font-mono text-lg font-bold tabular-nums">{average.toFixed(1)}</div>
          </div>
          <div className="rounded-lg border border-transparent bg-muted/25 px-2 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Peak</div>
            <div className="font-mono text-lg font-bold tabular-nums">{peakPoint?.total ?? 0}</div>
            <div className="truncate text-[9px] text-muted-foreground">{peakPoint?.label ?? "No data"}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-4 pb-4">
        <div className="relative h-full min-h-0 overflow-hidden rounded-lg border bg-gradient-to-b from-blue-500/[0.04] to-transparent p-2">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading traffic history…
            </div>
          ) : chartPoints.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No traffic data yet</div>
          ) : (
            <div className="flex h-full flex-col" role="img" aria-label={`Vehicle totals for the last ${days} days`}>
              <svg viewBox="0 0 330 125" className="min-h-0 w-full flex-1 overflow-visible" aria-hidden="true">
                <defs>
                  <linearGradient id="vehicle-traffic-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {[plot.top, plot.top + (plot.bottom - plot.top) / 3, plot.top + ((plot.bottom - plot.top) * 2) / 3, plot.bottom].map((y, index) => (
                  <g key={y}>
                    <line x1={plot.left} x2={plot.right} y1={y} y2={y} stroke="#94a3b8" strokeOpacity="0.28" strokeDasharray={index === 3 ? undefined : "3 3"} />
                    <text x={plot.left - 5} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[8px]">
                      {Math.round(max * (1 - index / 3))}
                    </text>
                  </g>
                ))}
                <path d={areaPath} fill="url(#vehicle-traffic-area)" />
                <path d={linePath} fill="none" stroke="#2563eb" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                {lineCoordinates.map((point, index) => (
                  <circle key={chartPoints[index]?.key} cx={point.x} cy={point.y} r="2.25" fill="#2563eb" stroke="white" strokeWidth="1">
                    <title>{`${chartPoints[index]?.label}: ${chartPoints[index]?.total} vehicles`}</title>
                  </circle>
                ))}
                <text x={plot.left} y="120" className="fill-muted-foreground text-[8px]">{chartPoints[0]?.label}</text>
                <text x={plot.right} y="120" textAnchor="end" className="fill-muted-foreground text-[8px]">{chartPoints.at(-1)?.label}</text>
              </svg>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
