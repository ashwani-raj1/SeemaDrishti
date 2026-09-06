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

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-ibvap-actor",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

export const fail = (message: string, status = 400) => json({ error: message }, status);

export class Forbidden extends Error {}
export class NotFound extends Error {}

/**
 * Who is acting. Every mutating route needs this, because an unattributed
 * change is exactly what the audit log exists to make impossible.
 *
 * Real logins are a later job; today the caller names itself and the name is
 * recorded. What matters for this slice is that no write path is anonymous.
 */
export function actorOf(req: Request): Actor {
  const wanted = req.headers.get("x-ibvap-actor") ?? "usr_operator";
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

export async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") throw new Error();
    return body as Record<string, any>;
  } catch {
    throw new BadRequest("expected a JSON object body");
  }
}

/** One place that turns a thrown error into the right status code. */
export function handled(fn: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (error) {
      if (error instanceof ReasonRequired) return fail(error.message, 422);
      if (error instanceof BadRequest) return fail(error.message, 400);
      if (error instanceof Forbidden) return fail(error.message, 403);
      if (error instanceof NotFound) return fail(error.message, 404);
      console.error(error);
      return fail((error as Error).message ?? "internal error", 500);
    }
  };
}

export const query = (req: Request) => new URL(req.url).searchParams;
