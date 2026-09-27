import { seed, DEFAULT_ORG } from "./db/seed";
import { detachments } from "./db/migrate";
import { recordAction } from "./l3/audit";
import { logFormat } from "./core/logger";
import { createApp } from "./app";

seed();

// A schema migration can change what is being watched -- the one-zone-per-camera
// rule retires duplicate bindings. That belongs in the hash chain like any other
// change to coverage, and it cannot be written from inside migrate.ts, because
// l3/audit.ts imports ../db and the migration runs while that module is still
// being constructed. So it is recorded here, at the first moment it can be.
for (const detached of detachments) {
  recordAction({
    actor: { id: "system", name: "schema migration", role: "admin" },
    orgId: DEFAULT_ORG,
    verb: "zone.camera.detach",
    targetType: "zone",
    targetId: detached.zoneId,
    reason: "one camera belongs to one zone",
    detail: { cameraId: detached.cameraId, bindingId: detached.bindingId },
  });
}

const PORT = Number(process.env.IBVAP_BACKEND_PORT ?? 8000);

const app = createApp();

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`IBVAP edge node on ${url}`);
  console.log(`  request log  ${logFormat} (IBVAP_LOG=dev|combined|off)`);
  console.log(`  detections  POST ${url}hooks/ingress/detections`);
  console.log(`  vision      POST ${url}hooks/ingress/events`);
  console.log(`  live stream  GET ${url}api/stream`);
});

// The live stream is a long-lived response. A server that closes an idle
// request after a few seconds silently tears the operator's stream down and
// makes the screen flicker between "live" and "no link" all shift.
server.timeout = 0;
server.requestTimeout = 0;

export { app, server };
