import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {sshArguments,sshConnectorName,sshExitCode,SshPipe,startSshMcp,bootstrapPayload} from '../ssh-mcp.mjs';
import {workerPaths,runWorker,queryWorker,ensureSshWorker,stopSshWorkers,readSshLogin} from '../ssh-terminal.mjs';
import {sshRoots,createSshDispatcher} from '../ssh-local-tools.mjs';

const login={host:'203.0.113.2',port:2222,username:'root',method:'password',secret:'ENCRYPTED-PLACEHOLDER'};
async function until(check){const start=Date.now();while(!await check()){if(Date.now()-start>5000)throw Error('condition timeout');await delay(10);}}
const frame=value=>Buffer.from('CPCMCP1:'+Buffer.from(JSON.stringify(value)).toString('base64')+'\n');
class RelayPipe extends EventEmitter {
  constructor(){super();this.readyState=1;this.bufferedAmount=0;this.messages=[];this.parts=[];queueMicrotask(()=>this.emit('message',frame({t:'ready'}),true));}
  send(text){
    const envelope=JSON.parse(text);if(envelope.t==='kill'){this.close();return;}
    const packet=JSON.parse(envelope.d.slice(8));
    if(packet.t==='ping'){this.emit('message',frame({t:'pong'}),true);return;}
    if(packet.t!=='data')return;
    this.parts.push(packet.data);this.emit('message',frame({t:'ack',id:packet.id,n:packet.n}),true);
    if(packet.end){const msg=JSON.parse(Buffer.from(this.parts.join(''),'base64'));this.parts=[];this.messages.push(msg);if(msg.t==='hello')this.emit('message',frame({t:'welcome'}),true);}
  }
  request(msg){this.emit('message',frame(msg),true);}
  close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.emit('close',1000,'closed'));}
  terminate(){this.close();}
}

test('SSH arguments are non-PTY, persistent, correctly quoted and carry no saved credential',()=>{
  const args=sshArguments(login,{background:true});
  assert.ok(args.includes('-T'));assert.ok(args.includes('ForwardAgent=no'));assert.ok(args.includes('ClearAllForwardings=yes'));
  assert.deepEqual(args.slice(-2),['--',login.host]);assert.ok(!args.includes(login.secret));
  assert.ok(sshArguments({...login,host:'::ffff:127.0.0.1'}).includes('::ffff:127.0.0.1'));
  assert.ok(sshArguments({...login,method:'key',keyPath:"C:\\a b's\\id"}).includes("C:\\a b's\\id"));
  for(const host of ['-oProxyCommand=x','a;id','a\nb',"a'b"]){assert.throws(()=>sshArguments({...login,host}));}
  for(const port of [0,65536,1.2])assert.throws(()=>sshArguments({...login,port}));
});

test('SSH uses a separate connector and catalog; web relay files are not overwritten',()=>{
  const payload=bootstrapPayload('one-device',{tools:[]});
  assert.match(payload.name,/^cmcp-ssh-[a-f0-9]{16}$/);assert.notEqual(payload.name,sshConnectorName('other-device'));
  assert.ok(payload.connector.includes('def apply_install'));assert.ok(payload.relay.includes('class Relay'));
  assert.ok(bootstrapPayload('mac',{tools:[]},'darwin').connector.includes('physical Mac'));
});

test('raw SSH pipe sends bootstrap through stdin and maps authentication failure without exposing credentials',async()=>{
  let observed;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  let input='';child.stdin.on('data',chunk=>{input+=chunk;});
  const pipe=new SshPipe({login,payload:{catalog:{tools:[]}},spawnProcess:(file,args,options)=>{observed={file,args,options};return child;}});
  assert.ok(observed.args.at(-1).startsWith('python3 -I -B -u -c '));assert.ok(!JSON.stringify(observed.args).includes(login.secret));
  assert.equal(JSON.parse(input).catalog.tools.length,0);assert.equal(observed.options.windowsHide,true);
  const errors=[];pipe.on('error',e=>errors.push(e));child.stderr.write('Permission denied (publickey,password).');child.emit('close',255);
  assert.equal(errors[0].code,'SSH_AUTH');assert.ok(!errors[0].message.includes('PLACEHOLDER'));
});

test('auth, host key and remote setup failures are classified separately from network interruptions',()=>{
  assert.equal(sshExitCode('Host key verification failed.'),'SSH_HOST_KEY');
  assert.equal(sshExitCode('Permission denied (publickey).'),'SSH_AUTH');
  assert.equal(sshExitCode('Traceback\nPermissionError: config'),'SSH_SETUP');
  assert.equal(sshExitCode('Connection reset by peer'),'SSH_DISCONNECTED');
});

