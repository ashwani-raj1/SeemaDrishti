/**
 * Geographic BOP / sector options shown in the global header.
 *
 * These are operator-facing post names. They are not the same thing as a
 * monitoring zone (a fence line, a gate) stored by the edge node. The header
 * is the only place this choice is made; screens that need "the current post"
 * read it from client context rather than drawing a second selector.
 */

export interface ZoneOption {
  name: string;
  bop: string;
  sector: string;
  subtitle: string;
}

export const ALL_ZONES = "All Zones";

export const ZONE_OPTIONS: ZoneOption[] = [
  {
    name: "Attari",
    bop: "BOP Attari",
    sector: "IB Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
  {
    name: "Hussainiwala",
    bop: "BOP Hussainiwala",
    sector: "IB Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
  {
    name: "Uri",
    bop: "BOP Uri",
    sector: "LoC Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
  {
    name: "Poonch",
    bop: "BOP Poonch",
    sector: "LoC Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
  {
    name: "Rajouri",
    bop: "BOP Rajouri",
    sector: "LoC Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
  {
    name: "Abohar",
    bop: "BOP Abohar",
    sector: "IB Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
  {
    name: ALL_ZONES,
    bop: "All posts",
    sector: "IB Sector",
    subtitle: "Surveillance • Real-time Monitoring • Securing Borders",
  },
];

export const ZONE_STORAGE_KEY = "ibvap.zone";

/** Map a site name like "BOP Attari" onto a header option when possible. */
export function zoneFromSiteName(siteName: string | null | undefined): string {
  if (!siteName) return ZONE_OPTIONS[0]!.name;
  const lower = siteName.toLowerCase();
  const match = ZONE_OPTIONS.find(
    (zone) => zone.name !== ALL_ZONES && lower.includes(zone.name.toLowerCase()),
  );
  return match?.name ?? ZONE_OPTIONS[0]!.name;
}

export function zoneOption(name: string): ZoneOption {
  return ZONE_OPTIONS.find((zone) => zone.name === name) ?? ZONE_OPTIONS[0]!;
}

/**
 * Does this header selection mean "everything this node actually watches"?
 *
 * The node is one BOP. Selecting that BOP, or All Zones, is the same set of
 * cameras. Selecting a different BOP name must not invent cameras for it.
 */
export function zoneCoversSite(zoneName: string, siteName: string | null | undefined): boolean {
  if (zoneName === ALL_ZONES) return true;
  if (!siteName) return false;
  return siteName.toLowerCase().includes(zoneName.toLowerCase());
}

export function camerasInSelectedZone<T extends { id: string; name: string }>(
  cameras: T[],
  zoneName: string,
  siteName: string | null | undefined,
): T[] {
  if (zoneCoversSite(zoneName, siteName)) return cameras;
  const needle = zoneName.toLowerCase();
  const compact = needle.replace(/\s+/g, "_");
  return cameras.filter(
    (camera) =>
      camera.name.toLowerCase().includes(needle) ||
      camera.id.toLowerCase().includes(compact) ||
      camera.id.toLowerCase().includes(needle.replace(/\s+/g, "-")),
  );
}

/** `null` means every camera on this node; otherwise only these ids. */
export function scopedCameraIds(
  cameras: Array<{ id: string }>,
  zoneName: string,
  siteName: string | null | undefined,
): Set<string> | null {
  if (zoneCoversSite(zoneName, siteName)) return null;
  return new Set(cameras.map((camera) => camera.id));
}

export function cameraInScope(
  cameraId: string | null | undefined,
  scope: Set<string> | null,
): boolean {
  if (scope === null) return true;
  if (!cameraId) return false;
  return scope.has(cameraId);
}
