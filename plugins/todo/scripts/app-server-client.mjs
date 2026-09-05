import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function protocolError(message) {
  const detail = message?.error?.message || "Codex app-server request failed";
  const error = new Error(detail);
  error.code = message?.error?.code;
  error.data = message?.error?.data;
  return error;
}

function turnKey(threadId, turnId) {
  return `${threadId}:${turnId}`;
}

export class AppServerClient {
  constructor({ command = "codex", cwd, env = process.env, onStderr, onServerRequest } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.onStderr = onStderr;
    this.onServerRequest = onServerRequest;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turnHandlers = new Map();
    this.threadHandlers = new Map();
    this.turnCompletions = new Map();
    this.loadedThreads = new Set();
    this.closed = false;
  }

  get pid() {
    return this.child?.pid || null;
  }

  get running() {
    return Boolean(
      this.child &&
        this.child.exitCode === null &&
        this.child.signalCode === null &&
        !this.closed,
    );
  }

  async start() {
    if (this.child) return this;
    this.child = spawn(this.command, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.onStderr?.(chunk));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("close", (code, signal) => {
      if (!this.closed) {
        this.failAll(
          new Error(
            `Codex app-server exited (${signal || `code ${String(code)}`})`,
          ),
        );
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "todo", title: "ToDo", version: "1" },
    });
    this.notify("initialized", {});
    return this;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onStderr?.(`Invalid app-server JSON: ${line}\n`);
      return;
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(protocolError(message));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      if (this.onServerRequest) {
        Promise.resolve().then(() => this.onServerRequest(message)).then(
          result => this.write({ id: message.id, result }),
          error => this.write({ id: message.id, error: { code: -32601, message: error.message } }),
        ).catch(error => this.onStderr?.(`${error.message}\n`));
        return;
      }
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: `Interactive server request is unsupported: ${message.method}`,
        },
      });
    }
    const params = message.params || {};
    const threadId = params.threadId;
    const turnId = params.turnId || params.turn?.id;
    if (threadId && turnId) {
      const handler =
        this.turnHandlers.get(turnKey(threadId, turnId)) ||
        this.threadHandlers.get(threadId);
      handler?.(message, line);
    }
    if (message.method === "turn/completed" && threadId && turnId) {
      const key = turnKey(threadId, turnId);
      const completion = this.turnCompletions.get(key);
      if (completion?.resolve) {
        this.turnCompletions.delete(key);
        completion.resolve(params.turn);
      } else {
        this.turnCompletions.set(key, { turn: params.turn });
      }
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error("Codex app-server is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  async startThread(params) {
    const response = await this.request("thread/start", {
      ...params,
      ephemeral: false,
    });
    this.loadedThreads.add(response.thread.id);
    return response.thread;
  }

  async resumeThread(threadId, params = {}) {
    if (this.loadedThreads.has(threadId)) return null;
    const response = await this.request("thread/resume", {
      ...params,
      threadId,
    });
    this.loadedThreads.add(threadId);
    return response.thread;
  }

  async archiveThread(threadId) {
    await this.request("thread/archive", { threadId });
    this.loadedThreads.delete(threadId);
  }

  async unarchiveThread(threadId) {
    await this.request("thread/unarchive", { threadId });
  }

  async setThreadName(threadId, name) {
    await this.request("thread/name/set", { threadId, name });
  }

  async startTurn(params, onMessage) {
    this.threadHandlers.set(params.threadId, onMessage);
    let response;
    try {
      response = await this.request("turn/start", params);
    } catch (error) {
      this.threadHandlers.delete(params.threadId);
      throw error;
    }
    const turnId = response.turn.id;
    this.turnHandlers.set(turnKey(params.threadId, turnId), onMessage);
    return turnId;
  }

  waitForTurn(threadId, turnId) {
    const key = turnKey(threadId, turnId);
    const cached = this.turnCompletions.get(key);
    if (cached?.turn) {
      this.turnCompletions.delete(key);
      this.turnHandlers.delete(key);
      this.threadHandlers.delete(threadId);
      return Promise.resolve(cached.turn);
    }
    return new Promise((resolve, reject) => {
      this.turnCompletions.set(key, {
        resolve: (turn) => {
          this.turnHandlers.delete(key);
          this.threadHandlers.delete(threadId);
          resolve(turn);
        },
        reject,
      });
    });
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  steerTurn(threadId, turnId, text) {
    return this.request("turn/steer", {
      threadId, expectedTurnId: turnId, input: [{ type: "text", text }],
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const completion of this.turnCompletions.values()) {
      completion.reject?.(error);
    }
    this.turnCompletions.clear();
    this.turnHandlers.clear();
    this.threadHandlers.clear();
  }

  async close() {
    if (!this.child) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child.stdin.writable) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", resolve);
    });
    const graceful = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
    this.failAll(new Error("Codex app-server closed"));
  }
}
