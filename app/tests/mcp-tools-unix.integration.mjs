// The whole refresh path with real parts: tool registry (PC) -> SSH channel -> real Python bootstrap,
// relay and stdio connector (VPS, isolated HOME) -> the client Claude would be. Turning a local tool
// on reaches the client as notifications/tools/list_changed, and its tools work through the chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {SshPipe,startSshMcp,bootstrapPayload,sshConnectorName} from '../ssh-mcp.mjs';
import {createToolRegistry} from '../tool-registry.mjs';
import {updateSettings,approvalKey} from '../mcp-tools.mjs';

const fixture=fileURLToPath(new URL('./fixtures/mcp-tool-fixture.mjs',import.meta.url));
async function until(check,ms=20000){const start=Date.now();for(;;){const value=await check();if(value)return value;if(Date.now()-start>ms)throw Error('condition timeout');await delay(25);}}

test('turning a local tool on notifies the cloud client through the real relay, and its calls work end to end',{skip:process.platform!=='linux',timeout:60000},async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cmcpT-')),pc=fs.mkdtempSync(path.join(os.tmpdir(),'cmcpP-')),state=path.join(pc,'user'),root=path.join(pc,'mcp-tools');
  fs.mkdirSync(state);fs.writeFileSync(path.join(home,'.claude.json'),'{}');
  const builtin={definitions:[{name:'read_text_file',description:'Read',inputSchema:{type:'object'}},{name:'write_file',description:'Write',inputSchema:{type:'object'}},{name:'list_allowed_directories',description:'Roots',inputSchema:{type:'object'}}],
    call:async()=>({content:[{type:'text',text:'builtin'}]})};
  // Only the files group is complete in this fixture; the others are off, as a user may choose.
  updateSettings(state,s=>{for(const g of ['commands','processes','toolchains','desktop'])s.groups[g]=false;});
  const binary={definitions:['windows_binary_info','windows_binary_begin','windows_binary_write','windows_binary_finish'].map(name=>({name,description:name,inputSchema:{type:'object'}})),call:async()=>({content:[]})};
  const registry=createToolRegistry({stateDir:state,root,providers:[builtin,binary],serverName:'windows-pc-files',version:'test',instructions:{base:'Fixture PC.'},secrets:null});
  const init=await registry.forward({jsonrpc:'2.0',id:0,method:'initialize',params:{}}),listed=await registry.forward({jsonrpc:'2.0',id:1,method:'tools/list'});
  const catalog={...listed.result,instructions:init.result.instructions};
  const controller=new AbortController(),children=[],states=[],key='tools-device';
  const bootstrap=fileURLToPath(new URL('../ssh-bootstrap.py',import.meta.url));
  const task=startSshMcp({key,signal:controller.signal,catalog,changes:registry,login:{},retryDelay:50,status:s=>states.push(s),forward:registry.forward,
    transport:()=>new SshPipe({login:{host:'fixture.invalid',username:'fixture',port:22,method:'password'},payload:bootstrapPayload(key,catalog),
      spawnProcess:(_file,_args,options)=>{const child=spawn('python3',['-I','-B','-u',bootstrap],{...options,env:{...options.env,HOME:home}});children.push(child);return child;}})});
  let client;
  t.after(async()=>{
    controller.abort();await task;if(client&&client.exitCode===null)client.kill();await registry.close();
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(c=>once(c,'exit').catch(()=>{})));
    fs.rmSync(home,{recursive:true,force:true});fs.rmSync(pc,{recursive:true,force:true});
  });
  await until(()=>states.includes('ready'));
  const entry=JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).mcpServers[sshConnectorName(key)];
  client=spawn(entry.command,['-B',...entry.args],{env:{...process.env,HOME:home,...entry.env},stdio:['pipe','pipe','pipe']});
  const lines=[];let buffer='';client.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){lines.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
  let stderr='';client.stderr.on('data',chunk=>{stderr+=chunk;});
  const send=message=>client.stdin.write(JSON.stringify(message)+'\n');
  const reply=id=>until(()=>lines.find(m=>m.id===id));
  const names=async id=>{send({jsonrpc:'2.0',id,method:'tools/list'});return (await reply(id)).result.tools.map(x=>x.name);};
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'claude-code'},capabilities:{elicitation:{form:{}}}}});await reply(1);
  send({jsonrpc:'2.0',method:'notifications/initialized'});
  const first=await names(2);
  assert.ok(first.includes('read_text_file')&&first.includes('windows_download_to_cloud'),'files group with transfers, other groups off: '+first+stderr);
  assert.ok(!first.some(n=>n.startsWith('fx__')));
  // The user adds and turns on a tool on the PC; nothing else asks for a refresh.
  const manifest={schema:1,name:'Fixture',description:'Test',transport:'stdio',command:'node',args:[fixture],capabilities:[]};
  fs.mkdirSync(path.join(root,'fx'),{recursive:true});fs.writeFileSync(path.join(root,'fx','cmcp-tool.json'),JSON.stringify(manifest));
  const before=lines.filter(m=>m.method==='notifications/tools/list_changed').length;
  updateSettings(state,s=>{s.tools.fx=true;s.acknowledged.fx=approvalKey(manifest);});
  await until(()=>lines.filter(m=>m.method==='notifications/tools/list_changed').length>before);
  const after=await names(3);assert.ok(after.includes('fx__echo'),after.join(','));
  send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'fx__echo',arguments:{text:'through the chain'}}});
  assert.equal((await reply(4)).result.content[0].text,'through the chain');
  // A tool's question reaches the client as elicitation/create and the answer goes back to it.
  send({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'fx__ask',arguments:{}}});
  const question=await until(()=>lines.find(m=>m.method==='elicitation/create'));
  assert.equal(question.params.message,'Name?');assert.match(String(question.id),/^cmcp-ask-/);
  send({jsonrpc:'2.0',id:question.id,result:{action:'accept',content:{name:'Ada'}}});
  assert.deepEqual(JSON.parse((await reply(6)).result.content[0].text),{action:'accept',content:{name:'Ada'}});
  // Turning the files group off removes it and its transfers on the next notification.
  const count=lines.filter(m=>m.method==='notifications/tools/list_changed').length;
  updateSettings(state,s=>{s.groups.files=false;});
  await until(()=>lines.filter(m=>m.method==='notifications/tools/list_changed').length>count);
  const last=await names(5);assert.ok(!last.includes('read_text_file')&&!last.includes('windows_download_to_cloud')&&last.includes('fx__echo'),last.join(','));
  client.stdin.end();await once(client,'exit');
});

