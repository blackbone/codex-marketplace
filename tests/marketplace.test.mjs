import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json");
const pluginRoot = path.join(repoRoot, "plugins/todo");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    paths.push(entryPath);
    if (entry.isDirectory()) {
      paths.push(...await walk(entryPath));
    }
  }
  return paths;
}

test("marketplace exposes the packaged ToDo plugin", async () => {
  const marketplace = await readJson(marketplacePath);
  assert.equal(marketplace.name, "scabr");
  assert.equal(marketplace.interface.displayName, "Scabr");
  assert.equal(marketplace.plugins.length, 1);

  const [entry] = marketplace.plugins;
  assert.deepEqual(entry, {
    name: "todo",
    source: {
      source: "local",
      path: "./plugins/todo"
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL"
    },
    category: "Productivity"
  });

  const resolvedPluginRoot = path.resolve(repoRoot, entry.source.path);
  assert.equal(resolvedPluginRoot, pluginRoot);
  await access(path.join(resolvedPluginRoot, ".codex-plugin/plugin.json"));
});

test("plugin manifest and directory identity match", async () => {
  const manifest = await readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
  assert.equal(manifest.name, path.basename(pluginRoot));
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.displayName, "ToDo");
});

test("bundled MCP server resolves from the installed plugin root", async () => {
  const mcp = await readJson(path.join(pluginRoot, ".mcp.json"));
  const server = mcp.mcpServers.todo;

  assert.equal(server.command, "sh");
  assert.deepEqual(server.args, [
    "-c",
    "exec node \"$PLUGIN_ROOT/scripts/mcp-server.mjs\""
  ]);
  assert.doesNotMatch(server.args.join(" "), /\$HOME\/plugins\/todo/);
  await access(path.join(pluginRoot, "scripts/mcp-server.mjs"));
});

test("package excludes local Finder metadata", async () => {
  const packagedPaths = await walk(repoRoot);
  assert.equal(packagedPaths.some((entryPath) => path.basename(entryPath) === ".DS_Store"), false);
});
