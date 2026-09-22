import { useCallback, useState, useEffect } from "react";
import {
  BarChart3Icon,
  CalendarDaysIcon,
  CarFrontIcon,
  CheckCircle2Icon,
  ClockIcon,
  FilterIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanIcon,
  SearchIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TruckIcon,
} from "lucide-react";
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
import { PlateScannerCanvas } from "./plate-scanner-canvas";
import { AddWatchlistDialog } from "./add-watchlist-dialog";

export function WatchlistScreen() {
  const [tab, setTab] = useState<"scanner" | "registry" | "logs">("scanner");
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [trafficDays, setTrafficDays] = useState(14);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<WatchlistEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WatchlistEntry | null>(null);

  // Scanner Workbench state
  const [latestDetection, setLatestDetection] = useState<PlateDetection | null>(null);
  const [scanning, setScanning] = useState(false);

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
  } = useResource(() => api.plateDetections({ limit: 60 }), []);

  const {
    data: traffic,
    loading: trafficLoading,
    reload: reloadTraffic,
  } = useResource(() => api.vehicleTraffic({ days: trafficDays }), [trafficDays]);

  const handleVehicleCounted = useCallback(async (vehicle: {
    sourceKey: string;
    cameraId: string;
    vehicleType: string;
    occurredAt: string;
  }) => {
    try {
      await api.recordVehicleTraffic(vehicle);
      reloadTraffic();
    } catch (cause) {
      console.warn("Unable to save vehicle traffic count", cause);
    }
  }, [reloadTraffic]);

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

    return () => {
      unsubDet();
      unsubWl();
    };
  }, [reloadEntries, reloadLogs, reloadStats]);

  // Set initial latest detection from logs if available
  useEffect(() => {
    if (logs && logs.length > 0 && !latestDetection) {
      setLatestDetection(logs[0]!);
    }
  }, [logs, latestDetection]);

  // Run Preset Simulation Scan
  const handleRunScan = async (presetKey: string) => {
    setScanning(true);
    try {
      const result = await api.simulatePlateDetection(presetKey);
      setLatestDetection(result);
      reloadLogs();
      reloadStats();
      if (result.match_status === "MATCHED") {
        toast.error(`ALERT: Flagged Vehicle Detected (${result.plate_number})`, {
          description: `Watchlist match flagged on ${result.camera_name ?? result.camera_id}`,
        });
      }
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setScanning(false);
    }
  };

  // Run Custom Manual Plate Scan
  const handleManualScan = async (plate: string, vehicleType: string, cameraId: string) => {
    setScanning(true);
    try {
      const result = await api.detectVehicleAndPlate({
        plateNumber: plate,
        vehicleType,
        cameraId,
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
    } finally {
      setScanning(false);
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
      {/* Overview Stat Metric Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-[11px] font-medium text-muted-foreground">Flagged Vehicles</div>
          <div className="text-2xl font-bold tracking-tight text-foreground font-mono">
            {stats?.totalWatchlist ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {stats?.activeWatchlist ?? 0} active in memory
          </div>
        </Card>

        <Card className="p-3 border-red-500/20 bg-red-500/5">
          <div className="text-[11px] font-medium text-red-600 dark:text-red-400">Critical Threats</div>
          <div className="text-2xl font-bold tracking-tight text-red-600 dark:text-red-400 font-mono">
            {stats?.criticalCount ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">High priority BOLO</div>
        </Card>

        <Card className="p-3">
          <div className="text-[11px] font-medium text-muted-foreground">Scans (24h)</div>
          <div className="text-2xl font-bold tracking-tight text-foreground font-mono">
            {stats?.scans24h ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">Across all checkpoints</div>
        </Card>

        <Card className="p-3 border-amber-500/20 bg-amber-500/5">
          <div className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Watchlist Hits</div>
          <div className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400 font-mono">
            {stats?.matches24h ?? 0}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">Matched flagged plates</div>
        </Card>

        <Card className="p-3">
          <div className="text-[11px] font-medium text-muted-foreground">OCR Accuracy</div>
          <div className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400 font-mono">
            {stats?.readRate ?? 98.4}%
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">Edge ALPR confidence</div>
        </Card>
      </div>

      {/* Main Tabs Navigation */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
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
            scanning={scanning}
            onRunScan={handleRunScan}
            onManualScan={handleManualScan}
            onVehicleCounted={handleVehicleCounted}
          />
          <VehicleTrafficChart
            summary={traffic}
            loading={trafficLoading}
            days={trafficDays}
            onDaysChange={setTrafficDays}
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
                <Table>
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
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: ANPR Scan Logs */}
        <TabsContent value="logs" className="space-y-4">
          <Card className="border">
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-semibold">ANPR Vehicle Detections Log</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Chronological stream of license plates recognized across perimeter cameras.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => reloadLogs()} disabled={logsLoading}>
                  <RefreshCwIcon className="h-3.5 w-3.5" data-icon="inline-start" />
                  Refresh Feed
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {logsLoading && <LoadingRows rows={5} />}
              {logsError && <ErrorState error={logsError} onRetry={reloadLogs} />}

              {logs && logs.length === 0 && (
                <NothingHere
                  icon={ClockIcon}
                  title="No vehicle scans recorded"
                  description="Vehicle detection scans will appear here as they are processed by the edge node."
                />
              )}

              {logs && logs.length > 0 && (
                <Table>
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
                    {logs.map((scan) => {
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
                          <TableCell className="font-mono text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
                            {Math.round(scan.plate_confidence * 100)}%
                          </TableCell>
                          <TableCell>
                            {isHit ? (
                              <Badge variant="destructive" className="font-mono text-[10px] gap-1">
                                <ShieldAlertIcon className="h-3 w-3" />
                                WATCHLIST HIT
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
    </PageShell>
  );
}

function VehicleTrafficChart({
  summary,
  loading,
  days,
  onDaysChange,
}: {
  summary: VehicleTrafficSummary | null;
  loading: boolean;
  days: number;
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
  const average = summary && summary.days > 0 ? summary.total / summary.days : 0;

  return (
    <Card className="border">
      <CardHeader className="px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <BarChart3Icon className="h-4 w-4 text-cyan-600" />
              Vehicle Traffic by Date
            </CardTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Unique tracked vehicles, including vehicles whose number plate could not be read.
            </p>
          </div>
          <Select value={String(days)} onValueChange={(value) => onDaysChange(Number(value))}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <CalendarDaysIcon className="mr-1 h-3.5 w-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 1 month</SelectItem>
              <SelectItem value="180">Last 6 months</SelectItem>
              <SelectItem value="365">Last 1 year</SelectItem>
              <SelectItem value="730">Last 2 years</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border bg-muted/20 p-2.5">
            <div className="text-[10px] text-muted-foreground">Today</div>
            <div className="font-mono text-xl font-bold">{today}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-2.5">
            <div className="text-[10px] text-muted-foreground">Period total</div>
            <div className="font-mono text-xl font-bold">{summary?.total ?? 0}</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-2.5">
            <div className="text-[10px] text-muted-foreground">Daily average</div>
            <div className="font-mono text-xl font-bold">{average.toFixed(1)}</div>
          </div>
        </div>

        <div className="relative h-56 rounded-md border bg-muted/10 px-3 pb-8 pt-5">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading traffic history…
            </div>
          ) : (
            <div className="flex h-full items-end gap-1 sm:gap-2" role="img" aria-label={`Vehicle totals for the last ${days} days`}>
              {chartPoints.map((point, index) => {
                const height = point.total === 0 ? 2 : Math.max(8, (point.total / max) * 100);
                const showLabel = chartPoints.length <= 14 || index % Math.ceil(chartPoints.length / 10) === 0 || index === chartPoints.length - 1;
                const shortDate = point.label;
                return (
                  <div key={point.key} className="group relative flex h-full min-w-0 flex-1 items-end justify-center">
                    <div
                      className="w-full max-w-10 rounded-t bg-cyan-500/80 transition-colors hover:bg-cyan-500"
                      style={{ height: `${height}%` }}
                      title={`${shortDate}: ${point.total} vehicle${point.total === 1 ? "" : "s"}`}
                    />
                    {point.total > 0 && (
                      <span className="absolute -top-4 hidden font-mono text-[9px] font-semibold text-foreground group-hover:block">
                        {point.total}
                      </span>
                    )}
                    {showLabel && (
                      <span className="absolute -bottom-6 whitespace-nowrap text-[9px] text-muted-foreground">
                        {shortDate}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
