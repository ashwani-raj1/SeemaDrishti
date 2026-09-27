// Launches the non-JS half of the stack together: the media hub, the
// people/face/target service, and the real multi-camera detection pipeline.
// Mirrors run-app.mjs's own shape exactly (spawn together, kill together,
// preserve a failing exit code) so the two scripts read as one pattern, not
// two unrelated ones -- this one is just the vision side instead of the web
// app side, the same split the repo itself already draws between
// backend/frontend and ibvap/.
const root = new URL("../", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1");

const children = [
  Bun.spawn({
    cmd: [`${root}media\\bin\\mediamtx.exe`, `${root}media\\mediamtx.yml`],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["python", "-m", "uvicorn", "people_ai_service:app", "--host", "127.0.0.1", "--port", "8002"],
    cwd: `${root}ibvap`,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["python", "main.py"],
    cwd: `${root}ibvap`,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // All 5 cameras at once is heavy on a single dev box (measured: it
    // saturates CPU badly enough that WHEP video stalls, even though
    // tracking/matching keep working over the WS channel regardless -- see
    // .env's own comment on IBVAP_WORKER_CAMERAS). Left as whatever .env
    // already says rather than silently overriding it here; if you want
    // fewer cameras for smoother video, set IBVAP_WORKER_CAMERAS before
    // running this script, the same as running main.py directly.
  }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill(); } catch { /* already stopped */ }
    // child.kill() alone measurably left `python main.py` running on
    // Windows -- still holding its ports and still serving requests minutes
    // later, confirmed by taskkill reporting it as a live child of this
    // process. taskkill /F actually ends it every time it was tested;
    // child.kill() did not, so it is not trusted alone here.
    if (process.platform === "win32" && child.pid) {
      try { Bun.spawnSync(["taskkill", "/F", "/PID", String(child.pid)]); } catch { /* already stopped */ }
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const result = await Promise.race(children.map(async (child) => ({
  child,
  code: await child.exited,
})));

// Any one of the three exiting makes the vision side incomplete -- stop its
// peers rather than leave two of three running silently short-handed.
stop(result.code ?? 1);
