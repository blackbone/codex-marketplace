import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { atomicWriteJson, configPath, DEFAULT_CONFIG, listTaskStatuses, loadConfig } from "./lib.mjs";
import { hostModels, withHostModels } from "./host.mjs";
import { DEFAULT_MODEL_PROFILES } from "./model-profiles.mjs";
import { cliModels, profileProblems, readCliModels } from "./claude-models.mjs";

const numericFields = { workers: [1, 32], retries: [-1, Number.MAX_SAFE_INTEGER], pollIntervalMs: [250, 60000], configReloadIntervalMs: [250, 60000] };
const gitFields = ["executionMode", "delivery", "targetBranch", "remote", "push"];
const revision = text => createHash("sha256").update(text).digest("hex");
const profileFields = profile => ({ name: profile?.name, model: profile?.model, reasoningEffort: profile?.reasoningEffort,
  ...(profile?.description !== undefined ? { description: profile.description } : {}) });
const CLOSED = new Set(["completed", "rejected", "canceled", "cancelled"]);

// Open tasks per model profile; a profile they use cannot be removed.
function profileUsage(repoRoot) {
  const usage = {};
  for (const task of listTaskStatuses(repoRoot, { recoverUsage: false })) {
    const name = task.execution?.modelProfile;
    if (name && !CLOSED.has(task.status)) (usage[name] ||= []).push(task.id);
  }
  return usage;
}

export function readSettings(repoRoot) {
  const text = readFileSync(configPath(repoRoot), "utf8");
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must contain an object");
  const config = loadConfig(repoRoot);
  const branches = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: repoRoot, encoding: "utf8", timeout: 3000, windowsHide: true });
  const configured = hostModels(raw.models);
  const modelProfiles = (Array.isArray(configured) ? configured : DEFAULT_MODEL_PROFILES).map(profileFields);
  const values = Object.fromEntries([...Object.keys(numericFields), "defaultModelProfile"].map(key => [key, raw[key] ?? DEFAULT_CONFIG[key]]).concat([["git", Object.fromEntries(gitFields.map(key => [key, raw.git?.[key] ?? DEFAULT_CONFIG.git[key]]))]]));
  values.modelProfiles = modelProfiles;
  const catalog = readCliModels(repoRoot, config.codexCommand);
  return {
    revision: revision(text),
    values,
    profiles: config.modelProfiles.map(profile => profile.name),
    profilesInherited: !Array.isArray(configured),
    modelCatalog: catalog,
    profileProblems: profileProblems(modelProfiles, values.defaultModelProfile, catalog),
    profileUsage: profileUsage(repoRoot),
    branches: branches.status === 0 ? branches.stdout.trim().split("\n").filter(Boolean) : [],
    warning: config.readError,
  };
}

