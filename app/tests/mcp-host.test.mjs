// One process per third-party tool: SSH channel workers use the main CMCP process's tools through
// the tool host, questions travel through it, and a worker falls back to its own copy without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {updateSettings,approvalKey} from '../mcp-tools.mjs';
import {createToolRegistry} from '../tool-registry.mjs';
import {startToolHost,hostClient,HostedProxy} from '../tool-host.mjs';

const fixture=fileURLToPath(new URL('./fixtures/mcp-tool-fixture.mjs',import.meta.url));
async function until(check,ms=15000){const end=Date.now()+ms;for(;;){const v=await check();if(v)return v;if(Date.now()>end)throw Error('condition timeout');await delay(50);}}

test('workers share the host\'s tool process, pass questions through it, and fall back when it is gone',async t=>{
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-host-'))),state=path.join(base,'user'),root=path.join(base,'mcp-tools'),marker=path.join(base,'starts.txt');fs.mkdirSync(state);
  const closers=[];t.after(async()=>{for(const c of closers.reverse())await c().catch(()=>{});for(let i=0;i<50;i++){try{fs.rmSync(base,{recursive:true,force:true});return;}catch{await delay(100);}}});
  const manifest={schema:1,name:'Fixture',description:'Test',transport:'stdio',command:'node',args:[fixture],env:{FIXTURE_MARKER:marker},capabilities:[]};
  fs.mkdirSync(path.join(root,'fx'),{recursive:true});fs.writeFileSync(path.join(root,'fx','cmcp-tool.json'),JSON.stringify(manifest));
  updateSettings(state,s=>{s.tools.fx=true;s.acknowledged.fx=approvalKey(manifest);});
  const options={stateDir:state,root,providers:[],serverName:'t',version:'0',secrets:null,instructions:{base:'B.'}};
  const host=createToolRegistry(options);closers.push(()=>host.close());
  const server=await startToolHost({stateDir:state,registry:host});closers.push(()=>server.close());
  assert.equal(fs.statSync(path.join(state,'tool-host.json')).mode&0o777&(process.platform==='win32'?0:0o077),0,'only this account can read the token');
  const client=hostClient(state);closers.push(async()=>client.close());
  const worker=createToolRegistry({...options,makeProxy:o=>new HostedProxy(o,client)});closers.push(()=>worker.close());
  const second=createToolRegistry({...options,makeProxy:o=>new HostedProxy(o,hostClient(state))});closers.push(()=>second.close());
  await until(()=>worker.has('fx__echo')&&second.has('fx__echo')&&host.has('fx__echo'));
  const call=(r,name,args,ctx)=>r.forward({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},ctx);
  assert.equal((await call(worker,'fx__echo',{text:'w'})).result.content[0].text,'w');
  assert.equal((await call(second,'fx__echo',{text:'s'})).result.content[0].text,'s');
  assert.equal((await call(host,'fx__echo',{text:'h'})).result.content[0].text,'h');
  assert.equal(fs.readFileSync(marker,'utf8').trim().split('\n').length,1,'one process serves the host and both workers');
  // The worker's cloud user answers a question asked by the tool running in the host.
  const shown=[];const answered=await call(worker,'fx__ask',{},{ask:async p=>{shown.push(p.message);return {action:'accept',content:{name:'Ada'}};}});
  assert.deepEqual(shown,['Name?']);assert.deepEqual(JSON.parse(answered.result.content[0].text),{action:'accept',content:{name:'Ada'}});
  assert.deepEqual(JSON.parse((await call(worker,'fx__ask',{},{})).result.content[0].text),{action:'cancel'},'no channel to ask: cancelled through the host');
  // A wrong token is refused.
  const record=JSON.parse(fs.readFileSync(path.join(state,'tool-host.json'),'utf8'));fs.writeFileSync(path.join(state,'tool-host.json'),JSON.stringify({...record,token:'0'.repeat(64)}));
  assert.equal(await hostClient(state,{connectTimeout:1000}).available(),false);fs.writeFileSync(path.join(state,'tool-host.json'),JSON.stringify(record));
  // The host goes away: the worker answers from its own copy of the tool.
  await server.close();client.close();
  assert.equal((await call(worker,'fx__echo',{text:'alone'})).result.content[0].text,'alone');
  assert.equal(fs.readFileSync(marker,'utf8').trim().split('\n').length,2,'the worker started its own copy only after the host was gone');
});
