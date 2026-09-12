import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { AppServerClient } from "./app-server-client.mjs";

// Task roles, not a benchmark ranking. Keep original profile names stable.
export const DEFAULT_MODEL_PROFILES = [
  { name: "mini", model: "gpt-5.6-luna", reasoningEffort: "low", description: "Small, mechanical edits and simple bounded fixes." },
  { name: "fast", model: "gpt-5.6-luna", reasoningEffort: "medium", description: "Mechanical edits, straightforward fixes, and cost-sensitive routine work." },
  { name: "standard", model: "gpt-5.6-terra", reasoningEffort: "low", description: "Straightforward everyday implementation with clear requirements." },
  { name: "medium", model: "gpt-5.6-terra", reasoningEffort: "medium", description: "Bounded implementation across several files; balanced everyday coding." },
  { name: "proven", model: "gpt-5.6-sol", reasoningEffort: "medium", description: "Multi-step engineering and debugging with moderate reasoning." },
  { name: "advanced", model: "gpt-5.6-sol", reasoningEffort: "high", description: "Multi-step implementation, debugging, and substantial everyday engineering." },
  { name: "expert", model: "gpt-6-astra", reasoningEffort: "xhigh", description: "Most capable model for complex implementation work." },
  { name: "ultra", model: "gpt-6-astra", reasoningEffort: "max", description: "Most capable model for very complex, high-risk, cross-cutting work." },
];
const excludedModel = model => model === "gpt-5.3-codex-spark";
const legacyBuiltinModels = { mini: "gpt-5.4-mini", standard: "gpt-5.4", proven: "gpt-5.5", expert: "gpt-5.6-sol", ultra: "gpt-5.6-sol" };
// Keep intentional custom profiles, but do not automatically add pre-5.6 GPT models.
const legacyGeneration = model => {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
  return version && (Number(version[1]) < 5 || (Number(version[1]) === 5 && Number(version[2] || 0) < 6));
};
const visibleModels = catalog => catalog.models.filter(m => !excludedModel(m.model));
const CATALOG_TTL_MS = 5 * 60 * 1000;
const catalogPath = root => path.join(root, ".todo", "model-catalog.json");
const hash = value => createHash("sha256").update(value).digest("hex");
const inFlight = new Map();
const modelConfigKey = root => {
  try { return hash(JSON.stringify(JSON.parse(readFileSync(path.join(root, ".todo/config.json"), "utf8")).models ?? null)); }
  catch { return hash(""); }
};

export function readModelCatalog(root, command = "codex") {
  try {
    const value = JSON.parse(readFileSync(catalogPath(root), "utf8"));
    return value.command === command && value.configKey === modelConfigKey(root) && Array.isArray(value.models) &&
      Date.now() - Date.parse(value.checkedAt) < CATALOG_TTL_MS ? { ...value, models: visibleModels(value) } : null;
  } catch { return null; }
}

