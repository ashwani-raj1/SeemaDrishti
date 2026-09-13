import { env, envInt, mediaConfig } from "../core/env";
import { listCameras } from "../l3/cameras";
import { DEFAULT_SITE } from "../db/seed";
import { handled, json } from "../http";

/**
 * What the media hub is actually serving, right now.
 *
 * WHY THE NODE PROXIES THIS INSTEAD OF THE BROWSER CALLING MediaMTX DIRECTLY --
 * two reasons, and the second is the one that matters:
 *
 *   1. MediaMTX's control API answers 200 with NO Access-Control-Allow-Origin
 *      header, so a fetch from the console's origin is blocked. Measured, not
 *      assumed.
 *   2. That API is the hub's full control surface. It exposes source
 *      configuration, and a real camera's path carries `user:pass@` in its
 *      RTSP URL. Handing the browser a direct line to it would put camera
 *      credentials one fetch away from every machine on the network -- the
 *      exact thing core/env.ts refuses to do in `mediaConfig()`.
 *
 * So the node reads it, keeps the parts a console needs, and drops the rest.
 * Nothing here returns a source URL.
 *
 * THE JOIN IS THE POINT. A camera can be in the hub but not seeded in this
 * database, or seeded here but absent from the hub. Both are real states with
 * different fixes, and a console that silently showed only the intersection
 * would hide a typo in cameras.yml as "camera missing" with no clue why.
 */

interface MediaMtxTrack {
  codec?: string;
  codecProps?: { width?: number; height?: number };
}

interface MediaMtxPath {
  name: string;
  ready?: boolean;
  readyTime?: string | null;
  tracks?: string[];
  tracks2?: MediaMtxTrack[];
  readers?: unknown[];
  bytesReceived?: number;
}

export interface HubCamera {
  id: string;
  name: string;
  /** Serving frames right now, per the hub itself. */
  ready: boolean;
  /** Since when, so a console can say "up for 4 minutes" rather than "up". */
  readySince: string | null;
  /** How many things are pulling this path. Zero is normal and not a fault. */
  readers: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  /** Where the browser plays it. Addresses only, never credentials. */
  whepUrl: string;
  /** True when this path also exists as a camera row in the node's database. */
  seeded: boolean;
  /** The node's observed blindness ladder, when it knows this camera. */
  status: string | null;
  /** False when a person took the feed out of service. */
  enabled: boolean | null;
}

const apiBase = () =>
  `http://${env("IBVAP_MEDIA_HOST", "127.0.0.1")}:${envInt("IBVAP_MEDIA_API_PORT", 9997)}`;

async function hubPaths(): Promise<{ paths: MediaMtxPath[]; error: string | null }> {
  try {
    // Short timeout on purpose: this endpoint sits behind a screen an operator
    // is waiting on, and a hub that is down should say so in a second rather
    // than hang the page for the OS-default connect timeout.
    const response = await fetch(`${apiBase()}/v3/paths/list`, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { paths: [], error: `media hub returned ${response.status}` };
    const body = (await response.json()) as { items?: MediaMtxPath[] };
    return { paths: body.items ?? [], error: null };
  } catch (error) {
    // Not a 500. A dead hub is a fact the console must be able to draw, not an
    // error that blanks the page -- the seeded cameras are still worth listing,
    // marked unavailable, because that is what tells an operator the cameras
    // exist and the hub is what broke.
    return { paths: [], error: (error as Error).message || "media hub unreachable" };
  }
}

export const mediaRoutes = {
  "/api/media/cameras": handled(async () => {
    const { paths, error } = await hubPaths();
    const { whepBase } = mediaConfig();
    const seeded = listCameras(DEFAULT_SITE);
    const seenInHub = new Set<string>();

    const cameras: HubCamera[] = paths.map((path) => {
      seenInHub.add(path.name);
      const row = seeded.find((camera) => camera.id === path.name);
      const track = path.tracks2?.[0];
      return {
        id: path.name,
        name: row?.name ?? path.name,
        ready: path.ready === true,
        readySince: path.readyTime ?? null,
        readers: Array.isArray(path.readers) ? path.readers.length : 0,
        width: track?.codecProps?.width ?? null,
        height: track?.codecProps?.height ?? null,
        // tracks2 carries structured codec props; `tracks` is the plain list.
        // Fall back so a hub build that only fills one still shows something.
        codec: track?.codec ?? path.tracks?.[0] ?? null,
        whepUrl: `${whepBase}/${path.name}/whep`,
        seeded: Boolean(row),
        status: row?.status ?? null,
        enabled: row ? row.enabled : null,
      };
    });

    // Seeded cameras the hub is not serving. Listed, not hidden: this is what
    // "the node expects a feed that is not arriving" looks like, and it is a
    // different problem from a path the hub has that nobody seeded.
    for (const row of seeded) {
      if (seenInHub.has(row.id)) continue;
      cameras.push({
        id: row.id,
        name: row.name,
        ready: false,
        readySince: null,
        readers: 0,
        width: null,
        height: null,
        codec: null,
        whepUrl: `${whepBase}/${row.id}/whep`,
        seeded: true,
        status: row.status,
        enabled: row.enabled,
      });
    }

    cameras.sort((a, b) => a.name.localeCompare(b.name));

    return json({
      hub: { url: apiBase(), reachable: error === null, error },
      cameras,
    });
  }),
};
