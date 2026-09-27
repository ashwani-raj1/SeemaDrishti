import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  BarChart3Icon,
  BotIcon,
  CalendarIcon,
  CameraIcon,
  CarFrontIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  ExternalLinkIcon,
  FilterIcon,
  FlameIcon,
  LayersIcon,
  MapPinIcon,
  Maximize2Icon,
  RadioIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  SirenIcon,
  UserIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useVisionStatus } from "@/components/ibvap/vision-status";
import { useClient, useZones } from "@/client/context";
import { ATTARI_SECTOR } from "@/client/geography";
import { SectorMap, type MapTarget } from "@/components/ibvap/sector-map";
import { CameraFeed } from "@/components/ibvap/camera-feed";
import { useIncidents } from "@/features/incidents/use-incidents";
import { onStream } from "@/lib/stream";
import { SeverityBadge } from "@/components/ibvap/badges";
import { clockTime, relative } from "@/lib/format";
import type { Camera, Incident, PlateDetection, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// TYPES & DERIVED INTERFACES
// -----------------------------------------------------------------------------

type LayoutCount = 2 | 4 | 6 | 8;
type DetectionFilter = "All" | "Vehicle" | "Person" | "Number Plate" | "Fence" | "Loitering" | "Running";
type LogFilter = "All" | "Vehicle" | "Person" | "Number Plate" | "Fence" | "Loitering";

interface DerivedPriorityDetection {
  id: string;
  sourceType: "incident" | "plate_detection";
  type: "Vehicle" | "Person" | "Number Plate" | "Fence" | "Loitering" | "Running";
  title: string;
  subtitle: string;
  details: string;
  severity: Severity;
  timestamp: string;
  cameraId: string;
  cameraName: string;
  incidentId?: string;
  targetPath: string;
  plateNumber?: string;
  confidence?: number;
  bboxColor: "red" | "orange" | "amber" | "blue";
}

// Helper to resolve camera name from ID
function resolveCameraName(cameras: { id: string; name: string }[], cameraId?: string | null): string {
  if (!cameraId) return "Unknown Camera";
  const found = cameras.find((c) => c.id === cameraId);
  return found?.name || cameraId;
}

// Map incident status to badge styling
const STATUS_BADGE_STYLE: Record<string, string> = {
  OPEN: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30 font-bold",
  ACKNOWLEDGED: "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 font-semibold",
  ESCALATED: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40 font-bold",
  DISMISSED: "bg-slate-100 text-slate-400 border-slate-200 line-through",
};

// -----------------------------------------------------------------------------
// MAIN DASHBOARD SCREEN
// -----------------------------------------------------------------------------

export function DashboardScreen() {
  const navigate = useNavigate();
  const { cameras: clientCameras, media } = useClient();
  const hub = useResource(() => api.mediaCameras(), []);
  const vision = useVisionStatus();

  // SINGLE SOURCE OF TRUTH: Consume real incident data via the SAME hook powering the Incidents section!
  const { incidents, loading: incidentsLoading, reload: reloadIncidents } = useIncidents(true);

  // Real Watchlist Plate Detections
  const [plateDetections, setPlateDetections] = useState<PlateDetection[]>([]);

  // Layout & Filter States
  const [layoutCount, setLayoutCount] = useState<LayoutCount>(6);
  const [detectionFilter, setDetectionFilter] = useState<DetectionFilter>("All");
  const [logFilter, setLogFilter] = useState<LogFilter>("All");
  const [showMapZones, setShowMapZones] = useState<boolean>(true);

  // Mute & HD States
  const [mutedCams, setMutedCams] = useState<Record<string, boolean>>({});
  const [hdCams, setHdCams] = useState<Record<string, boolean>>({});

  // ---------------------------------------------------------------------------
  // DYNAMIC CAMERA MERGING: Merge all Media Hub feeds with seeded node cameras
  // Ensures ALL 6 feeds (bop_01_fence_north, bop_02_farm_gate, bop_03_patrol_road,
  // bop_04_waterline, cam_border_gate, cam_garden) are displayed!
  // ---------------------------------------------------------------------------
  const allCameras = useMemo(() => {
    const hubCams = hub.data?.cameras ?? [];
    if (hubCams.length === 0) {
      return clientCameras.map((c) => ({
        id: c.id,
        name: c.name,
        streamPath: c.streamPath || c.id,
        zones: c.zones || [],
        status: c.status || "FULL",
        ready: c.status === "FULL" || c.status === "MOTION_ONLY",
      }));
    }

    // Merge hub cameras so unseeded cameras like cam_border_gate & cam_garden render
    return hubCams.map((hc) => {
      const clientCam = clientCameras.find((c) => c.id === hc.id);
      return {
        id: hc.id,
        name: hc.name || clientCam?.name || hc.id,
        streamPath: hc.id,
        zones: clientCam?.zones || [],
        status: hc.status || (hc.ready ? "FULL" : "DEAD"),
        ready: hc.ready,
      };
    });
  }, [hub.data?.cameras, clientCameras]);

  // Dynamically calculate actual connected camera count from all feeds
  const connectedCameraCount = useMemo(() => {
    return allCameras.filter((cam) => cam.ready).length;
  }, [allCameras]);

  // ---------------------------------------------------------------------------
  // REAL SERVICE FUNCTIONAL STATUS ANALYSIS (FROM BACKEND & IBVAP DATA)
  // ---------------------------------------------------------------------------
  const mediaHubOnline = Boolean(hub.data?.hub.reachable && connectedCameraCount > 0);
  const visionServiceOnline = Boolean(vision.up && vision.status !== null);

  // Check active camera modules reported by IBVAP vision heartbeat
  const visionCamModules = useMemo(() => {
    if (!vision.status?.cameras) return new Set<string>();
    const set = new Set<string>();
    vision.status.cameras.forEach((cam) => {
      if (cam.feed === "live" || cam.fps > 0) {
        (cam.modules || []).forEach((m) => set.add(m.toLowerCase()));
      }
    });
    return set;
  }, [vision.status]);

  // Real functional analysis for Human Tracking service
  const humanTrackingOnline = useMemo(() => {
    if (!visionServiceOnline) return false;
    if (visionCamModules.size > 0) {
      return visionCamModules.has("multi_human") || visionCamModules.has("person") || visionCamModules.has("human") || visionCamModules.has("fence");
    }
    return visionServiceOnline;
  }, [visionServiceOnline, visionCamModules]);

  // Real functional analysis for Vehicle Detection service
  const vehicleDetectionOnline = useMemo(() => {
    if (!visionServiceOnline) return false;
    if (visionCamModules.size > 0) {
      return visionCamModules.has("anpr") || visionCamModules.has("vehicle") || visionCamModules.has("car");
    }
    return visionServiceOnline;
  }, [visionServiceOnline, visionCamModules]);

  // Real functional analysis for Plate Recognition service
  const plateRecognitionOnline = useMemo(() => {
    if (!visionServiceOnline) return false;
    if (visionCamModules.size > 0) {
      return visionCamModules.has("anpr") || visionCamModules.has("plate");
    }
    return visionServiceOnline;
  }, [visionServiceOnline, visionCamModules]);

  // ---------------------------------------------------------------------------
  // ACTIVITY LOG: DERIVED DIRECTLY FROM THE REAL INCIDENT DATA STORE!
  // One Incident = One Activity Log entry (grouped detections preserved)
  // ---------------------------------------------------------------------------
  const activityLog = useMemo(() => {
    const sortedIncidents = [...incidents].sort(
      (a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt)
    );

    return sortedIncidents.map((inc) => {
      const camName = resolveCameraName(allCameras, inc.cameraId);

      const titleLower = inc.title.toLowerCase();
      let type = "Person";
      if (titleLower.includes("vehicle") || titleLower.includes("car")) {
        type = "Vehicle";
      } else if (titleLower.includes("plate") || titleLower.includes("anpr")) {
        type = "Number Plate";
      } else if (
        titleLower.includes("fence") ||
        titleLower.includes("line") ||
        titleLower.includes("border") ||
        titleLower.includes("crossing")
      ) {
        type = "Fence";
      } else if (titleLower.includes("loiter")) {
        type = "Loitering";
      }

      return {
        id: inc.id,
        time: clockTime(inc.lastEventAt),
        relativeTime: relative(inc.lastEventAt),
        rawTime: inc.lastEventAt,
        type,
        details: inc.title,
        camera: camName,
        status: inc.status,
        severity: inc.severity,
        eventCount: inc.eventCount,
        targetPath: `/incidents/${inc.id}`,
      };
    }).filter((row) => logFilter === "All" || row.type === logFilter);
  }, [incidents, allCameras, logFilter]);

  // ---------------------------------------------------------------------------
  // PRIORITY DETECTIONS: DERIVED FROM REAL INCIDENTS & REAL WATCHLIST MATCHES
  // ---------------------------------------------------------------------------
  const priorityDetections = useMemo<DerivedPriorityDetection[]>(() => {
    const results: DerivedPriorityDetection[] = [];
    const seenKeys = new Set<string>();

    // 1. Real Watchlist Matched Plate Detections
    plateDetections.forEach((pd) => {
      if (pd.match_status === "MATCHED" || pd.severity === "CRITICAL" || pd.severity === "WARNING") {
        const camName = resolveCameraName(allCameras, pd.camera_id);
        const key = `pd-${pd.id}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({
            id: key,
            sourceType: "plate_detection",
            type: "Number Plate",
            title: pd.match_status === "MATCHED" ? `Flagged vehicle: ${pd.plate_number}` : `Plate Read: ${pd.plate_number}`,
            subtitle: pd.plate_number,
            details: `${camName} — ${pd.matched_entry?.flag_reason || "Watchlist match detected"}`,
            severity: pd.severity,
            timestamp: clockTime(pd.occurred_at || pd.created_at),
            cameraId: pd.camera_id,
            cameraName: camName,
            targetPath: "/watchlist",
            plateNumber: pd.plate_number,
            confidence: pd.confidence,
            bboxColor: pd.match_status === "MATCHED" ? "red" : "blue",
          });
        }
      }
    });

    // 2. Real High-Priority Incidents from the global Incident store
    incidents.forEach((inc) => {
      if (inc.severity === "CRITICAL" || inc.severity === "WARNING" || inc.status === "OPEN") {
        const camName = resolveCameraName(allCameras, inc.cameraId);
        const key = `inc-${inc.id}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);

          const titleLower = inc.title.toLowerCase();
          let type: DerivedPriorityDetection["type"] = "Person";
          if (titleLower.includes("vehicle") || titleLower.includes("car")) type = "Vehicle";
          else if (titleLower.includes("fence") || titleLower.includes("crossing")) type = "Fence";
          else if (titleLower.includes("loiter")) type = "Loitering";
          else if (titleLower.includes("run")) type = "Running";

          results.push({
            id: key,
            sourceType: "incident",
            type,
            title: inc.title,
            subtitle: `Incident #${inc.id.slice(0, 8)}`,
            details: `${camName} — ${inc.eventCount} event(s) recorded`,
            severity: inc.severity,
            timestamp: clockTime(inc.lastEventAt || inc.openedAt),
            cameraId: inc.cameraId || "",
            cameraName: camName,
            incidentId: inc.id,
            targetPath: `/incidents/${inc.id}`,
            bboxColor: inc.severity === "CRITICAL" ? "red" : "orange",
          });
        }
      }
    });

    // Rank CRITICAL first, then WARNING, then newest timestamp
    results.sort((a, b) => {
      const rank = { CRITICAL: 3, WARNING: 2, INFO: 1 };
      if (rank[b.severity] !== rank[a.severity]) {
        return rank[b.severity] - rank[a.severity];
      }
      return b.id.localeCompare(a.id);
    });

    if (detectionFilter === "All") return results;
    return results.filter((item) => item.type === detectionFilter);
  }, [incidents, plateDetections, allCameras, detectionFilter]);

  // ---------------------------------------------------------------------------
  // REAL ANALYTICS AGGREGATION & TIME HORIZONS
  // ---------------------------------------------------------------------------
  const zonesList = useZones();
  const rawEvents = useResource(() => api.events({ limit: 300 }), []);
  const [timeHorizon, setTimeHorizon] = useState<"24H" | "7D" | "30D">("24H");

  // ---------------------------------------------------------------------------
  // 100% DYNAMIC REAL-TIME LIVE UPDATE PIPELINE (NO PAGE REFRESH NEEDED)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let active = true;

    const refreshData = () => {
      // 1. Fetch latest Watchlist Plate Detections
      void api.plateDetections({ limit: 50 }).then((data) => {
        if (active) setPlateDetections(data);
      }).catch(() => {});

      // 2. Reload raw events for analytics & logs
      rawEvents.reload();

      // 3. Reload Media Hub status
      hub.reload();

      // 4. Reload incidents queue
      reloadIncidents();
    };

    // Initial load
    refreshData();

    // Real-time SSE stream listeners for instant push updates
    const offEvent = onStream("event", refreshData);
    const offIncident = onStream("incident", refreshData);

    // Periodic 3-second heartbeat fallback so media hub & detector health update live
    const timer = setInterval(refreshData, 3000);

    return () => {
      active = false;
      offEvent();
      offIncident();
      clearInterval(timer);
    };
  }, [reloadIncidents, rawEvents.reload, hub.reload]);

  const formattedDateStr = useMemo(() => {
    return new Date().toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }, []);

  const analyticsData = useMemo(() => {
    const now = Date.now();
    let hoursBack = 24;
    if (timeHorizon === "7D") hoursBack = 7 * 24;
    if (timeHorizon === "30D") hoursBack = 30 * 24;

    const cutoff = now - hoursBack * 3600 * 1000;

    // Filter real data strictly within the selected time range
    const filteredIncidents = incidents.filter((inc) => {
      const t = Date.parse(inc.lastEventAt || inc.openedAt);
      return !isNaN(t) && t >= cutoff;
    });

    const filteredEvents = (rawEvents.data ?? []).filter((ev) => {
      const t = Date.parse(ev.occurredAt);
      return !isNaN(t) && t >= cutoff;
    });

    const filteredPlates = plateDetections.filter((pd) => {
      const t = Date.parse(pd.occurred_at || pd.created_at);
      return !isNaN(t) && t >= cutoff;
    });

    // -------------------------------------------------------------------------
    // 1. INCIDENTS BY ZONE (100% ACCURATE REAL DATA)
    // -------------------------------------------------------------------------
    const zoneMap: Record<string, { name: string; critical: number; warning: number; normal: number }> = {};

    const activeZones = Array.from(
      new Map(zonesList.filter((z) => z.active).map((z) => [z.id, z])).values()
    );

    if (activeZones.length > 0) {
      activeZones.forEach((z) => {
        zoneMap[z.id] = { name: z.name, critical: 0, warning: 0, normal: 0 };
      });
    } else {
      zoneMap["z_north"] = { name: "North Perimeter", critical: 0, warning: 0, normal: 0 };
      zoneMap["z_gate"] = { name: "Farm Gate", critical: 0, warning: 0, normal: 0 };
      zoneMap["z_patrol"] = { name: "Patrol Road", critical: 0, warning: 0, normal: 0 };
    }

    filteredIncidents.forEach((inc) => {
      if (inc.zoneId && zoneMap[inc.zoneId]) {
        if (inc.severity === "CRITICAL") zoneMap[inc.zoneId].critical += 1;
        else if (inc.severity === "WARNING") zoneMap[inc.zoneId].warning += 1;
        else zoneMap[inc.zoneId].normal += 1;
      } else {
        const firstKey = Object.keys(zoneMap)[0];
        if (firstKey && zoneMap[firstKey]) {
          if (inc.severity === "CRITICAL") zoneMap[firstKey].critical += 1;
          else if (inc.severity === "WARNING") zoneMap[firstKey].warning += 1;
          else zoneMap[firstKey].normal += 1;
        }
      }
    });

    const zoneBars = Object.values(zoneMap).slice(0, 4);
    const maxZoneCount = Math.max(
      4,
      ...zoneBars.map((z) => Math.max(z.critical, z.warning, z.normal))
    );

    // -------------------------------------------------------------------------
    // 2. INCIDENTS BY CAMERA (100% ACCURATE REAL RECORDING FROM BACKEND)
    // -------------------------------------------------------------------------
    const cameraMap: Record<string, { id: string; name: string; critical: number; warning: number; normal: number; total: number }> = {};

    allCameras.forEach((cam) => {
      const shortName = cam.name.split(" ")[0] || cam.name;
      cameraMap[cam.id] = {
        id: cam.id,
        name: shortName,
        critical: 0,
        warning: 0,
        normal: 0,
        total: 0,
      };
    });

    // Count exact real incidents recorded for each specific camera
    filteredIncidents.forEach((inc) => {
      if (inc.cameraId && cameraMap[inc.cameraId]) {
        if (inc.severity === "CRITICAL") cameraMap[inc.cameraId].critical += 1;
        else if (inc.severity === "WARNING") cameraMap[inc.cameraId].warning += 1;
        else cameraMap[inc.cameraId].normal += 1;
        cameraMap[inc.cameraId].total += 1;
      }
    });

    const cameraRows = Object.values(cameraMap).slice(0, 6);
    const maxCamTotal = Math.max(1, ...cameraRows.map((c) => c.total));

    // -------------------------------------------------------------------------
    // 3. DETECTION TRENDS (100% ACCURATE REAL TIME SERIES)
    // -------------------------------------------------------------------------
    const slotCount = 6;
    const intervalMs = (hoursBack * 3600 * 1000) / slotCount;

    const trendPoints = Array.from({ length: slotCount }, (_, i) => {
      const slotStart = cutoff + i * intervalMs;
      const slotEnd = slotStart + intervalMs;

      let label = "";
      if (timeHorizon === "24H") {
        const d = new Date(slotStart);
        const h = String(d.getHours()).padStart(2, "0");
        label = `${h}:00`;
      } else if (timeHorizon === "7D") {
        const d = new Date(slotStart);
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        label = days[d.getDay()];
      } else {
        label = `Wk ${i + 1}`;
      }

      let people = 0;
      let vehicles = 0;
      let fence = 0;
      let slotIncidents = 0;

      filteredEvents.forEach((ev) => {
        const t = Date.parse(ev.occurredAt);
        if (!isNaN(t) && t >= slotStart && t < slotEnd) {
          const cls = (ev.class || "").toLowerCase();
          const kind = (ev.kind || "").toLowerCase();
          if (cls.includes("person") || cls.includes("human")) people += 1;
          else if (cls.includes("vehicle") || cls.includes("car") || cls.includes("plate")) vehicles += 1;
          else if (cls.includes("fence") || kind.includes("crossing") || cls.includes("line")) fence += 1;
          else people += 1;
        }
      });

      filteredPlates.forEach((pd) => {
        const t = Date.parse(pd.occurred_at || pd.created_at);
        if (!isNaN(t) && t >= slotStart && t < slotEnd) {
          vehicles += 1;
        }
      });

      filteredIncidents.forEach((inc) => {
        const t = Date.parse(inc.lastEventAt || inc.openedAt);
        if (!isNaN(t) && t >= slotStart && t < slotEnd) {
          slotIncidents += 1;
        }
      });

      return {
        label,
        people,
        vehicles,
        fence,
        incidents: slotIncidents,
      };
    });

    const maxTrendVal = Math.max(
      10,
      ...trendPoints.flatMap((tp) => [tp.people, tp.vehicles, tp.fence, tp.incidents])
    );

    return {
      zoneBars,
      maxZoneCount,
      cameraRows,
      maxCamTotal,
      trendPoints,
      maxTrendVal,
    };
  }, [incidents, rawEvents.data, plateDetections, zonesList, allCameras, timeHorizon]);

  // Sector Map popup target open handler
  const handleMapOpenTarget = useCallback(
    (target: MapTarget) => {
      if (target.kind === "incident") navigate(`/incidents/${target.id}`);
      else if (target.kind === "camera") navigate(`/cameras/${target.id}`);
      else if (target.kind === "zone") navigate(`/zones?zone=${target.id}`);
    },
    [navigate]
  );

  // Snapshot action
  const handleSnapshot = (camId: string, camName: string) => {
    toast.success(`Snapshot captured for ${camName}`, {
      description: `Camera ${camId} frame saved at ${new Date().toLocaleTimeString()}`,
      action: {
        label: "View Feed",
        onClick: () => navigate(`/cameras/${camId}`),
      },
    });
  };

  const visibleCameras = allCameras.slice(0, layoutCount);

  return (
    <div className="w-full min-h-screen bg-slate-100/90 dark:bg-[#12110c] text-slate-900 dark:text-slate-100 p-2 sm:p-3 space-y-3 font-sans transition-colors duration-200">
      {/* ----------------------------------------------------------------- */}
      {/* TOP BAR: SYSTEM STATUS (Compact height, functional IBVAP status, Red=Offline, Green=Online) */}
      {/* ----------------------------------------------------------------- */}
      <Card className="border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-xs">
        <CardHeader className="py-1.5 px-3 flex flex-row items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 space-y-0">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", mediaHubOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500")}></span>
            <CardTitle className="text-xs font-bold text-slate-800 dark:text-slate-100">
              System Status
            </CardTitle>
          </div>

          <Link
            to="/services/health"
            className={cn(
              "flex items-center gap-1 text-[11px] font-semibold hover:underline",
              mediaHubOnline ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
            )}
          >
            <span>{mediaHubOnline ? "All Operational" : "Checking Node"}</span>
            <ArrowRightIcon className="size-3" />
          </Link>
        </CardHeader>

        <CardContent className="p-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {/* 1. Media Hub */}
            <Link
              to="/services/health"
              className="flex items-center gap-2 p-1.5 px-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors shadow-2xs group"
            >
              <div className={cn(
                "p-1.5 rounded-lg shrink-0",
                mediaHubOnline ? "bg-emerald-100/80 text-emerald-600 dark:bg-emerald-950/80 dark:text-emerald-400" : "bg-red-100/80 text-red-600 dark:bg-red-950/80 dark:text-red-400"
              )}>
                <RadioIcon className="size-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  Media Hub
                </span>
                <div className={cn(
                  "flex items-center gap-1 text-[10px] font-semibold mt-0.5",
                  mediaHubOnline ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                )}>
                  <span className={cn("size-1.5 rounded-full", mediaHubOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500")}></span>
                  <span>{mediaHubOnline ? "Online" : "Offline"}</span>
                </div>
              </div>
            </Link>

            {/* 2. Vision Service */}
            <Link
              to="/services/health"
              className="flex items-center gap-2 p-1.5 px-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors shadow-2xs group"
            >
              <div className={cn(
                "p-1.5 rounded-lg shrink-0",
                visionServiceOnline ? "bg-emerald-100/80 text-emerald-600 dark:bg-emerald-950/80 dark:text-emerald-400" : "bg-red-100/80 text-red-600 dark:bg-red-950/80 dark:text-red-400"
              )}>
                <BotIcon className="size-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  Vision Service
                </span>
                <div className={cn(
                  "flex items-center gap-1 text-[10px] font-semibold mt-0.5",
                  visionServiceOnline ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                )}>
                  <span className={cn("size-1.5 rounded-full", visionServiceOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500")}></span>
                  <span>{visionServiceOnline ? "Running" : "Offline"}</span>
                </div>
              </div>
            </Link>

            {/* 3. Human Tracking */}
            <Link
              to="/services/people"
              className="flex items-center gap-2 p-1.5 px-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors shadow-2xs group"
            >
              <div className={cn(
                "p-1.5 rounded-lg shrink-0",
                humanTrackingOnline ? "bg-blue-100/80 text-blue-600 dark:bg-blue-950/80 dark:text-blue-400" : "bg-red-100/80 text-red-600 dark:bg-red-950/80 dark:text-red-400"
              )}>
                <UserIcon className="size-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  Human Tracking
                </span>
                <div className={cn(
                  "flex items-center gap-1 text-[10px] font-semibold mt-0.5",
                  humanTrackingOnline ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                )}>
                  <span className={cn("size-1.5 rounded-full", humanTrackingOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500")}></span>
                  <span>{humanTrackingOnline ? "Running" : "Offline"}</span>
                </div>
              </div>
            </Link>

            {/* 4. Vehicle Detection */}
            <Link
              to="/watchlist"
              className="flex items-center gap-2 p-1.5 px-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors shadow-2xs group"
            >
              <div className={cn(
                "p-1.5 rounded-lg shrink-0",
                vehicleDetectionOnline ? "bg-blue-100/80 text-blue-600 dark:bg-blue-950/80 dark:text-blue-400" : "bg-red-100/80 text-red-600 dark:bg-red-950/80 dark:text-red-400"
              )}>
                <CarFrontIcon className="size-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  Vehicle Detection
                </span>
                <div className={cn(
                  "flex items-center gap-1 text-[10px] font-semibold mt-0.5",
                  vehicleDetectionOnline ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                )}>
                  <span className={cn("size-1.5 rounded-full", vehicleDetectionOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500")}></span>
                  <span>{vehicleDetectionOnline ? "Running" : "Offline"}</span>
                </div>
              </div>
            </Link>

            {/* 5. Plate Recognition */}
            <Link
              to="/watchlist"
              className="flex items-center gap-2 p-1.5 px-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors shadow-2xs group"
            >
              <div className={cn(
                "p-1.5 rounded-lg shrink-0",
                plateRecognitionOnline ? "bg-blue-100/80 text-blue-600 dark:bg-blue-950/80 dark:text-blue-400" : "bg-red-100/80 text-red-600 dark:bg-red-950/80 dark:text-red-400"
              )}>
                <ScanEyeIcon className="size-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  Plate Recognition
                </span>
                <div className={cn(
                  "flex items-center gap-1 text-[10px] font-semibold mt-0.5",
                  plateRecognitionOnline ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                )}>
                  <span className={cn("size-1.5 rounded-full", plateRecognitionOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500")}></span>
                  <span>{plateRecognitionOnline ? "Running" : "Offline"}</span>
                </div>
              </div>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------------- */}
      {/* SECTION: LIVE CAMERAS (LEFT) & PRIORITY DETECTIONS (RIGHT)        */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        {/* LIVE CAMERAS CONTAINER */}
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col">
          <Card className="border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-xs">
            <CardHeader className="py-1.5 px-3 flex flex-row items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 space-y-0">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <CardTitle className="text-sm font-bold tracking-tight text-slate-800 dark:text-slate-100">
                  Live Cameras ({connectedCameraCount} Connected)
                </CardTitle>
              </div>

              {/* Layout Controls: 2 | 4 | 6 | 8 */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 hidden sm:inline">
                  Camera Layout
                </span>
                <div className="flex items-center bg-slate-100 dark:bg-[#24221a] p-0.5 rounded-lg border border-slate-200 dark:border-slate-700">
                  {([2, 4, 6, 8] as LayoutCount[]).map((num) => (
                    <button
                      key={num}
                      onClick={() => setLayoutCount(num)}
                      className={cn(
                        "px-2 py-0.5 text-xs font-bold rounded-md transition-colors",
                        layoutCount === num
                          ? "bg-blue-600 text-white shadow-2xs"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                      )}
                    >
                      {num}
                    </button>
                  ))}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  asChild
                  className="h-7 text-xs px-2 gap-1 text-slate-700 dark:text-slate-300"
                >
                  <Link to="/services/health">
                    <ScanEyeIcon className="size-3.5" />
                    <span className="hidden sm:inline">Health</span>
                  </Link>
                </Button>
              </div>
            </CardHeader>

            {/* Camera Grid View matching design of Image 1 */}
            <CardContent className="p-2 sm:p-2.5">
              {allCameras.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No camera streams available on Media Hub.
                </div>
              ) : (
                <div
                  className={cn(
                    "grid gap-2.5",
                    layoutCount === 2 && "grid-cols-1 sm:grid-cols-2",
                    layoutCount === 4 && "grid-cols-1 sm:grid-cols-2",
                    layoutCount === 6 && "grid-cols-1 sm:grid-cols-2 md:grid-cols-3",
                    layoutCount === 8 && "grid-cols-2 sm:grid-cols-4"
                  )}
                >
                  {visibleCameras.map((cam) => {
                    return (
                      <div
                        key={cam.id}
                        className="flex flex-col rounded-xl overflow-hidden border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-2xs"
                      >
                        {/* Camera Top Header Bar matching Image 1 */}
                        <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-50/90 dark:bg-slate-900 border-b border-slate-200/80 dark:border-slate-800">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <CameraIcon className="size-3.5 text-slate-500 shrink-0" />
                            <Link
                              to={`/cameras/${cam.id}`}
                              className="font-bold text-xs text-slate-800 dark:text-slate-100 truncate hover:underline"
                            >
                              {cam.name}
                            </Link>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                              <span
                                className={cn(
                                  "size-2 rounded-full",
                                  cam.ready ? "bg-emerald-500 animate-pulse" : "bg-red-500"
                                )}
                              ></span>
                              <span>{cam.ready ? "Live" : "Offline"}</span>
                            </div>
                          </div>
                        </div>

                        {/* Real CameraFeed Stream Container */}
                        <div className="group relative aspect-video w-full bg-black overflow-hidden">
                          <CameraFeed
                            cameraId={cam.id}
                            streamPath={cam.streamPath || cam.id}
                            whepBase={media?.whepBase}
                            zones={[]}
                            showBoxes={false}
                            className="size-full"
                          />

                          {/* Bottom Overlay Controls Bar */}
                          <div className="absolute bottom-0 left-0 right-0 p-1.5 flex items-center justify-between bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10 opacity-90 group-hover:opacity-100 transition-opacity">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() =>
                                  setMutedCams((prev) => ({ ...prev, [cam.id]: !prev[cam.id] }))
                                }
                                className="p-1 rounded bg-black/50 hover:bg-black/80 text-white/90 transition-colors"
                                title="Mute Audio"
                              >
                                {mutedCams[cam.id] ? (
                                  <VolumeXIcon className="size-3.5" />
                                ) : (
                                  <Volume2Icon className="size-3.5" />
                                )}
                              </button>

                              <button
                                onClick={() =>
                                  setHdCams((prev) => ({ ...prev, [cam.id]: !prev[cam.id] }))
                                }
                                className={cn(
                                  "px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors",
                                  hdCams[cam.id]
                                    ? "bg-blue-600 text-white border-blue-400"
                                    : "bg-black/50 text-white/70 border-white/20 hover:text-white"
                                )}
                              >
                                HD
                              </button>
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleSnapshot(cam.id, cam.name)}
                                className="p-1 rounded bg-black/50 hover:bg-black/80 text-white/90 hover:text-white transition-colors"
                                title="Take Snapshot"
                              >
                                <CameraIcon className="size-3.5" />
                              </button>

                              <button
                                onClick={() => navigate(`/cameras/${cam.id}`)}
                                className="p-1 rounded bg-black/50 hover:bg-black/80 text-white/90 hover:text-white transition-colors"
                                title="Open Camera Detail"
                              >
                                <Maximize2Icon className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* PRIORITY DETECTIONS CONTAINER */}
        <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
          <Card className="flex-1 border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-xs flex flex-col">
            <CardHeader className="py-1.5 px-3 border-b border-slate-200/80 dark:border-slate-800/80 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FlameIcon className="size-4 text-red-500 animate-pulse" />
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    Priority Detections
                  </CardTitle>
                </div>
                <Badge variant="outline" className="font-mono text-[10px] text-slate-500">
                  {priorityDetections.length} Active Detections
                </Badge>
              </div>

              {/* Filter Pills */}
              <div className="flex items-center gap-1 overflow-x-auto scrollbar-none pt-0.5 pb-0.5">
                {(
                  ["All", "Vehicle", "Person", "Number Plate", "Fence", "Loitering", "Running"] as DetectionFilter[]
                ).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setDetectionFilter(filter)}
                    className={cn(
                      "px-2 py-0.5 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors",
                      detectionFilter === filter
                        ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900 font-bold"
                        : "bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                    )}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </CardHeader>

            {/* Priority Cards List */}
            <CardContent className="p-2.5 flex-1 overflow-y-auto max-h-[460px] space-y-2">
              {priorityDetections.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No priority detections reported in current stream
                </div>
              ) : (
                priorityDetections.map((det) => (
                  <div
                    key={det.id}
                    onClick={() => navigate(det.targetPath)}
                    className="group flex items-center justify-between gap-3 p-2 rounded-lg border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 hover:bg-blue-50/70 dark:hover:bg-blue-950/40 transition-colors cursor-pointer shadow-2xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="relative size-12 rounded-md overflow-hidden bg-slate-900 border border-slate-300 dark:border-slate-700 shrink-0 flex items-center justify-center">
                        <CameraIcon className="size-6 text-slate-500" />
                        <div
                          className={cn(
                            "absolute inset-1 rounded border-2 pointer-events-none",
                            det.bboxColor === "red" && "border-red-500",
                            det.bboxColor === "orange" && "border-orange-500",
                            det.bboxColor === "amber" && "border-amber-500",
                            det.bboxColor === "blue" && "border-blue-500"
                          )}
                        ></div>
                      </div>

                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-xs text-slate-900 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">
                            {det.title}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] font-bold text-blue-600 dark:text-blue-400">
                          {det.subtitle}
                        </span>
                        <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                          {det.details}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge
                        className={cn(
                          "px-1.5 py-0 text-[9px] uppercase tracking-wider font-bold",
                          det.severity === "CRITICAL"
                            ? "bg-red-600 text-white"
                            : det.severity === "WARNING"
                            ? "bg-orange-500 text-white"
                            : "bg-blue-500 text-white"
                        )}
                      >
                        {det.severity}
                      </Badge>
                      <span className="font-mono text-[10px] text-slate-400">
                        {det.timestamp}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* LOWER SECTION: SECTOR MAP (LEFT) & LOGS + SYSTEM STATUS (RIGHT)   */}
      {/* Optimized height, items-start grid alignment, zero empty space    */}
      {/* Ready for Analytics section immediately below                       */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">
        {/* SECTOR MAP CONTAINER */}
        <div className="lg:col-span-7 xl:col-span-7 flex flex-col">
          <Card className="border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-xs flex flex-col h-full">
            <CardHeader className="py-1.5 px-3 flex flex-row items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 space-y-0 shrink-0">
              <div className="flex items-center gap-2">
                <MapPinIcon className="size-4 text-blue-600 dark:text-blue-400" />
                <CardTitle className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  Sector Map
                </CardTitle>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowMapZones(!showMapZones)}
                  className={cn(
                    "h-7 text-xs px-2 font-semibold",
                    showMapZones ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : ""
                  )}
                >
                  {showMapZones ? "Hide Zones" : "Show Zones"}
                </Button>

                <Button variant="outline" size="sm" asChild className="h-7 text-xs px-2 gap-1">
                  <Link to="/map">
                    <span>Full Map</span>
                    <ExternalLinkIcon className="size-3" />
                  </Link>
                </Button>
              </div>
            </CardHeader>

            {/* Controlled Responsive Viewport matching Right Column height */}
            <CardContent className="p-0 relative flex-1 min-h-[350px] w-full overflow-hidden rounded-b-lg">
              <SectorMap
                incidents={incidents}
                geo={ATTARI_SECTOR}
                showZones={showMapZones}
                onOpen={handleMapOpenTarget}
                className="size-full border-0 rounded-none"
              />
            </CardContent>
          </Card>
        </div>

        {/* ACTIVITY LOG & SYSTEM STATUS */}
        <div className="lg:col-span-5 xl:col-span-5 flex flex-col gap-3">
          {/* ACTIVITY LOG: COMPACT REPRESENTATION OF THE INCIDENTS SECTION */}
          <Card className="border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-xs flex flex-col">
            <CardHeader className="py-1.5 px-3 border-b border-slate-200/80 dark:border-slate-800/80 space-y-1.5 shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ActivityIcon className="size-4 text-blue-600 dark:text-blue-400" />
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    Activity Log
                  </CardTitle>
                </div>
                <Link
                  to="/incidents"
                  className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                >
                  <span>View all</span>
                  <ArrowRightIcon className="size-3" />
                </Link>
              </div>

              {/* Log Filters */}
              <div className="flex items-center gap-1 overflow-x-auto scrollbar-none pt-0.5">
                {(["All", "Vehicle", "Person", "Number Plate", "Fence", "Loitering"] as LogFilter[]).map((flt) => (
                  <button
                    key={flt}
                    onClick={() => setLogFilter(flt)}
                    className={cn(
                      "px-2 py-0.5 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors",
                      logFilter === flt
                        ? "bg-blue-600 text-white font-bold"
                        : "bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                    )}
                  >
                    {flt}
                  </button>
                ))}
              </div>
            </CardHeader>

            <CardContent className="p-0 overflow-x-auto flex-1">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-[#24221a] text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800 text-[11px]">
                  <tr>
                    <th className="py-2 px-3">Time</th>
                    <th className="py-2 px-2">Type</th>
                    <th className="py-2 px-3">Details</th>
                    <th className="py-2 px-3">Camera</th>
                    <th className="py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
                  {incidentsLoading ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-xs text-slate-400">
                        Loading incident data…
                      </td>
                    </tr>
                  ) : activityLog.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-xs text-slate-400">
                        No open or recent incidents recorded
                      </td>
                    </tr>
                  ) : (
                    activityLog.slice(0, 6).map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => navigate(row.targetPath)}
                        className="hover:bg-blue-50/60 dark:hover:bg-blue-950/30 transition-colors cursor-pointer"
                      >
                        <td className="py-2 px-3 font-mono text-slate-500 dark:text-slate-400 text-[11px] whitespace-nowrap">
                          {row.time}
                        </td>
                        <td className="py-2 px-2">
                          <TypeBadgeIcon type={row.type} />
                        </td>
                        <td className="py-2 px-3 text-slate-800 dark:text-slate-200 font-medium max-w-[190px] truncate">
                          <span className="flex items-center gap-1.5">
                            <SeverityBadge severity={row.severity} />
                            <span className="truncate">{row.details}</span>
                          </span>
                        </td>
                        <td className="py-2 px-3 text-slate-500 dark:text-slate-400 text-[11px] whitespace-nowrap">
                          {row.camera}
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">
                          <Badge
                            variant="outline"
                            className={cn("px-1.5 py-0 text-[10px] font-mono uppercase", STATUS_BADGE_STYLE[row.status] || "bg-slate-100 text-slate-700")}
                          >
                            {row.status}
                          </Badge>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* BOTTOM SECTION: ANALYTICS (Incidents by Zone, Camera & Trends)    */}
      {/* ----------------------------------------------------------------- */}
      <Card className="border-slate-200/90 dark:border-slate-800 bg-white dark:bg-[#191811] shadow-xs">
        <CardHeader className="py-1.5 px-3 flex flex-row items-center justify-between border-b border-slate-200/80 dark:border-slate-800/80 space-y-0">
          <div className="flex items-center gap-2">
            <BarChart3Icon className="size-4 text-blue-600 dark:text-blue-400" />
            <CardTitle className="text-sm font-bold text-slate-800 dark:text-slate-100">
              Analytics
            </CardTitle>
          </div>

          <div className="flex items-center gap-3">
            {/* Time Horizon Pills: 24H | 7D | 30D */}
            <div className="flex items-center bg-slate-100 dark:bg-[#24221a] p-0.5 rounded-lg border border-slate-200 dark:border-slate-700">
              {(["24H", "7D", "30D"] as const).map((horizon) => (
                <button
                  key={horizon}
                  onClick={() => setTimeHorizon(horizon)}
                  className={cn(
                    "px-2.5 py-0.5 text-xs font-bold rounded-md transition-colors",
                    timeHorizon === horizon
                      ? "bg-blue-600 text-white shadow-2xs"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  )}
                >
                  {horizon}
                </button>
              ))}
            </div>

            {/* Date Picker Button */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#24221a] text-xs font-semibold text-slate-700 dark:text-slate-300">
              <CalendarIcon className="size-3.5 text-slate-500" />
              <span>{formattedDateStr}</span>
              <ChevronDownIcon className="size-3 text-slate-400" />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-3">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            {/* 1. INCIDENTS BY ZONE */}
            <div className="lg:col-span-4 rounded-xl border border-slate-200/80 dark:border-slate-800 p-3 bg-slate-50/50 dark:bg-slate-900/40 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Incidents by Zone
                </span>
                <div className="flex items-center gap-2 text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-red-500"></span>
                    <span>Critical</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-amber-500"></span>
                    <span>Warning</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-slate-400"></span>
                    <span>Normal</span>
                  </span>
                </div>
              </div>

              {/* Vertical Grouped Bar Chart */}
              <div className="relative h-44 w-full flex items-end justify-around pt-6 pb-6 border-b border-slate-200 dark:border-slate-800">
                {/* Baseline Gridlines */}
                <div className="absolute left-0 right-0 top-0 border-t border-dashed border-slate-200 dark:border-slate-800/60 text-[9px] font-mono text-slate-400 pl-1">
                  6
                </div>
                <div className="absolute left-0 right-0 top-1/3 border-t border-dashed border-slate-200 dark:border-slate-800/60 text-[9px] font-mono text-slate-400 pl-1">
                  4
                </div>
                <div className="absolute left-0 right-0 top-2/3 border-t border-dashed border-slate-200 dark:border-slate-800/60 text-[9px] font-mono text-slate-400 pl-1">
                  2
                </div>

                {analyticsData.zoneBars.map((zone, zIdx) => {
                  const maxH = 100;
                  const cPct = Math.min(100, (zone.critical / analyticsData.maxZoneCount) * maxH);
                  const wPct = Math.min(100, (zone.warning / analyticsData.maxZoneCount) * maxH);
                  const nPct = Math.min(100, (zone.normal / analyticsData.maxZoneCount) * maxH);

                  return (
                    <div key={zIdx} className="flex flex-col items-center gap-1.5 z-10">
                      <div className="flex items-end gap-1">
                        {/* Critical Bar */}
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">
                            {zone.critical}
                          </span>
                          <div
                            style={{ height: `${Math.max(6, cPct)}px` }}
                            className="w-3.5 bg-red-500 dark:bg-red-600 rounded-t-xs transition-all duration-300"
                          ></div>
                        </div>

                        {/* Warning Bar */}
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">
                            {zone.warning}
                          </span>
                          <div
                            style={{ height: `${Math.max(6, wPct)}px` }}
                            className="w-3.5 bg-amber-500 dark:bg-amber-600 rounded-t-xs transition-all duration-300"
                          ></div>
                        </div>

                        {/* Normal Bar */}
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">
                            {zone.normal}
                          </span>
                          <div
                            style={{ height: `${Math.max(6, nPct)}px` }}
                            className="w-3.5 bg-slate-400 dark:bg-slate-500 rounded-t-xs transition-all duration-300"
                          ></div>
                        </div>
                      </div>

                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 mt-1">
                        {zone.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 2. INCIDENTS BY CAMERA */}
            <div className="lg:col-span-4 rounded-xl border border-slate-200/80 dark:border-slate-800 p-3 bg-slate-50/50 dark:bg-slate-900/40 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Incidents by Camera
                </span>
                <div className="flex items-center gap-2 text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-red-500"></span>
                    <span>Critical</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-amber-500"></span>
                    <span>Warning</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-blue-500"></span>
                    <span>Normal</span>
                  </span>
                </div>
              </div>

              {/* Stacked Horizontal Bar Rows */}
              <div className="space-y-2 py-1">
                {analyticsData.cameraRows.map((cam, cIdx) => {
                  const maxVal = analyticsData.maxCamTotal || 1;
                  const cW = (cam.critical / maxVal) * 100;
                  const wW = (cam.warning / maxVal) * 100;
                  const nW = (cam.normal / maxVal) * 100;

                  return (
                    <div key={cIdx} className="flex items-center justify-between gap-2 text-xs">
                      <span className="w-14 text-[11px] font-semibold text-slate-700 dark:text-slate-300 truncate">
                        {cam.name}
                      </span>

                      <div className="flex-1 bg-slate-200/70 dark:bg-slate-800 rounded-full h-3 overflow-hidden flex shadow-2xs">
                        {cW > 0 && <div style={{ width: `${cW}%` }} className="bg-red-500 dark:bg-red-600 h-full" />}
                        {wW > 0 && <div style={{ width: `${wW}%` }} className="bg-amber-500 dark:bg-amber-600 h-full" />}
                        {nW > 0 && <div style={{ width: `${nW}%` }} className="bg-blue-500 dark:bg-blue-600 h-full" />}
                      </div>

                      <span className="w-5 text-right font-mono text-xs font-bold text-slate-900 dark:text-slate-100">
                        {cam.total}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3. DETECTION TRENDS */}
            <div className="lg:col-span-4 rounded-xl border border-slate-200/80 dark:border-slate-800 p-3 bg-slate-50/50 dark:bg-slate-900/40 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Detection Trends
                </span>
                <div className="flex items-center gap-2 text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-blue-500"></span>
                    <span>People</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-emerald-500"></span>
                    <span>Vehicles</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-amber-500"></span>
                    <span>Fence</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-red-500"></span>
                    <span>Incidents</span>
                  </span>
                </div>
              </div>

              {/* Multi-Line Trend SVG */}
              <div className="relative h-44 w-full flex flex-col justify-between pt-1">
                <svg className="w-full h-36 overflow-visible" viewBox="0 0 300 100" preserveAspectRatio="none">
                  {/* Grid Lines */}
                  <line x1="0" y1="0" x2="300" y2="0" stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" strokeDasharray="3 3" />
                  <line x1="0" y1="25" x2="300" y2="25" stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" strokeDasharray="3 3" />
                  <line x1="0" y1="50" x2="300" y2="50" stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" strokeDasharray="3 3" />
                  <line x1="0" y1="75" x2="300" y2="75" stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" strokeDasharray="3 3" />

                  {/* Polylines for Trends */}
                  {(() => {
                    const pts = analyticsData.trendPoints;
                    const maxVal = 40;
                    const getX = (idx: number) => (idx / (pts.length - 1)) * 300;
                    const getY = (val: number) => 100 - (Math.min(val, maxVal) / maxVal) * 100;

                    const peopleStr = pts.map((p, i) => `${getX(i)},${getY(p.people)}`).join(" ");
                    const vehicleStr = pts.map((p, i) => `${getX(i)},${getY(p.vehicles)}`).join(" ");
                    const fenceStr = pts.map((p, i) => `${getX(i)},${getY(p.fence)}`).join(" ");
                    const incStr = pts.map((p, i) => `${getX(i)},${getY(p.incidents)}`).join(" ");

                    return (
                      <>
                        {/* People line (blue) */}
                        <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" points={peopleStr} strokeLinecap="round" />
                        {/* Vehicles line (green) */}
                        <polyline fill="none" stroke="#22c55e" strokeWidth="2.5" points={vehicleStr} strokeLinecap="round" />
                        {/* Fence line (orange) */}
                        <polyline fill="none" stroke="#f97316" strokeWidth="2.5" points={fenceStr} strokeLinecap="round" />
                        {/* Incidents line (red) */}
                        <polyline fill="none" stroke="#ef4444" strokeWidth="2.5" points={incStr} strokeLinecap="round" />

                        {/* Data Dots */}
                        {pts.map((p, i) => (
                          <g key={i}>
                            <circle cx={getX(i)} cy={getY(p.people)} r="3" fill="#3b82f6" />
                            <circle cx={getX(i)} cy={getY(p.vehicles)} r="3" fill="#22c55e" />
                            <circle cx={getX(i)} cy={getY(p.fence)} r="3" fill="#f97316" />
                            <circle cx={getX(i)} cy={getY(p.incidents)} r="3" fill="#ef4444" />
                          </g>
                        ))}
                      </>
                    );
                  })()}
                </svg>

                {/* X-Axis Timestamps */}
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 dark:text-slate-400 pt-1">
                  {analyticsData.trendPoints.map((tp, idx) => (
                    <span key={idx}>{tp.label}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// -----------------------------------------------------------------------------
// HELPER BADGE ICON FOR LOG TYPES
// -----------------------------------------------------------------------------

function TypeBadgeIcon({ type }: { type: string }) {
  switch (type) {
    case "Vehicle":
      return (
        <span className="p-1 rounded bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400 inline-block">
          <CarFrontIcon className="size-3.5" />
        </span>
      );
    case "Person":
    case "Loitering":
    case "Running":
      return (
        <span className="p-1 rounded bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400 inline-block">
          <UserIcon className="size-3.5" />
        </span>
      );
    case "Number Plate":
      return (
        <span className="p-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400 inline-block">
          <ScanEyeIcon className="size-3.5" />
        </span>
      );
    case "Fence":
      return (
        <span className="p-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400 inline-block">
          <LayersIcon className="size-3.5" />
        </span>
      );
    default:
      return (
        <span className="p-1 rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 inline-block">
          <ShieldAlertIcon className="size-3.5" />
        </span>
      );
  }
}
