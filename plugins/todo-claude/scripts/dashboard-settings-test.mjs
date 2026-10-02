import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeRepo, configPath, readDaemonState } from "./lib.mjs";
import { seedCliModels } from "./test-cli-models.mjs";
import { startDashboard } from "./dashboard.mjs";
import { browserCommand, closeInitDashboards, openInitSettings } from "./init-dashboard.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-b", "main", root]).status, 0);
  initializeRepo(root);
  const config = JSON.parse(readFileSync(configPath(root)));
  config.customExtension = { retained: true };
  config.git.customExtension = "retained";
  writeFileSync(configPath(root), JSON.stringify(config));
  seedCliModels(root);
  return root;
}

test("settings API validates edits, retains unknown fields, and rejects stale or cross-origin writes", async t => {
  const root = fixture(t);
  const dashboard = await startDashboard(root);
  t.after(() => { dashboard.server.close(); dashboard.server.closeAllConnections(); });
  const url = `${dashboard.url}api/settings`;
  const original = await (await fetch(url)).json();
  const post = (input, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: dashboard.url.slice(0, -1), "X-ToDo-Action": "1", ...headers }, body: JSON.stringify(input) });
  const input = structuredClone(original);
  input.values.workers = 8;
  input.values.git.targetBranch = "develop";
  let result = await post(input, { Origin: "https://example.invalid" });
  assert.equal(result.status, 403);
  result = await post(input, { "X-ToDo-Action": "" });
  assert.equal(result.status, 403);
  // readSettings returns only editable fields, even with future Git extensions.
  assert.equal(input.values.git.customExtension, undefined);
  const before = readFileSync(configPath(root), "utf8");
  for (const mutate of [v => { v.workers = 0; }, v => { v.pollIntervalMs = 100; }, v => { v.git.targetBranch = "bad..branch"; }, v => { v.defaultModelProfile = "missing"; }, v => { v.git.executionMode = "single-branch"; v.git.push = true; }]) {
    const invalid = structuredClone(input); mutate(invalid.values);
    assert.equal((await post(invalid)).status, 409);
    assert.equal(readFileSync(configPath(root), "utf8"), before);
  }
  result = await post(input);
  assert.equal(result.status, 200, await result.text());
  const saved = JSON.parse(readFileSync(configPath(root)));
  assert.equal(saved.workers, 8);
  assert.equal(saved.git.targetBranch, "develop");
  assert.deepEqual(saved.customExtension, { retained: true });
  assert.equal(saved.git.customExtension, "retained");
  assert.equal((await post(original)).status, 409);
  const html = await (await fetch(dashboard.url + "?settings=1")).text();
  assert.match(html, /id="settings-open"/);
  assert.match(html, /id="settings-dialog"/);
  const script = await (await fetch(dashboard.url + "dashboard.js")).text();
  new Function(script);
  writeFileSync(configPath(root), "{broken");
  assert.equal((await fetch(url)).status, 409);
  assert.equal((await post(input)).status, 409);
  assert.equal(readFileSync(configPath(root), "utf8"), "{broken");
});

test("settings add, edit and remove model profiles only with models from the Claude CLI list", async t => {
  const root = fixture(t);
  const dashboard = await startDashboard(root);
  t.after(() => { dashboard.server.close(); dashboard.server.closeAllConnections(); });
  const url = `${dashboard.url}api/settings`;
  const post = input => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: dashboard.url.slice(0, -1), "X-ToDo-Action": "1" }, body: JSON.stringify(input) });
  const original = await (await fetch(url)).json();
  assert.equal(original.values.modelProfiles.length, 8);
  assert.equal(original.profilesInherited, true);
  assert.deepEqual(original.profileProblems, []);
  assert.ok(original.modelCatalog.models.some(m => m.model === "claude-opus-5-5"));
  const before = readFileSync(configPath(root), "utf8");
  const bad = [
    v => { v.modelProfiles.push({ name: "typo", model: "claude-nope-1", reasoningEffort: "high" }); },
    v => { v.modelProfiles.push({ name: "older", model: "claude-sonnet-4-6", reasoningEffort: "xhigh" }); },
    v => { v.modelProfiles.push({ name: "fast", model: "claude-sonnet-5-5", reasoningEffort: "low" }); },
    v => { v.modelProfiles.push({ name: "Bad Name", model: "claude-sonnet-5-5", reasoningEffort: "low" }); },
    v => { v.modelProfiles = []; },
    v => { v.modelProfiles = v.modelProfiles.filter(p => p.name !== v.defaultModelProfile); },
  ];
  for (const mutate of bad) {
    const invalid = structuredClone(original); mutate(invalid.values);
    const result = await post(invalid);
    assert.equal(result.status, 409);
    assert.ok((await result.json()).error);
    assert.equal(readFileSync(configPath(root), "utf8"), before);
  }
  const edited = structuredClone(original);
  edited.values.modelProfiles = edited.values.modelProfiles.filter(p => p.name !== "ultra");
  edited.values.modelProfiles.push({ name: "quick", model: "claude-haiku-4-5", reasoningEffort: "low", description: "Typos" });
  edited.values.modelProfiles.push({ name: "frontier", model: "fable", reasoningEffort: "max" });
  const result = await post(edited);
  assert.equal(result.status, 200, await result.clone().text());
  const saved = JSON.parse(readFileSync(configPath(root)));
  assert.deepEqual(saved.models.claude.map(p => p.name), ["mini", "fast", "standard", "medium", "proven", "advanced", "expert", "quick", "frontier"]);
  const reread = await (await fetch(url)).json();
  assert.equal(reread.profilesInherited, false);
  assert.ok(reread.profiles.includes("quick"));
  const modelsUrl = `${dashboard.url}api/models`;
  assert.equal((await fetch(modelsUrl, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.invalid", "X-ToDo-Action": "1" }, body: "{}" })).status, 403);
  const listed = await (await fetch(modelsUrl, { method: "POST", headers: { "Content-Type": "application/json", Origin: dashboard.url.slice(0, -1), "X-ToDo-Action": "1" }, body: "{}" })).json();
  assert.ok(listed.models.some(m => m.aliases.includes("opus")));
});

test("init opens settings by default, reuses its listener and does not start workers", async t => {
  const root = fixture(t);
  t.after(closeInitDashboards);
  const launches = [];
  const launch = (...args) => { launches.push(args); return { status: 0 }; };
  const first = await openInitSettings(root, { launch });
  assert.equal(first.browserOpened, true);
  assert.match(first.settingsUrl, /\?settings=1$/);
  assert.equal((await fetch(first.settingsUrl)).status, 200);
  assert.equal(readDaemonState(root), null);
  const second = await openInitSettings(root, { launch });
  assert.equal(second.settingsUrl, first.settingsUrl);
  assert.equal(launches.length, 2);
  assert.deepEqual(await openInitSettings(root, { open: false, launch }), { settingsUrl: null, browserOpened: false });
  assert.equal(launches.length, 2);
  const failed = await openInitSettings(root, { launch: () => ({ status: 1 }) });
  assert.equal(failed.browserOpened, false);
  assert.equal(failed.settingsUrl, first.settingsUrl);
  assert.match(failed.browserError, /Open settingsUrl/);
  for (const platform of ["darwin", "win32", "linux"]) assert(browserCommand(first.settingsUrl, platform)[1].includes(first.settingsUrl));
  assert.throws(() => browserCommand("https://example.invalid"));
});
