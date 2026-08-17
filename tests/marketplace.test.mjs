import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    paths.push(entryPath);
    if (entry.isDirectory()) paths.push(...await walk(entryPath));
  }
  return paths;
}

function packageRoot(entry) {
  return path.resolve(repoRoot, entry.source.path);
}

test("marketplace exposes self-contained plugin packages", async () => {
  const marketplace = await readJson(marketplacePath);
  assert.equal(marketplace.name, "blackbone");
  assert.equal(marketplace.interface.displayName, "Blackbone");
  assert.ok(marketplace.plugins.length > 0);

  const names = new Set();
  for (const entry of marketplace.plugins) {
    assert.equal(names.has(entry.name), false, `duplicate plugin ${entry.name}`);
    names.add(entry.name);
    assert.equal(entry.source.source, "local");
    assert.equal(entry.source.path, `./plugins/${entry.name}`);
    assert.equal(entry.policy.installation, "AVAILABLE");
    assert.equal(entry.policy.authentication, "ON_INSTALL");

    const root = packageRoot(entry);
    await access(path.join(root, ".codex-plugin/plugin.json"));
    await access(path.join(root, "README.md"));
  }

  assert.ok(names.has("todo"));
});

test("root documentation indexes every marketplace plugin", async () => {
  const marketplace = await readJson(marketplacePath);
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  for (const file of [
    ".github/workflows/test.yml",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "Makefile",
    "SECURITY.md",
    "docs/ARCHITECTURE.md",
  ]) {
    await access(path.join(repoRoot, file));
  }

  for (const entry of marketplace.plugins) {
    assert.match(readme, new RegExp(`plugins/${entry.name}/README\\.md`));
  }

  const license = await readFile(path.join(repoRoot, "LICENSE"), "utf8");
  assert.match(license, /^MIT License/m);
  assert.match(license, /Permission is hereby granted/);

  const workflow = await readFile(
    path.join(repoRoot, ".github/workflows/test.yml"),
    "utf8",
  );
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /run: make test/);

  const makefile = await readFile(path.join(repoRoot, "Makefile"), "utf8");
  assert.match(makefile, /^test:\n\tnpm test$/m);
});

test("plugin manifests match directory identity and document screenshots", async () => {
  const marketplace = await readJson(marketplacePath);

  for (const entry of marketplace.plugins) {
    const root = packageRoot(entry);
    const manifest = await readJson(path.join(root, ".codex-plugin/plugin.json"));
    assert.equal(manifest.name, path.basename(root));
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    assert.ok(Array.isArray(manifest.interface.screenshots));
    assert.ok(manifest.interface.screenshots.length >= 2);

    for (const screenshot of manifest.interface.screenshots) {
      assert.match(screenshot, /^\.\/assets\/.*\.png$/);
      const screenshotPath = path.resolve(root, screenshot);
      assert.equal(screenshotPath.startsWith(`${root}${path.sep}`), true);
      const header = await readFile(screenshotPath);
      assert.deepEqual([...header.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(header.readUInt32BE(16) >= 800, `${screenshot} is too narrow`);
      assert.ok(header.readUInt32BE(20) >= 700, `${screenshot} is too short`);
    }
  }
});

test("relative documentation links resolve", async () => {
  const markdownFiles = (await walk(repoRoot)).filter((file) => file.endsWith(".md"));
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const file of markdownFiles) {
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(linkPattern)) {
      const destination = match[1].split("#", 1)[0];
      if (!destination || /^(?:[a-z]+:|#)/i.test(destination)) continue;
      await access(path.resolve(path.dirname(file), decodeURIComponent(destination)));
    }
  }
});

test("ToDo MCP server resolves from the installed plugin root", async () => {
  const pluginRoot = path.join(repoRoot, "plugins/todo");
  const manifest = await readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
  const mcp = await readJson(path.join(pluginRoot, ".mcp.json"));
  const server = mcp.mcpServers.todo;

  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.displayName, "ToDo");
  assert.equal(server.command, "sh");
  assert.deepEqual(server.args, [
    "-c",
    "exec node \"$PLUGIN_ROOT/scripts/mcp-server.mjs\"",
  ]);
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.env, { PLUGIN_ROOT: "." });
  assert.doesNotMatch(server.args.join(" "), /\$HOME\/plugins\/todo/);
  await access(path.join(pluginRoot, "scripts/mcp-server.mjs"));

  const skills = await readdir(path.join(pluginRoot, "skills"), {
    withFileTypes: true,
  });
  assert.equal(skills.filter((entry) => entry.isDirectory()).length, 16);
});

test("packages exclude local Finder metadata", async () => {
  const packagedPaths = await walk(repoRoot);
  assert.equal(
    packagedPaths.some((entryPath) => path.basename(entryPath) === ".DS_Store"),
    false,
  );
});
