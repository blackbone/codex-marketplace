// Shared fake executor catalog for integration tests; no production bypass.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL_PROFILES } from "./model-profiles.mjs";
export function fakeModelList(root = process.cwd()) {
  const models = new Set(DEFAULT_MODEL_PROFILES.map(p => p.model));
  const folder = path.join(root, ".todo");
  for (const sub of [folder, path.join(folder, "history")]) {
    if (!existsSync(sub)) continue;
    for (const file of readdirSync(sub).filter(n => /\.(json|md)$/.test(n))) {
      const text = readFileSync(path.join(sub, file), "utf8");
      for (const match of text.matchAll(/"model"\s*:\s*"([^"]+)"/g)) models.add(match[1]);
    }
  }
  return { data: [...models].map(model => ({ id: model, model, description: "test fixture",
    defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(reasoningEffort => ({ reasoningEffort })) })), nextCursor: null };
}
