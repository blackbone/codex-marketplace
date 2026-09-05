import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { managedRoutingPolicyBlock, refreshRepoRoutingPolicy, ROUTING_POLICY_START, ROUTING_POLICY_END, TODO_ROUTING_POLICY, TOOLING_OPERATION_POLICY, WORKER_TOOLING_BOUNDARY } from "./routing-policy.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.dirname(scripts);
const base = mkdtempSync(path.join(os.tmpdir(), "todo-routing-policy-"));
test.after(() => rmSync(base, { recursive: true, force: true }));
const legacy = `${ROUTING_POLICY_START}\nRoute every mutation through ToDo.\n${ROUTING_POLICY_END}`;
function fixture(name, activated = true) {
  const root = path.join(base, name);
  mkdirSync(root);
  const git = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  if (activated) {
    mkdirSync(path.join(root, ".todo"));
    writeFileSync(path.join(root, ".todo/config.json"), '{"routingMode":"all-mutations","workers":3}\n');
  }
  return root;
}
function run(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: "utf8", timeout: 15000, ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function hook(root, event, env = {}) {
  return JSON.parse(run("session-context.mjs", [], {
    input: JSON.stringify({ cwd: root, hook_event_name: event }),
    env: { ...process.env, TODO_RUNNER_WORKER: "0", ...env },
  })).hookSpecificOutput.additionalContext;
}

// These are instruction-contract checks, not a natural-language classifier or
// an assertion that an independently running model followed the instructions.
const scenarios = [
  ["1. semantic-search:init + service config + docs index => direct", /semantic-search:init writing \.semantic-search\.json and indexing docs\/ is direct/],
  ["2. another Codex plugin or MCP setup => direct", /configuring another Codex plugin or MCP connection is direct/],
  ["3. plugin edits product code or project docs => ToDo", /editing source code or docs\/ through a plugin requires ToDo/],
  ["4. build/deployment disguised as tooling => ToDo", /changing a build pipeline or deployment under the label "tooling setup" requires ToDo/],
  ["5. mixed request => setup direct, docs task routed", /connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task/],
];
const sources = [TODO_ROUTING_POLICY, managedRoutingPolicyBlock()];
for (const name of ["route", "create", "init", "run"]) {
  sources.push(readFileSync(path.join(plugin, "skills", name, "SKILL.md"), "utf8"));
}
sources.push(readFileSync(path.join(plugin, "README.md"), "utf8"));
const messages = run("mcp-server.mjs", [], { input: [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
].map(JSON.stringify).join("\n") + "\n" }).trim().split("\n").map(JSON.parse);
sources.push(messages.find((message) => message.id === 1).result.instructions);
const tools = messages.find((message) => message.id === 2).result.tools;
assert.ok(tools.length > 0);
sources.push(...tools.map((tool) => tool.description));
const contractRoot = fixture("contracts");
sources.push(hook(contractRoot, "SessionStart"));

for (const [name, pattern] of scenarios) {
  test(name, () => {
    for (const source of sources) {
      assert.match(source, pattern);
      assert.ok(source.includes(TOOLING_OPERATION_POLICY));
      assert.ok(source.includes(WORKER_TOOLING_BOUNDARY));
    }
  });
}
test("permissions, hook trust, semantic purpose, mixed prerequisites and worker restrictions stay explicit", () => {
  assert.match(TOOLING_OPERATION_POLICY, /purpose and effects, not just its file path/);
  assert.match(TOOLING_OPERATION_POLICY, /application dependencies, build, CI\/CD, and deployment changes still require ToDo/);
  assert.match(TOOLING_OPERATION_POLICY, /Developing a plugin as the repository's product is also a project change/);
  assert.match(TOOLING_OPERATION_POLICY, /do not ask for a separate routing confirmation/);
  assert.match(TOOLING_OPERATION_POLICY, /never approve hook trust on the user's behalf/);
  assert.match(TOOLING_OPERATION_POLICY, /setup failure must not publish tasks that depend on it/);
  const daemon = readFileSync(path.join(scripts, "daemon.mjs"), "utf8");
  assert.ok(daemon.split("WORKER_TOOLING_BOUNDARY").length >= 4, "both worker prompt templates must include the boundary");
  assert.ok(hook(contractRoot, "SubagentStart", { TODO_RUNNER_WORKER: "1", TODO_RUNNER_REPO_ROOT: contractRoot }).includes(WORKER_TOOLING_BOUNDARY));
});

test("legacy AGENTS and override blocks refresh together, preserving user bytes and config", () => {
  const root = fixture("legacy");
  const prefix = "# User rules\r\nKeep my custom instruction.\r\n\r\n";
  const suffix = "\r\n\r\n## After\r\nDo not change this.\r\n";
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
    writeFileSync(path.join(root, name), prefix + legacy.replaceAll("\n", "\r\n") + suffix);
  }
  const beforeConfig = readFileSync(path.join(root, ".todo/config.json"));
  const result = refreshRepoRoutingPolicy(root);
  assert.equal(result.files.filter((file) => file.updated).length, 2);
  for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
    assert.equal(readFileSync(path.join(root, name), "utf8"), prefix + managedRoutingPolicyBlock("\r\n") + suffix);
  }
  assert.equal(refreshRepoRoutingPolicy(root).updated, false);
  assert.deepEqual(readFileSync(path.join(root, ".todo/config.json")), beforeConfig);
  assert.deepEqual(readdirSync(path.join(root, ".todo")), ["config.json"]);
});
test("trusted interactive hook events upgrade old blocks without tasks", () => {
  const root = fixture("hook-upgrade");
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    writeFileSync(path.join(root, "AGENTS.md"), `Before\n${legacy}\nAfter\n`);
    const context = hook(root, event);
    assert.ok(context.includes(TODO_ROUTING_POLICY));
    assert.equal(readFileSync(path.join(root, "AGENTS.md"), "utf8"), `Before\n${managedRoutingPolicyBlock()}\nAfter\n`);
    assert.ok(context.length < 16000, "hook context must fit its configured limit");
  }
  assert.deepEqual(readdirSync(path.join(root, ".todo")), ["config.json"]);
});
test("background workers and subagent hooks never migrate parent instructions", () => {
  const root = fixture("worker");
  const file = path.join(root, "AGENTS.md");
  writeFileSync(file, legacy);
  for (const event of ["SessionStart", "UserPromptSubmit", "SubagentStart"]) {
    hook(root, event, { TODO_RUNNER_WORKER: "1", TODO_RUNNER_REPO_ROOT: root });
    assert.equal(readFileSync(file, "utf8"), legacy);
  }
  hook(root, "SubagentStart");
  assert.equal(readFileSync(file, "utf8"), legacy);
  const maintenance = JSON.parse(run("refresh-routing-policy.mjs", [root], {
    env: { ...process.env, TODO_RUNNER_WORKER: "1" },
  }));
  assert.equal(maintenance.skipped, "claimed-worker");
  assert.equal(readFileSync(file, "utf8"), legacy);
});
test("maintenance does not activate repos or add missing managed blocks", () => {
  const inactive = fixture("inactive", false);
  writeFileSync(path.join(inactive, "AGENTS.md"), legacy);
  assert.equal(refreshRepoRoutingPolicy(inactive).skipped, "not-activated");
  assert.equal(readFileSync(path.join(inactive, "AGENTS.md"), "utf8"), legacy);
  const active = fixture("unmanaged");
  writeFileSync(path.join(active, "AGENTS.md"), "My routing rules\n");
  assert.equal(refreshRepoRoutingPolicy(active).updated, false);
  assert.equal(readFileSync(path.join(active, "AGENTS.md"), "utf8"), "My routing rules\n");
  assert.equal(existsSync(path.join(active, "AGENTS.override.md")), false);
});
test("malformed/duplicate markers and symlinks are preserved and reported", () => {
  const root = fixture("malformed");
  const file = path.join(root, "AGENTS.md");
  for (const invalid of [ROUTING_POLICY_START, ROUTING_POLICY_END, `${ROUTING_POLICY_END}\n${ROUTING_POLICY_START}`, legacy + legacy]) {
    writeFileSync(file, invalid);
    assert.match(refreshRepoRoutingPolicy(root).files[0].error, /Malformed/);
    assert.equal(readFileSync(file, "utf8"), invalid);
    assert.match(hook(root, "SessionStart"), /managed routing refresh failed/);
    assert.equal(readFileSync(file, "utf8"), invalid);
  }
  rmSync(file);
  const target = path.join(base, "outside.md");
  writeFileSync(target, legacy);
  symlinkSync(target, file);
  assert.match(refreshRepoRoutingPolicy(root).files[0].error, /symlinked/);
  assert.equal(readFileSync(target, "utf8"), legacy);
  rmSync(target);
  assert.match(refreshRepoRoutingPolicy(root).files[0].error, /symlinked/);
  assert.equal(existsSync(target), false);
});
test("explicit maintenance CLI upgrades activated repositories idempotently", () => {
  const root = fixture("cli");
  writeFileSync(path.join(root, "AGENTS.md"), legacy);
  assert.equal(JSON.parse(run("refresh-routing-policy.mjs", [root])).updated, true);
  assert.equal(JSON.parse(run("refresh-routing-policy.mjs", [root])).updated, false);
  assert.deepEqual(readdirSync(path.join(root, ".todo")), ["config.json"]);
});
