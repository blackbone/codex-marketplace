import { resolveProject, ensureEditor, withinBudget } from './runtime.mjs';

let input = '';
const inputDeadline = setTimeout(() => process.exit(0), 1500);
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
}
clearTimeout(inputDeadline);
try {
  const event = JSON.parse(input);
  if (event.hook_event_name !== 'SessionStart') process.exit(0);
  const { project, result } = withinBudget(() => {
    const project = resolveProject(event.cwd);
    // Compaction must not reopen an Editor the user closed.
    return { project, result: event.source === 'compact' ? { state: 'not_checked' } : ensureEditor(project) };
  });
  const context = [
    `Unity project: ${JSON.stringify(project.root)}. Editor version: ${project.version}.`,
    `Editor: ${result.state}. Pipeline: ${project.pipeline ? 'declared, readiness not checked' : 'not installed'}.`,
    ...(result.reason ? [`Diagnostic: ${JSON.stringify({ reason: result.reason, facts: result.facts, nextAction: result.nextAction })}.`] : []),
    'Use $unity:editor for actions inside this Unity project. Its wrapper checks Pipeline once before every action.',
    'Do not wait, poll, queue actions, or retry automatically when Pipeline is unavailable. Check again only for a new requested action or after an explicit recovery action.',
    ...(!project.pipeline ? ['Use $unity:init when asked to set up the Pipeline package.'] : []),
  ].join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
} catch (error) {
  if (error.code === 'NOT_UNITY_PROJECT') process.exit(0);
  const context = error.code === 'AMBIGUOUS_PROJECT'
    ? `Multiple Unity projects: ${JSON.stringify(error.details.candidates)}. Ask which one to use, then use $unity:editor with that explicit project. No Editor was launched.`
    : error.code?.startsWith('TODO_')
      ? `Unity commands blocked: ${error.code}. ${error.message} Do not bypass the wrapper with direct Unity CLI commands.`
      : `Unity auto-open unavailable: ${error.code || 'INVALID_HOOK_INPUT'}. No Pipeline wait or action was scheduled.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}
