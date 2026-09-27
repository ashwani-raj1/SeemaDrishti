/**
 * HTTP request logging.
 *
 * Morgan's OUTPUT, as one Express middleware and with no new dependency --
 * which is what `requirements`-style discipline asks for (CLAUDE.md section 9:
 * every dependency is a laptop that fails to set up the night before
 * submission). The `dev` and `combined` format names and their column order
 * are morgan's on purpose, so anyone who knows morgan can read this without
 * being told.
 *
 * ONE ADDITION MORGAN DOES NOT HAVE: the actor. Every mutating route in this
 * node is attributed (see `actorOf` in http.ts) because an unattributed change
 * is what the audit log exists to make impossible. A request log that drops
 * the actor would be the one place in the system where that stops being true.
 *
 * WHAT IT DOES NOT CLAIM. `/api/stream` is a long-lived SSE body that streams
 * for the rest of the shift, so it is logged when it is OPENED and not timed.
 * Morgan would log that request once, at disconnect, with a duration of
 * several hours.
 */
import type { Request, RequestHandler, Response } from "express";
import { env } from "./env";

type Format = "dev" | "combined" | "off";

const FORMAT = ((): Format => {
  const wanted = env("IBVAP_LOG", "dev").toLowerCase();
  return wanted === "combined" || wanted === "off" ? wanted : "dev";
})();

// NO_COLOR is the de facto standard, and a log piped to a file or read through
// a Windows terminal that does not handle ANSI is worse with escapes in it.
const COLOUR = FORMAT === "dev" && !env("NO_COLOR") && Boolean(process.stdout?.isTTY);

const paint = (code: number, text: string) =>
  COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text;

/** morgan's dev palette: 5xx red, 4xx yellow, 3xx cyan, 2xx green. */
function colourStatus(status: number): string {
  const text = String(status);
  if (status >= 500) return paint(31, text);
  if (status >= 400) return paint(33, text);
  if (status >= 300) return paint(36, text);
  return paint(32, text);
}

/**
 * A long-lived body whose duration would be meaningless, and whose repeated
 * reconnects would drown everything else on the terminal during a demo.
 */
const STREAMING = new Set(["/api/stream"]);

function line(req: Request, res: Response, ms: number | null): string {
  const url = req.originalUrl;
  const actor = req.get("x-ibvap-actor") ?? "-";
  const length = res.get("content-length") ?? "-";
  const status = colourStatus(res.statusCode);
  const timing = ms === null ? "-" : `${ms.toFixed(1)} ms`;
  const note = ms === null ? " (stream opened)" : "";

  if (FORMAT === "combined") {
    // morgan's `combined`, with the actor standing in for the remote user --
    // this node has no IP-level identity worth recording on a LAN, and the
    // actor is the thing an audit reader actually wants.
    return (
      `${actor} [${new Date().toISOString()}] "${req.method} ${url} HTTP/${req.httpVersion}" ` +
      `${res.statusCode} ${length} "${req.get("referer") ?? "-"}" ` +
      `"${req.get("user-agent") ?? "-"}" ${timing}`
    );
  }

  return (
    `${paint(90, req.method.padEnd(6))} ${url} ` +
    `${status} ${paint(90, timing)} - ${length} ${paint(90, actor)}${note}`
  );
}

/**
 * Log every request the app sees, matched or not.
 *
 * Mounted once, ahead of every router, rather than at each route: a logger you
 * have to remember to add is a logger that is missing from the route you most
 * need it on. Unmatched paths and CORS preflights pass through here too, and
 * those are exactly the requests worth logging when a console or a worker is
 * pointed at the wrong URL.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  if (FORMAT === "off") return next();

  const started = performance.now();
  if (STREAMING.has(req.path)) {
    // Logged when the headers go out, which is the moment the stream opens.
    const onHeaders = res.writeHead;
    res.writeHead = function (this: Response, ...args: any[]) {
      const result = onHeaders.apply(this, args as any);
      console.log(line(req, res, null));
      return result;
    } as typeof res.writeHead;
  } else {
    res.on("finish", () => console.log(line(req, res, performance.now() - started)));
  }
  next();
};

export const logFormat = FORMAT;
