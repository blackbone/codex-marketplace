import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeRepo, configPath, readDaemonState } from "./lib.mjs";
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
