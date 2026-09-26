import { DEFAULT_ORG } from "../db/seed";
import {
  getSettings, MAX_CLIP_RETENTION_DAYS, MAX_GROUPING_WINDOW_SECONDS,
  MIN_CLIP_RETENTION_DAYS, MIN_GROUPING_WINDOW_SECONDS, updateSettings,
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

/**
 * A whole number inside its stated bounds.
 *
 * One validator for every setting rather than one per field: they are all
 * bounded integers, and a second copy of this is how one of them ends up
 * accepting a float or a negative while the other does not.
 */
function wholeNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  unit: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequest(`${field} must be a number of ${unit}`);
  }
  if (!Number.isInteger(value)) {
    throw new BadRequest(`${field} must be a whole number of ${unit}`);
  }
  if (value < min || value > max) {
    throw new BadRequest(`${field} must be between ${min} and ${max} ${unit}`);
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

      // Each setting is optional and only what was SENT is touched. The
      // console saves one panel at a time, so requiring every field would mean
      // saving the retention window silently rewrote the grouping window to
      // whatever that form happened to be holding.
      const patch: {
        groupingWindowSeconds?: number;
        clipRetentionDays?: number;
      } = {};

      if (body.groupingWindowSeconds !== undefined) {
        patch.groupingWindowSeconds = wholeNumber(
          body.groupingWindowSeconds,
          "groupingWindowSeconds",
          MIN_GROUPING_WINDOW_SECONDS,
          MAX_GROUPING_WINDOW_SECONDS,
          "seconds",
        );
      }

      if (body.clipRetentionDays !== undefined) {
        patch.clipRetentionDays = wholeNumber(
          body.clipRetentionDays,
          "clipRetentionDays",
          MIN_CLIP_RETENTION_DAYS,
          MAX_CLIP_RETENTION_DAYS,
          "days",
        );
      }

      if (Object.keys(patch).length === 0) throw new BadRequest("nothing to change");

      return json(
        updateSettings({
          actor,
          orgId: DEFAULT_ORG,
          ...patch,
          reason: typeof body.reason === "string" ? body.reason : null,
        }),
      );
    }),
  },
};
