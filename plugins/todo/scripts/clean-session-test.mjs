import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  initializeRepo,
  processIsAlive,
  readDaemonState,
} from "./lib.mjs";

const repoRoot = mkdtempSync(path.join(os.tmpdir(), "todo-clean-session-"));
let daemonPid = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stopDaemon() {
  const state = readDaemonState(repoRoot);
  daemonPid = state?.pid || daemonPid;
  if (daemonPid && processIsAlive(daemonPid)) {
    process.kill(daemonPid, "SIGINT");
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5000;
    while (processIsAlive(daemonPid) && Date.now() < deadline) {
      Atomics.wait(sleeper, 0, 0, 100);
    }
  }
}

try {
  const git = spawnSync("git", ["init", "--quiet", repoRoot], {
    encoding: "utf8",
  });
  assert(git.status === 0, git.stderr || "git init failed");
  const initialized = initializeRepo(repoRoot);
  assert(
    initialized.routingPolicy?.updated === true,
    "init did not install routing policy",
  );

  const fakeCodex = path.join(repoRoot, "fake-codex.mjs");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0
    }
  }) + "\\n");
  writeFileSync(args[outputIndex + 1], JSON.stringify({
    status: "completed",
    summary: "Clean-session routing fixture completed.",
    validation: ["fixture"]
  }));
});
`,
    "utf8",
  );
  chmodSync(fakeCodex, 0o755);

  const configPath = path.join(repoRoot, ".todo", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(
    configPath,
    `${JSON.stringify({
      ...config,
      workers: 1,
      pollIntervalMs: 250,
      codexCommand: fakeCodex,
      models: [
        {
          name: "fast",
          model: "gpt-test-fast",
          reasoningEffort: "low",
          description: "Clean-session routing fixture.",
        },
      ],
      defaultModelProfile: "fast",
    })}\n`,
    "utf8",
  );

  const finalMessage = path.join(repoRoot, "main-result.txt");
  const result = spawnSync(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--dangerously-bypass-hook-trust",
      "--model",
      "gpt-5.6-terra",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-C",
      repoRoot,
      "--color",
      "never",
      "--json",
      "--output-last-message",
      finalMessage,
      "Create a new file proof.txt containing exactly the word routed. Return immediately after handing the implementation off; do not wait for or inspect background execution.",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert(
    result.status === 0,
    result.stderr || `clean Codex session exited with ${result.status}`,
  );

  const openTasks = readdirSync(path.join(repoRoot, ".todo")).filter((name) =>
    /^\d+-.*\.md$/.test(name),
  );
  const historyTasks = readdirSync(path.join(repoRoot, ".todo", "history")).filter(
    (name) => /^\d+-.*\.json$/.test(name),
  );
  const finalText = existsSync(finalMessage)
    ? readFileSync(finalMessage, "utf8").trim()
    : "";
  assert(
    openTasks.length + historyTasks.length >= 1,
    [
      "clean session did not create a ToDo task",
      `proofExists=${existsSync(path.join(repoRoot, "proof.txt"))}`,
      `finalMessage=${JSON.stringify(finalText)}`,
      `stdoutTail=${JSON.stringify(result.stdout.slice(-4000))}`,
      `stderrTail=${JSON.stringify(result.stderr.slice(-2000))}`,
    ].join("\n"),
  );
  assert(
    !existsSync(path.join(repoRoot, "proof.txt")),
    "clean session bypassed ToDo and edited the repository directly",
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      repoRoot,
      taskCreated: true,
      directEditPrevented: true,
      finalMessage: finalText,
    })}\n`,
  );
} finally {
  stopDaemon();
  assert(
    !daemonPid || !processIsAlive(daemonPid),
    "clean-session test daemon did not stop",
  );
  rmSync(repoRoot, { recursive: true, force: true });
}
