import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import type { CorsOptions } from "cors";
import { one } from "./db";
import type { Actor, Role } from "./core/types";
import { ReasonRequired } from "./l3/audit";
import { BadRequest } from "./l4/hooks";

/**
 * The shared HTTP plumbing.
 *
 * Extracted so route modules can be split by subject without importing the
 * server back into themselves. Nothing here knows what a zone or an incident
 * is -- it only knows how to name the caller, refuse them, and turn a thrown
 * error into the right status code.
 */

export const CORS: CorsOptions = {
  origin: "*",
  allowedHeaders: ["content-type", "x-ibvap-actor"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};

export class Forbidden extends Error {}
export class NotFound extends Error {}
/** A well-formed request that collides with current state. 409, not 400: the
 *  caller made no syntax mistake, the world is just not in the shape they
 *  assumed -- e.g. a camera that already belongs to another zone. */
export class Conflict extends Error {}

/** The shape every refusal takes on the wire. */
export interface ErrorBody {
  error: string;
}

/**
 * Who is acting. Every mutating route needs this, because an unattributed
 * change is exactly what the audit log exists to make impossible.
 *
 * Real logins are a later job; today the caller names itself and the name is
 * recorded. What matters for this slice is that no write path is anonymous.
 */
export function actorOf(req: Request): Actor {
  const wanted = req.get("x-ibvap-actor") ?? "usr_operator";
  const row = one<{ id: string; name: string; role: Role }>(
    "SELECT id, name, role FROM app_user WHERE id = $id",
    { $id: wanted },
  );
  if (!row) throw new Forbidden(`unknown actor ${wanted}`);
  return row;
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw new Forbidden(`${actor.role} may not do this; requires ${roles.join(" or ")}`);
  }
}

const isObject = (value: unknown): value is object =>
  Boolean(value) && typeof value === "object";

/**
 * The parsed JSON body, for routes that cannot do without one.
 *
 * `T` is the wire shape the route expects. It is a declaration, not a proof:
 * every field is still untrusted input, which is why the body types are all
 * optional and the routes keep their own checks.
 */
export function readJson<T extends object = Record<string, unknown>>(req: Request): T {
  if (!isObject(req.body)) throw new BadRequest("expected a JSON object body");
  return req.body as T;
}

/** The parsed JSON body, or an empty one -- for routes where a body is a courtesy. */
export function optionalJson<T extends object = Record<string, unknown>>(req: Request): T {
  return (isObject(req.body) ? req.body : {}) as T;
}

/**
 * The query string, flat: one string per key.
 *
 * `K` names the keys a route reads, so a typo in a filter name is a compile
 * error rather than a filter that silently never applies. The app is set up
 * with `flatQuery` below, which is what makes the `string` value honest.
 */
export type Query<K extends string = string> = Partial<Record<K, string>>;

export const query = <K extends string>(req: Request): Query<K> => req.query as Query<K>;

/** Parse the query string the way URLSearchParams would, with no nested objects. */
export const flatQuery = (raw: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(raw));

/** A numeric query value, or the fallback when it is absent. */
export function num(value: string | undefined): number | undefined;
export function num(value: string | undefined, fallback: number): number;
export function num(value: string | undefined, fallback?: number): number | undefined {
  return value === undefined ? fallback : Number(value);
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not found" } satisfies ErrorBody);
};

/**
 * One place that turns a thrown error into the right status code.
 *
 * Express 5 forwards a rejected handler promise here on its own, so routes
 * just throw.
 */
export const handleErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = statusOf(error);
  if (status === 500) console.error(error);
  const message =
    status === 400 && isBodyParseError(error)
      ? "expected a JSON object body"
      : ((error as Error)?.message ?? "internal error");
  res.status(status).json({ error: message } satisfies ErrorBody);
};

function statusOf(error: unknown): number {
  if (error instanceof ReasonRequired) return 422;
  if (error instanceof BadRequest) return 400;
  if (error instanceof Forbidden) return 403;
  if (error instanceof NotFound) return 404;
  if (error instanceof Conflict) return 409;
  if (isBodyParseError(error)) return 400;
  if (isObject(error) && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return 500;
}

/** body-parser tags its own failures; a malformed body is the caller's fault. */
const isBodyParseError = (error: unknown): boolean =>
  isObject(error) && "type" in error && error.type === "entity.parse.failed";
