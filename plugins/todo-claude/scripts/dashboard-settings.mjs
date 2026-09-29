import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { atomicWriteJson, configPath, DEFAULT_CONFIG, loadConfig } from "./lib.mjs";

const numericFields = { workers: [1, 32], retries: [-1, Number.MAX_SAFE_INTEGER], pollIntervalMs: [250, 60000], configReloadIntervalMs: [250, 60000] };
const gitFields = ["executionMode", "delivery", "targetBranch", "remote", "push"];
const revision = text => createHash("sha256").update(text).digest("hex");

export function readSettings(repoRoot) {
  const text = readFileSync(configPath(repoRoot), "utf8");
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must contain an object");
  const config = loadConfig(repoRoot);
  const branches = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: repoRoot, encoding: "utf8", timeout: 3000, windowsHide: true });
  return {
    revision: revision(text),
    values: Object.fromEntries([...Object.keys(numericFields), "defaultModelProfile"].map(key => [key, raw[key] ?? DEFAULT_CONFIG[key]]).concat([["git", Object.fromEntries(gitFields.map(key => [key, raw.git?.[key] ?? DEFAULT_CONFIG.git[key]]))]])),
    profiles: config.modelProfiles.map(profile => profile.name),
    branches: branches.status === 0 ? branches.stdout.trim().split("\n").filter(Boolean) : [],
    warning: config.readError,
  };
}

export function saveSettings(repoRoot, input) {
  const file = configPath(repoRoot);
  const text = readFileSync(file, "utf8");
  if (input?.revision !== revision(text)) throw new Error("Settings changed elsewhere. Reload settings before saving.");
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must contain an object");
  const values = input.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Settings must be an object");
  const allowed = [...Object.keys(numericFields), "defaultModelProfile", "git"];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error("Unsupported settings field");
  for (const [key, [min, max]] of Object.entries(numericFields)) {
    if (!Number.isSafeInteger(values[key]) || values[key] < min || values[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  if (!loadConfig(repoRoot).modelProfiles.some(profile => profile.name === values.defaultModelProfile)) throw new Error("Select a configured model profile");
  const git = values.git;
  if (!git || typeof git !== "object" || Array.isArray(git) || Object.keys(git).some(key => !gitFields.includes(key))) throw new Error("Invalid Git settings");
  if (!["worktree", "single-branch"].includes(git.executionMode)) throw new Error("Invalid execution mode");
  if (!["keep", "merge"].includes(git.delivery)) throw new Error("Invalid delivery mode");
  if (typeof git.push !== "boolean") throw new Error("Push must be a boolean");
  if (git.executionMode === "single-branch" && git.push) throw new Error("Single-branch mode does not support push");
  if (typeof git.remote !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(git.remote)) throw new Error("Invalid Git remote name");
  if (git.targetBranch !== null) {
    if (typeof git.targetBranch !== "string" || !git.targetBranch || git.targetBranch.startsWith("-") || git.targetBranch.startsWith("@") || /[\r\n]/.test(git.targetBranch) || spawnSync("git", ["check-ref-format", "--branch", git.targetBranch], { cwd: repoRoot, stdio: "ignore", timeout: 3000, windowsHide: true }).status !== 0) throw new Error("Invalid target branch name");
  }
  // Only edit form-owned keys; custom models, pipelines and future fields survive.
  atomicWriteJson(file, { ...raw, ...values, git: { ...raw.git, ...git } });
  return readSettings(repoRoot);
}

function settingsClient() {
  const dialog = document.querySelector("#settings-dialog");
  const form = document.querySelector("#settings-form");
  const message = document.querySelector("#settings-message");
  const save = document.querySelector("#settings-save");
  let loaded = null;
  const field = name => form.elements.namedItem(name);
  const numbers = ["workers", "retries", "pollIntervalMs", "configReloadIntervalMs"];
  function modeChanged() {
    const single = field("executionMode").value === "single-branch";
    field("workers").disabled = single;
    for (const key of ["targetBranch", "delivery", "remote", "push"]) field(key).disabled = single;
    if (single) field("push").checked = false;
    document.querySelector("#settings-mode-help").textContent = single ? "Single-branch runs one worker and commits locally in the current branch." : "Empty target branch uses the branch active at preflight.";
  }
  function populate(data) {
    loaded = data;
    for (const key of numbers) field(key).value = data.values[key];
    const profiles = field("defaultModelProfile");
    profiles.replaceChildren(...data.profiles.map(name => new Option(name, name)));
    profiles.value = data.values.defaultModelProfile;
    for (const key of ["executionMode", "delivery", "targetBranch", "remote"]) field(key).value = data.values.git[key] ?? "";
    field("push").checked = data.values.git.push;
    document.querySelector("#settings-branches").replaceChildren(...data.branches.map(name => new Option(name, name)));
    modeChanged();
  }
  async function reload() {
    save.disabled = true;
    message.textContent = "Loading…";
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      populate(data);
      message.textContent = data.warning || "";
      save.disabled = false;
    } catch (error) { message.textContent = error.message; }
  }
  function open() { dialog.showModal(); reload(); }
  document.querySelector("#settings-open").addEventListener("click", open);
  document.querySelector("#settings-reload").addEventListener("click", reload);
  document.querySelector("#settings-close").addEventListener("click", () => dialog.close());
  field("executionMode").addEventListener("change", modeChanged);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!loaded) return;
    save.disabled = true;
    const values = Object.fromEntries(numbers.map(key => [key, Number(field(key).value)]));
    values.defaultModelProfile = field("defaultModelProfile").value;
    values.git = Object.fromEntries(["executionMode", "delivery", "targetBranch", "remote"].map(key => [key, field(key).value.trim()]));
    values.git.targetBranch ||= null;
    values.git.push = field("push").checked;
    try {
      const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json", "X-ToDo-Action": "1" }, body: JSON.stringify({ revision: loaded.revision, values }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      populate(data);
      message.textContent = "Saved to .todo/config.json. A running runner applies changes on its next config reload; active tasks keep their settings.";
    } catch (error) { message.textContent = error.message; }
    finally { save.disabled = false; }
  });
  if (new URLSearchParams(location.search).get("settings") === "1") open();
}

