import { callTool } from './tools.mjs';

const [command, ...args] = process.argv.slice(2);
const names = { inspect: 'repo_inspect', init: 'repo_init', find: 'docs_search', search: 'docs_search', read: 'docs_read', index: 'docs_index', status: 'docs_status', dashboard: 'docs_dashboard' };
if (!names[command]) {
  console.error('Usage: node cli.mjs inspect | init <folder...> | find <question> | read <path> [fromLine] [maxLines] | index | status | dashboard\nAll commands use the current directory. Runtime and model downloads are cached in system tmp.');
  process.exitCode = 1;
} else {
  const input = { cwd: process.cwd() };
  if (command === 'init') input.folders = args;
  if (command === 'find' || command === 'search') input.query = args.join(' ');
  if (command === 'read') Object.assign(input, { path: args[0], fromLine: args[1] ? Number(args[1]) : 1, maxLines: args[2] ? Number(args[2]) : 100 });
  try { console.log(JSON.stringify(await callTool(names[command], input), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
