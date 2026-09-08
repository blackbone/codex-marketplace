export function executionOwner(metadata = {}, env = process.env) {
  let turn = metadata["x-codex-turn-metadata"];
  if (typeof turn === "string") { try { turn = JSON.parse(turn); } catch { turn = null; } }
  const firstString = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim();
  const threadId = firstString(metadata["openai/threadId"], metadata["openai/thread_id"], metadata.codexThreadId,
    metadata.threadId, turn?.thread_id, metadata.thread?.id, env.CODEX_THREAD_ID);
  const turnId = firstString(metadata["openai/turnId"], metadata["openai/turn_id"], metadata.codexTurnId,
    metadata.turnId, turn?.turn_id, metadata.turn?.id);
  return threadId ? { threadId, turnId: turnId || null } : null;
}
