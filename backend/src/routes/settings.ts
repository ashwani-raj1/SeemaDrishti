import { DEFAULT_ORG } from "../db/seed";
import {
  getSettings, MAX_GROUPING_WINDOW_SECONDS, MIN_GROUPING_WINDOW_SECONDS, updateSettings,
} from "../l3/settings";
import { BadRequest } from "../l4/hooks";
import { actorOf, handled, json, readJson, requireRole } from "../http";

/**
 * Node settings.
 *
 * Reading them is open -- the console shows the grouping window next to the
 * incidents it explains, and an operator who cannot see the rule cannot
 * reason about the list in front of them. Writing is supervisor-only and
 * audited, because the window decides what counts as one intrusion.
 */

/** Whole seconds, inside the bounds `l3/settings.ts` states the reasons for. */
function validateWindow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequest("groupingWindowSeconds must be a number of seconds");
  }
  if (!Number.isInteger(value)) {
    throw new BadRequest("groupingWindowSeconds must be a whole number of seconds");
  }
  if (value < MIN_GROUPING_WINDOW_SECONDS || value > MAX_GROUPING_WINDOW_SECONDS) {
    throw new BadRequest(
      `groupingWindowSeconds must be between ${MIN_GROUPING_WINDOW_SECONDS} and ` +
        `${MAX_GROUPING_WINDOW_SECONDS} seconds`,
    );
  }
  return value;
}

export const settingsRoutes = {
  "/api/settings": {
    GET: handled(async () => json(getSettings(DEFAULT_ORG))),

    PATCH: handled(async (req) => {
      const actor = actorOf(req);
      requireRole(actor, "supervisor", "admin");

      const body = await readJson(req);
      if (body.groupingWindowSeconds === undefined) {
        throw new BadRequest("nothing to change");
      }

      return json(
        updateSettings({
          actor,
          orgId: DEFAULT_ORG,
          groupingWindowSeconds: validateWindow(body.groupingWindowSeconds),
          reason: typeof body.reason === "string" ? body.reason : null,
        }),
      );
    }),
  },
};
