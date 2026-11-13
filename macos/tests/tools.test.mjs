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
  assert.equal(pageDirection('connect','tools'),1);assert.equal(pageDirection('tools','market'),1);assert.equal(pageDirection('market','about'),1);assert.equal(pageDirection('tools','about'),1);assert.equal(pageDirection('about','tools'),-1);
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
  // Quick clicks arrive as one batch: one write, last states only, the tool's approval recorded.
  const batch=(await call('tools/apply',{groups:{blender:false,desktop:false},tools:{fixture:false}})).data;
  assert.equal(batch.groups.blender,false);assert.equal(batch.groups.desktop,false);assert.equal(batch.tools.fixture,false);
  await call('tools/apply',{groups:{desktop:true},tools:{fixture:true}});
  const reread=(await call('tools')).data;assert.equal(reread.groups.desktop,true);assert.equal(reread.tools[0].enabled&&reread.tools[0].approved,true);
  assert.equal((await call('tools/apply',{groups:{blender:'yes'}})).status,400);assert.equal((await call('tools/apply',{tools:{missing:true}})).status,400);
  // One device's own switch, then back to following this Mac's switch.
  await call('tools/apply',{device:'vps-1',groups:{files:false},tools:{fixture:false}});
  const device=(await call('tools',{device:'vps-1'})).data;
  assert.equal(device.groups.files,false);assert.equal(device.globalGroups.files,true);assert.deepEqual(device.overriddenGroups,['files']);
  assert.equal(device.tools[0].enabled,false);assert.equal(device.tools[0].overridden,true);assert.equal(device.tools[0].global,true);
  assert.equal((await call('tools')).data.groups.files,true,'the Mac\'s own switch is unchanged');
  await call('tools/apply',{device:'vps-1',groups:{files:null},tools:{fixture:null}});
  assert.deepEqual((await call('tools',{device:'vps-1'})).data.overriddenGroups,[]);
  await call('tools/set',{group:'blender',on:true});
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

test('the market reads the CMCP version where the Mac bundle keeps it',async t=>{
  // The bundle has Resources/app without package.json and Resources/macos/package.json.
  const bundle=folder(t),app=path.join(bundle,'app'),mac=path.join(bundle,'macos');fs.mkdirSync(app);fs.mkdirSync(mac);
  fs.copyFileSync(new URL('../../app/mcp-market.mjs',import.meta.url),path.join(app,'mcp-market.mjs'));
  fs.writeFileSync(path.join(mac,'package.json'),JSON.stringify({version:'9.8.7'}));
  fs.writeFileSync(path.join(app,'mcp-tools.mjs'),"export const ID=/x/,RESERVED=new Set(),toolsRoot=()=>'',ensureToolsFolder=()=>{},parseManifest=()=>({}),approvalKey=()=>'',describeTool=()=>({}),readSettings=()=>({}),updateSettings=()=>{},resolveLaunch=()=>{},RuntimeMissing=Error,runtimeOf=x=>x,detectApp=()=>null,atomicWrite=()=>{};");
  const {cmcpVersion}=await import(new URL('file://'+path.join(app,'mcp-market.mjs')).href);
  assert.equal(cmcpVersion(),'9.8.7');
});

test('market routes list the reviewed presets, install one that stays off, and refuse an unconfirmed update',async t=>{
  const directory=folder(t);
  const m=await createManager({directory,secrets:async()=>{},proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}}});t.after(()=>m.close());
  const call=async(route,body={})=>{const r=await fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const market=(await call('market')).data.presets;
  assert.ok(market.length>=5&&market.every(p=>p.title.zh&&p.title.en&&p.version&&p.license&&p.homepage.startsWith('https://')));
  const blender=market.find(p=>p.id==='blender_mcp');assert.ok(blender.requires.some(r=>r.kind==='app'&&r.name==='blender'));
  assert.equal((await call('market/install',{id:'memory'})).data.installed,'memory');
  const tools=(await call('tools')).data.tools;assert.equal(tools.find(x=>x.id==='memory').enabled,false,'installed presets start off');
  assert.equal((await call('market')).data.presets.find(p=>p.id==='memory').installed.version,'2.0.1');
  assert.equal((await call('market/install',{id:'memory'})).status,400);
  assert.equal((await call('market/update',{id:'memory'})).status,400,'an update needs the confirmation flag');
  assert.equal((await call('market/install',{id:'nope'})).status,400);
  assert.ok(fs.existsSync(path.join(directory,'tool-refresh.json')),'installing tells running CMCP processes');
});

test('a remote tool reports its sign-in, and only a tool with a sign-in can start one',async t=>{
  const directory=folder(t);
  const m=await createManager({directory,secrets:async()=>{},proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},toolSecrets:plainStore});
  t.after(()=>m.close());
  const call=async(route,body={})=>{const r=await fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  await call('tools/import',{text:JSON.stringify({mcpServers:{linear:{type:'http',url:'https://mcp.linear.app/mcp'},local:{command:'node',args:[fixture]}}}),apply:true});
  const tools=(await call('tools')).data.tools,linear=tools.find(x=>x.id==='linear');
  assert.deepEqual([linear.remote,linear.auth],[true,{type:'oauth',signedIn:false,needed:false}]);assert.equal(tools.find(x=>x.id==='local').auth,null);
  const refused=await call('tools/login',{id:'local'});assert.equal(refused.status,400);assert.match(refused.data.error,/no sign-in/);
  assert.equal((await call('tools/login',{id:'missing'})).status,400);
});