test('SSH tool execution survives reconnect with one retained result and no repeated file operation',async()=>{
  const controller=new AbortController(),pipes=[],states=[];let executed=0,complete;
  const task=startSshMcp({key:'device',login,catalog:{tools:[]},signal:controller.signal,retryDelay:1,heartbeatMs:20,silenceMs:200,
    transport:()=>{const p=new RelayPipe();pipes.push(p);return p;},status:state=>states.push(state),
    forward:()=>{executed++;return new Promise(resolve=>{complete=resolve;});}});
  await until(()=>states.includes('ready'));
  const msg={jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'write_file',arguments:{path:'local-file',content:'one'}}};
  const request={t:'req',id:'first',msg,recovery:{protocol:1,requestId:'a'.repeat(32),action:'execute'}};
  pipes[0].request(request);await until(()=>executed===1);pipes[0].close();await until(()=>pipes.length===2&&states.filter(x=>x==='ready').length===2);
  pipes[1].request({...request,id:'query',recovery:{...request.recovery,action:'query'}});
  await until(()=>pipes[1].messages.some(m=>m.id==='query'));
  assert.equal(pipes[1].messages.find(m=>m.id==='query').recovery.state,'running');
  complete({jsonrpc:'2.0',id:4,result:{content:[{type:'text',text:'written'}]}});await delay(10);
  pipes[1].request({...request,id:'result',recovery:{...request.recovery,action:'query'}});
  await until(()=>pipes[1].messages.some(m=>m.id==='result'));
  assert.equal(pipes[1].messages.find(m=>m.id==='result').msg.result.content[0].text,'written');assert.equal(executed,1);
  pipes[1].request({...request,id:'duplicate'});await until(()=>pipes[1].messages.some(m=>m.id==='duplicate'));assert.equal(executed,1);
  controller.abort();await task;assert.ok(states.includes('recovering'));assert.equal(pipes[1].readyState,3);
});

test('SSH authentication failure pauses instead of retrying a saved password',async()=>{
  const controller=new AbortController();let calls=0;const states=[];
  await startSshMcp({key:'x',login,catalog:{tools:[]},forward:()=>{},signal:controller.signal,status:s=>states.push(s),transport:()=>{
    calls++;const p=new RelayPipe();queueMicrotask(()=>{p.emit('error',Object.assign(Error('SSH auth failed'),{code:'SSH_AUTH'}));p.close();});return p;
  }});
  assert.equal(calls,1);assert.ok(states.includes('failed'));
});

test('a remote takeover pauses this SSH worker instead of fighting the other computer',{timeout:5000},async t=>{
  const controller=new AbortController(),states=[];let pipe,calls=0;
  t.after(()=>controller.abort());
  const task=startSshMcp({key:'same-device',login,catalog:{tools:[]},forward:()=>{},signal:controller.signal,status:s=>states.push(s),transport:()=>{calls++;return pipe=new RelayPipe();}});
  await until(()=>states.includes('ready'));pipe.request({t:'close',code:4002,reason:'replaced'});await task;
  assert.equal(calls,1);assert.equal(states.at(-1),'failed');
});

test('worker reuses one authenticated IPC endpoint, rejects unauthenticated stops and closes local tools',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-ssh-worker-')),id=randomUUID();
  fs.writeFileSync(path.join(directory,'ssh-logins.json'),JSON.stringify({schema:1,logins:[{...login,name:id}]}));
  const paths=workerPaths(directory,id);let closed=0,launches=0;
  const worker=runWorker({directory,id,owner:process.pid,createDispatcher:async()=>({forward:async()=>({result:{tools:[]}}),close:async()=>{closed++;}}),connect:async({signal,status})=>{status('ready','ready');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}});
  t.after(async()=>{await stopSshWorkers(directory);await worker;fs.rmSync(directory,{recursive:true,force:true});});
  await until(async()=>{try{return (await queryWorker(paths)).state==='ready';}catch{return false;}});
  await ensureSshWorker({directory,id,owner:process.pid,launch:()=>{launches++;throw Error('must reuse');}});assert.equal(launches,0);
  await new Promise(resolve=>{const s=net.connect(paths.endpoint,()=>s.write(JSON.stringify({action:'stop',token:'0'.repeat(64)})+'\n'));s.on('close',resolve);});
  assert.equal((await queryWorker(paths)).state,'ready');
  await stopSshWorkers(directory);await worker;assert.equal(closed,1);
});

test('SSH account changes stop only their worker and never rewrite web targets',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-ssh-config-')),id=randomUUID(),file=path.join(directory,'ssh-logins.json');
  fs.writeFileSync(file,JSON.stringify({schema:1,logins:[{...login,name:id}]}));
  const web=path.join(directory,'cloudpc-targets.json');fs.writeFileSync(web,'WEB-STATE-UNCHANGED');
  const worker=runWorker({directory,id,owner:process.pid,createDispatcher:async()=>({forward:async()=>({result:{tools:[]}}),close:async()=>{}}),connect:async({signal,status})=>{status('ready','ready');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}});
  t.after(async()=>{await stopSshWorkers(directory);await worker;fs.rmSync(directory,{recursive:true,force:true});});
  await until(async()=>{try{return(await queryWorker(workerPaths(directory,id))).state==='ready';}catch{return false;}});
  fs.writeFileSync(file,JSON.stringify({schema:1,logins:[{...login,name:id,host:'203.0.113.3'}]}));
  await worker;assert.equal(fs.readFileSync(web,'utf8'),'WEB-STATE-UNCHANGED');
});

test('SSH local executors actually read and modify a permitted local file', {skip:process.platform!=='win32'},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-ssh-tools-'));fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({roots:[directory]}));
  const dispatcher=await createSshDispatcher(directory);t.after(async()=>{await dispatcher.close();fs.rmSync(directory,{recursive:true,force:true});});
  const file=path.join(directory,'local.txt');
  const call=async(name,args)=>(await dispatcher.forward({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})).result;
  assert.ok(!(await call('write_file',{path:file,content:'local agent task'})).isError);
  assert.equal(fs.readFileSync(file,'utf8'),'local agent task');
  const read=await call('read_file',{path:file});assert.ok(JSON.stringify(read).includes('local agent task'));
  const initialize=await dispatcher.forward({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-11-25'}});assert.match(initialize.result.instructions,/physical Windows PC/);
  const denied=await call('read_file',{path:path.join(path.dirname(directory),'outside-root.txt')});assert.equal(denied.isError,true);
});
