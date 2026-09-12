import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// Use the shipped MCP and its runtime launcher, including native peer authorization.
// This adapter deliberately exposes only renaming; task execution stays on app-server.
export function desktopTitleCommand(env = process.env) {
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) return null;
  const home = env.CODEX_HOME || path.join(homedir(), ".codex");
  const nodeResources = env.CODEX_MCP_NODE_PATH && path.resolve(path.dirname(env.CODEX_MCP_NODE_PATH), "..", "..");
  const roots = [
    env.CODEX_ELECTRON_RESOURCES_PATH && path.join(env.CODEX_ELECTRON_RESOURCES_PATH, "plugins", "openai-bundled", "plugins", "codex-app-tools"),
    nodeResources && path.join(nodeResources, "plugins", "openai-bundled", "plugins", "codex-app-tools"),
    path.join(home, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "codex-app-tools"),
  ].filter(Boolean);
  for (const root of roots) {
    const command = path.join(root, "scripts", process.platform === "win32"
      ? "launch_codex_app_tools_mcp.cmd" : "launch_codex_app_tools_mcp");
    const server = path.join(root, "server.mjs");
    if (existsSync(command) && existsSync(server)) return {
      command: env.CODEX_MCP_NODE_PATH || command, args: [server], cwd: root,
    };
  }
  throw new Error("Desktop title sync requires the bundled codex-app-tools MCP launcher");
}

export class DesktopTitleClient {
  constructor({ env = process.env, timeoutMs = 5000, command = null } = {}) {
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.command = command;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.initialize().catch(error => { this.close(); throw error; });
    return this.ready;
  }

  async initialize() {
    const launch = this.command || desktopTitleCommand(this.env);
    if (!launch) throw new Error("Desktop title sync has no host connection");
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let reply;
      try { reply = JSON.parse(line); } catch { this.close(); return; }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error) pending.reject(new Error(reply.error.message || "Desktop MCP request failed"));
      else pending.resolve(reply.result);
    });
    const disconnected = () => { if (this.child === child) this.close(); };
    child.once("error", disconnected);
    child.once("close", disconnected);
    child.stdin.on("error", disconnected);
    await this.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "todo-title", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const catalog = await this.request("tools/list", {});
    if (!catalog?.tools?.some(tool => tool.name === "set_thread_title")) {
      throw new Error("Desktop MCP does not expose set_thread_title");
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error("Desktop MCP disconnected")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => this.close(new Error(`Desktop MCP ${method} timed out`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async setThreadName(threadId, title) {
    await this.start();
    const result = await this.request("tools/call", {
      name: "set_thread_title", arguments: { threadId, title },
      _meta: { "openai/threadId": threadId },
    });
    if (!result || result.isError) {
      throw new Error(result?.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Desktop title update failed");
    }
  }

  close(error = new Error("Desktop MCP disconnected")) {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