export async function refreshModelCatalog(root, command = "codex", { force = false } = {}) {
  if (!force) { const cached = readModelCatalog(root, command); if (cached) return cached; }
  const key = `${root}\0${command}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = (async () => {
    const configKey = modelConfigKey(root);
    const client = new AppServerClient({ command, cwd: root });
    let timer;
    try {
      const operation = (async () => {
        await client.start();
        const models = [], cursors = new Set();
        let cursor = null;
        do {
          const page = await client.request("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page.data)) throw new Error("model/list returned an invalid catalog");
          models.push(...page.data.map(item => ({ model: item.model || item.id,
            displayName: item.displayName, description: item.description, hidden: item.hidden === true,
            efforts: (item.supportedReasoningEfforts || []).map(e => e.reasoningEffort),
            defaultEffort: item.defaultReasoningEffort, inputModalities: item.inputModalities || [],
            upgrade: item.upgradeInfo?.model || item.upgrade || null,
            retirementAt: item.upgradeInfo?.retirementAt || null })));
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("model/list repeated a cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (!models.length || models.some(m => typeof m.model !== "string" || !m.model)) throw new Error("model/list returned no usable models");
        return { command, configKey, checkedAt: new Date().toISOString(), models: models.filter(m => !excludedModel(m.model)) };
      })();
      const catalog = await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out querying executor model/list")), 10000);
      })]);
      const file = catalogPath(root), temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(catalog, null, 2) + "\n");
      renameSync(temp, file);
      return catalog;
    } finally { clearTimeout(timer); await client.close(); }
  })();
  inFlight.set(key, request);
  try { return await request; } finally { inFlight.delete(key); }
}

export function profileDiagnostic(profile, catalog) {
  if (excludedModel(profile.model) || profile.name === "spark") return { name: profile.name, model: profile.model, status: "excluded", message: `Profile '${profile.name}' is excluded: Spark has been removed from ToDo. Use model_profiles to remove the outdated profile.` };
  if (!catalog) return { name: profile.name, model: profile.model, status: "unverified", message: "Executor availability has not been checked. Use model_profiles to refresh." };
  const model = catalog.models.find(m => m.model === profile.model);
  if (!model) return { name: profile.name, model: profile.model, status: "unsupported", message: `Profile '${profile.name}' is outdated or unavailable: model '${profile.model}' is not listed as supported by this executor. Review model_profiles before updating.` };
  if (model.retirementAt && model.retirementAt * 1000 <= Date.now()) return { name: profile.name, model: profile.model, status: "retired", replacement: model.upgrade, message: `Profile '${profile.name}' uses retired model '${profile.model}'. Suggested replacement: ${model.upgrade || "choose an available model"}.` };
  if (!model.efforts.includes(profile.reasoningEffort)) return { name: profile.name, model: profile.model, status: "unsupported-effort", message: `Profile '${profile.name}': '${profile.reasoningEffort}' is not supported by '${profile.model}'. Supported: ${model.efforts.join(", ")}.` };
  return { name: profile.name, model: profile.model, status: model.upgrade ? "deprecated" : "available", replacement: model.upgrade, message: model.upgrade ? `Suggested model update: ${model.upgrade}.` : null };
}
export const profileUsable = diagnostic => ["available", "deprecated", "unverified"].includes(diagnostic.status);

export function assertProfilesAvailable(profiles, catalog) {
  for (const profile of profiles) {
    const diagnostic = profileDiagnostic(profile, catalog);
    if (!profileUsable(diagnostic)) {
      const error = new Error(diagnostic.message); error.kind = "model_unavailable"; throw error;
    }
  }
}

export function modelProfilePlan(root, catalog) {
  const file = path.join(root, ".todo", "config.json");
  const text = readFileSync(file, "utf8");
  const config = JSON.parse(text);
  const current = Array.isArray(config.models) ? config.models : DEFAULT_MODEL_PROFILES;
  if (config.models === undefined) {
    const profiles = { models: DEFAULT_MODEL_PROFILES, defaultModelProfile: config.defaultModelProfile || "expert" };
    return { source: "plugin", checkedAt: catalog.checkedAt, executor: catalog.command,
      models: visibleModels(catalog), diagnostics: current.map(p => profileDiagnostic(p, catalog)),
      current: profiles, proposed: profiles, changes: [], changed: false,
      planId: hash(text + JSON.stringify(catalog.models)), next: config,
      message: "Profiles are inherited from the plugin. Updating the plugin updates future attempts without writing a models block." };
  }
  const supported = visibleModels(catalog).filter(m => !m.hidden && !(m.retirementAt && m.retirementAt * 1000 <= Date.now()));
  const recommended = DEFAULT_MODEL_PROFILES.filter(p => supported.some(m => m.model === p.model)).map(p => {
    const model = supported.find(m => m.model === p.model);
    return { ...p, reasoningEffort: model.efforts.includes(p.reasoningEffort) ? p.reasoningEffort : model.defaultEffort };
  });
  for (const model of supported) {
    if (legacyGeneration(model.model)) continue;
    if (recommended.some(p => p.model === model.model) || current.some(p =>
      p?.model === model.model && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.name || "") && profileUsable(profileDiagnostic(p, catalog)))) continue;
    let name = `model-${model.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`;
    while (recommended.some(p => p.name === name) || current.some(p => p?.name === name)) name += "-new";
    recommended.push({ name, model: model.model, reasoningEffort: model.defaultEffort,
      description: model.description || "New executor model; review task suitability before use." });
  }
  const diagnostics = current.map(p => p && typeof p === "object" ? profileDiagnostic(p, catalog) : { status: "invalid", message: "Profile must be an object." });
  const proposed = [...recommended];
  for (const profile of current) {
    if (!profile || typeof profile !== "object" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.name || "")) continue;
    if (excludedModel(profile.model) || profile.name === "spark") continue;
    const builtin = DEFAULT_MODEL_PROFILES.find(p => p.name === profile.name);
    const legacyBuiltin = legacyBuiltinModels[profile.name] === profile.model;
    if (builtin?.model === profile.model) {
      // A familiar profile name can still carry an intentional custom effort.
      if (profileUsable(profileDiagnostic(profile, catalog))) {
        const index = proposed.findIndex(p => p.name === profile.name);
        if (index >= 0) proposed[index] = { ...profile };
        else proposed.push({ ...profile });
      }
      continue;
    }
    if (legacyBuiltin && proposed.some(p => p.name === profile.name)) continue;
    const model = catalog.models.find(m => m.model === profile.model);
    const replacement = model?.upgrade && supported.find(m => m.model === model.upgrade);
    let candidate = { ...profile };
    if (replacement) candidate = { ...candidate, model: replacement.model,
      reasoningEffort: replacement.efforts.includes(profile.reasoningEffort) ? profile.reasoningEffort : replacement.defaultEffort };
    else if (model && supported.includes(model) && !model.efforts.includes(candidate.reasoningEffort)) candidate.reasoningEffort = model.defaultEffort;
    if (!profileUsable(profileDiagnostic(candidate, catalog))) continue;
    const index = proposed.findIndex(p => p.name === candidate.name);
    if (index >= 0) proposed[index] = candidate; else proposed.push(candidate);
  }
  const defaultModelProfile = proposed.some(p => p.name === config.defaultModelProfile) ? config.defaultModelProfile
    : proposed.find(p => p.name === "expert")?.name || proposed.find(p => p.name === "advanced")?.name || proposed[0]?.name;
  const next = { ...config, models: proposed, defaultModelProfile };
  const changes = current.map(profile => {
    const replacement = proposed.find(p => p.name === profile?.name);
    return { profile: profile?.name || null, before: profile, after: replacement || null,
      action: !replacement ? "remove" : JSON.stringify(profile) === JSON.stringify(replacement) ? "keep" : "update" };
  }).concat(proposed.filter(p => !current.some(old => old?.name === p.name)).map(p => ({ profile: p.name, action: "add", after: p })));
  return { checkedAt: catalog.checkedAt, executor: catalog.command,
    models: visibleModels(catalog), diagnostics, current: { models: current, defaultModelProfile: config.defaultModelProfile || "expert" },
    changes,
    proposed: { models: proposed, defaultModelProfile },
    planId: hash(text + JSON.stringify(catalog.models) + JSON.stringify(next)),
    changed: JSON.stringify(current) !== JSON.stringify(proposed) || config.defaultModelProfile !== defaultModelProfile,
    next };
}

export function applyModelProfilePlan(root, catalog, planId) {
  const plan = modelProfilePlan(root, catalog);
  if (plan.planId !== planId) throw new Error("Model update preview is stale. Inspect model_profiles again before applying.");
  if (!plan.changed) return { applied: false, source: plan.source || "config", profiles: plan.proposed };
  if (!plan.proposed.models.length) throw new Error("No supported models; configuration was not changed.");
  const names = new Set();
  for (const profile of plan.proposed.models) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.name || "") || names.has(profile.name) ||
        !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(profile.reasoningEffort)) {
      throw new Error("Proposed profiles need explicit classification; inspect model_profiles before applying.");
    }
    names.add(profile.name);
  }
  const file = path.join(root, ".todo", "config.json");
  const backup = `${file}.models-${Date.now()}.bak`;
  writeFileSync(backup, readFileSync(file), { flag: "wx", mode: 0o600 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(plan.next, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return { applied: true, backupPath: backup, profiles: plan.proposed, taskProfileReferencesPreserved: true };
}
