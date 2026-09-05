/**
 * Everything client-specific lives here (#39).
 *
 * A file rather than environment variables, because adapting a deployment to
 * another force must be editing one file on their box -- not a rebuild. This
 * is the whole "one program, many configuration files" thesis, so nothing
 * force-specific may appear anywhere else in the source.
 */
import type { Severity } from "@/lib/types";

/**
 * Where basemap imagery comes from.
 *
 * Deliberately a config entry, not a hard-coded provider. OSM is the MVP
 * default because it needs no credential; ISRO's Bhuvan serves WMS over the
 * same interface, so moving to an Indian-hosted source is this object
 * changing, not a component changing. A provider needing a key carries it here
 * rather than in the source.
 *
 * `kind: "none"` is the honest posture for a post with no connectivity: the
 * map still draws the border, the fence and the camera coverage from local
 * geometry, and simply has no imagery underneath.
 */
export interface BasemapConfig {
  kind: "xyz" | "wms" | "none";
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains?: string;
  /** WMS only — e.g. Bhuvan's layer names. */
  layers?: string;
  format?: string;
  transparent?: boolean;
}

export interface ClientConfig {
  brand: { name: string; short: string; tagline?: string };
  /** Where the edge node is. Same origin by default. */
  apiBase: string;
  /** Section id -> enabled. Omitted means "use the registry default". */
  sections: Record<string, boolean>;
  defaults: {
    incidentSeverityFloor: Severity;
    /** Auto-refresh interval for screens with no live push of their own. */
    pollMs: number;
  };
  basemap: BasemapConfig;
}

export const FALLBACK_CONFIG: ClientConfig = {
  brand: { name: "IBVAP", short: "IB", tagline: "Border Video Analytics" },
  apiBase: "http://localhost:8000",
  sections: {},
  defaults: { incidentSeverityFloor: "INFO", pollMs: 15_000 },
  basemap: {
    kind: "xyz",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
    subdomains: "abc",
  },
};

/** Shallow-merge one level deep; a client file may specify only what it changes. */
export function mergeConfig(base: ClientConfig, patch: Partial<ClientConfig>): ClientConfig {
  return {
    brand: { ...base.brand, ...patch.brand },
    apiBase: patch.apiBase ?? base.apiBase,
    sections: { ...base.sections, ...patch.sections },
    defaults: { ...base.defaults, ...patch.defaults },
    basemap: { ...base.basemap, ...patch.basemap },
  };
}

/**
 * Served by the frontend's own Bun server from IBVAP_CLIENT_CONFIG.
 * A missing file is not an error -- it means "run the defaults".
 */
export async function loadClientConfig(): Promise<ClientConfig> {
  try {
    const response = await fetch("/client.json", { cache: "no-store" });
    if (!response.ok) return FALLBACK_CONFIG;
    return mergeConfig(FALLBACK_CONFIG, (await response.json()) as Partial<ClientConfig>);
  } catch {
    return FALLBACK_CONFIG;
  }
}
