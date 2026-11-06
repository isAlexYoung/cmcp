import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ManagerState} from '../state.mjs';
import {createManager} from '../manager.mjs';
import {CLOSABLE,closePages,detectBrowsers,openArguments,openPage,pageFolder} from '../browsers.mjs';
import {closeSessions,commandScript,sessionsFolder} from '../ssh.mjs';

function fixture(t){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-connect-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const values=new Map();const secrets=async(op,id,password)=>{if(op==='set')values.set(id,password);if(op==='delete')values.delete(id);if(op==='get'){if(!values.has(id))throw Error('missing');return values.get(id);}};return {directory,secrets};}
const posix=process.platform!=='win32';
const until=async(check,ms=10000)=>{for(const end=Date.now()+ms;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,50)))if(check())return true;return false;};

test('only installed browsers are offered, from /Applications or ~/Applications',()=>{
  const own=path.join('/Users/me','Applications','Firefox.app');
  const found=detectBrowsers(file=>['/Applications/Safari.app',own].includes(file),'/Users/me');
  assert.deepEqual(found.map(item=>[item.id,item.path]),[['safari','/Applications/Safari.app'],['firefox',own]]);
  assert.deepEqual(CLOSABLE,['chrome','edge','firefox']);
});
test('a page that closes on disconnect opens a new instance with a profile of its own',()=>{
  const chrome={id:'chrome',path:'/Applications/Google Chrome.app'},firefox={id:'firefox',path:'/Applications/Firefox.app'};
  assert.deepEqual(openArguments(chrome,'http://127.0.0.1:1/__mcp/open#x'),['-a','/Applications/Google Chrome.app','http://127.0.0.1:1/__mcp/open#x']);
  assert.deepEqual(openArguments(chrome,'https://a.example','/s/browser-windows/chrome-1').slice(0,5),['-n','-a','/Applications/Google Chrome.app','--args','--user-data-dir=/s/browser-windows/chrome-1']);
  assert.deepEqual(openArguments(firefox,'https://a.example','/s/f'),['-n','-a','/Applications/Firefox.app','--args','-profile','/s/f','-new-window','https://a.example']);
  assert.notEqual(pageFolder('/s','one','chrome'),pageFolder('/s','two','chrome'));
  assert.equal(pageFolder('/s','one','chrome'),pageFolder('/s','one','chrome'));
});
test('the chosen browser opens the page; nothing chosen leaves it to the system default',async t=>{
  const f=fixture(t),calls=[],run=async(file,args)=>{calls.push([file,args]);return '';};
  const found=[{id:'safari',label:'Safari',path:'/Applications/Safari.app'},{id:'chrome',label:'Google Chrome',path:'/Applications/Google Chrome.app'}];
  assert.equal(await openPage({},f.directory,'d1','https://a.example',{found,run}),false);
  assert.equal(await openPage({browser:'edge'},f.directory,'d1','https://a.example',{found,run}),false);
  assert.equal(calls.length,0);
  assert.equal(await openPage({browser:'chrome'},f.directory,'d1','https://a.example',{found,run}),true);
  assert.deepEqual(calls.pop(),['/usr/bin/open',['-a','/Applications/Google Chrome.app','https://a.example']]);
  assert.equal(await openPage({browser:'chrome',closeWeb:true},f.directory,'d1','https://a.example',{found,run}),true);
  const folder=pageFolder(f.directory,'d1','chrome');
  assert.ok(calls.pop()[1].includes('--user-data-dir='+folder));
  assert.ok(fs.statSync(folder).isDirectory());if(posix)assert.equal(fs.statSync(folder).mode&0o777,0o700);
  assert.equal(await openPage({browser:'safari',closeWeb:true},f.directory,'d1','https://a.example',{found,run}),true);
  assert.deepEqual(calls.pop()[1],['-a','/Applications/Safari.app','https://a.example']);
});
test('closing ends only processes carrying this device\'s page folder, and only when asked',async t=>{
  const f=fixture(t),mine=pageFolder(f.directory,'d1','edge'),other=pageFolder(f.directory,'d2','edge');
  let processes=[{pid:11,ppid:1,command:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --user-data-dir='+mine+' --new-window x'},{pid:12,ppid:11,command:'Helper --type=renderer --user-data-dir='+mine},{pid:13,ppid:1,command:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --user-data-dir='+other},{pid:14,ppid:1,command:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'}];
  const kills=[],list=async()=>processes,kill=(pid,signal)=>{kills.push([pid,signal]);processes=processes.filter(item=>item.pid!==pid);};
  assert.equal(await closePages({browser:'edge',closeWeb:false},f.directory,'d1',{list,kill}),0);
  assert.equal(await closePages({browser:'safari',closeWeb:true},f.directory,'d1',{list,kill}),0);
  assert.equal(kills.length,0);
  assert.equal(await closePages({browser:'edge',closeWeb:true},f.directory,'d1',{list,kill,wait:async()=>{}}),2);
  assert.deepEqual(kills,[[11,'SIGTERM'],[12,'SIGTERM']]);
  assert.deepEqual(processes.map(item=>item.pid),[13,14]);
});
test('a page window that ignores the polite request is ended',async t=>{
  const f=fixture(t),mine=pageFolder(f.directory,'d1','chrome'),kills=[];
  const list=async()=>kills.some(([,signal])=>signal==='SIGKILL')?[]:[{pid:21,ppid:1,command:'Chrome --user-data-dir='+mine}];
  assert.equal(await closePages({browser:'chrome',closeWeb:true},f.directory,'d1',{list,kill:(pid,signal)=>kills.push([pid,signal]),wait:async()=>{}}),1);
  assert.deepEqual(kills,[[21,'SIGTERM'],[21,'SIGKILL']]);
});
test('a real process with this device\'s page folder is closed',{skip:!posix},async t=>{
  const f=fixture(t),folder=pageFolder(f.directory,'d1','chrome'),otherFolder=pageFolder(f.directory,'d2','chrome');
  const start=target=>spawn(process.execPath,['-e','setTimeout(()=>{},30000)','--','--user-data-dir='+target],{stdio:'ignore'});
  const mine=start(folder),other=start(otherFolder);t.after(()=>{mine.kill('SIGKILL');other.kill('SIGKILL');});
  let mineExit=null;mine.on('exit',(code,signal)=>{mineExit=signal||code;});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(await closePages({browser:'chrome',closeWeb:true},f.directory,'d1'),1);
  assert.ok(await until(()=>mineExit!==null));assert.equal(mineExit,'SIGTERM');
  assert.equal(other.exitCode,null);assert.equal(other.signalCode,null);
});
test('a terminal that closes on disconnect records its script and ends after ssh',()=>{
  const login={id:'d1',host:'203.0.113.24',port:22,username:'root',method:'password',keyPath:''};
  const kept=commandScript(login,{state:'/s'}),closing=commandScript(login,{state:'/s',sessions:'/s/ssh-sessions/abc',ended:'Press Enter'});
  assert.ok(kept.includes('exec "${SHELL:-/bin/zsh}" -l')&&!kept.includes('cmcp_session'));
  assert.ok(closing.includes("cmcp_session='/s/ssh-sessions/abc'/$$.pid")&&closing.indexOf('cmcp_session=')<closing.indexOf("'/usr/bin/ssh'"));
  assert.ok(closing.includes('cmcp_code=$?')&&closing.includes("'Press Enter'")&&closing.trimEnd().endsWith('exit 0')&&!closing.includes('exec "${SHELL'));
});
// The generated script with a stand-in for ssh: a link named ssh to sleep, or to false for a failed login.
async function runScript(t,f,stand){
  const id='d1',sessions=fs.mkdirSync(sessionsFolder(f.directory,id),{recursive:true,mode:0o700})&&sessionsFolder(f.directory,id);
  const bin=path.join(f.directory,'bin');fs.mkdirSync(bin);fs.symlinkSync(stand,path.join(bin,'ssh'));
  const login={id,host:'203.0.113.24',port:22,username:'root',method:'password',keyPath:''};
  const text=commandScript(login,{state:f.directory,ssh:'SSHCMD',sessions,ended:'PRESS-ENTER'}).split('\n').map(line=>line.startsWith("'SSHCMD'")?path.join(bin,'ssh')+(stand.endsWith('sleep')?' 30':''):line).join('\n');
  fs.mkdirSync(path.join(f.directory,'ssh-run'),{mode:0o700});const script=path.join(f.directory,'ssh-run','t.command');fs.writeFileSync(script,text,{mode:0o700});
  const child=spawn('/bin/sh',[script],{stdio:['pipe','pipe','ignore']});let output='',exit=null;child.stdout.on('data',chunk=>{output+=chunk;});child.on('exit',code=>{exit=code;});t.after(()=>child.kill('SIGKILL'));
  return {child,sessions,output:()=>output,exit:()=>exit};
}
test('stopping ends the ssh inside a recorded terminal and the script exits normally',{skip:!posix},async t=>{
  const f=fixture(t),run=await runScript(t,f,'/bin/sleep');
  assert.ok(await until(()=>fs.readdirSync(run.sessions).length===1));
  assert.equal(await closeSessions(f.directory,'other'),0);
  let closed=0;for(let i=0;i<50&&!closed;i++){closed=await closeSessions(f.directory,'d1');if(!closed)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(closed,1);
  assert.ok(await until(()=>run.exit()!==null));assert.equal(run.exit(),0);
  assert.ok(!run.output().includes('PRESS-ENTER'));assert.deepEqual(fs.readdirSync(run.sessions),[]);
});
test('a failed login waits for Enter so its message can be read',{skip:!posix},async t=>{
  const f=fixture(t),run=await runScript(t,f,'/usr/bin/false');
  assert.ok(await until(()=>run.output().includes('PRESS-ENTER')));
  assert.equal(run.exit(),null);run.child.stdin.end('\n');
  assert.ok(await until(()=>run.exit()!==null));assert.equal(run.exit(),0);
});
test('a record whose script has gone is removed without touching anything',async t=>{
  const f=fixture(t),folder=sessionsFolder(f.directory,'d1');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'999999.pid'),'');
  const kills=[];assert.equal(await closeSessions(f.directory,'d1',{list:async()=>[{pid:999999,ppid:1,command:'/bin/zsh'},{pid:5,ppid:999999,command:'/usr/bin/ssh x'}],kill:pid=>kills.push(pid)}),0);
  assert.deepEqual(kills,[]);assert.deepEqual(fs.readdirSync(folder),[]);
});
test('the connection settings save, and stopping closes what the settings ask for',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({url:'https://first.invalid',label:'Web',password:'',autoLogin:false,icon:'',ssh:{host:'203.0.113.24',port:'22',username:'root',method:'password',keyPath:'',secret:''}},async()=>true);
  const pages=[],terminals=[],launches=[];
  const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},terminals:()=>[{id:'terminal',label:'Terminal',path:'/T.app'}],browsers:()=>[{id:'chrome',label:'Google Chrome',path:'/Applications/Google Chrome.app'}],
    closeBrowserPages:async(preferences,directory,target)=>{pages.push([preferences.browser,preferences.closeWeb,target]);return 0;},closeTerminals:async(directory,target)=>{terminals.push(target);return 1;},stopChannel:async()=>{},
    launchTerminal:async(login,directory,chosen,options)=>{launches.push(options);return 'terminal';}});t.after(()=>m.close());
  const call=async(route,body={})=>{const res=await fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const snapshot=await (await fetch(m.origin+'/api/state',{headers:{'x-cmcp-token':m.token}})).json();
  assert.deepEqual(snapshot.browsers,[{id:'chrome',label:'Google Chrome'}]);
  assert.equal((await call('settings',{closeWeb:'yes'})).status,400);
  assert.equal((await call('settings',{browser:'chrome',closeWeb:true,closeTerminal:true})).status,200);
  assert.equal(new ManagerState(f.directory,f.secrets).preferences.closeTerminal,true);
  await call('targets/stop',{id});assert.ok(await until(()=>pages.length===1));assert.deepEqual(pages[0],['chrome',true,id]);
  assert.deepEqual((await call('targets/ssh-stop',{id})).body,{stopped:true,closedTerminals:true});assert.deepEqual(terminals,[id]);
  await call('targets/terminal',{id});assert.deepEqual(launches.pop(),{closeTerminal:true});
  await call('settings',{closeTerminal:false});
  assert.deepEqual((await call('targets/ssh-stop',{id})).body,{stopped:true,closedTerminals:false});assert.deepEqual(terminals,[id]);
  await call('targets/terminal',{id});assert.deepEqual(launches.pop(),{closeTerminal:false});
});
