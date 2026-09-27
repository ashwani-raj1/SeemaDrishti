import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClipUsage, clipManifest } from "../src/l3/clips";
import type { ErrorBody } from "../src/http";

type Manifest = NonNullable<ReturnType<typeof clipManifest>>;

/**
 * Evidence clips, read side.
 *
 * The thing worth pinning hardest is the one that would fail silently: the
 * manifest must never carry pixels. A regression there ships a megabyte on
 * every render and nothing looks broken.
 */

const DB_PATH = join(tmpdir(), `ibvap-clip-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.IBVAP_DB = DB_PATH;

const ORG = "org_bsf";
const CLIP = "clip_test_cam_garden_1";

/** A 1x1 JPEG, so the bytes are real without needing an encoder. */
const JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

let server: Server;
let base: string;

beforeAll(async () => {
  const { run } = await import("../src/db");
  const { seed } = await import("../src/db/seed");
  const { createApp } = await import("../src/app");
  seed();

  run(
    `INSERT INTO clip (id, org_id, camera_id, at, fps, frame_count, bytes, simulated, created_at)
     VALUES ($id, $org, 'cam_garden', '2026-09-23T15:51:23.348Z', 5.8, 2, 1000, 1, '2026-09-23T15:51:30.000Z')`,
    { $id: CLIP, $org: ORG },
  );
  for (const [seq, offset] of [[0, -1.5], [1, 0.2]]) {
    run(
      `INSERT INTO clip_frame (clip_id, seq, offset_s, jpeg, boxes)
       VALUES ($id, $seq, $offset, $jpeg, $boxes)`,
      { $id: CLIP, $seq: seq, $offset: offset, $jpeg: JPEG, $boxes: JSON.stringify([{ class: "vehicle" }]) },
    );
  }

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_PATH + suffix);
    } catch {
      /* nothing to clean up */
    }
  }
});

describe("the clip manifest", () => {
  test("lists every frame's time and boxes", async () => {
    const res = await fetch(`${base}/api/clips/${CLIP}`);
    expect(res.status).toBe(200);
    const clip = (await res.json()) as Manifest;

    expect(clip.cameraId).toBe("cam_garden");
    expect(clip.frameCount).toBe(2);
    expect(clip.simulated).toBe(true);
    expect(clip.frames).toEqual([
      { seq: 0, offset: -1.5, boxes: [{ class: "vehicle" }] },
      { seq: 1, offset: 0.2, boxes: [{ class: "vehicle" }] },
    ]);
  });

  test("never carries pixels", async () => {
    const body = await (await fetch(`${base}/api/clips/${CLIP}`)).text();
    expect(body).not.toContain(JPEG.slice(0, 20));
  });

  test("an unknown clip is a 404", async () => {
    const res = await fetch(`${base}/api/clips/clip_nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe("no clip clip_nope");
  });
});

describe("a clip frame", () => {
  test("is the stored JPEG, as an image", async () => {
    const res = await fetch(`${base}/api/clips/${CLIP}/frames/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(JPEG, "base64"));
  });

  test("a browser asking for images still gets the image", async () => {
    const res = await fetch(`${base}/api/clips/${CLIP}/frames/1`, {
      headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    expect(res.headers.get("content-type")).toStartWith("image/jpeg");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  test("asked for JSON, is the stored base64 with its offset and boxes", async () => {
    const res = await fetch(`${base}/api/clips/${CLIP}/frames/1`, {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toBe("Accept");
    expect(await res.json()).toEqual({
      clipId: CLIP,
      seq: 1,
      offset: 0.2,
      boxes: [{ class: "vehicle" }],
      jpeg: JPEG,
    });
  });

  test("asked for JSON, a missing frame is still a 404", async () => {
    const res = await fetch(`${base}/api/clips/${CLIP}/frames/9`, {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("a frame past the end is a 404", async () => {
    expect((await fetch(`${base}/api/clips/${CLIP}/frames/2`)).status).toBe(404);
  });

  test("a seq that is not a frame number is a 400", async () => {
    expect((await fetch(`${base}/api/clips/${CLIP}/frames/-1`)).status).toBe(400);
    expect((await fetch(`${base}/api/clips/${CLIP}/frames/abc`)).status).toBe(400);
  });
});

test("usage totals what is stored", async () => {
  const usage = (await (await fetch(`${base}/api/clips`)).json()) as ClipUsage;
  expect(usage).toEqual({ clips: 1, frames: 2, bytes: 1000, oldest: "2026-09-23T15:51:30.000Z" });
});
