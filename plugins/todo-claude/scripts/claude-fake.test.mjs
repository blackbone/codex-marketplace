#!/usr/bin/env node
// Test double for `claude -p --output-format stream-json --input-format stream-json`.
// Behavior is selected by markers in the user prompt:
//   FAKE:EDIT <file>   write <file> in the working directory before answering
//   FAKE:FAIL          finish with an API error result
//   FAKE:RATE          finish with an API 429 result
//   FAKE:SLOW          wait for more input (steer) or SIGINT before answering
// Every invocation is appended to $FAKE_CLAUDE_LOG; sessions live in
// $FAKE_CLAUDE_SESSIONS so --resume of an unknown session fails like Claude.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.284 (Claude Code)\n");
  process.exit(0);
}
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const sessionsDir = process.env.FAKE_CLAUDE_SESSIONS || path.join(process.cwd(), ".fake-claude-sessions");
const resume = value("--resume");
const sessionId = resume || value("--session-id");
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), worker: process.env.TODO_RUNNER_WORKER || null })}\n`);
}
if (resume && !existsSync(path.join(sessionsDir, resume))) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(path.join(sessionsDir, sessionId), "");

const emit = (event) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...event })}\n`);
const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 30, output_tokens_details: { thinking_tokens: 5 } };
const schema = value("--json-schema") ? JSON.parse(value("--json-schema")) : null;
let pending = [];
let slowWaiting = false;

function answer(text) {
  if (text.includes("FAKE:FAIL")) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 500, result: "upstream failure", usage });
    return;
  }
  if (text.includes("FAKE:RATE")) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, result: "Rate limited", usage });
    return;
  }
  const edit = /FAKE:EDIT (\S+)/.exec(text);
  if (edit) {
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-edit", name: "Write", input: { file_path: edit[1] } }] } });
    writeFileSync(path.join(process.cwd(), edit[1]), `written by fake claude\n`);
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-edit", content: "ok", is_error: false }] } });
  }
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "echo check" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "check", is_error: false }] } });
  const structured = schema
    ? { status: "completed", summary: `done: ${text.slice(0, 40).replace(/\s+/g, " ")}`, error: null, validation: ["fake check"], requiresInteractive: false, interactiveReason: null }
    : null;
  emit({ type: "result", subtype: "success", is_error: false, result: structured ? JSON.stringify(structured) : "done", structured_output: structured, usage });
}

emit({ type: "system", subtype: "init", cwd: process.cwd(), model: value("--model") });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const text = JSON.parse(line).message.content.map((part) => part.text || "").join("\n");
  if (slowWaiting) {
    slowWaiting = false;
    answer(`${pending.join("\n")}\n${text}`);
    answer(text);
    return;
  }
  if (text.includes("FAKE:SLOW")) {
    slowWaiting = true;
    pending.push(text.replace("FAKE:SLOW", ""));
    return;
  }
  answer(text);
});
process.on("SIGINT", () => process.exit(130));
