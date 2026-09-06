import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendTaskChat } from "./task-chat.mjs";
import { claimTask, formatTaskThreadTitle, getTaskDetails, readTask, releaseClaim, writeTask } from "./lib.mjs";

export function createTaskInteraction({ repoRoot, active, getAppServer, getClient, getOwnerThreadId, onChange = () => {} }) {
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
    nativeThreadId: task.metadata.interaction?.nativeThreadId || null,
    questions, question: questions.map(item => item.question).join("\n"), updatedAt: new Date().toISOString() };
  writeTask(task);
  record(task.id, { role: "assistant", label: "Question", text: questions.map(item => item.question).join("\n\n") });
  onChange();
  return new Promise((resolve, reject) => {
    pendingUserInputs.set(requestId, { taskId: task.id, taskPath: task.path, claimToken: entry.claim.token, resolve, reject });
  });
}

async function desktopTaskAction({ taskId, action, text = "", expectedTurnId, requestId, answers }) {
  const task = getTaskDetails(repoRoot, taskId);
  if (!task.id || task.status === "unknown") throw new Error("Task not found");
  const entry = active.get(task.id);
  if (action === "steer") {
    if (typeof text !== "string" || !text.trim() || text.length > 8000) throw new Error("Enter an instruction (1-8000 characters)");
    if (entry?.threadId && entry.turnId && entry.turnId === expectedTurnId) {
      const result = await getAppServer().steerTurn(entry.threadId, entry.turnId, text.trim());
      return { accepted: true, turnId: result.turnId, ...record(task.id, { role: "user", label: "Instruction", text: text.trim() }) };
    }
    const owner = task.claim?.owner;
    if (entry || !owner?.threadId || !owner.turnId || owner.turnId !== expectedTurnId) {
      throw new Error("The task's active turn changed. Refresh before sending an instruction.");
    }
    const client = getClient();
    const observed = await client.call("read_thread", { threadId: owner.threadId, turnLimit: 1 }, getOwnerThreadId());
    if (observed.thread?.status?.type !== "active" || observed.turns?.[0]?.id !== owner.turnId) {
      throw new Error("The app turn changed. Open its chat to continue.");
    }
    await client.call("send_message_to_thread", { threadId: owner.threadId, prompt: text.trim() }, getOwnerThreadId());
    return { accepted: true, threadId: owner.threadId, ...record(task.id, { role: "user", label: "Instruction", text: text.trim() }) };
  }
  if (action === "reply" && task.interaction?.requestId) {
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
  if (!["open", "native", "reply"].includes(action)) throw new Error("Unsupported task action");
  const ownerThreadId = getOwnerThreadId();
  if (!ownerThreadId) throw new Error("Start ToDo in the Codex app to bind an owner chat");
  let threadId = task.interaction?.nativeThreadId || task.interaction?.owner?.threadId || task.codexThread?.id;
  const dedicated = threadId && (task.interaction?.nativeThreadId === threadId || task.codexThread?.id === threadId);
  const client = getClient();
  if (action === "open") {
    if (!threadId) throw new Error("This task has no chat yet. Choose Continue in Codex to start it.");
    if (dedicated) await client.call("set_thread_archived", { threadId, archived: false }, ownerThreadId);
    await client.call("navigate_to_codex_page", { threadId }, ownerThreadId);
    return { opened: true, threadId };
  }
  if (entry || task.claim) throw new Error("The task is still executing. Use Steer or wait for its current run to finish.");
  if (!task.path) throw new Error("Reopen the completed task before starting another run");
  if (task.existingBlockers?.length) throw new Error("The task still has active blockers");
  if (typeof text !== "string" || text.length > 8000) throw new Error("Instruction exceeds 8000 characters");
  const answerText = task.interaction?.questions?.map(q => {
    const answer = answers?.[q.id];
    if (typeof answer !== "string" || !answer.trim() || answer.length > 8000) throw new Error(`Answer required: ${q.question}`);
    return `${q.question}\n${answer.trim()}`;
  }).join("\n\n") || text;
  const prompt = `Continue this ToDo task interactively in the Codex app. Use $todo:run with ${task.path}.\n` +
    "This turn uses the interactive ToDo lifecycle: call task_run_start and task_run_finish/task_run_wait. Earlier background restrictions on ToDo tools do not apply to this interactive handoff. Use the returned worktree; the runner owns Git delivery.\n" + answerText;
  // Check the connection and deterministic prerequisites before reserving a
  // dispatch. A failed connection must not leave an unstartable task behind.
  let project;
  if (!threadId) {
    const catalog = await client.call("list_projects", {}, ownerThreadId);
    project = catalog.projects?.find(item => item.projectKind === "local" && path.resolve(item.path) === repoRoot);
    if (!project) throw new Error("Save this repository as a Codex app project before starting its interactive tasks");
  } else {
    await client.call("set_thread_archived", { threadId, archived: false }, ownerThreadId);
    if (dedicated) await client.call("set_thread_title", { threadId, title: formatTaskThreadTitle(repoRoot, task) }, ownerThreadId);
  }
  const dispatchId = randomUUID();
  const reservation = claimTask(task.path, "desktop-dispatch");
  try {
    const current = readTask(task.path);
    if (current.metadata.interaction?.dispatching) throw new Error("An earlier app dispatch has an uncertain outcome. Check its chat before retrying.");
    current.metadata.execution = { ...current.metadata.execution, mode: "interactive" };
    current.metadata.interaction = { ...current.metadata.interaction, state: "waiting-input",
      question: "Opening interactive execution in Codex…", dispatching: true, dispatchId, updatedAt: new Date().toISOString() };
    writeTask(current);
  } finally { releaseClaim(reservation); }
  if (!threadId) {
    // ToDo already owns the task worktree. The app session starts in the saved
    // project and task_run_start supplies the one authoritative task checkout.
    const created = await client.call("create_thread", {
      title: formatTaskThreadTitle(repoRoot, task), prompt,
      target: { type: "project", projectId: project.projectId, environment: { type: "local" } },
    }, ownerThreadId);
    threadId = created.threadId;
    if (!threadId) throw new Error("Codex app setup is pending; no ready thread was returned. Inspect the app before retrying.");
    if (existsSync(task.path)) {
      const current = readTask(task.path);
      current.metadata.interaction = { ...current.metadata.interaction, dispatching: false, nativeThreadId: threadId,
        owner: current.metadata.interaction?.owner || { threadId, turnId: null } };
      writeTask(current);
    }
    return { accepted: true, threadId, ...record(task.id, { role: "user", label: "Instruction", text: answerText || "Continue this task" }) };
  }
  await client.call("send_message_to_thread", { threadId, prompt }, ownerThreadId);
  if (existsSync(task.path)) {
    const current = readTask(task.path);
    current.metadata.interaction = { ...current.metadata.interaction, dispatching: false,
      ...(dedicated ? { nativeThreadId: threadId } : {}),
      owner: current.metadata.interaction?.owner || { threadId, turnId: null } };
    writeTask(current);
  }
  return { accepted: true, threadId, ...record(task.id, { role: "user", label: "Instruction", text: answerText || "Continue this task" }) };
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
    pending.reject(new Error("The execution ended before the user answered. Continue in Codex."));
  }
}
return { action: desktopTaskAction, onServerRequest: handleAgentInputRequest, abandon };
}
