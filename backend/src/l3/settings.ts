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

/**
 * How long an evidence clip is kept before the sweep takes it.
 *
 * 7 days, not the 30 that `organisation.retention_days` carries for the record.
 * They are different things kept for different reasons: an event is a few
 * hundred bytes and is the record, a clip is about a megabyte and is the
 * picture attached to it. At fifty crossings a day, 30 days of clips is around
 * a gigabyte and a half on a post that may have no spare disk and nobody to
 * clear it.
 *
 * A week is long enough that an incident is still illustrated when somebody
 * comes back to it after a weekend, which is the case this exists for.
 */
export const DEFAULT_CLIP_RETENTION_DAYS = 7;

/**
 * The bounds, and what each end actually means.
 *
 * At 0 a clip is swept the moment the sweep next runs -- which is immediately
 * after the next clip is stored -- so clips effectively stop working. That is
 * a legitimate thing to want (a post that decides it cannot afford them at
 * all), so it is allowed rather than forbidden, and the console says what it
 * means rather than letting somebody discover it.
 *
 * At the top, 90 days of clips is tens of gigabytes. Past that the honest
 * answer is not a bigger number here, it is a bigger disk and a conversation
 * about what this node is for.
 */
export const MIN_CLIP_RETENTION_DAYS = 0;
export const MAX_CLIP_RETENTION_DAYS = 90;

export interface NodeSettings {
  groupingWindowSeconds: number;
  clipRetentionDays: number;
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

/**
 * How many days of evidence clips to keep. Same read-side clamping and same
 * fallback reasoning as the grouping window above.
 */
export function clipRetentionDays(orgId: string): number {
  const row = one<{ clip_retention_days: number | null }>(
    "SELECT clip_retention_days FROM organisation WHERE id = $id",
    { $id: orgId },
  );
  const value = row?.clip_retention_days;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CLIP_RETENTION_DAYS;
  }
  return Math.min(MAX_CLIP_RETENTION_DAYS, Math.max(MIN_CLIP_RETENTION_DAYS, value));
}

export function getSettings(orgId: string): NodeSettings {
  return {
    groupingWindowSeconds: groupingWindowSeconds(orgId),
    clipRetentionDays: clipRetentionDays(orgId),
  };
}

export interface UpdateSettingsInput {
  actor: Actor;
  orgId: string;
  /**
   * Already validated and in range by the time it gets here.
   *
   * Every setting is OPTIONAL: the console sends one panel at a time, and a
   * required field would mean saving the retention window silently rewrote the
   * grouping window to whatever the form happened to be holding.
   */
  groupingWindowSeconds?: number;
  clipRetentionDays?: number;
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
  const changed: string[] = [];

  if (input.groupingWindowSeconds !== undefined) {
    const next = Math.min(
      MAX_GROUPING_WINDOW_SECONDS,
      Math.max(MIN_GROUPING_WINDOW_SECONDS, Math.round(input.groupingWindowSeconds)),
    );
    if (next !== before.groupingWindowSeconds) {
      run("UPDATE organisation SET grouping_window_seconds = $value WHERE id = $id", {
        $value: next,
        $id: input.orgId,
      });
      changed.push("groupingWindowSeconds");
    }
  }

  if (input.clipRetentionDays !== undefined) {
    const next = Math.min(
      MAX_CLIP_RETENTION_DAYS,
      Math.max(MIN_CLIP_RETENTION_DAYS, Math.round(input.clipRetentionDays)),
    );
    if (next !== before.clipRetentionDays) {
      run("UPDATE organisation SET clip_retention_days = $value WHERE id = $id", {
        $value: next,
        $id: input.orgId,
      });
      changed.push("clipRetentionDays");
    }
  }

  // No audit row when nothing moved. An operator who opens the page, thinks
  // about it and saves without changing anything has not made a decision, and
  // a log full of no-op changes is a log nobody reads.
  if (changed.length === 0) return before;

  const after = getSettings(input.orgId);
  recordAction({
    actor: input.actor,
    orgId: input.orgId,
    verb: "settings.update",
    targetType: "settings",
    targetId: input.orgId,
    reason: input.reason ?? null,
    // Which settings moved, so the audit row answers "what did they change"
    // without the reader having to diff before against after.
    detail: { settings: changed },
    before,
    after,
  });
  return after;
}
