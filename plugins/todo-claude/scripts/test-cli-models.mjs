// Test helper: a Claude CLI model list as the CLI reports it, so starting a
// runner or saving settings never calls the real Claude CLI.
import { loadConfig } from "./lib.mjs";
import { writeCliModels } from "./claude-models.mjs";

const all = ["low", "medium", "high", "xhigh", "max"];
export const TEST_CLI_MODELS = [
  { model: "claude-sonnet-5-5", aliases: ["sonnet"], displayName: "Sonnet 5.5", efforts: all, supportsEffort: true },
  { model: "claude-opus-5-5", aliases: ["opus"], displayName: "Opus 5.5", efforts: all, supportsEffort: true },
  { model: "claude-fable-5-1", aliases: ["fable"], displayName: "Fable 5.1", efforts: all, supportsEffort: true },
  { model: "claude-haiku-4-5-20251001", aliases: ["haiku"], displayName: "Haiku 4.5", efforts: [], supportsEffort: false },
  { model: "claude-sonnet-4-6", aliases: [], displayName: "Sonnet 4.6", efforts: ["low", "medium", "high", "max"], supportsEffort: true },
];

export function seedCliModels(root, command = loadConfig(root).codexCommand, models = TEST_CLI_MODELS) {
  writeCliModels(root, command, models);
}