export async function saveSettings(repoRoot, input, { fetchModels } = {}) {
  const file = configPath(repoRoot);
  const text = readFileSync(file, "utf8");
  if (input?.revision !== revision(text)) throw new Error("Settings changed elsewhere. Reload settings before saving.");
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must contain an object");
  const values = input.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Settings must be an object");
  const allowed = [...Object.keys(numericFields), "defaultModelProfile", "git", "modelProfiles"];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error("Unsupported settings field");
  for (const [key, [min, max]] of Object.entries(numericFields)) {
    if (!Number.isSafeInteger(values[key]) || values[key] < min || values[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  const config = loadConfig(repoRoot);
  let profiles = null;
  if (values.modelProfiles !== undefined) {
    if (!Array.isArray(values.modelProfiles)) throw new Error("Model profiles must be a list");
    profiles = values.modelProfiles.map(profileFields).map(p => (p.description === "" ? profileFields({ ...p, description: undefined }) : p));
    const catalog = await cliModels(repoRoot, config.codexCommand, fetchModels ? { fetch: fetchModels } : {});
    const problems = profileProblems(profiles, values.defaultModelProfile, catalog);
    if (problems.length) {
      const error = new Error(`Model profiles are invalid:\n${problems.map(p => (p.profile ? `${p.profile}: ${p.message}` : p.message)).join("\n")}`);
      error.profileProblems = problems;
      throw error;
    }
    const usage = profileUsage(repoRoot);
    const removed = Object.keys(usage).filter(name => !profiles.some(p => p.name === name));
    if (removed.length) throw new Error(`Open tasks still use ${removed.map(name => `'${name}' (${usage[name].map(id => id.split("-")[0]).join(", ")})`).join(", ")}; keep those profiles or update the tasks first`);
  } else if (!config.modelProfiles.some(profile => profile.name === values.defaultModelProfile)) throw new Error("Select a configured model profile");
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
  const { modelProfiles: _profiles, ...plain } = values;
  const next = { ...raw, ...plain, git: { ...raw.git, ...git } };
  atomicWriteJson(file, profiles ? withHostModels(next, profiles) : next);
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
    profileRows = data.values.modelProfiles.map(p => ({ ...p, description: p.description ?? "" }));
    catalog = data.modelCatalog;
    renderProfiles();
    if (!catalog || catalog.error) refreshModels(false);
    modeChanged();
  }
  let profileRows = [], catalog = null, loadingModels = false;
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  // Matches by id, alias, or dated id, as findCliModel in claude-models.mjs.
  const catalogEntry = model => catalog?.models.find(m => m.model === model || m.aliases.includes(model)) ||
    catalog?.models.find(m => m.model.startsWith(model + "-") && /^\d{8}$/.test(m.model.slice(model.length + 1)));
  const effortsOf = model => { const entry = catalogEntry(model); return entry?.supportsEffort ? entry.efforts : efforts; };
  // Mirrors profileProblems in claude-models.mjs; the save re-checks on the server.
  function problems() {
    const list = [], names = new Set();
    if (!profileRows.length) list.push({ index: -1, message: "Add at least one model profile." });
    if (catalog && !catalog.models.length) list.push({ index: -1, message: "The Claude CLI model list is unavailable" + (catalog.error ? ": " + catalog.error : ".") });
    profileRows.forEach((p, index) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.name)) list.push({ index, message: "Name must be lowercase letters, digits and single hyphens." });
      else if (names.has(p.name)) list.push({ index, message: `Profile name '${p.name}' is used twice.` });
      names.add(p.name);
      if (catalog?.models.length && !catalogEntry(p.model)) list.push({ index, message: `Model '${p.model}' is not in the Claude CLI model list.` });
      if (!effortsOf(p.model).includes(p.reasoningEffort)) list.push({ index, message: `Effort '${p.reasoningEffort}' is not supported by '${p.model}'.` });
    });
    if (!profileRows.some(p => p.name === field("defaultModelProfile").value)) list.push({ index: -1, message: "The default profile is not in the list." });
    return list;
  }
  async function refreshModels(force) {
    loadingModels = true;
    renderProfiles();
    try {
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json", "X-ToDo-Action": "1" }, body: JSON.stringify({ force }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      catalog = data;
    } catch (error) { message.textContent = error.message; }
    finally { loadingModels = false; renderProfiles(); }
  }
  function renderProfiles() {
    const body = document.querySelector("#settings-profiles");
    const issues = problems();
    const defaultSelect = field("defaultModelProfile"), current = defaultSelect.value || loaded?.values.defaultModelProfile;
    defaultSelect.replaceChildren(...profileRows.filter(p => p.name).map(p => new Option(p.name, p.name)));
    defaultSelect.value = current;
    document.querySelector("#settings-models-state").textContent = loadingModels ? "Loading the Claude CLI model list…"
      : catalog ? `${catalog.models.length} models from the Claude CLI, ${new Date(catalog.checkedAt).toLocaleString()}` : "";
    body.replaceChildren(...profileRows.map((p, index) => {
      const row = document.createElement("tr");
      const cell = node => { const td = document.createElement("td"); td.append(node); row.append(td); return td; };
      const name = Object.assign(document.createElement("input"), { value: p.name, required: true, ariaLabel: "Profile name" });
      name.addEventListener("change", () => { p.name = name.value.trim(); renderProfiles(); });
      const entry = catalogEntry(p.model);
      const model = document.createElement("select");
      const options = (catalog?.models || []).map(m => new Option(`${m.displayName} (${m.model})`, m.model));
      if (!catalog?.models.some(m => m.model === p.model)) options.unshift(new Option(entry ? `${entry.displayName} (${p.model})` : `${p.model} (not in list)`, p.model));
      model.replaceChildren(...options); model.value = p.model;
      model.addEventListener("change", () => {
        p.model = model.value;
        if (!effortsOf(p.model).includes(p.reasoningEffort)) p.reasoningEffort = effortsOf(p.model).includes("high") ? "high" : effortsOf(p.model)[0];
        renderProfiles();
      });
      const effort = document.createElement("select");
      effort.replaceChildren(...effortsOf(p.model).map(e => new Option(e, e)));
      effort.value = p.reasoningEffort;
      effort.addEventListener("change", () => { p.reasoningEffort = effort.value; renderProfiles(); });
      const description = Object.assign(document.createElement("input"), { value: p.description, placeholder: "When to use it", ariaLabel: "Description" });
      description.addEventListener("change", () => { p.description = description.value; });
      const state = document.createElement("span");
      state.className = "profile-state " + (!catalog ? "pending" : entry ? "ok" : "bad");
      state.textContent = !catalog ? "loading…" : entry ? "listed" : "not listed";
      const used = loaded.profileUsage[p.name]?.length || 0;
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: used ? `In use (${used})` : "Remove", disabled: used > 0,
        title: used ? `Open tasks use this profile: ${loaded.profileUsage[p.name].join(", ")}` : "" });
      remove.addEventListener("click", () => { profileRows.splice(index, 1); renderProfiles(); });
      cell(name); cell(model); cell(effort); cell(description); cell(state); cell(remove);
      const mine = issues.filter(i => i.index === index);
      if (mine.length) { row.classList.add("profile-invalid"); state.title = mine.map(i => i.message).join("\n"); }
      return row;
    }));
    const list = document.querySelector("#settings-profile-problems");
    list.replaceChildren(...issues.map(i => Object.assign(document.createElement("li"),
      { textContent: (i.index >= 0 ? `${profileRows[i.index]?.name || "#" + (i.index + 1)}: ` : "") + i.message })));
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
  document.querySelector("#settings-profile-add").addEventListener("click", () => {
    let name = "custom";
    for (let i = 2; profileRows.some(p => p.name === name); i += 1) name = `custom-${i}`;
    profileRows.push({ name, model: catalog?.models[0]?.model || "claude-sonnet-5-5", reasoningEffort: "medium", description: "" });
    renderProfiles();
  });
  document.querySelector("#settings-profile-check").addEventListener("click", () => refreshModels(true));
  field("defaultModelProfile").addEventListener("change", renderProfiles);
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
    values.modelProfiles = profileRows.map(({ description, ...p }) => (description ? { ...p, description } : p));
    const blocking = problems();
    if (blocking.length) { message.textContent = "Fix the model profiles first."; save.disabled = false; return; }
    message.textContent = "Saving…";
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
#settings-dialog { box-sizing: border-box; width: min(960px, calc(100vw - 24px)); height: auto; max-height: calc(100dvh - 24px); overflow: auto; padding: 24px; border-radius: 10px; }
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
.settings-profiles-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.settings-profiles h3 { margin: 0; font-size: 16px; }
.settings-profiles table { width: 100%; border-collapse: collapse; }
.settings-profiles td, .settings-profiles th { padding: 4px; text-align: left; vertical-align: middle; }
.settings-profiles input, .settings-profiles select { box-sizing: border-box; width: 100%; padding: 6px; font: inherit; background: Canvas; color: CanvasText; border: 1px solid #8888; border-radius: 4px; }
.settings-profiles tr.profile-invalid input, .settings-profiles tr.profile-invalid select { border-color: #f85149; }
.profile-state.ok { color: #2ea043; } .profile-state.bad { color: #f85149; } .profile-state.pending { color: #d29922; }
#settings-profile-problems { color: #f85149; padding-left: 18px; }
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
    <section class="settings-profiles">
      <div class="settings-profiles-head"><h3>Model profiles</h3><span><button type="button" id="settings-profile-check">Reload model list</button> <button type="button" id="settings-profile-add">Add profile</button></span></div>
      <p>Each task runs with one profile. Models come from the Claude CLI model list; the runner does not start while any profile is invalid. <span id="settings-models-state"></span></p>
      <table><thead><tr><th>Name</th><th>Model</th><th>Effort</th><th>Description</th><th>Status</th><th></th></tr></thead><tbody id="settings-profiles"></tbody></table>
      <ul id="settings-profile-problems"></ul>
    </section>
    <datalist id="settings-branches"></datalist>
    <p id="settings-mode-help"></p>
    <p id="settings-message" role="status" aria-live="polite"></p>
    <div class="settings-actions"><button type="button" id="settings-reload">Reload</button><button type="button" id="settings-close">Close</button><button type="submit" id="settings-save" disabled>Save settings</button></div>
  </form>
</dialog>`;
