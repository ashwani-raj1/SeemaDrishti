/**
 * The sector, as ground rather than as a list.
 *
 * Imagery under locally-held geometry: the international boundary, the fence,
 * the patrol road, each zone, and each camera's actual coverage. Incidents are
 * plotted where they happened, so "which way did they go" and "what is not
 * being watched" become visible questions rather than inferred ones.
 *
 * Imagery is the only part that needs a network. If tiles cannot be fetched --
 * the normal state at a post with no uplink -- the geometry still draws and
 * the map says so, rather than showing blank ground and letting an operator
 * assume there is nothing there.
 */
import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, Popup, Tooltip, useMap } from "react-leaflet";
import type { LatLngBoundsExpression, LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useClient } from "@/client/context";
import {
  ATTARI_SECTOR, formatLatLon, fovPolygon, framePathToGround, gridRef,
  type GeoPoint, type SiteGeography,
} from "@/client/geography";
import type { Camera, Incident, Severity, Zone } from "@/lib/types";
import { clockTime, humanise, relative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BasemapLayer, BasemapSwitcher, OfflineNotice, TileWatch } from "./basemap";
import { SeverityBadge } from "./badges";

const ll = (point: GeoPoint): LatLngExpression => [point.lat, point.lon];
const path = (points: GeoPoint[]): LatLngExpression[] => points.map(ll);

const SEVERITY_COLOUR: Record<Severity, string> = {
  INFO: "#78716c",
  WARNING: "#f59e0b",
  CRITICAL: "#dc2626",
};

export interface MapTarget {
  kind: "incident" | "camera" | "zone";
  id: string;
}

function FitSector({ geo }: { geo: SiteGeography }) {
  const map = useMap();
  useEffect(() => {
    const bounds: LatLngBoundsExpression = [
      [geo.bounds.south, geo.bounds.west],
      [geo.bounds.north, geo.bounds.east],
    ];
    map.fitBounds(bounds, { padding: [16, 16] });
  }, [map, geo]);
  return null;
}

