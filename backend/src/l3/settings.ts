import { one, run } from "../db";
import { recordAction } from "./audit";
import type { Actor } from "../core/types";

/**
 * Settings that change how the node behaves, held in the database rather than
 * in a constant.
 *
 * WHAT QUALIFIES. A number here has to be one whose right value is a property
 * of the ground rather than of the software -- something a post commander can
 * be wrong about, discover they are wrong about, and fix without a deploy.
 * Anything that is genuinely a property of the software stays a constant in
 * the file that uses it, because a knob nobody should turn is a knob somebody
 * will eventually turn.
 *
 * EVERY CHANGE IS AUDITED, for the same reason a zone edit is: the grouping
 * window decides what counts as one intrusion, so "why were these two
 * crossings filed as one incident" is answerable only if the value in force at
 * the time is in the log. `updateSettings` is the only writer, and it cannot
 * write without going through `recordAction`.
 *
 * VALIDATION LIVES IN `routes/settings.ts`, not here. Every other L3 module
 * follows that split -- `BadRequest` is defined in `l4/hooks`, which imports
 * `l3/events`, so an L3 module that threw one would close an import cycle.
 * This file takes numbers it can trust and clamps anything it cannot.
 */

/**
 * How long an incident stays open to new events sharing its group key.
 *
 * 300s was the original hardcoded value in `l3/events.ts`, carried here as the
 * default so an upgrading node groups exactly as it did before. It was never
 * derived from anything measured -- see the bounds below for what the ends of
 * the range actually mean.
 */
export const DEFAULT_GROUPING_WINDOW_SECONDS = 300;

/**
 * The bounds, and what makes each end the wrong answer.
 *
 * At 0 an event can only join an incident whose last event carries the exact
 * same timestamp, so in practice every crossing opens its own incident and an
 * operator triages one person walking a fence line forty separate times.
 *
 * At the top, one incident can stay open through an hour of continuous
 * activity -- a long time for a second genuine intrusion to be filed under the
 * first one's headline and severity. Past an hour the grouping stops meaning
 * "this is the same piece of work" and starts meaning "everything that
 * happened this shift".
 */
export const MIN_GROUPING_WINDOW_SECONDS = 0;
export const MAX_GROUPING_WINDOW_SECONDS = 3600;

export interface NodeSettings {
  groupingWindowSeconds: number;
}

/**
 * The window in force for one org, in seconds.
 *
 * Called on the hot path -- once per recorded event -- so it is a single
 * primary-key lookup and nothing else. It deliberately does NOT cache: a
 * supervisor who widens the window expects the next event to obey it, and a
 * cache would make the change take effect at some later moment nobody could
 * explain afterwards. At the rate this node records events (one per confirmed
 * crossing, not one per frame) the lookup costs nothing worth saving.
 *
 * Falls back to the default rather than throwing. A missing org row is already
 * a broken node, and refusing to record an intrusion because a settings read
 * came back empty would turn a configuration problem into a lost event.
 */
export function groupingWindowSeconds(orgId: string): number {
  const row = one<{ grouping_window_seconds: number | null }>(
    "SELECT grouping_window_seconds FROM organisation WHERE id = $id",
    { $id: orgId },
  );
  const value = row?.grouping_window_seconds;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GROUPING_WINDOW_SECONDS;
  }
  // Clamped on read as well as on write. The column is reachable by anything
  // holding the sqlite file, and a negative window would quietly stop every
  // incident from ever grouping again.
  return Math.min(MAX_GROUPING_WINDOW_SECONDS, Math.max(MIN_GROUPING_WINDOW_SECONDS, value));
}

export function getSettings(orgId: string): NodeSettings {
  return { groupingWindowSeconds: groupingWindowSeconds(orgId) };
}

export interface UpdateSettingsInput {
  actor: Actor;
  orgId: string;
  /** Already validated and in range by the time it gets here. */
  groupingWindowSeconds: number;
  reason?: string | null;
}

/**
 * Change a setting, and record who changed it from what to what.
 *
 * Returns the settings unchanged, and writes no audit row, when the submitted
 * value is the one already in force. An operator who opens the page, thinks
 * about it and saves without moving anything has not made a decision, and a
 * log full of no-op changes is a log nobody reads.
 */
export function updateSettings(input: UpdateSettingsInput): NodeSettings {
  const before = getSettings(input.orgId);
  const next = Math.min(
    MAX_GROUPING_WINDOW_SECONDS,
    Math.max(MIN_GROUPING_WINDOW_SECONDS, Math.round(input.groupingWindowSeconds)),
  );
  if (next === before.groupingWindowSeconds) return before;

  run("UPDATE organisation SET grouping_window_seconds = $value WHERE id = $id", {
    $value: next,
    $id: input.orgId,
  });

  const after = getSettings(input.orgId);
  recordAction({
    actor: input.actor,
    orgId: input.orgId,
    verb: "settings.update",
    targetType: "settings",
    targetId: input.orgId,
    reason: input.reason ?? null,
    detail: { setting: "groupingWindowSeconds" },
    before,
    after,
  });
  return after;
}
