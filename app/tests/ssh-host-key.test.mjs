import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnSshWithRecovery,HOST_KEY_RECOVERY_ERROR} from '../ssh-host-key.mjs';
import {sshArguments,sshExitCode} from '../ssh-mcp.mjs';
import {SshPipe} from '../ssh-mcp.mjs';
import {acquireWebTunnel} from '../ssh-web.mjs';
import {runRemote} from '../cloudcli-setup.mjs';
import {createTargetConnections} from '../target-connections.mjs';

const login = {host:'203.0.113.42',port:2222,username:'ubuntu',method:'password',secret:'SECRET-NOT-IN-ARGV'};
async function until(check) { for (let n=0;n<200;n++) { if (check()) return; await delay(10); } throw Error('condition timeout'); }
function fixture(t,{exists=true,reset='success'}={}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-host-key-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const file = path.join(directory,'known hosts');
  if (exists) fs.writeFileSync(file,'old key fixture\nother host fixture\n');
  const calls=[], children=[], keygens=[];
  const spawnProcess = (exe,args,options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.input=''; child.stdin.on('data',data => child.input+=data); child.kills=0;
    child.kill=() => { child.kills++; queueMicrotask(() => child.emit('close',null,'SIGTERM')); };
    calls.push({exe,args,options,child});
    if (path.basename(exe).startsWith('ssh-keygen')) {
      keygens.push(child);
      if (reset !== 'pending') queueMicrotask(() => {
        if (reset === 'success') fs.writeFileSync(file,'other host fixture\n');
        child.emit('close',reset === 'success' ? 0 : 1);
      });
    } else children.push(child);
    return child;
  };
  const connect = (overrides={}) => spawnSshWithRecovery('ssh',[...sshArguments(login,{background:true}),'remote-command'],
    {windowsHide:true,env:{FIXTURE:'YES'},stdio:['pipe','pipe','pipe']},
    {login,spawnProcess,knownHostsFile:file,input:'{"bootstrap":true}\n',...overrides});
  const fail = (child,text='Host key verification failed.') => { child.stderr.write(text); child.emit('close',255); };
  return {file,calls,children,keygens,connect,fail,spawnProcess};
}

test('host mismatch resets only this address/port, then replays bootstrap with accept-new silently',async t => {
  const f=fixture(t), pipe=f.connect(); let closes=0, output=''; pipe.on('close',()=>closes++); pipe.stdout.on('data',v=>output+=v);
  assert.ok(f.calls[0].args.includes('StrictHostKeyChecking=yes'));
  f.fail(f.children[0]); await until(()=>f.children.length===2);
  assert.equal(closes,0,'intermediate host-key failure is not published to the card');
  const keygen=f.calls.find(c=>c.exe==='ssh-keygen');
  assert.deepEqual(keygen.args,['-R','[203.0.113.42]:2222','-f',f.file]);
  assert.ok(f.calls.at(-1).args.includes('StrictHostKeyChecking=accept-new'));
  assert.equal(f.children[1].input,f.children[0].input);
  assert.ok(f.calls.every(c=>c.options.windowsHide));
  assert.ok(!JSON.stringify(f.calls.map(c=>c.args)).includes(login.secret));
  assert.equal(fs.readFileSync(f.file,'utf8'),'other host fixture\n');
  f.children[1].stdout.write('connected'); f.children[1].emit('close',0);
  assert.equal(output,'connected'); assert.equal(closes,1);
});

test('a second host-key failure finishes once instead of repeatedly deleting records',async t => {
  const f=fixture(t), pipe=f.connect(), closed=once(pipe,'close'); let stderr=''; pipe.stderr.on('data',v=>stderr+=v);
  f.fail(f.children[0]); await until(()=>f.children.length===2); f.fail(f.children[1]); await closed;
  assert.equal(f.children.length,2); assert.equal(f.keygens.length,1); assert.equal(sshExitCode(stderr),'SSH_HOST_KEY');
});

test('an authentication failure does not reset any fingerprint or retry credentials',async t => {
  const f=fixture(t), pipe=f.connect(), closed=once(pipe,'close');
  f.fail(f.children[0],'Permission denied (publickey,password).'); await closed;
  assert.equal(f.children.length,1); assert.equal(f.keygens.length,0);
  assert.match(fs.readFileSync(f.file,'utf8'),/old key fixture/);
});

test('a failed retry reports its own auth error rather than the suppressed first fingerprint error',async t => {
  const f=fixture(t), pipe=f.connect(), closed=once(pipe,'close'); let stderr=''; pipe.stderr.on('data',v=>stderr+=v);
  f.fail(f.children[0]); await until(()=>f.children.length===2); f.fail(f.children[1],'Permission denied (publickey).'); await closed;
  assert.equal(sshExitCode(stderr),'SSH_AUTH'); assert.doesNotMatch(stderr,/Host key verification failed/);
});

