import { useState } from "react";
import { TileLayer, WMSTileLayer, useMap } from "react-leaflet";
import { useEffect } from "react";
import { LayersIcon, WifiOffIcon } from "lucide-react";
import type { BasemapConfig } from "@/client/config";
import { cn } from "@/lib/utils";

/** Renders whichever imagery source is selected. */
export function BasemapLayer({ basemap }: { basemap: BasemapConfig }) {
  if (basemap.kind === "wms") {
    return (
      <WMSTileLayer
        key={basemap.id}
        url={basemap.url}
        attribution={basemap.attribution}
        layers={basemap.layers ?? ""}
        format={basemap.format ?? "image/png"}
        transparent={basemap.transparent ?? false}
      />
    );
  }
  if (basemap.kind === "xyz") {
    return (
      <TileLayer
        key={basemap.id}
        url={basemap.url}
        attribution={basemap.attribution}
        maxZoom={basemap.maxZoom}
        {...(basemap.subdomains ? { subdomains: basemap.subdomains } : {})}
      />
    );
  }
  return null;
}

/**
 * Imagery choice, wearing the app's own chrome.
 *
 * Leaflet ships a layer control that looks like a third-party widget bolted
 * on. In a console this is a first-class decision -- satellite for reading
 * ground, street for names and routes, nothing at all when the post is offline.
 */
export function BasemapSwitcher({
  basemaps,
  activeId,
  onChange,
  className,
}: {
  basemaps: BasemapConfig[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  if (basemaps.length < 2) return null;

  return (
    <div
      className={cn(
        "absolute right-2 top-2 z-[500] flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-sm",
        className,
      )}
      // The map must not pan when someone reaches for these.
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <LayersIcon className="mx-1 size-3.5 text-muted-foreground" />
      {basemaps.map((basemap) => (
        <button
          key={basemap.id}
          type="button"
          onClick={() => onChange(basemap.id)}
          className={cn(
            "rounded px-2 py-1 text-xs transition-colors",
            basemap.id === activeId
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {basemap.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Tiles are the one networked part of the map; watch them rather than assume
 * them. A post with a dead uplink should be told, not shown blank ground.
 */
export function useTileHealth() {
  const [ok, setOk] = useState(true);
  return { ok, setOk };
}

export function TileWatch({ onState }: { onState: (ok: boolean) => void }) {
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

export function OfflineNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute left-2 top-2 z-[500] flex items-center gap-2 rounded-md border border-amber-500/40 bg-background/95 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
      <WifiOffIcon className="size-3" />
      No imagery — geometry only
    </div>
  );
}
