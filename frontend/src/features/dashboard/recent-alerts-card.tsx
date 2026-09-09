import { Link, useNavigate } from "react-router-dom";
import {
  BellIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  ChevronRightIcon,
  ArrowRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Incident } from "@/lib/types";

interface AlertItem {
  id: string;
  title: string;
  camera: string;
  zone: string;
  time: string;
  severity: "Critical" | "High" | "Medium";
}

interface RecentAlertsCardProps {
  liveIncidents?: Incident[];
  className?: string;
}

const DEFAULT_ALERTS: AlertItem[] = [
  {
    id: "alt-1",
    title: "Person detected",
    camera: "CAM-01",
    zone: "Fence North · Sector 2A",
    time: "22:30:34",
    severity: "Critical",
  },
  {
    id: "alt-2",
    title: "Vehicle detected",
    camera: "CAM-05",
    zone: "Patrol Road · Sector 2C",
    time: "22:28:17",
    severity: "High",
  },
  {
    id: "alt-3",
    title: "Loitering detected",
    camera: "CAM-02",
    zone: "Near Fence · Sector 2B",
    time: "22:24:03",
    severity: "Medium",
  },
  {
    id: "alt-4",
    title: "Fence crossing",
    camera: "CAM-03",
    zone: "Fence Line · Sector 2A",
    time: "22:21:09",
    severity: "Critical",
  },
  {
    id: "alt-5",
    title: "Crawling detected",
    camera: "CAM-03",
    zone: "Outer Perimeter · Sector 2C",
    time: "22:19:45",
    severity: "High",
  },
  {
    id: "alt-6",
    title: "Object detected",
    camera: "CAM-07",
    zone: "River Bank · Sector 2C",
    time: "22:17:31",
    severity: "Medium",
  },
  {
    id: "alt-7",
    title: "Multiple people",
    camera: "CAM-02",
    zone: "Inner Perimeter · Sector 2A",
    time: "22:16:12",
    severity: "Critical",
  },
  {
    id: "alt-8",
    title: "Vehicle detected",
    camera: "CAM-05",
    zone: "Patrol Road · Sector 2C",
    time: "22:14:28",
    severity: "High",
  },
];

export function RecentAlertsCard({ liveIncidents = [], className }: RecentAlertsCardProps) {
  const navigate = useNavigate();

  // Map any live incidents from backend to alert format
  const dynamicAlerts: AlertItem[] = liveIncidents.map((inc) => {
    let sev: "Critical" | "High" | "Medium" = "Medium";
    if (inc.severity === "CRITICAL") sev = "Critical";
    else if (inc.severity === "WARNING") sev = "High";

    const date = new Date(inc.lastEventAt || inc.openedAt);
    const splitTime = date.toTimeString().split(" ")[0];
    const timeStr: string = !isNaN(date.getTime()) && splitTime ? splitTime : "22:30:00";

    return {
      id: inc.id,
      title: inc.title || "Person detected",
      camera: inc.cameraId ? inc.cameraId.replace("cam_", "CAM-").toUpperCase() : "CAM-01",
      zone: inc.zoneId ? inc.zoneId.replace("zone_", "").replace(/_/g, " ") : "Fence line north",
      time: timeStr,
      severity: sev,
    };
  });

  // Combine dynamic incidents with defaults
  const alerts = [...dynamicAlerts, ...DEFAULT_ALERTS].slice(0, 10);

  const getSeverityBadge = (severity: AlertItem["severity"]) => {
    switch (severity) {
      case "Critical":
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400">
            Critical
          </span>
        );
      case "High":
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-400">
            High
          </span>
        );
      case "Medium":
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
            Medium
          </span>
        );
    }
  };

  const getSeverityIcon = (severity: AlertItem["severity"]) => {
    switch (severity) {
      case "Critical":
        return (
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white shadow-xs">
            <span className="font-black text-[11px] leading-none">!</span>
          </div>
        );
      case "High":
        return (
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white shadow-xs">
            <AlertTriangleIcon className="size-3" />
          </div>
        );
      case "Medium":
        return (
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white shadow-xs">
            <AlertCircleIcon className="size-3" />
          </div>
        );
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden h-full",
        className
      )}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-slate-100 dark:border-slate-800/80 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-lg bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400">
            <BellIcon className="size-3.5" />
          </div>
          <div>
            <h2 className="text-xs font-bold tracking-tight text-slate-800 dark:text-slate-100 leading-tight">
              Recent Alerts
            </h2>
          </div>
        </div>

        <Link
          to="/incidents"
          className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 transition-colors"
        >
          <span>View All</span>
          <ArrowRightIcon className="size-3" />
        </Link>
      </div>

      {/* Alerts Scroll List */}
      <div className="flex-1 min-h-0 divide-y divide-slate-100 dark:divide-slate-800/70 overflow-y-auto">
        {alerts.map((alert) => (
          <div
            key={alert.id}
            onClick={() => {
              if (alert.id.startsWith("inc_")) {
                navigate(`/incidents/${alert.id}`);
              } else {
                navigate("/incidents");
              }
            }}
            className="flex items-center justify-between px-3 py-1.5 hover:bg-slate-50/80 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group"
          >
            <div className="flex items-start gap-2.5 min-w-0 pr-2">
              <div className="mt-0.5">{getSeverityIcon(alert.severity)}</div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  {alert.title}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">{alert.camera}</span>
                  <span className="mx-1">&bull;</span>
                  <span>{alert.zone}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="flex flex-col items-end">
                <span className="font-mono text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {alert.time}
                </span>
                <div className="mt-0.5">{getSeverityBadge(alert.severity)}</div>
              </div>
              <ChevronRightIcon className="size-4 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200 transition-colors" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