test('stopping while reset is pending kills its subprocess, releases its lock and never reconnects',async t => {
  const f=fixture(t,{reset:'pending'}), pipe=f.connect();
  f.fail(f.children[0]); await until(()=>f.keygens.length===1); pipe.kill();
  await until(()=>!fs.existsSync(f.file+'.cmcp-host-key-lock')); await delay(30);
  assert.equal(f.keygens[0].kills,1); assert.equal(f.children.length,1);
});

test('a remote command that already produced output can never be replayed',async t => {
  const f=fixture(t), pipe=f.connect(), closed=once(pipe,'close');
  f.children[0].stdout.write('remote operation ran'); f.fail(f.children[0]); await closed;
  assert.equal(f.keygens.length,0); assert.equal(f.children.length,1);
});

test('a reset failure preserves a fixed, useful final host-key error',async t => {
  const f=fixture(t,{reset:'fail'}), pipe=f.connect(), closed=once(pipe,'close'); let stderr=''; pipe.stderr.on('data',v=>stderr+=v);
  f.fail(f.children[0]); await closed;
  assert.equal(f.children.length,1); assert.ok(stderr.includes(HOST_KEY_RECOVERY_ERROR));
  assert.equal(fs.existsSync(f.file+'.cmcp-host-key-lock'),false);
});

test('an unknown host with no known_hosts file goes straight to accept-new without invoking keygen',async t => {
  const f=fixture(t,{exists:false}), pipe=f.connect();
  f.fail(f.children[0]); await until(()=>f.children.length===2);
  assert.equal(f.keygens.length,0); pipe.kill();
});

test('concurrent connections do not delete another successful reset or lose unrelated host records',async t => {
  const f=fixture(t), a=f.connect(), b=f.connect();
  f.fail(f.children[0]); f.fail(f.children[1]); await until(()=>f.children.length===4);
  assert.equal(f.keygens.length,1); assert.equal(fs.readFileSync(f.file,'utf8'),'other host fixture\n'); a.kill(); b.kill();
});

test('default SSH port resets the plain host instead of another port of the same server',async t => {
  const f=fixture(t), normal={...login,port:22};
  const pipe=spawnSshWithRecovery('ssh',sshArguments(normal),{windowsHide:true},{login:normal,spawnProcess:f.spawnProcess,knownHostsFile:f.file});
  f.fail(f.children[0]); await until(()=>f.children.length===2);
  assert.equal(f.calls.find(c=>c.exe==='ssh-keygen').args[1],normal.host); pipe.kill();
});

test('the actual web tunnel retries once before publishing its final card error',async t => {
  const f=fixture(t);
  const pending=acquireWebTunnel({directory:path.dirname(f.file),id:'fixture',login,spawnProcess:f.spawnProcess,knownHostsFile:f.file});
  const refused=assert.rejects(pending,error=>error.code==='SSH_HOST_KEY'&&error.message===HOST_KEY_RECOVERY_ERROR);
  await until(()=>f.children.length===1); f.fail(f.children[0]);
  await until(()=>f.children.length===2); f.fail(f.children[1]); await refused;
  assert.equal(f.children.length,2); assert.equal(f.keygens.length,1);
  assert.ok(f.calls.filter(c=>c.exe==='ssh').every(c=>c.args.includes('-N')&&c.args.includes('ForwardAgent=no')));
});

test('the actual MCP pipe suppresses the intermediate failure and preserves bootstrap on recovery',async t => {
  const f=fixture(t), errors=[];
  const pipe=new SshPipe({login,payload:{catalog:{tools:[]}},spawnProcess:f.spawnProcess,knownHostsFile:f.file});
  pipe.on('error',error=>errors.push(error));
  f.fail(f.children[0]); await until(()=>f.children.length===2);
  assert.equal(errors.length,0); assert.equal(f.children[0].input,f.children[1].input);
  pipe.close();
});

test('CloudCLI setup replays its JSON only after host verification and reports the successful retry',async t => {
  const f=fixture(t);
  const pending=runRemote(login,{action:'inspect'}, {spawnProcess:f.spawnProcess,knownHostsFile:f.file});
  f.fail(f.children[0]); await until(()=>f.children.length===2);
  assert.equal(f.children[1].input,'{"action":"inspect"}\n');
  f.children[1].stdout.write('{"ok":true}\n'); f.children[1].emit('close',0);
  assert.deepEqual(await pending,{ok:true});
});

test('the connection card shows recovery failure once and does not loop until the user reconnects',async () => {
  let starts=0; const states=[];
  const target={name:'tunnel:web:fixture',url:'http://127.0.0.1:3000'};
  const manager=createTargetConnections({readTargets:()=>[target],readControls:()=>new Map([[target.name,{enabled:true,revision:'1'}]]),
    status:{set:(name,state,message)=>states.push({name,state,message})},interval:5,retryMs:1,
    create:async()=>{starts++;throw Object.assign(Error('host key'),{code:'SSH_HOST_KEY'});}});
  try {
    await until(()=>states.some(row=>row.state==='error')); await delay(30);
    assert.equal(starts,1); assert.equal(states.find(row=>row.state==='error').message,HOST_KEY_RECOVERY_ERROR);
  } finally { await manager.close(); }
});
