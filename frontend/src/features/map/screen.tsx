import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { PageShell } from "@/components/ibvap/page-shell";
import { SectorMap, type MapTarget } from "@/components/ibvap/sector-map";
import { ErrorState, LoadingRows } from "@/components/ibvap/states";
import { useClient } from "@/client/context";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { ATTARI_SECTOR } from "@/client/geography";

/**
 * The whole sector on one screen.
 *
 * The incident queue answers "what needs a decision". This answers "what does
 * the ground look like" -- where the posts are, which fields each camera
 * actually covers, and where tonight's incidents sit relative to the fence.
 * Every marker follows through to the section that owns it, so the map is a
 * way into the console rather than a picture of it.
 */
export function SectorMapScreen() {
  const { cameras } = useClient();
  const navigate = useNavigate();
  const [showClosed, setShowClosed] = useState(false);
  const [showZones, setShowZones] = useState(true);

  const { data, error, loading, reload } = useResource(() => api.incidents({ limit: 200 }), []);

  const incidents = (data ?? []).filter(
    (incident) => showClosed || incident.status === "OPEN" || incident.status === "ACKNOWLEDGED",
  );

  /**
   * Following a marker through to the thing it stands for.
   *
   * Every target has its own address, so what you are looking at can be sent
   * to somebody else. The browser's back button returns you to the map.
   */
  const open = (target: MapTarget) => {
    if (target.kind === "incident") navigate(`/incidents/${target.id}`);
    if (target.kind === "camera") navigate(`/cameras/${target.id}`);
    if (target.kind === "zone") navigate(`/zones?zone=${target.id}`);
  };

  const blind = cameras.filter((camera) => camera.status !== "FULL").length;

  return (
    <PageShell
      title="Sector map"
      description="Posts, coverage and tonight's incidents on the ground they happened on."
      actions={
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="map-zones" checked={showZones} onCheckedChange={setShowZones} />
            <Label htmlFor="map-zones" className="text-xs text-muted-foreground">
              Zones
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="map-closed" checked={showClosed} onCheckedChange={setShowClosed} />
            <Label htmlFor="map-closed" className="text-xs text-muted-foreground">
              Closed
            </Label>
          </div>
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {incidents.length} plotted
          </Badge>
          <Badge variant="outline" className="font-mono">
            {cameras.length} cameras
          </Badge>
          {blind > 0 && (
            <Badge
              variant="outline"
              className="border-destructive/40 bg-destructive/10 font-mono text-destructive"
            >
              {blind} below full
            </Badge>
          )}
          <Legend />
        </div>
      }
    >
      {loading && <LoadingRows rows={3} />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {!loading && !error && (
        <SectorMap
          incidents={incidents}
          onOpen={open}
          showZones={showZones}
          geo={ATTARI_SECTOR}
          className="h-[calc(100vh-13rem)] min-h-[420px]"
        />
      )}
    </PageShell>
  );
}

function Legend() {
  const items = [
    { colour: "#dc2626", label: "Boundary", dashed: true },
    { colour: "#f59e0b", label: "Fence" },
    { colour: "#e2e8f0", label: "Patrol road", dashed: true },
    { colour: "#0ea5e9", label: "Camera coverage" },
  ];

  return (
    <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0 w-5 border-t-2"
            style={{
              borderColor: item.colour,
              borderTopStyle: item.dashed ? "dashed" : "solid",
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
