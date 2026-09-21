import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [workspace]=process.argv.slice(2);
const plugin=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temp=mkdtempSync(join(tmpdir(),'ori-hook-smoke-'));
try {
 const cache=join(temp,'cache'),env={...process.env,PLUGIN_DATA:cache};
 const script=join(plugin,'scripts/session-context.sh');
 const hook=event=>execFileSync('sh',[script],{cwd:workspace,env,input:JSON.stringify(event),encoding:'utf8',timeout:8000});
 const event={hook_event_name:'SessionStart',source:'compact',cwd:workspace};
 for(const hook_event_name of ['SessionStart','UserPromptSubmit','SubagentStart']){
  const output=JSON.parse(hook({...event,hook_event_name}));
  assert.equal(output.hookSpecificOutput.hookEventName,hook_event_name);
  assert.ok(output.hookSpecificOutput.additionalContext.includes('.ori/INSTRUCTIONS.md'));
 }
 assert.equal(existsSync(cache),false,'hook created a runtime cache');
 assert.equal(hook({...event,cwd:temp}),'','unconfigured repository emitted context');
 const manifest=JSON.parse(readFileSync(join(plugin,'hooks/hooks.json')));
 assert.deepEqual(Object.keys(manifest.hooks).sort(),['SessionStart','SubagentStart','UserPromptSubmit']);
 console.log('Ori hook smoke passed: bundled runtime handles all lifecycle events without a cache, unrelated folders stay quiet.');
} finally {rmSync(temp,{recursive:true,force:true});}
