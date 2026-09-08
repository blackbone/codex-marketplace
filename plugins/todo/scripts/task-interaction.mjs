import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendTaskChat } from "./task-chat.mjs";
import { resumeTaskMergeRepair, claimTask, getTaskDetails, readTask, releaseClaim, writeTask } from "./lib.mjs";

export function createTaskInteraction({ repoRoot, active, getAppServer, onChange = () => {} }) {
  const pendingUserInputs = new Map();
  function record(taskId, event) {
    try { appendTaskChat(repoRoot, taskId, event); return {}; }
    catch { return { warning: "Accepted, but the chat history could not be saved." }; }
  }
function handleAgentInputRequest(message) {
  if (message.method !== "item/tool/requestUserInput") {
    throw new Error(`Interactive server request is unsupported: ${message.method}`);
  }
  const { threadId, turnId, questions } = message.params || {};
  const entry = [...active.values()].find(value => value.threadId === threadId && (!value.turnId || value.turnId === turnId));
  if (!entry || !turnId || !Array.isArray(questions) || !questions.length || questions.length > 3 ||
      questions.some(q => !q || typeof q.id !== "string" || !q.id || typeof q.question !== "string" || !q.question.trim()) ||
      new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("Unknown or invalid task input request");
  if ([...pendingUserInputs.values()].some(p => p.taskId === entry.taskId)) throw new Error("Task already has a pending input request");
  const requestId = randomUUID();
  const task = readTask(entry.taskPath);
  task.metadata.interaction = { state: "waiting-input", requestId, threadId, turnId,
    questions, question: questions.map(item => item.question).join("\n"), updatedAt: new Date().toISOString() };
  writeTask(task);
  record(task.id, { role: "assistant", label: "Question", text: questions.map(item => item.question).join("\n\n") });
  onChange();
  return new Promise((resolve, reject) => {
    pendingUserInputs.set(requestId, { taskId: task.id, taskPath: task.path, claimToken: entry.claim.token, resolve, reject });
  });
}

async function taskAction({ taskId, action, text = "", expectedTurnId, expectedInteractionId, requestId, answers }) {
  const task = getTaskDetails(repoRoot, taskId);
  if (!task.id || task.status === "unknown") throw new Error("Task not found");
  const entry = active.get(task.id);
  if (action === "steer") {
    if (typeof text !== "string" || !text.trim() || text.length > 8000) throw new Error("Enter an instruction (1-8000 characters)");
    if (entry?.threadId && entry.turnId && entry.turnId === expectedTurnId) {
      const result = await getAppServer().steerTurn(entry.threadId, entry.turnId, text.trim());
      return { accepted: true, turnId: result.turnId, ...record(task.id, { role: "user", label: "Instruction", text: text.trim() }) };
    }
    throw new Error("The task's active turn changed. Refresh before sending an instruction.");
  }

  if (action === "reply" && task.interaction?.requestId && entry) {
    const pending = pendingUserInputs.get(requestId);
    if (!pending || requestId !== task.interaction.requestId || pending.taskId !== task.id ||
        pending.claimToken !== entry?.claim.token) throw new Error("This input request is no longer active. Open the task to continue.");
    const result = {};
    for (const question of task.interaction.questions) {
      const answer = answers?.[question.id];
      if (typeof answer !== "string" || !answer.trim() || answer.length > 8000) throw new Error(`Answer required: ${question.question}`);
      result[question.id] = { answers: [answer.trim()] };
    }
    const current = readTask(task.path);
    current.metadata.interaction = { ...current.metadata.interaction, state: "resolved" };
    writeTask(current);
    pendingUserInputs.delete(requestId);
    pending.resolve({ answers: result });
    onChange();
    return { accepted: true, ...record(task.id, { role: "user", label: "Answer",
      text: task.interaction.questions.map(q => `${q.question}\n${answers[q.id].trim()}`).join("\n\n") }) };
  }
  if (!["continue", "reply"].includes(action)) throw new Error("Unsupported task action");
  if (entry || task.claim) throw new Error("The task is still executing. Use Steer or wait for its current run to finish.");
  if (!task.path || !existsSync(task.path)) throw new Error("Reopen the completed task before starting another run");
  if (task.existingBlockers?.length) throw new Error("The task still has active blockers");
  if (requestId && requestId !== task.interaction?.requestId) throw new Error("This input request is no longer active. Refresh before replying.");
  if (typeof text !== "string" || text.length > 8000) throw new Error("Instruction exceeds 8000 characters");
  const answerText = task.interaction?.questions?.map(q => {
    const answer = answers?.[q.id];
    if (typeof answer !== "string" || !answer.trim() || answer.length > 8000) throw new Error(`Answer required: ${q.question}`);
    return `${q.question}\n${answer.trim()}`;
  }).join("\n\n") || text.trim();
  if (action === "reply" && !answerText) throw new Error("Enter an answer (1-8000 characters)");
  const reservation = claimTask(task.path, "task-answer");
  let warning = {};
  try {
    const current = readTask(task.path);
    if (current.metadata.interaction?.dispatching) throw new Error("An earlier dispatch has an uncertain outcome. Resolve its existing execution before continuing.");
    if ((current.metadata.interaction?.requestId && current.metadata.interaction.requestId !== requestId) ||
        (action === "reply" && (current.metadata.interaction?.state !== "waiting-input" ||
          !expectedInteractionId || current.metadata.interaction.updatedAt !== expectedInteractionId)) ||
        (action === "continue" && current.metadata.interaction?.state === "waiting-input")) {
      throw new Error("The task's question changed. Refresh before sending an answer.");
    }
    if (current.metadata.interaction?.response && !current.metadata.error) {
      throw new Error("An instruction is already queued for this task.");
    }
    current.metadata.execution = { ...current.metadata.execution, backend: "app-server", mode: "background" };
    current.metadata.interaction = { state: "resolved", updatedAt: new Date().toISOString(),
      response: { id: randomUUID(), text: answerText || "Continue this task",
        question: current.metadata.interaction?.question || null } };
    const continuation = current.metadata.pipelineContinuation;
    if (continuation && !continuation.ready) {
      current.metadata.pipelineContinuation = { ...continuation, resume: true };
    }
    if (!resumeTaskMergeRepair(repoRoot, current, { manual: true }) && current.metadata.git?.phase === "merge-failed") {
      current.metadata.git = { ...current.metadata.git, phase: "merge-queued", mergeQueuedAt: new Date().toISOString() };
    }
    current.metadata.error = null;
    // An answer continues the selected profile; it does not escalate models.
    current.metadata.nextAttemptTrigger = "manual_retry";
    writeTask(current);
    warning = record(task.id, { role: "user", label: action === "reply" ? "Answer" : "Instruction",
      text: current.metadata.interaction.response.text });
  } finally { releaseClaim(reservation); }
  onChange();
  return { accepted: true, queued: true, threadId: task.codexThread?.id || null, ...warning };
}



function abandon(taskId) {
  for (const [id, pending] of pendingUserInputs) {
    if (pending.taskId !== taskId) continue;
    pendingUserInputs.delete(id);
    if (existsSync(pending.taskPath)) {
      const task = readTask(pending.taskPath);
      if (task.metadata.interaction?.requestId === id) {
        delete task.metadata.interaction.requestId;
        task.metadata.interaction.state = "waiting-input";
        task.metadata.execution = { ...task.metadata.execution, mode: "interactive" };
        writeTask(task);
      }
    }
    pending.reject(new Error("The execution ended before the user answered. Answer in the dashboard to resume."));
  }
}
return { action: taskAction, onServerRequest: handleAgentInputRequest, abandon };
}
