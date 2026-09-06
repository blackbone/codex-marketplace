import readline from 'node:readline';
import fs from 'node:fs';
const { version } = JSON.parse(fs.readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
import { tools, callTool } from './tools.mjs';

const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let message;
  try { message = JSON.parse(line); }
  catch { return output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
  if (message.id === undefined) return;
  const reply = result => output({ jsonrpc: '2.0', id: message.id, result });
  try {
    if (message.method === 'initialize') return reply({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'semantic-search', version }, instructions: 'In folders with .semantic-search.json, search and read relevant local documentation before project decisions or implementation. Pass the absolute current folder as cwd. Init asks the user which documentation folders to use.' });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools });
    if (message.method === 'tools/call') {
      try {
        const result = await callTool(message.params?.name, message.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      } catch (e) { return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    output({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) { output({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } }); }
});
input.on('close', () => process.exit(0));
