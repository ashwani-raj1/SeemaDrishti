/**
 * HTTP request logging.
 *
 * WHY NOT MORGAN. Morgan is Connect/Express middleware: it takes
 * `(req, res, next)` over Node's `http.IncomingMessage`/`ServerResponse`, and
 * it writes its line from a `res.on("finish")` listener. This node is
 * `Bun.serve`, where a handler receives a Web `Request` and returns a Web
 * `Response` -- there is no `res` to attach a listener to, no `next` to call,
 * and no finish event. Morgan cannot be dropped in without a Node-compat shim
 * around every route, which is more moving parts than the thing being logged.
 *
 * So this is morgan's OUTPUT, reimplemented against the actual server, in
 * about sixty lines and with no new dependency -- which is what
 * `requirements`-style discipline asks for (CLAUDE.md section 9: every
 * dependency is a laptop that fails to set up the night before submission).
 * The `dev` and `combined` format names and their column order are morgan's on
 * purpose, so anyone who knows morgan can read this without being told.
 *
 * ONE ADDITION MORGAN DOES NOT HAVE: the actor. Every mutating route in this
 * node is attributed (see `actorOf` in http.ts) because an unattributed change
 * is what the audit log exists to make impossible. A request log that drops
 * the actor would be the one place in the system where that stops being true.
 *
 * WHAT IT DOES NOT CLAIM. The duration is time-to-Response, not
 * time-to-last-byte. For ordinary JSON those are the same thing. For
 * `/api/stream`, which is a long-lived SSE body, the Response is returned
 * immediately and the body streams for the rest of the shift -- so the line
 * says the stream was OPENED, and does not pretend to time it. Morgan would
 * log that request once, at disconnect, with a duration of several hours.
 */
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

function line(req: Request, response: Response, ms: number): string {
  const url = new URL(req.url);
  const actor = req.headers.get("x-ibvap-actor") ?? "-";
  const length = response.headers.get("content-length") ?? "-";
  const status = colourStatus(response.status);
  const note = STREAMING.has(url.pathname) ? " (stream opened)" : "";

  if (FORMAT === "combined") {
    // morgan's `combined`, with the actor standing in for the remote user --
    // this node has no IP-level identity worth recording on a LAN, and the
    // actor is the thing an audit reader actually wants.
    return (
      `${actor} [${new Date().toISOString()}] "${req.method} ${url.pathname}${url.search} HTTP/1.1" ` +
      `${response.status} ${length} "${req.headers.get("referer") ?? "-"}" ` +
      `"${req.headers.get("user-agent") ?? "-"}" ${ms.toFixed(1)}ms`
    );
  }

  return (
    `${paint(90, req.method.padEnd(6))} ${url.pathname}${url.search} ` +
    `${status} ${paint(90, `${ms.toFixed(1)} ms`)} - ${length} ${paint(90, actor)}${note}`
  );
}

type Handler = (req: Request) => Response | Promise<Response>;

/** Wrap one handler so it reports what it did. */
function logHandler(handler: Handler): Handler {
  return async (req: Request) => {
    const started = performance.now();
    try {
      const response = await handler(req);
      console.log(line(req, response, performance.now() - started));
      return response;
    } catch (error) {
      // `handled()` turns errors into responses, so reaching here means a route
      // threw outside it. Log the attempt rather than losing it, then rethrow
      // and let Bun's own error handler decide the status.
      console.log(line(req, new Response(null, { status: 500 }), performance.now() - started));
      throw error;
    }
  };
}

/**
 * Wrap every handler in a Bun.serve `routes` object.
 *
 * Applied once, to the whole table, rather than at each route: a logger you
 * have to remember to add is a logger that is missing from the route you most
 * need it on. Values are either a handler or a `{ GET, POST, ... }` map.
 */
export function withLogging<T extends Record<string, unknown>>(routes: T): T {
  if (FORMAT === "off") return routes;

  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes)) {
    if (typeof value === "function") {
      out[path] = logHandler(value as Handler);
      continue;
    }
    if (value && typeof value === "object") {
      const methods: Record<string, unknown> = {};
      for (const [method, handler] of Object.entries(value as Record<string, unknown>)) {
        methods[method] =
          typeof handler === "function" ? logHandler(handler as Handler) : handler;
      }
      out[path] = methods;
      continue;
    }
    out[path] = value;
  }
  return out as T;
}

/**
 * Wrap Bun.serve's fallback `fetch`, which the routes table never sees.
 *
 * Everything unmatched lands there -- 404s and CORS preflights -- and those
 * are exactly the requests worth logging when a console or a worker is
 * pointed at the wrong path. Morgan logs them because it sits in front of
 * routing; this has to be asked separately.
 */
export function logFallback(handler: Handler): Handler {
  return FORMAT === "off" ? handler : logHandler(handler);
}

export const logFormat = FORMAT;
