import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code sends no session or turn in MCP request metadata. The session
// hooks record the current session and prompt under the Claude process ID,
// which is also the parent of this per-session stdio MCP server.
function sessionsDir(env = process.env) {
  const base = env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), `todo-claude-${process.getuid?.() ?? "user"}`);
  return path.join(base, "sessions");
}

export function claudeTurnPath(claudePid, env = process.env) {
  return path.join(sessionsDir(env), `${claudePid}.json`);
}

export function recordClaudeTurn(claudePid, { sessionId, promptId }, env = process.env) {
  if (!Number.isInteger(claudePid) || claudePid <= 0 || typeof sessionId !== "string" || !sessionId) return false;
  const file = claudeTurnPath(claudePid, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ sessionId, promptId: promptId || null, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed */ }
  }
  return true;
}

export function readClaudeTurn(claudePid, env = process.env) {
  try {
    const value = JSON.parse(readFileSync(claudeTurnPath(claudePid, env), "utf8"));
    return typeof value?.sessionId === "string" && value.sessionId ? value : null;
  } catch {
    return null;
  }
}

export function executionOwner(metadata = {}, env = process.env) {
  const firstString = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim();
  const explicitThread = firstString(metadata.threadId, metadata.thread?.id);
  if (explicitThread) {
    return { threadId: explicitThread, turnId: firstString(metadata.turnId, metadata.turn?.id) || null };
  }
  const turn = readClaudeTurn(process.ppid);
  return turn ? { threadId: turn.sessionId, turnId: turn.promptId || null } : null;
}
