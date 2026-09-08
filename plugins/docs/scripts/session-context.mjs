import { request } from './client.mjs';
import { readConfig, CONFIG_NAME, isLinkedWorktree } from './common.mjs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { input += value; });
process.stdin.on('end', async () => {
  let event;
  try { event = JSON.parse(input); } catch { return; }
  const session = event.session_id || event.thread_id;
  const owner = typeof session === 'string' && session ? `session:${session}` : null;
  if (event.hook_event_name === 'SessionEnd') {
    if (owner) try { await request('unregister', { owner }); } catch (error) { console.error(`Documentation watcher unregister failed: ${error.message}`); }
    return;
  }
  if (!['SessionStart', 'UserPromptSubmit', 'SubagentStart'].includes(event.hook_event_name)) return;
  // Like ToDo, claimed workers do not start background service maintenance.
  // A copied config in a linked worktree is not a new automatic registration.
  const cwd = event.cwd || process.cwd();
  if (process.env.TODO_RUNNER_WORKER === '1' || isLinkedWorktree(cwd)) return;
  let root, config;
  try { ({ root, config } = readConfig(cwd)); }
  catch (error) {
    if (error.message.startsWith('No ' + CONFIG_NAME)) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: `Local documentation search is unavailable: ${error.message}.` } }));
    return;
  }
  let registrationError;
  if (owner) {
    try { await request('register', { cwd: root, owner }); }
    catch (error) { registrationError = error.message; }
  } else registrationError = 'Hook supplied no session identity; background watcher was not registered.';
  const context = [
    'This project has local documentation search enabled.',
    `Project: ${JSON.stringify(root)}. Documentation folders: ${JSON.stringify(config.folders)}.`,
    'Use $docs:find to find documentation fragments by topic: call docs_search with query and absolute cwd, then return fragments with paths and line ranges. If needed, read only a matching range with docs_read. Briefly report no results or unavailable search.',
    ...(registrationError ? [`Documentation watcher registration failed: ${registrationError}`] : []),
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } }));
});
