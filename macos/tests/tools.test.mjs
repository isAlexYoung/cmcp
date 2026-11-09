// Settings > Tools on the Mac: the manager's routes and the Mac dispatcher on the shared catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createManager} from '../manager.mjs';
import {createDispatcher} from '../dispatcher.mjs';
import {pageDirection} from '../ui/motion.js';

const fixture=fileURLToPath(new URL('../../app/tests/fixtures/mcp-tool-fixture.mjs',import.meta.url));
const plainStore={protect:async value=>'plain:'+value,unprotect:async value=>value.slice(6)};
function folder(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-mac-tools-')));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}

test('the tools page sits between Connections and About',()=>{
  assert.equal(pageDirection('connect','tools'),1);assert.equal(pageDirection('tools','about'),1);assert.equal(pageDirection('about','tools'),-1);
});

test('manager routes list, import, switch, refresh and remove tools inside the Mac data folder',async t=>{
  const directory=folder(t);
  const m=await createManager({directory,secrets:async()=>{},proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},toolSecrets:plainStore});
  t.after(()=>m.close());
  const call=async(route,body={})=>{const r=await fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const first=(await call('tools')).data;
  assert.equal(first.root,path.join(directory,'mcp-tools'));assert.equal(first.groups.blender,false);assert.deepEqual(first.tools,[]);
  assert.ok(fs.existsSync(path.join(directory,'mcp-tools','AGENT.md')));
  const text=JSON.stringify({mcpServers:{fixture:{command:'node',args:[fixture],env:{API_TOKEN:'sk-test-value-123'}}}});
  const preview=(await call('tools/import',{text})).data;assert.equal(preview.items[0].id,'fixture');assert.equal(fs.existsSync(path.join(directory,'mcp-tools','fixture')),false,'a preview writes nothing');
  await call('tools/import',{text,apply:true});
  assert.ok(!fs.readFileSync(path.join(directory,'mcp-tools','fixture','cmcp-tool.json'),'utf8').includes('sk-test-value-123'));
  let listed=(await call('tools')).data.tools[0];assert.equal(listed.enabled,false);assert.deepEqual(listed.missingSecrets,[]);
  await call('tools/set',{tool:'fixture',on:true});await call('tools/set',{group:'blender',on:true});await call('tools/set',{idle:0});await call('tools/set',{blenderOfferDone:true});
  const after=(await call('tools')).data;listed=after.tools[0];
  assert.equal(listed.enabled&&listed.approved,true);assert.equal(after.groups.blender,true);assert.equal(after.idleMinutes,0);assert.equal(after.blender.offerDone,true);
  assert.equal((await call('tools/set',{group:'nonsense',on:true})).status,400);
  assert.equal((await call('tools/refresh')).data.refreshed,true);assert.ok(fs.existsSync(path.join(directory,'tool-refresh.json')));
  assert.equal((await call('tools/open',{what:'log',id:'fixture'})).status,400,'no log yet');
  const removed=(await call('tools/remove',{id:'fixture'})).data;assert.ok(removed.keptAt.includes('.removed-fixture-'));
  assert.deepEqual((await call('tools')).data.tools,[]);
});

test('the Mac dispatcher exposes an enabled third-party tool with its prefix and keeps Blender off by default',async t=>{
  const state=folder(t),root=path.join(state,'mcp-tools');fs.mkdirSync(path.join(root,'fx'),{recursive:true});
  const manifest={schema:1,name:'Fixture',description:'Test',transport:'stdio',command:'node',args:[fixture],capabilities:[]};
  fs.writeFileSync(path.join(root,'fx','cmcp-tool.json'),JSON.stringify(manifest));
  const {approvalKey}=await import('../../app/mcp-tools.mjs');
  fs.writeFileSync(path.join(state,'tool-settings.json'),JSON.stringify({schema:1,tools:{fx:true},acknowledged:{fx:approvalKey(manifest)}}));
  const d=await createDispatcher({roots:[state],stateDir:state,filesystem:{listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('no files');},close:async()=>{}}});t.after(()=>d.close());
  const names=async()=>(await d.forward({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.map(x=>x.name);
  let list=[];for(let i=0;i<200&&!list.includes('fx__echo');i++){list=await names();await delay(50);}
  assert.ok(list.includes('fx__echo'));assert.ok(list.includes('mac_execute'));assert.ok(!list.some(n=>n.startsWith('blender_')));
  const r=await d.forward({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'fx__echo',arguments:{text:'mac'}}});assert.equal(r.result.content[0].text,'mac');
});
