// Real Python bootstrap, stdio connector and Unix relay; isolated temporary HOME.
// Only the SSH network process is replaced by a direct child pipe in this test.
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

async function until(check){const start=Date.now();while(!check()){if(Date.now()-start>12000)throw Error('condition timeout');await delay(20);}}
test('CLI connector installs beside web, forwards real file operations and recovers a disconnected result once', {skip:process.platform!=='linux',timeout:40000}, async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cmcpS-')),local=fs.mkdtempSync(path.join(os.tmpdir(),'cmcpL-'));
  fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({keep:true,mcpServers:{existing:{command:'original'}}}));
  const desktop=path.join(home,'.config','Claude');fs.mkdirSync(desktop,{recursive:true});fs.writeFileSync(path.join(desktop,'claude_desktop_config.json'),'DESKTOP UNCHANGED');
  const controller=new AbortController(),children=[],states=[],key='test-device';let count=0,release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const catalog={instructions:'Tools operate on local fixture files',tools:[{name:'write_local',description:'Write a local fixture',inputSchema:{type:'object',properties:{content:{type:'string'}}}}]};
  const bootstrap=fileURLToPath(new URL('../ssh-bootstrap.py',import.meta.url));
  const task=startSshMcp({key,signal:controller.signal,catalog,login:{},retryDelay:50,status:s=>states.push(s),
    transport:()=>new SshPipe({login:{host:'fixture.invalid',username:'fixture',port:22,method:'password'},payload:bootstrapPayload(key,catalog),
      spawnProcess:(_file,_args,options)=>{const child=spawn('python3',['-I','-B','-u',bootstrap],{...options,env:{...options.env,HOME:home}});children.push(child);return child;}}),
    forward:async message=>{
      if(message.method==='initialize')return {jsonrpc:'2.0',id:message.id,result:{instructions:catalog.instructions}};
      if(message.method==='tools/list')return {jsonrpc:'2.0',id:message.id,result:{tools:catalog.tools}};
      if(message.method==='tools/call'){count++;await blocked;fs.writeFileSync(path.join(local,'local.txt'),message.params.arguments.content);return {jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'local file written'}]}};}
      return null;
    }});
  let client;
  t.after(async()=>{
    release();controller.abort();await task;if(client&&client.exitCode===null&&client.signalCode===null)client.kill();
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(c=>once(c,'exit').catch(()=>{})));
    fs.rmSync(home,{recursive:true,force:true});fs.rmSync(local,{recursive:true,force:true});
  });
  await until(()=>states.includes('ready'));
  const config=JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8'));
  assert.equal(config.keep,true);assert.deepEqual(config.mcpServers.existing,{command:'original'});
  assert.equal(fs.readFileSync(path.join(desktop,'claude_desktop_config.json'),'utf8'),'DESKTOP UNCHANGED');
  const entry=config.mcpServers[sshConnectorName(key)];
  client=spawn(entry.command,['-B',...entry.args],{env:{...process.env,HOME:home,...entry.env},stdio:['pipe','pipe','pipe']});
  let output='',stderr='';client.stdout.on('data',chunk=>{output+=chunk;});client.stderr.on('data',chunk=>{stderr+=chunk;});
  client.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'claude-code'}}})+'\n');
  client.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  client.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'write_local',arguments:{content:'agent wrote locally'}}})+'\n');
  await until(()=>count===1);children[0].kill('SIGKILL');
  await until(()=>states.filter(s=>s==='ready').length===2);release();
  await until(()=>output.split('\n').filter(Boolean).some(line=>JSON.parse(line).id===2));
  const result=output.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(message=>message.id===2);
  assert.ok(!result.result.isError,JSON.stringify(result)+' '+stderr);assert.equal(count,1);
  assert.equal(fs.readFileSync(path.join(local,'local.txt'),'utf8'),'agent wrote locally');
  client.stdin.end();await once(client,'exit');
});
