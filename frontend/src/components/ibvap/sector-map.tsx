/**
 * The sector, as ground rather than as a list.
 *
 * A basemap under locally-held geometry: the international boundary, the
 * fence, the patrol road and each camera's actual coverage. Incidents are
 * plotted where they happened, so "which way did they go" and "what is not
 * being watched" become visible questions rather than inferred ones.
 *
 * The imagery is the only part that needs a network. If tiles cannot be
 * fetched -- which is the normal state at a post with no connectivity -- the
 * geometry still draws and the map says so, rather than showing blank grey and
 * letting the operator assume nothing is there.
 */
import { useEffect, useMemo, useState } from "react";
import {
  CircleMarker, MapContainer, Polygon, Polyline, TileLayer, Tooltip, useMap, WMSTileLayer,
} from "react-leaflet";
import type { LatLngExpression, LatLngBoundsExpression } from "leaflet";
import { WifiOffIcon } from "lucide-react";
import "leaflet/dist/leaflet.css";
import { useClient } from "@/client/context";
import {
  ATTARI_SECTOR, fovPolygon, formatLatLon, gridRef, type GeoPoint, type SiteGeography,
} from "@/client/geography";
import type { Incident, Severity } from "@/lib/types";
import { clockTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const ll = (point: GeoPoint): LatLngExpression => [point.lat, point.lon];
const path = (points: GeoPoint[]): LatLngExpression[] => points.map(ll);

/** Matches the severity badges, so the map and the list agree at a glance. */
const SEVERITY_COLOUR: Record<Severity, string> = {
  INFO: "#78716c",
  WARNING: "#f59e0b",
  CRITICAL: "#dc2626",
};

function FitSector({ geo }: { geo: SiteGeography }) {
  const map = useMap();
  useEffect(() => {
    const bounds: LatLngBoundsExpression = [
      [geo.bounds.south, geo.bounds.west],
      [geo.bounds.north, geo.bounds.east],
    ];
    map.fitBounds(bounds, { padding: [12, 12] });
  }, [map, geo]);
  return null;
}

/** Tiles are the one networked part; watch them rather than assume them. */
function TileWatch({ onState }: { onState: (ok: boolean) => void }) {
  const map = useMap();
  useEffect(() => {
    let failures = 0;
    const onError = () => {
      failures += 1;
      if (failures >= 3) onState(false);
    };
    const onLoad = () => {
      failures = 0;
      onState(true);
    };
    map.on("tileerror" as never, onError);
    map.on("tileload" as never, onLoad);
    return () => {
      map.off("tileerror" as never, onError);
      map.off("tileload" as never, onLoad);
    };
  }, [map, onState]);
  return null;
}

export function SectorMap({
  incidents,
  selectedId,
  onSelect,
  geo = ATTARI_SECTOR,
  className,
}: {
  incidents: Incident[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  geo?: SiteGeography;
  className?: string;
}) {
  const { cameras, config } = useClient();
  const [tilesOk, setTilesOk] = useState(true);
  const basemap = config.basemap;

  const centre: LatLngExpression = [
    (geo.bounds.north + geo.bounds.south) / 2,
    (geo.bounds.east + geo.bounds.west) / 2,
  ];

  /** Incidents carry a camera, and a camera is placed — that is the fix. */
  const plotted = useMemo(
    () =>
      incidents.flatMap((incident) => {
        const placement = incident.cameraId ? geo.cameras[incident.cameraId] : undefined;
        return placement ? [{ incident, at: placement.at }] : [];
      }),
    [incidents, geo],
  );

  const unplaced = incidents.length - plotted.length;

  return (
    <div className={cn("relative overflow-hidden rounded-md border", className)}>
      <MapContainer
        center={centre}
        zoom={13}
        scrollWheelZoom={false}
        className="size-full bg-muted"
        attributionControl
      >
        <FitSector geo={geo} />
        <TileWatch onState={setTilesOk} />

        {basemap.kind === "xyz" && (
          <TileLayer
            url={basemap.url}
            attribution={basemap.attribution}
            maxZoom={basemap.maxZoom}
            {...(basemap.subdomains ? { subdomains: basemap.subdomains } : {})}
          />
        )}
        {basemap.kind === "wms" && (
          <WMSTileLayer
            url={basemap.url}
            attribution={basemap.attribution}
            layers={basemap.layers ?? ""}
            format={basemap.format ?? "image/png"}
            transparent={basemap.transparent ?? false}
          />
        )}

        {/* The international boundary. Heavy, and drawn first so nothing hides it. */}
        <Polyline
          positions={path(geo.border)}
          pathOptions={{ color: "#dc2626", weight: 3, dashArray: "10 6", opacity: 0.95 }}
        >
          <Tooltip sticky>International boundary</Tooltip>
        </Polyline>

        <Polyline
          positions={path(geo.fence)}
          pathOptions={{ color: "#f59e0b", weight: 2.5, opacity: 0.95 }}
        >
          <Tooltip sticky>Fence line</Tooltip>
        </Polyline>

        <Polyline
          positions={path(geo.patrolRoad)}
          pathOptions={{ color: "#94a3b8", weight: 2, dashArray: "4 5", opacity: 0.9 }}
        >
          <Tooltip sticky>Patrol road</Tooltip>
        </Polyline>

        <Polyline
          positions={path(geo.highway.path)}
          pathOptions={{ color: "#64748b", weight: 3, opacity: 0.6 }}
        >
          <Tooltip sticky>{geo.highway.name}</Tooltip>
        </Polyline>

        {/* Which ground is actually watched — and by omission, which is not. */}
        {cameras.map((camera) => {
          const placement = geo.cameras[camera.id];
          if (!placement) return null;
          const dead = camera.status === "DEAD" || camera.status === "RECORD_ONLY";

          return (
            <Polygon
              key={`fov-${camera.id}`}
              positions={path(fovPolygon(placement))}
              pathOptions={{
                color: dead ? "#dc2626" : "#0ea5e9",
                weight: 1,
                fillOpacity: dead ? 0.05 : 0.14,
                dashArray: dead ? "3 4" : undefined,
              }}
            >
              <Tooltip sticky>
                {camera.name} — {camera.status} · {placement.rangeM} m · {placement.fovDeg}° ·
                bearing {placement.bearing}°
              </Tooltip>
            </Polygon>
          );
        })}

        {cameras.map((camera) => {
          const placement = geo.cameras[camera.id];
          if (!placement) return null;
          return (
            <CircleMarker
              key={`cam-${camera.id}`}
              center={ll(placement.at)}
              radius={5}
              pathOptions={{ color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 1, weight: 2 }}
            >
              <Tooltip>
                <span className="font-medium">{camera.name}</span>
                <br />
                {formatLatLon(placement.at)} · grid {gridRef(placement.at, geo)}
              </Tooltip>
            </CircleMarker>
          );
        })}

        {geo.landmarks.map((landmark) => (
          <CircleMarker
            key={landmark.name}
            center={ll(landmark.at)}
            radius={3}
            pathOptions={{ color: "#475569", fillColor: "#cbd5e1", fillOpacity: 1, weight: 1 }}
          >
            <Tooltip permanent direction="right" className="ibvap-label">
              {landmark.name}
            </Tooltip>
          </CircleMarker>
        ))}

        {plotted.map(({ incident, at }) => {
          const colour = SEVERITY_COLOUR[incident.severity];
          const active = incident.id === selectedId;
          return (
            <CircleMarker
              key={incident.id}
              center={ll(at)}
              radius={active ? 11 : 7}
              eventHandlers={onSelect ? { click: () => onSelect(incident.id) } : undefined}
              pathOptions={{
                color: active ? "#ffffff" : colour,
                fillColor: colour,
                fillOpacity: 0.85,
                weight: active ? 3 : 1.5,
              }}
            >
              <Tooltip>
                <span className="font-medium">{incident.title}</span>
                <br />
                {incident.severity} · {incident.status} · grid {gridRef(at, geo)}
                <br />
                {clockTime(incident.lastEventAt)}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {basemap.kind !== "none" && !tilesOk && (
        <div className="pointer-events-none absolute left-2 top-2 z-[500] flex items-center gap-2 rounded-md border border-amber-500/40 bg-background/95 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          <WifiOffIcon className="size-3" />
          No basemap imagery — geometry only
        </div>
      )}

      <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded-md border bg-background/90 px-2 py-1 font-mono text-[10px] leading-tight text-muted-foreground">
        <div>
          {geo.label} · {geo.region}
        </div>
        <div>
          {geo.datum} · {incidents.length} incidents
          {unplaced > 0 && ` · ${unplaced} unplaced`}
        </div>
      </div>
    </div>
  );
}
