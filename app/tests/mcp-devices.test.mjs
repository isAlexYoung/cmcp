// Per-device overrides on top of the switches for this computer: each device card's channels
// see their own catalog, while a third-party tool keeps one process for all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {readSettings,updateSettings,effectiveSwitches,deviceOf,approvalKey} from '../mcp-tools.mjs';
import {createToolRegistry} from '../tool-registry.mjs';
import {applySwitches,status} from '../mcp-tools-cli.mjs';

const fixture=fileURLToPath(new URL('./fixtures/mcp-tool-fixture.mjs',import.meta.url));
function folders(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-devices-'))),state=path.join(base,'user'),root=path.join(base,'mcp-tools'),closers=[];
  fs.mkdirSync(state);process.env.CMCP_MCP_TOOLS_DIR=root;
  t.after(async()=>{delete process.env.CMCP_MCP_TOOLS_DIR;await Promise.allSettled(closers.map(c=>c()));for(let i=0;;i++){try{fs.rmSync(base,{recursive:true,force:true});return;}catch(e){if(i>=50)throw e;await delay(100);}}});
  return {base,state,root,later:c=>closers.push(c)};
}
async function until(check,ms=15000){const end=Date.now()+ms;for(;;){const v=await check();if(v)return v;if(Date.now()>end)throw Error('condition timeout');await delay(50);}}
const builtin={definitions:[{name:'read_text_file',inputSchema:{type:'object'}},{name:'windows_execute',inputSchema:{type:'object'}},{name:'blender_get_scene_info',inputSchema:{type:'object'}}],call:async n=>({content:[{type:'text',text:'builtin '+n}]})};
const manifest={schema:1,name:'Fixture',description:'Test',transport:'stdio',command:'node',args:[fixture],capabilities:[]};

test('connection names of every channel map to the device card they belong to',()=>{
  for(const [name,device] of [['work-pc','work-pc'],['cloudcli:4f1c','4f1c'],['tunnel:cloudcli:4f1c','4f1c'],['tunnel:web:abc','abc'],['',null],[undefined,null]])assert.equal(deviceOf(name),device,String(name));
});

test('overrides are saved per device, follow the computer\'s switch when removed, and are read back defensively',t=>{
  const f=folders(t);
  applySwitches(f.state,{device:'A',groups:{blender:true,commands:false}});
  applySwitches(f.state,{device:'B',groups:{files:false}});
  let s=readSettings(f.state);
  assert.deepEqual(s.targets.A.groups,{blender:true,commands:false});assert.equal(s.groups.blender,false,'the global switch is unchanged');
  assert.equal(effectiveSwitches(s,'A').groups.blender,true);assert.equal(effectiveSwitches(s,'A').groups.files,true);assert.equal(effectiveSwitches(s,'B').groups.files,false);
  assert.equal(effectiveSwitches(s,null).groups.blender,false);assert.equal(effectiveSwitches(s,'unknown').groups.commands,true);
  applySwitches(f.state,{device:'A',groups:{blender:null,commands:null}});
  s=readSettings(f.state);assert.equal(s.targets.A,undefined,'an empty override disappears');
  assert.throws(()=>applySwitches(f.state,{groups:{blender:null}}),/Unknown group/,'only a device override can be removed');
  assert.throws(()=>applySwitches(f.state,{device:'',groups:{blender:true}}),/Invalid device/);
  fs.writeFileSync(path.join(f.state,'tool-settings.json'),JSON.stringify({schema:1,targets:{A:{groups:{blender:'yes',files:false},tools:{'Bad Id':true}},'':{groups:{files:false}}}}));
  assert.deepEqual(readSettings(f.state).targets,{A:{groups:{files:false},tools:{}}});
  const view=status(f.state,{device:'A'});assert.equal(view.groups.files,false);assert.equal(view.globalGroups.files,true);assert.deepEqual(view.overriddenGroups,['files']);assert.deepEqual(view.devices,['A']);
});

test('each device sees its own catalog and events; a tool keeps one process for every device',async t=>{
  const f=folders(t);
  fs.mkdirSync(path.join(f.root,'fx'),{recursive:true});fs.writeFileSync(path.join(f.root,'fx','cmcp-tool.json'),JSON.stringify(manifest));
  // Off for this computer, on for device A only.
  updateSettings(f.state,s=>{s.acknowledged.fx=approvalKey(manifest);s.targets.A={groups:{blender:true},tools:{fx:true}};s.targets.B={groups:{commands:false},tools:{}};});
  const r=createToolRegistry({stateDir:f.state,root:f.root,providers:[builtin],serverName:'t',version:'0',secrets:null,instructions:{base:'Base.',blender:'Blender.'}});f.later(()=>r.close());
  const names=device=>r.list(device).tools.map(x=>x.name);
  await until(()=>names('A').includes('fx__echo'));
  assert.ok(names('A').includes('blender_get_scene_info')&&!names('').includes('blender_get_scene_info'),'Blender only where it is on');
  assert.ok(!names('').some(n=>n.startsWith('fx__'))&&!names('B').some(n=>n.startsWith('fx__')),'the tool only where it is on');
  assert.ok(!names('B').includes('windows_execute')&&names('').includes('windows_execute'));
  assert.match(r.instructions('A'),/Blender\./);assert.doesNotMatch(r.instructions('B'),/Blender\./);
  const call=(device,name,args={})=>r.forward({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{device});
  assert.equal((await call('A','fx__echo',{text:'A'})).result.content[0].text,'A');
  assert.match((await call('B','fx__echo',{text:'B'})).error.message,/Unknown tool/);
  assert.match((await call('B','windows_execute')).error.message,/turned off in CMCP for this device/);
  const meta=(await r.forward({jsonrpc:'2.0',id:2,method:'tools/list'},{device:'A'})).result._meta['cmcp/catalog'];assert.ok(meta.groups.includes('blender'));
  // B now turns the tool on as well: same process, B's list changes, A's does not.
  const before={A:r.revision('A'),B:r.revision('B'),G:r.revision('')};let events=0;r.on('changed',()=>events++);
  applySwitches(f.state,{device:'B',tools:{fx:true}});
  await until(()=>r.revision('B')!==before.B);
  assert.equal(r.revision('A'),before.A);assert.equal(r.revision(''),before.G);assert.ok(events>=1);
  assert.equal((await call('B','fx__echo',{text:'B'})).result.content[0].text,'B');
  const marker=path.join(f.base,'starts.txt');assert.ok(!fs.existsSync(marker));
  const custom=r.custom('B').find(c=>c.id==='fx');assert.equal(custom.enabled&&custom.overridden,true);assert.equal(r.custom('').find(c=>c.id==='fx').enabled,false);
  // Turning it off everywhere stops the process.
  applySwitches(f.state,{device:'A',tools:{fx:null}});applySwitches(f.state,{device:'B',tools:{fx:null}});
  await until(()=>!r.list('A').tools.some(x=>x.name.startsWith('fx__')));
});
