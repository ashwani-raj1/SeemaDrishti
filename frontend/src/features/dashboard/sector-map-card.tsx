import { useState, useEffect } from "react";
import { MapContainer, TileLayer, Polygon, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Incident, Camera } from "@/lib/types";

interface SectorMapCardProps {
  cameras: Camera[];
  incidents: Incident[];
  onSelectCamera?: (cameraId: string) => void;
  onSelectIncident?: (incidentId: string) => void;
  className?: string;
}

// Custom Leaflet Icons using DivIcon for custom HTML styling
function createCameraIcon(label: string, isSelected: boolean = false) {
  return L.divIcon({
    className: "custom-camera-marker",
    html: `
      <div style="
        display: flex;
        align-items: center;
        gap: 4px;
        background: ${isSelected ? "#1d4ed8" : "#2563eb"};
        color: white;
        padding: 3px 7px;
        border-radius: 9999px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        box-shadow: 0 3px 8px rgba(37, 99, 235, 0.4);
        border: 1.5px solid white;
        cursor: pointer;
        white-space: nowrap;
        transform: translate(-50%, -50%);
        transition: transform 0.15s ease;
      ">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
          <circle cx="12" cy="13" r="3"/>
        </svg>
        <span>${label}</span>
      </div>
    `,
    iconSize: [60, 24],
    iconAnchor: [30, 12],
  });
}

