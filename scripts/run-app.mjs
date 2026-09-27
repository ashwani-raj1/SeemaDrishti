const mode = process.argv[2] === "start" ? "start" : "dev";
const root = new URL("../", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1");

const children = ["backend", "frontend"].map((directory) => Bun.spawn({
  cmd: ["bun", "run", mode],
  cwd: `${root}${directory}`,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}));

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill(); } catch { /* already stopped */ }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const result = await Promise.race(children.map(async (child) => ({
  child,
  code: await child.exited,
})));

// Either service exiting makes the combined app incomplete. Stop its peer and
// preserve the failing exit code so `bun run dev` never looks healthy when one
// half failed to bind or crashed during startup.
stop(result.code ?? 1);
