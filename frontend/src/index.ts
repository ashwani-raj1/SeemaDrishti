/**
 * The frontend's own server. Serves the operator screen and this deployment's
 * configuration file -- nothing else. All data comes from the edge node.
 */
import { serve } from "bun";
import { join, resolve } from "node:path";
import index from "./index.html";

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Per-client deployment knob (#39): point this at the force's own file and the
 * same image becomes their console. No rebuild, no fork.
 */
const CONFIG_PATH = process.env.IBVAP_CLIENT_CONFIG ?? "./client.json";
const MEDIA_DIR = resolve(process.env.IBVAP_PLAYBACK_MEDIA_DIR ?? join(import.meta.dir, "..", "..", "media"));
const PLAYBACK_MANIFEST = process.env.IBVAP_PLAYBACK_MANIFEST ?? join(MEDIA_DIR, "playback.json");

const videoResponse = (req: Request, file: Bun.BunFile) => {
  const size = file.size;
  const baseHeaders = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const range = req.headers.get("range");
  if (!range) return new Response(req.method === "HEAD" ? null : file, { headers: baseHeaders });

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response("invalid range", { status: 416 });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return new Response("range not satisfiable", { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), {
    status: 206,
    headers: { ...baseHeaders, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
};

const server = serve({
  port: PORT,
  routes: {
    "/client.json": async () => {
      const file = Bun.file(CONFIG_PATH);
      // Absent is not an error -- it means "run the defaults".
      if (!(await file.exists())) return new Response("{}", { headers: { "content-type": "application/json" } });
      return new Response(file, { headers: { "content-type": "application/json" } });
    },

    "/assets/*": async (req) => {
      const pathname = new URL(req.url).pathname.replace(/^\/assets\//, "");
      const file = Bun.file(join(import.meta.dir, "assets", pathname));
      if (await file.exists()) {
        return new Response(file);
      }
      return new Response("Not found", { status: 404 });
    },

    /** Local VOD for configured file cameras. RTSP cameras need a recorder. */
    "/archive/*": async (req) => {
      const cameraId = decodeURIComponent(new URL(req.url).pathname.slice("/archive/".length));
      if (!/^[a-z0-9_]+$/i.test(cameraId)) return new Response("Not found", { status: 404 });
      const manifestFile = Bun.file(PLAYBACK_MANIFEST);
      if (!(await manifestFile.exists())) return new Response("playback is not configured", { status: 404 });
      let manifest: { cameras?: Record<string, { file?: unknown }> };
      try {
        manifest = await manifestFile.json();
      } catch {
        return new Response("invalid playback manifest", { status: 500 });
      }
      const relative = manifest.cameras?.[cameraId]?.file;
      if (typeof relative !== "string") return new Response("no recording for this camera", { status: 404 });
      const path = resolve(MEDIA_DIR, relative);
      if (!path.startsWith(`${MEDIA_DIR}/`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response("recording file is missing", { status: 404 });
      return videoResponse(req, file);
    },

    // Client-side routing: every path is the app.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`IBVAP console on ${server.url}`);
console.log(`  client config  ${CONFIG_PATH}`);