function createIncidentIcon() {
  return L.divIcon({
    className: "custom-incident-marker",
    html: `
      <div style="position: relative; width: 26px; height: 26px; transform: translate(-50%, -50%);">
        <div style="
          position: absolute;
          inset: -4px;
          border-radius: 9999px;
          background: rgba(239, 68, 68, 0.4);
          animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
        "></div>
        <div style="
          position: relative;
          width: 26px;
          height: 26px;
          background: #ef4444;
          color: white;
          border-radius: 9999px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: sans-serif;
          font-weight: 900;
          font-size: 14px;
          border: 2px solid white;
          box-shadow: 0 3px 8px rgba(239, 68, 68, 0.5);
          cursor: pointer;
        ">!</div>
      </div>
    `,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function createTextLabelIcon(text: string, subtext?: string, isPakistan?: boolean) {
  return L.divIcon({
    className: "custom-text-label",
    html: `
      <div style="
        transform: translate(-50%, -50%);
        text-align: center;
        pointer-events: none;
        user-select: none;
      ">
        <div style="
          color: ${isPakistan ? "rgba(255, 255, 255, 0.75)" : "#ffffff"};
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
          font-weight: 700;
          font-size: ${isPakistan ? "13px" : "12px"};
          letter-spacing: ${isPakistan ? "0.12em" : "0.04em"};
          text-shadow: 0 1px 3px rgba(0,0,0,0.85), 0 2px 8px rgba(0,0,0,0.6);
        ">${text}</div>
        ${subtext ? `<div style="color: rgba(255,255,255,0.7); font-size: 10px; font-weight: 500;">${subtext}</div>` : ""}
      </div>
    `,
    iconSize: [120, 30],
    iconAnchor: [60, 15],
  });
}

function MapController({ isFullscreen }: { isFullscreen: boolean }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
  }, [map, isFullscreen]);
  return null;
}

export function SectorMapCard({
  cameras,
  incidents,
  onSelectCamera,
  onSelectIncident,
  className,
}: SectorMapCardProps) {
  const [basemap, setBasemap] = useState<"satellite" | "street" | "terrain">("satellite");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Attari border coordinates
  const centerLat = 31.612;
  const centerLon = 74.577;

  // Sector Polygons matching Image 1 layout
  const sector2A: [number, number][] = [
    [31.636, 74.558],
    [31.638, 74.583],
    [31.621, 74.582],
    [31.619, 74.557],
  ];

  const sector2B: [number, number][] = [
    [31.619, 74.557],
    [31.621, 74.582],
    [31.604, 74.581],
    [31.602, 74.556],
  ];

  const sector2C: [number, number][] = [
    [31.602, 74.556],
    [31.604, 74.581],
    [31.587, 74.580],
    [31.585, 74.555],
  ];

  // International Border & Fence Line
  const borderFenceLine: [number, number][] = [
    [31.645, 74.584],
    [31.632, 74.583],
    [31.620, 74.582],
    [31.608, 74.581],
    [31.596, 74.580],
    [31.580, 74.579],
  ];

  // Sector boundaries line
  const sectorBoundaryLine: [number, number][] = [
    [31.645, 74.587],
    [31.632, 74.586],
    [31.620, 74.585],
    [31.608, 74.584],
    [31.596, 74.583],
    [31.580, 74.582],
  ];

  // Camera marker positions
  const cameraMarkers = [
    { id: "cam_fence_north", label: "CAM-01", name: "BOP-01 Fence North", pos: [31.628, 74.584] as [number, number] },
    { id: "cam_patrol_road", label: "CAM-05", name: "BOP-03 Patrol Road", pos: [31.608, 74.583] as [number, number] },
    { id: "cam_waterline", label: "CAM-07", name: "BOP-04 Waterline", pos: [31.588, 74.582] as [number, number] },
  ];

  // Incident marker position
  const incidentPos: [number, number] = [31.618, 74.5835];

  const basemapUrls = {
    satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    street: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    terrain: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden",
        isFullscreen ? "fixed inset-4 z-50 shadow-2xl" : "h-full",
        className
      )}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-slate-100 dark:border-slate-800/80 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm z-10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
            <MapIcon className="size-3.5" />
          </div>
          <div>
            <h2 className="text-xs font-bold tracking-tight text-slate-800 dark:text-slate-100 leading-tight">
              Sector Map
            </h2>
            <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400 leading-none">
              Punjab, Amritsar District
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Basemap Segmented Toggle */}
          <div className="flex items-center rounded-md bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">
            {(["satellite", "street", "terrain"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setBasemap(mode)}
                className={cn(
                  "px-2 py-0.5 rounded-sm capitalize transition-all text-[10px] font-semibold",
                  basemap === mode
                    ? "bg-blue-600 text-white shadow-xs"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                )}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Fullscreen Button */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="flex size-6 items-center justify-center rounded-sm border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
          </button>
        </div>
      </div>

      {/* Map Viewport */}
      <div className="relative flex-1 min-h-0 w-full bg-slate-950">
        <MapContainer
          center={[centerLat, centerLon]}
          zoom={13}
          scrollWheelZoom={true}
          className="size-full"
          zoomControl={true}
          attributionControl={false}
        >
          <MapController isFullscreen={isFullscreen} />

          <TileLayer
            attribution="&copy; Esri &mdash; Attari Border Sector"
            url={basemapUrls[basemap]}
            maxZoom={19}
          />

          {/* Sector 2A Polygon (Green) */}
          <Polygon
            positions={sector2A}
            pathOptions={{
              color: "#10b981",
              weight: 2,
              fillColor: "#10b981",
              fillOpacity: 0.28,
            }}
          />
          <Marker position={[31.628, 74.570]} icon={createTextLabelIcon("Sector 2A")} />

          {/* Sector 2B Polygon (Blue) */}
          <Polygon
            positions={sector2B}
            pathOptions={{
              color: "#3b82f6",
              weight: 2,
              fillColor: "#3b82f6",
              fillOpacity: 0.28,
            }}
          />
          <Marker position={[31.611, 74.569]} icon={createTextLabelIcon("Sector 2B")} />

          {/* Sector 2C Polygon (Yellow/Gold) */}
          <Polygon
            positions={sector2C}
            pathOptions={{
              color: "#f59e0b",
              weight: 2,
              fillColor: "#eab308",
              fillOpacity: 0.28,
            }}
          />
          <Marker position={[31.594, 74.568]} icon={createTextLabelIcon("Sector 2C")} />

          {/* Pakistan Territory Label */}
          <Marker
            position={[31.616, 74.595]}
            icon={createTextLabelIcon("PAKISTAN\nTERRITORY", undefined, true)}
          />

          {/* Border Fence (Red Dashed Line) */}
          <Polyline
            positions={borderFenceLine}
            pathOptions={{
              color: "#ef4444",
              weight: 3,
              dashArray: "6, 6",
            }}
          />

          {/* Sector Boundary (Yellow Dashed Line) */}
          <Polyline
            positions={sectorBoundaryLine}
            pathOptions={{
              color: "#facc15",
              weight: 2.5,
              dashArray: "4, 4",
            }}
          />

          {/* Camera Markers */}
          {cameraMarkers.map((cam) => (
            <Marker
              key={cam.id}
              position={cam.pos}
              icon={createCameraIcon(cam.label)}
              eventHandlers={{
                click: () => onSelectCamera?.(cam.id),
              }}
            >
              <Popup>
                <div className="p-1">
                  <div className="font-bold text-xs">{cam.label} &bull; {cam.name}</div>
                  <div className="text-[11px] text-emerald-600 font-medium mt-0.5">Status: Online (Full Coverage)</div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* Incident Marker */}
          <Marker
            position={incidentPos}
            icon={createIncidentIcon()}
            eventHandlers={{
              click: () => onSelectIncident?.("inc_active"),
            }}
          >
            <Popup>
              <div className="p-1">
                <div className="font-bold text-xs text-red-600">Active Incident: Person Detected</div>
                <div className="text-[11px] text-slate-600 mt-0.5">Fence North &bull; Sector 2A</div>
                <div className="text-[10px] text-slate-400 mt-1">Status: Open &bull; Severity: Critical</div>
              </div>
            </Popup>
          </Marker>
        </MapContainer>

        {/* Scale indicator (1 km) bottom left */}
        <div className="absolute bottom-2 left-3 z-[400] flex flex-col items-start pointer-events-none">
          <div className="h-0.5 w-12 bg-white shadow-xs border-x border-white mb-0.5"></div>
          <span className="text-[9px] font-bold text-white drop-shadow-md">1 km</span>
        </div>

        {/* Bottom Legend Overlay matching Image 1 */}
        <div className="absolute bottom-2 left-18 right-3 z-[400] flex items-center justify-around gap-1.5 rounded-md border border-white/30 bg-white/90 dark:bg-slate-900/90 dark:border-slate-800/80 px-2 py-1 backdrop-blur-md shadow-xs text-[10px] font-semibold text-slate-700 dark:text-slate-300 pointer-events-auto">
          <div className="flex items-center gap-1">
            <span className="flex size-3 items-center justify-center rounded-full bg-blue-600 text-white text-[7px]">
              &#9679;
            </span>
            <span>Camera</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="flex size-3 items-center justify-center rounded-full bg-red-500 text-white font-bold text-[8px]">
              !
            </span>
            <span>Incident</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="h-0.5 w-3 border-b-2 border-dashed border-red-500"></span>
            <span>Border Fence</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="h-0.5 w-3 border-b-2 border-dashed border-amber-400"></span>
            <span>Sector Boundary</span>
          </div>
        </div>
      </div>
    </div>
  );
}