export function SectorMap({
  incidents,
  selectedId,
  onSelect,
  onOpen,
  geo = ATTARI_SECTOR,
  showZones = true,
  className,
}: {
  incidents: Incident[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Follow a marker through to its section. */
  onOpen?: (target: MapTarget) => void;
  geo?: SiteGeography;
  showZones?: boolean;
  className?: string;
}) {
  const { cameras, config } = useClient();
  const [basemapId, setBasemapId] = useState(config.basemaps[0]?.id ?? "none");
  const [tilesOk, setTilesOk] = useState(true);

  const basemap = config.basemaps.find((option) => option.id === basemapId) ?? config.basemaps[0];

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
      <MapContainer center={centre} zoom={13} scrollWheelZoom className="size-full bg-muted">
        <FitSector geo={geo} />
        <TileWatch onState={setTilesOk} />
        {basemap && <BasemapLayer basemap={basemap} />}

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
          pathOptions={{ color: "#e2e8f0", weight: 2, dashArray: "4 5", opacity: 0.85 }}
        >
          <Tooltip sticky>Patrol road</Tooltip>
        </Polyline>

        <Polyline
          positions={path(geo.highway.path)}
          pathOptions={{ color: "#cbd5e1", weight: 3, opacity: 0.55 }}
        >
          <Tooltip sticky>{geo.highway.name}</Tooltip>
        </Polyline>

        {/* Which ground is watched — and by omission, which is not. */}
        {cameras.map((camera) => {
          const placement = geo.cameras[camera.id];
          if (!placement) return null;
          const blind = camera.status === "DEAD" || camera.status === "RECORD_ONLY";
          return (
            <Polygon
              key={`fov-${camera.id}`}
              positions={path(fovPolygon(placement))}
              pathOptions={{
                color: blind ? "#dc2626" : "#0ea5e9",
                weight: 1,
                fillOpacity: blind ? 0.05 : 0.12,
                dashArray: blind ? "3 4" : undefined,
              }}
            />
          );
        })}

        {showZones &&
          cameras.flatMap((camera) => {
            const placement = geo.cameras[camera.id];
            if (!placement) return [];
            return camera.zones.map((zone) => {
              const ground = framePathToGround(zone.points, placement);
              const options = {
                color: SEVERITY_COLOUR[zone.severity],
                weight: 3,
                dashArray: "6 4",
                fillOpacity: 0.12,
              };
              const popup = (
                <Popup>
                  <ZonePopup zone={zone} camera={camera} onOpen={onOpen} />
                </Popup>
              );

              return zone.geometry === "polygon" ? (
                <Polygon key={zone.id} positions={path(ground)} pathOptions={options}>
                  {popup}
                </Polygon>
              ) : (
                <Polyline key={zone.id} positions={path(ground)} pathOptions={options}>
                  {popup}
                </Polyline>
              );
            });
          })}

        {cameras.map((camera) => {
          const placement = geo.cameras[camera.id];
          if (!placement) return null;
          return (
            <CircleMarker
              key={`cam-${camera.id}`}
              center={ll(placement.at)}
              radius={6}
              pathOptions={{ color: "#ffffff", fillColor: "#0ea5e9", fillOpacity: 1, weight: 2 }}
            >
              <Popup>
                <CameraPopup camera={camera} geo={geo} onOpen={onOpen} />
              </Popup>
            </CircleMarker>
          );
        })}

        {geo.landmarks.map((landmark) => (
          <CircleMarker
            key={landmark.name}
            center={ll(landmark.at)}
            radius={3}
            pathOptions={{ color: "#0f172a", fillColor: "#e2e8f0", fillOpacity: 1, weight: 1 }}
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
              radius={active ? 12 : 8}
              eventHandlers={onSelect ? { click: () => onSelect(incident.id) } : undefined}
              pathOptions={{
                color: active ? "#ffffff" : colour,
                fillColor: colour,
                fillOpacity: 0.9,
                weight: active ? 3 : 2,
              }}
            >
              <Popup>
                <IncidentPopup incident={incident} at={at} geo={geo} onOpen={onOpen} />
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {basemap && (
        <BasemapSwitcher basemaps={config.basemaps} activeId={basemapId} onChange={setBasemapId} />
      )}
      <OfflineNotice show={(basemap?.kind ?? "none") !== "none" && !tilesOk} />

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

// ------------------------------------------------------------------ popups

function PopupAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 w-full rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
    >
      {label}
    </button>
  );
}

function IncidentPopup({
  incident,
  at,
  geo,
  onOpen,
}: {
  incident: Incident;
  at: GeoPoint;
  geo: SiteGeography;
  onOpen?: (target: MapTarget) => void;
}) {
  return (
    <div className="flex min-w-52 flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-2">
        <SeverityBadge severity={incident.severity} />
        <span className="font-mono text-muted-foreground">grid {gridRef(at, geo)}</span>
      </div>
      <span className="text-sm font-medium leading-snug">{incident.title}</span>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
        <dt>Status</dt>
        <dd>{incident.status}</dd>
        <dt>Events</dt>
        <dd>{incident.eventCount}</dd>
        <dt>Last seen</dt>
        <dd>{clockTime(incident.lastEventAt)}</dd>
        <dt>Age</dt>
        <dd>{relative(incident.lastEventAt)}</dd>
      </dl>
      <span className="font-mono text-[10px] text-muted-foreground">{formatLatLon(at)}</span>
      {onOpen && (
        <PopupAction
          label="Open incident"
          onClick={() => onOpen({ kind: "incident", id: incident.id })}
        />
      )}
    </div>
  );
}

function CameraPopup({
  camera,
  geo,
  onOpen,
}: {
  camera: Camera;
  geo: SiteGeography;
  onOpen?: (target: MapTarget) => void;
}) {
  const placement = geo.cameras[camera.id]!;
  return (
    <div className="flex min-w-52 flex-col gap-1.5 text-xs">
      <span className="text-sm font-medium">{camera.name}</span>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
        <dt>State</dt>
        <dd>{camera.status.replace(/_/g, " ")}</dd>
        <dt>Bearing</dt>
        <dd>{placement.bearing}°</dd>
        <dt>Field of view</dt>
        <dd>{placement.fovDeg}°</dd>
        <dt>Range</dt>
        <dd>{placement.rangeM} m</dd>
        <dt>Grid</dt>
        <dd>{gridRef(placement.at, geo)}</dd>
      </dl>
      <div className="flex flex-wrap gap-1">
        {camera.zones.map((zone) => (
          <span key={zone.id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            {zone.name}
          </span>
        ))}
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">
        {formatLatLon(placement.at)}
      </span>
      {onOpen && (
        <PopupAction label="Open feed" onClick={() => onOpen({ kind: "camera", id: camera.id })} />
      )}
    </div>
  );
}

function ZonePopup({
  zone,
  camera,
  onOpen,
}: {
  zone: Zone;
  camera: Camera;
  onOpen?: (target: MapTarget) => void;
}) {
  return (
    <div className="flex min-w-52 flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-2">
        <SeverityBadge severity={zone.severity} />
        <span className="font-mono text-muted-foreground">{humanise(zone.kind)}</span>
      </div>
      <span className="text-sm font-medium">{zone.name}</span>
      <span className="text-muted-foreground">{camera.name}</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
        <dt>Alert on</dt>
        <dd className="text-foreground">{zone.watchClasses.join(", ") || "—"}</dd>
        <dt>Logged</dt>
        <dd>{zone.logOnlyClasses.join(", ") || "—"}</dd>
        <dt>Direction</dt>
        <dd>{zone.direction}</dd>
        <dt>Hold</dt>
        <dd>{zone.confirmSeconds}s</dd>
      </dl>
      {onOpen && (
        <PopupAction label="Edit zone" onClick={() => onOpen({ kind: "zone", id: zone.id })} />
      )}
    </div>
  );
}