export const SETTINGS_SCRIPT = `(${settingsClient.toString()})();`;
export const SETTINGS_STYLE = `
#settings-dialog { box-sizing: border-box; width: min(700px, calc(100vw - 24px)); height: auto; max-height: calc(100dvh - 24px); overflow: auto; padding: 24px; border-radius: 10px; }
#settings-dialog h2 { margin: 0; font-size: 20px; }
#settings-dialog p { line-height: 1.5; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 22px 0; }
.settings-grid label { display: flex; flex-direction: column; gap: 7px; }
.settings-grid input:not([type=checkbox]), .settings-grid select { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; background: Canvas; color: CanvasText; border: 1px solid #8888; border-radius: 4px; }
.settings-grid .settings-check { flex-direction: row; align-items: center; }
.settings-actions { display: flex; gap: 10px; justify-content: flex-end; }
.settings-actions button { padding: 8px 12px; }
#settings-save { background: #2563eb; color: white; border: 1px solid #2563eb; border-radius: 4px; }
#settings-message { overflow-wrap: anywhere; min-height: 20px; }
@media (max-width: 520px) { .settings-grid { grid-template-columns: 1fr; } }
`;
export const SETTINGS_HTML = `
<dialog id="settings-dialog" aria-labelledby="settings-title">
  <h2 id="settings-title">Repository settings</h2>
  <p>Edit <code>.todo/config.json</code>. Other configuration fields are preserved.</p>
  <form id="settings-form">
    <div class="settings-grid">
      <label>Workers <input name="workers" type="number" min="1" max="32" required></label>
      <label>Default model profile <select name="defaultModelProfile" required></select></label>
      <label>Execution mode <select name="executionMode"><option value="worktree">Isolated worktrees</option><option value="single-branch">Single branch</option></select></label>
      <label>Target branch <input name="targetBranch" list="settings-branches" placeholder="Current branch" autocomplete="off"></label>
      <label>Delivery <select name="delivery"><option value="keep">Keep task branch</option><option value="merge">Merge into target branch</option></select></label>
      <label>Git remote <input name="remote" required></label>
      <label>Retries (−1 = unlimited) <input name="retries" type="number" min="-1" required></label>
      <label class="settings-check"><input name="push" type="checkbox"> Push after delivery</label>
      <label>Task poll interval (ms) <input name="pollIntervalMs" type="number" min="250" max="60000" required></label>
      <label>Config reload interval (ms) <input name="configReloadIntervalMs" type="number" min="250" max="60000" required></label>
    </div>
    <datalist id="settings-branches"></datalist>
    <p id="settings-mode-help"></p>
    <p id="settings-message" role="status" aria-live="polite"></p>
    <div class="settings-actions"><button type="button" id="settings-reload">Reload</button><button type="button" id="settings-close">Close</button><button type="submit" id="settings-save" disabled>Save settings</button></div>
  </form>
</dialog>`;
