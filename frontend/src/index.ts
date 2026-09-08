/**
 * The frontend's own server. Serves the operator screen and this deployment's
 * configuration file -- nothing else. All data comes from the edge node.
 */
import { serve } from "bun";
import { join } from "node:path";
import index from "./index.html";

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Per-client deployment knob (#39): point this at the force's own file and the
 * same image becomes their console. No rebuild, no fork.
 */
const CONFIG_PATH = process.env.IBVAP_CLIENT_CONFIG ?? "./client.json";

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
