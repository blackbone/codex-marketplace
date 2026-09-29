import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { readLogTail } from "./bounded-log.mjs";

export async function runShellCommand({ command, cwd, env, timeoutSeconds, stdoutPath, stderrPath, onChild, signal }) {
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  const startedAt = Date.now();
  let child, timer, spawnError, timedOut = false, interrupted = false;
  let termination = null;
  const killTree = (signalName) => {
    if (!child?.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-child.pid, signalName); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  const terminate = () => {
    if (termination) return;
    interrupted = !timedOut;
    killTree("SIGTERM");
    // The shell can exit before descendants; always kill the process group,
    // even after close, and wait before a repair/new step may start.
    termination = new Promise(resolve => setTimeout(() => {
      killTree("SIGKILL");
      resolve();
    }, 2000));
  };
  try {
    if (signal?.aborted) throw new Error("Shell step interrupted before start");
    child = spawn(command, { cwd, env, shell: true,
      detached: process.platform !== "win32", stdio: ["ignore", stdoutFd, stderrFd] });
    child.terminateTree = terminate;
    onChild?.(child);
    signal?.addEventListener("abort", terminate, { once: true });
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutSeconds * 1000);
    const { exitCode, signal: exitSignal } = await new Promise(resolve => {
      child.once("error", error => { spawnError = error; resolve({ exitCode: null, signal: null }); });
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(timer);
    await termination;
    return { status: !spawnError && !timedOut && !interrupted && exitCode === 0 ? "completed" : "failed",
      command, exitCode, signal: exitSignal, timedOut, interrupted,
      error: spawnError?.message || null, durationMs: Date.now() - startedAt,
      stdoutTail: readLogTail(stdoutPath, 6000).trim(), stderrTail: readLogTail(stderrPath, 6000).trim() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", terminate);
    closeSync(stdoutFd); closeSync(stderrFd);
    onChild?.(null);
  }
}
