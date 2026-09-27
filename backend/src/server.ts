import { seed } from "./db/seed";
import { createApp } from "./app";

seed();

const PORT = Number(process.env.IBVAP_BACKEND_PORT ?? 8000);

const app = createApp();

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`IBVAP edge node on ${url}`);
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
