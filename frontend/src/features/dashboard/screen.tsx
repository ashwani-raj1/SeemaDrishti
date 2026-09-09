import { useState, useEffect } from "react";
import { SectorMapCard } from "./sector-map-card";
import { LiveCamerasCard } from "./live-cameras-card";
import { RecentAlertsCard } from "./recent-alerts-card";
import { DetectionFilterBar, type DetectionCategory } from "./detection-filter-bar";
import { RecentEventsCarousel } from "./recent-events-carousel";
import { useClient } from "@/client/context";
import { useResource } from "@/lib/use-resource";
import { api } from "@/lib/api";
import { onStream } from "@/lib/stream";
import type { Incident, IbvapEvent } from "@/lib/types";

export function DashboardScreen() {
  const { cameras, media } = useClient();
  const [selectedCategory, setSelectedCategory] = useState<DetectionCategory>("all");
  const [timeRange, setTimeRange] = useState("Last 24 Hours");
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);

  // Fetch real incidents from backend
  const { data: initialIncidents, reload } = useResource(
    () => api.incidents({ limit: 50 }),
    []
  );

  const [liveIncidents, setLiveIncidents] = useState<Incident[]>([]);

  useEffect(() => {
    if (initialIncidents) {
      setLiveIncidents(initialIncidents);
    }
  }, [initialIncidents]);

  // Subscribe to real-time SSE stream for incidents
  useEffect(() => {
    return onStream("incident", (data) => {
      const inc = data as Incident;
      setLiveIncidents((curr) => {
        const idx = curr.findIndex((i) => i.id === inc.id);
        if (idx >= 0) {
          const updated = [...curr];
          updated[idx] = inc;
          return updated;
        }
        return [inc, ...curr];
      });
    });
  }, []);

  return (
    <div className="h-full flex flex-col justify-between gap-2 p-2.5 sm:p-3 bg-slate-50/60 dark:bg-slate-950/40 overflow-hidden">
      {/* Upper Grid: Sector Map (5 cols), Live Cameras (4 cols), Recent Alerts (3 cols) */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-stretch overflow-hidden">
        {/* Column 1: Sector Map */}
        <div className="lg:col-span-5 h-full min-h-0">
          <SectorMapCard
            cameras={cameras}
            incidents={liveIncidents}
            onSelectCamera={(id) => setSelectedCameraId(id)}
            onSelectIncident={(id) => console.log("Incident selected:", id)}
          />
        </div>

        {/* Column 2: Live Cameras */}
        <div className="lg:col-span-4 h-full min-h-0">
          <LiveCamerasCard
            cameras={cameras}
            selectedCameraId={selectedCameraId}
            onSelectCamera={(id) => setSelectedCameraId(id)}
            whepBase={media?.whepBase}
          />
        </div>

        {/* Column 3: Recent Alerts */}
        <div className="lg:col-span-3 h-full min-h-0">
          <RecentAlertsCard liveIncidents={liveIncidents} />
        </div>
      </div>

      {/* Filter Bar: Show Detections */}
      <div className="shrink-0">
        <DetectionFilterBar
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          timeRange={timeRange}
          onSelectTimeRange={setTimeRange}
        />
      </div>

      {/* Lower Row: Recent Events Filmstrip Carousel */}
      <div className="shrink-0">
        <RecentEventsCarousel categoryFilter={selectedCategory} />
      </div>
    </div>
  );
}