test('a client that cannot show questions gets them declined at once',{skip:process.platform!=='linux',timeout:60000},async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cmcpQ-')),pc=fs.mkdtempSync(path.join(os.tmpdir(),'cmcpR-')),state=path.join(pc,'user'),root=path.join(pc,'mcp-tools');
  fs.mkdirSync(state);fs.writeFileSync(path.join(home,'.claude.json'),'{}');
  const manifest={schema:1,name:'Fixture',description:'Test',transport:'stdio',command:'node',args:[fixture],capabilities:[]};
  fs.mkdirSync(path.join(root,'fx'),{recursive:true});fs.writeFileSync(path.join(root,'fx','cmcp-tool.json'),JSON.stringify(manifest));
  updateSettings(state,s=>{for(const g of ['files','commands','processes','toolchains','desktop'])s.groups[g]=false;s.tools.fx=true;s.acknowledged.fx=approvalKey(manifest);});
  const registry=createToolRegistry({stateDir:state,root,providers:[],serverName:'windows-pc-files',version:'test',instructions:{base:'Fixture PC.'},secrets:null});
  await until(()=>registry.has('fx__ask'));
  const init=await registry.forward({jsonrpc:'2.0',id:0,method:'initialize',params:{}}),listed=await registry.forward({jsonrpc:'2.0',id:1,method:'tools/list'});
  const catalog={...listed.result,instructions:init.result.instructions};
  const controller=new AbortController(),children=[],states=[],key='questions-device';
  const bootstrap=fileURLToPath(new URL('../ssh-bootstrap.py',import.meta.url));
  const task=startSshMcp({key,signal:controller.signal,catalog,changes:registry,login:{},retryDelay:50,status:s=>states.push(s),forward:registry.forward,
    transport:()=>new SshPipe({login:{host:'fixture.invalid',username:'fixture',port:22,method:'password'},payload:bootstrapPayload(key,catalog),
      spawnProcess:(_file,_args,options)=>{const child=spawn('python3',['-I','-B','-u',bootstrap],{...options,env:{...options.env,HOME:home}});children.push(child);return child;}})});
  let client;
  t.after(async()=>{controller.abort();await task;if(client&&client.exitCode===null)client.kill();await registry.close();
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    fs.rmSync(home,{recursive:true,force:true});fs.rmSync(pc,{recursive:true,force:true});});
  await until(()=>states.includes('ready'));
  const entry=JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).mcpServers[sshConnectorName(key)];
  client=spawn(entry.command,['-B',...entry.args],{env:{...process.env,HOME:home,...entry.env},stdio:['pipe','pipe','pipe']});
  const lines=[];let buffer='';client.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){lines.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
  const send=message=>client.stdin.write(JSON.stringify(message)+'\n');
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'claude-desktop'}}});await until(()=>lines.find(m=>m.id===1));
  send({jsonrpc:'2.0',method:'notifications/initialized'});
  send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'fx__ask',arguments:{}}});
  const result=await until(()=>lines.find(m=>m.id===2));
  assert.deepEqual(JSON.parse(result.result.content[0].text),{action:'decline'});
  assert.ok(!lines.some(m=>m.method==='elicitation/create'));
  client.stdin.end();await once(client,'exit');
});
