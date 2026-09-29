/**
 * Module addresses, read from the repo-root `.env`.
 *
 * Every module in this system -- the media hub, the vision service, this node,
 * the console -- takes its addresses from that one file, so moving a module to
 * another machine is editing one line rather than hunting hardcoded loopback
 * addresses through four languages.
 *
 * Bun loads a `.env` next to the package it runs from, which would be
 * `backend/.env` and would mean a second copy to keep in sync. This reads the
 * root one instead, matching what vision-service/core/settings.py and
 * media/configure.py do. Real environment variables still win, so a one-off
 * override on the command line works everywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT_ENV = join(import.meta.dir, "..", "..", "..", ".env");

const fromFile: Record<string, string> = {};

if (existsSync(ROOT_ENV)) {
  for (const raw of readFileSync(ROOT_ENV, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fromFile[key] = value;
  }
}

export function env(key: string, fallback = ""): string {
  const live = process.env[key];
  if (live !== undefined && live !== "") return live;
  const stored = fromFile[key];
  return stored !== undefined && stored !== "" ? stored : fallback;
}

export const envInt = (key: string, fallback: number): number => {
  const parsed = Number(env(key, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Is this node running as a developer's box rather than a post?
 *
 * OFF UNLESS SOMEBODY TURNED IT ON, and off is the value a deployment gets by
 * saying nothing. A flag that defaults to "developer" is a flag that ships
 * enabled, and the thing it gates here is the one operation that empties the
 * tamper-evident event log.
 *
 * Read on every call rather than captured at import, so flipping it in `.env`
 * takes effect on the next request instead of the next restart -- and so a test
 * can turn it on for one case without leaking into the rest of the file.
 *
 * `IBVAP_DEBUG=1` in the repo-root `.env`.
 */
export const debugMode = (): boolean => {
  const raw = env("IBVAP_DEBUG", "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

/**
 * Where the console fetches video and live boxes.
 *
 * Deliberately addresses, never credentials. A real camera's RTSP URL carries
 * `user:pass@` and lives only in media/cameras.yml on the hub machine -- it is
 * not in this database and must never appear in an API response, because
 * `/api/config` is unauthenticated and every browser on the network reads it.
 *
 * The console reaches a camera's video at `${whepBase}/${cameraId}/whep`: the
 * hub path name is the camera id, which is what keeps a synthetic clip loop
 * and a real camera indistinguishable from up here.
 */
export function mediaConfig() {
  const mediaHost = env("IBVAP_MEDIA_HOST", "127.0.0.1");
  const whepPort = envInt("IBVAP_WHEP_PORT", 8889);
  const boxesHost = env("IBVAP_BOXES_HOST", "127.0.0.1");
  const boxesPort = envInt("IBVAP_BOXES_PORT", 8100);

  return {
    whepBase: `http://${mediaHost}:${whepPort}`,
    boxesUrl: `ws://${boxesHost}:${boxesPort}`,
  };
}
