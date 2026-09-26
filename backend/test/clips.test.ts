import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Evidence clips: storage, the manifest split, and retention.
 *
 * The two things worth pinning hardest are the ones that would fail silently:
 * that the manifest never carries pixels (a regression there ships a megabyte
 * on every render and nothing looks broken), and that retention actually
 * deletes (a regression there fills a BOP disk over weeks).
 */

const DB_PATH = join(tmpdir(), `ibvap-clips-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.IBVAP_DB = DB_PATH;

let clips: typeof import("../src/l3/clips");
let settings: typeof import("../src/l3/settings");
let db: typeof import("../src/db");

const ORG = "org_bsf";

beforeAll(async () => {
  db = await import("../src/db");
  const { seed } = await import("../src/db/seed");
  seed();
  clips = await import("../src/l3/clips");
  settings = await import("../src/l3/settings");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_PATH + suffix);
    } catch {
      /* nothing to clean up */
    }
  }
});

/** A 1x1 JPEG, so the bytes are real without needing an encoder. */
const JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function store(clipId: string, frameCount = 3) {
  return clips.storeClip({
    clipId,
    orgId: ORG,
    cameraId: "cam_garden",
    at: new Date().toISOString(),
    fps: 5.8,
    simulated: true,
    frames: Array.from({ length: frameCount }, (_, i) => ({
      // Negative before the crossing, positive after -- the pre-roll is the
      // whole reason the ring exists.
      offset: Number((i - 2).toFixed(2)),
      jpeg: JPEG,
      boxes: [{ class: "vehicle", bbox: [0.1, 0.1, 0.2, 0.2] }],
    })),
  });
}

describe("storing a clip", () => {
  test("frames and a manifest come back", () => {
    store("clip_a", 4);
    const manifest = clips.clipManifest("clip_a")!;

    expect(manifest.frameCount).toBe(4);
    expect(manifest.fps).toBe(5.8);
    expect(manifest.frames).toHaveLength(4);
    expect(manifest.frames[0]!.offset).toBe(-2);
  });

  test("the manifest carries no pixels", () => {
    // A regression here is invisible: the page still works, it just ships a
    // megabyte of base64 on every render to draw a strip of timestamps.
    const manifest = clips.clipManifest("clip_a")!;
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain(JPEG.slice(0, 40));
    expect(serialised.length).toBeLessThan(2000);
  });

  test("boxes ride along with each frame", () => {
    const manifest = clips.clipManifest("clip_a")!;
    expect((manifest.frames[0]!.boxes[0] as any).class).toBe("vehicle");
  });

  test("a frame is fetched one at a time", () => {
    expect(clips.clipFrame("clip_a", 0)).toBe(JPEG);
    expect(clips.clipFrame("clip_a", 99)).toBeNull();
  });

  test("re-sending the same clip replaces it rather than doubling it", () => {
    // DurableSink retries, so a clip whose POST succeeded on the node but timed
    // out on the wire arrives twice. Without the delete-first the scrubber
    // would play it through twice.
    store("clip_dup", 3);
    store("clip_dup", 3);
    expect(clips.clipManifest("clip_dup")!.frameCount).toBe(3);
    expect(
      db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM clip_frame WHERE clip_id = 'clip_dup'",
      )[0]!.n,
    ).toBe(3);
  });

  test("an unknown clip is null, not a throw", () => {
    expect(clips.clipManifest("clip_nope")).toBeNull();
  });
});

describe("retention", () => {
  test("a fresh clip survives the sweep", () => {
    store("clip_fresh");
    expect(clips.sweepClips(ORG)).toBe(0);
    expect(clips.clipManifest("clip_fresh")).not.toBeNull();
  });

  test("a clip past the window is deleted, frames and all", () => {
    // The reason this exists: organisation.retention_days sat in the schema
    // unread for the whole project because events were small. A clip is about
    // a megabyte, and fifty a day fills a post's disk with nobody watching.
    store("clip_old");
    const future = new Date(Date.now() + 8 * 86400_000);

    expect(clips.sweepClips(ORG, future)).toBeGreaterThan(0);
    expect(clips.clipManifest("clip_old")).toBeNull();
    expect(
      db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM clip_frame WHERE clip_id = 'clip_old'",
      )[0]!.n,
    ).toBe(0);
  });

  test("the window is the configured one", () => {
    settings.updateSettings({
      actor: { id: "usr_supervisor", name: "Test", role: "supervisor" },
      orgId: ORG,
      clipRetentionDays: 30,
    });
    store("clip_kept");

    // 8 days on: inside a 30-day window, so it stays.
    expect(clips.sweepClips(ORG, new Date(Date.now() + 8 * 86400_000))).toBe(0);
    expect(clips.clipManifest("clip_kept")).not.toBeNull();
  });

  test("retention never touches events or the audit log", () => {
    // Clips are evidence; events are the record. Sweeping the record would
    // break the append-only claim the whole log rests on.
    const events = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM event")[0]!.n;
    const actions = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM action")[0]!.n;

    store("clip_sweepable");
    clips.sweepClips(ORG, new Date(Date.now() + 999 * 86400_000));

    expect(db.all<{ n: number }>("SELECT COUNT(*) AS n FROM event")[0]!.n).toBe(events);
    expect(db.all<{ n: number }>("SELECT COUNT(*) AS n FROM action")[0]!.n).toBeGreaterThanOrEqual(actions);
  });
});

describe("settings", () => {
  test("each setting can be changed without disturbing the other", () => {
    // The console saves one panel at a time. A required field here would mean
    // saving the retention window silently rewrote the grouping window to
    // whatever that other form happened to be holding.
    //
    // Reads the grouping window rather than SETTING it: under `bun test` the
    // db module is a singleton shared with whichever file imported it first,
    // so writing it here would reach into settings.test.ts and change the
    // value its own assertions depend on. Independence is provable without
    // touching the other setting at all -- which is the point being made.
    const actor = { id: "usr_supervisor", name: "Test", role: "supervisor" as const };
    const before = settings.getSettings(ORG);

    settings.updateSettings({ actor, orgId: ORG, clipRetentionDays: 3 });
    const after = settings.getSettings(ORG);

    expect(after.groupingWindowSeconds).toBe(before.groupingWindowSeconds);
    expect(after.clipRetentionDays).toBe(3);
  });

  test("usage is reported for the settings page", () => {
    // Stores its own clip rather than relying on earlier tests: the retention
    // block above deliberately sweeps everything, so anything counting on
    // leftovers here would pass or fail on test ORDER.
    store("clip_usage", 5);
    const usage = clips.clipUsage(ORG);
    expect(usage.clips).toBeGreaterThan(0);
    expect(usage.frames).toBeGreaterThanOrEqual(5);
    expect(usage.bytes).toBeGreaterThan(0);
  });
});
