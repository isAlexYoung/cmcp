import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ManagerState} from '../state.mjs';
import {createManager} from '../manager.mjs';
import {runWorker,sshWorkerState,stopSshWorker} from '../../app/ssh-terminal.mjs';
import {VARIABLE,answerPrompt,classify,commandScript,detectTerminals,dialog,openArguments,openTerminal,resolveTerminal,sshOptions,sshProblem,validHost,validUser,writeLaunch} from '../ssh.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
function fixture(t){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-ssh-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const values=new Map();const secrets=async(op,id,password)=>{if(op==='set')values.set(id,password);if(op==='delete')values.delete(id);if(op==='get'){if(!values.has(id))throw Error('missing');return values.get(id);}};return {directory,secrets,values};}
const web=(url='https://first.invalid')=>({url,label:'Web',password:'',autoLogin:false,icon:''});
const ssh=(extra={})=>({host:'203.0.113.24',port:'2222',username:'root',method:'password',keyPath:'',secret:'',...extra});
const sshInput=(extra={},sshExtra={})=>({...web(''),label:'VPS',ssh:ssh(sshExtra),...extra});
const run=(file,args,options)=>new Promise(resolve=>execFile(file,args,{timeout:30000,...options},(error,stdout,stderr)=>resolve({code:error?error.code:0,stdout,stderr})));
const login=(extra={})=>({id:randomUUID(),host:'203.0.113.24',port:2222,username:'root',method:'password',keyPath:'',...extra});

test('card address hiding persists across edits, sign-in switches and web-to-SSH-only changes',async t=>{
  const f=fixture(t);let state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({...web(),ssh:ssh(),hideAddress:true,note:'Device note'},async()=>true);
  assert.equal(state.view().targets[0].hideAddress,true);
  state.setEnabled(id,false);
  const before=fs.readFileSync(path.join(f.directory,'target-controls.json'),'utf8');
  state.setLogin(id,true);
  assert.equal(state.view().targets[0].hideAddress,true);
  assert.equal(fs.readFileSync(path.join(f.directory,'target-controls.json'),'utf8'),before);
  state=new ManagerState(f.directory,f.secrets);
  assert.equal(state.view().targets[0].hideAddress,true);
  assert.equal(state.view().targets[0].note,'Device note');
  await state.save({...sshInput({id}),label:'SSH only'},async()=>true);
  state=new ManagerState(f.directory,f.secrets);
  assert.equal(state.view().targets[0].hideAddress,true);
  assert.equal(state.view().targets[0].url,'');
  await state.save({...web('https://second.invalid'),id,ssh:ssh()},async()=>true);
  assert.equal(state.view().targets[0].hideAddress,true);
  await state.save({...web('https://second.invalid'),id,ssh:ssh(),hideAddress:false},async()=>true);
  assert.equal(new ManagerState(f.directory,f.secrets).view().targets[0].hideAddress,false);
});
test('legacy devices show addresses by default and invalid display options leave the original configuration intact',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save(web(),async()=>true);
  assert.equal(state.view().targets[0].hideAddress,false);
  const file=path.join(f.directory,'targets.json'),before=fs.readFileSync(file,'utf8');
  await assert.rejects(state.save({...web(),id,hideAddress:'yes'},async()=>true),/显示设置无效/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('a host or user cannot pass as an option or a shell separator',()=>{
  for(const value of ['example.com','a-b.example.com','203.0.113.24','2001:db8::1','h'])assert.ok(validHost(value),value);
  for(const value of ['','-oProxyCommand=x','a b','a;b','a&b',"a'b",'a"b','a|b','$(x)','a\nb'])assert.ok(!validHost(value),value);
  for(const value of ['root','a.b_c-d','user@domain'])assert.ok(validUser(value),value);
  for(const value of ['','-l','a b','a;b',"a'b"])assert.ok(!validUser(value),value);
});
test('ports stay in range and the key method needs an absolute path',()=>{
  const good={host:'a.example',port:22,username:'root',method:'password'};
  assert.equal(sshProblem(good),'');
  for(const port of [0,65536,'x',1.5])assert.notEqual(sshProblem({...good,port}),'');
  assert.notEqual(sshProblem({...good,method:'other'}),'');
  assert.notEqual(sshProblem({...good,method:'key',keyPath:''}),'');
  assert.notEqual(sshProblem({...good,method:'key',keyPath:'relative/key'}),'');
  assert.equal(sshProblem({...good,method:'key',keyPath:'/Users/me/.ssh/id'}),'');
});
test('a saved password is tried once; nothing saved leaves ssh to ask in the terminal',()=>{
  const saved=sshOptions(login({credentialId:randomUUID()}));
  assert.ok(saved.includes('NumberOfPasswordPrompts=1')&&saved.includes('PubkeyAuthentication=no'));
  assert.deepEqual(sshOptions(login()),['-p','2222','-l','root','--','203.0.113.24']);
  assert.deepEqual(sshOptions(login({method:'key',keyPath:'/k/id'})),['-p','2222','-l','root','-i','/k/id','-o','IdentitiesOnly=yes','--','203.0.113.24']);
});
test('the real shell passes every value as one argument and forgets the helper once ssh ends',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),folder=path.join(f.directory,"it's here");fs.mkdirSync(folder);
  const seen=path.join(folder,'seen'),after=path.join(folder,'after'),fake=path.join(folder,'fake-ssh'),shell=path.join(folder,'fake-shell');
  fs.writeFileSync(fake,`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${JSON.stringify(seen)}\nprintf '%s\\n' "$SSH_ASKPASS_REQUIRE" >> ${JSON.stringify(seen)}\n`,{mode:0o755});
  fs.writeFileSync(shell,`#!/bin/sh\nprintf '[%s][%s]\\n' "$SSH_ASKPASS" "$${VARIABLE}" > ${JSON.stringify(after)}\n`,{mode:0o755});
  const value=login({method:'key',keyPath:path.join(folder,'my key'),credentialId:randomUUID()}),script=path.join(folder,'run.command');
  fs.writeFileSync(script,commandScript(value,{askpass:path.join(folder,'helper'),state:folder,ssh:fake}),{mode:0o700});
  const result=await run('/bin/sh',[script],{env:{PATH:process.env.PATH,SHELL:shell}});
  assert.equal(result.code,0,result.stderr);
  const lines=fs.readFileSync(seen,'utf8').trim().split('\n');
  assert.deepEqual(lines,['-p','2222','-l','root','-i',value.keyPath,'-o','IdentitiesOnly=yes','--','203.0.113.24','force']);
  assert.equal(fs.readFileSync(after,'utf8').trim(),'[][]');
  assert.ok(!fs.existsSync(script),'the script deletes itself');
});
test('the launch script prepares MCP even without a saved secret and keeps the helper private',t=>{
  const f=fixture(t),plain=writeLaunch(login(),f.directory);
  assert.ok(fs.readFileSync(plain,'utf8').includes('SSH_ASKPASS'));assert.ok(fs.existsSync(path.join(f.directory,'ssh-askpass')));
  assert.ok(fs.readFileSync(plain,'utf8').includes('ssh-terminal.mjs'));assert.ok(fs.readFileSync(plain,'utf8').includes("'--owner' '"+process.pid+"'"));
  if(process.platform!=='win32')assert.equal(fs.statSync(plain).mode&0o777,0o700);assert.ok(plain.endsWith('.command'));
  const script=writeLaunch(login({credentialId:randomUUID()}),f.directory,{node:'/app/run time/node',kit:'/app/kit'}),helper=path.join(f.directory,'ssh-askpass');
  if(process.platform!=='win32')assert.equal(fs.statSync(helper).mode&0o777,0o700);assert.ok(fs.readFileSync(helper,'utf8').replaceAll('\\','/').includes("'/app/run time/node' '/app/kit/ssh-askpass.mjs' \"$1\""));
  assert.ok(fs.readFileSync(script,'utf8').includes('SSH_ASKPASS_REQUIRE=force'));
});
test('only installed terminals are offered and each one gets its own way of running the script',()=>{
  const found=detectTerminals(file=>file.includes('Terminal.app')||file.endsWith('Applications/kitty.app'),'/Users/me');
  assert.deepEqual(found.map(item=>item.id),['terminal','kitty']);assert.equal(found[1].path,'/Applications/kitty.app');
  assert.equal(resolveTerminal('iterm',found).id,'terminal');assert.equal(resolveTerminal('kitty',found).id,'kitty');assert.equal(resolveTerminal('x',[]),null);
  assert.deepEqual(openArguments({id:'terminal',path:'/T.app'},'/s'),['-a','/T.app','/s']);
  assert.deepEqual(openArguments({id:'iterm',path:'/I.app'},'/s'),['-a','/I.app','/s']);
  assert.deepEqual(openArguments({id:'ghostty',path:'/G.app'},'/s'),['-n','-a','/G.app','--args','-e','/s']);
  assert.deepEqual(openArguments({id:'wezterm',path:'/W.app'},'/s'),['-n','-a','/W.app','--args','start','--','/s']);
  assert.deepEqual(openArguments({id:'kitty',path:'/K.app'},'/s'),['-n','-a','/K.app','--args','/s']);
});
test('opening uses the chosen terminal, and a failure leaves no script behind',async t=>{
  const f=fixture(t),found=[{id:'terminal',path:'/T.app'},{id:'kitty',path:'/K.app'}];let call;
  assert.equal(await openTerminal(login(),f.directory,'kitty',{found,run:async(file,args)=>{call=[file,args];}}),'kitty');
  assert.equal(call[0],'/usr/bin/open');assert.ok(call[1].includes('/K.app'));
  const folder=path.join(f.directory,'ssh-run'),before=fs.readdirSync(folder).length;
  await assert.rejects(openTerminal(login(),f.directory,'kitty',{found,run:async()=>{throw Error('no');}}),/无法打开/);
  assert.equal(fs.readdirSync(folder).length,before);
  await assert.rejects(openTerminal(login(),f.directory,'',{found:[]}),/无法打开/);
});
test('a saved secret only answers the exact prompt for this device',()=>{
  const password=login({credentialId:randomUUID()}),key=login({method:'key',keyPath:'/Users/me/.ssh/id_ed25519',credentialId:randomUUID()});
  for(const prompt of ["root@203.0.113.24's password: ",'(root@203.0.113.24) Password: ','Password: '])assert.equal(classify(prompt,password),'secret',prompt);
  for(const prompt of ["admin@203.0.113.24's password: ","root@198.51.100.7's password: ",'Verification code: '])assert.equal(classify(prompt,password),'ask',prompt);
  assert.equal(classify("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ",key),'secret');assert.equal(classify("Enter passphrase for key '/other/id': ",key),'ask');
  assert.equal(classify('Are you sure you want to continue connecting (yes/no/[fingerprint])? ',password),'confirm');
  assert.equal(classify("root@203.0.113.24's password: ",login()),'ask');assert.equal(classify('Password: ',null),'ask');
});
test('the helper prints the secret, leaves host keys to the user and reports a refusal',async t=>{
  const f=fixture(t),id=randomUUID(),credentialId=randomUUID();f.values.set(credentialId,'TESTONLY 口令');
  fs.writeFileSync(path.join(f.directory,'ssh-logins.json'),JSON.stringify({schema:1,logins:[{id,host:'203.0.113.24',port:22,username:'root',method:'password',keyPath:'',credentialId}],order:[]}));
  const asks=[],ask=(answer)=>async(prompt,kind)=>{asks.push(kind);return answer;},base={id,directory:f.directory,secrets:f.secrets};
  assert.deepEqual(await answerPrompt({...base,prompt:"root@203.0.113.24's password: ",ask:ask('x')}),{code:0,output:'TESTONLY 口令\n'});assert.equal(asks.length,0);
  assert.deepEqual(await answerPrompt({...base,prompt:'Continue (yes/no)? ',ask:ask('yes')}),{code:0,output:'yes\n'});
  assert.deepEqual(await answerPrompt({...base,prompt:'Continue (yes/no)? ',ask:ask(null)}),{code:0,output:'no\n'});
  assert.deepEqual(await answerPrompt({...base,prompt:'Code: ',ask:ask('123')}),{code:0,output:'123\n'});
  assert.deepEqual(await answerPrompt({...base,prompt:'Code: ',ask:ask(null)}),{code:1,output:''});
  f.values.clear();assert.deepEqual(await answerPrompt({...base,prompt:'Password: ',ask:ask('typed')}),{code:0,output:'typed\n'});
  assert.deepEqual(await answerPrompt({...base,id:randomUUID(),prompt:'Password: ',ask:ask('typed')}),{code:0,output:'typed\n'});
  assert.deepEqual(await answerPrompt({...base,prompt:'x',style:'none',ask:ask('z')}),{code:0,output:''});
});
test('dialogs pass the text as data, never as script',async()=>{
  let call;const answer=await dialog('"; do shell script "x','ask','en',async(file,args)=>{call=[file,args];return 'typed\n';});
  assert.equal(answer,'typed');assert.equal(call[0],'/usr/bin/osascript');assert.ok(!call[1][1].includes('do shell script'));assert.equal(call[1][2],'"; do shell script "x');
  assert.equal(await dialog('m','confirm','zh-CN',async()=>{throw Error('cancelled');}),null);
});
test('real OpenSSH takes the passphrase from the helper',{skip:!fs.existsSync('/usr/bin/ssh-keygen')},async t=>{
  const f=fixture(t),key=path.join(f.directory,'id test'),phrase='TESTONLY 口令 123',id=randomUUID(),credentialId=randomUUID();
  assert.equal((await run('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N',phrase,'-f',key])).code,0);
  fs.writeFileSync(path.join(f.directory,'ssh-logins.json'),JSON.stringify({schema:1,logins:[{id,host:'203.0.113.24',port:22,username:'root',method:'key',keyPath:key,credentialId}],order:[]}));
  const module=path.join(here,'..','ssh.mjs'),entry=path.join(f.directory,'helper.mjs'),helper=path.join(f.directory,'helper');
  fs.writeFileSync(entry,`import {answerPrompt} from ${JSON.stringify(module)};\nconst r=await answerPrompt({prompt:process.argv[2],id:process.env.${VARIABLE},directory:${JSON.stringify(f.directory)},secrets:async()=>${JSON.stringify(phrase)},ask:async()=>null});\nprocess.stdout.write(r.output,()=>process.exit(r.code));\n`);
  fs.writeFileSync(helper,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$1"\n`,{mode:0o755});
  const result=await run('/usr/bin/ssh-keygen',['-y','-f',key],{env:{PATH:process.env.PATH,SSH_ASKPASS:helper,SSH_ASKPASS_REQUIRE:'force',[VARIABLE]:id}});
  assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes(fs.readFileSync(key+'.pub','utf8').split(' ')[1]));
});
test('a device can have SSH only, and it never reaches the connection list or targets.json',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets);
  const id=await s.save(sshInput({},{secret:'TESTONLY'}),()=>assert.fail('SSH must not probe a web address'));
  assert.equal(s.targets.length,0);assert.deepEqual(s.linkTargets(),[]);assert.ok(!fs.existsSync(path.join(f.directory,'targets.json')));
  const device=s.view().targets[0];
  assert.equal(device.id,id);assert.equal(device.url,'');assert.equal(device.label,'VPS');assert.equal(device.ssh.active,true);assert.equal(device.ssh.hasSecret,true);assert.equal(device.ssh.address,'root@203.0.113.24:2222');
  const text=fs.readFileSync(path.join(f.directory,'ssh-logins.json'),'utf8');assert.ok(!text.includes('TESTONLY'));assert.ok(!JSON.stringify(s.view()).includes('TESTONLY'));assert.equal([...f.values.values()][0],'TESTONLY');
  const again=new ManagerState(f.directory,f.secrets);assert.equal(again.view().targets[0].ssh.port,2222);
});
test('a device needs one way to sign in, and bad details are refused before anything is saved',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),key=path.join(f.directory,'id');fs.writeFileSync(key,'x');fs.writeFileSync(key+'.pub','x');
  await assert.rejects(s.save({...web(''),ssh:null},async()=>true),/至少填写/);
  await assert.rejects(s.save(sshInput({},{host:'-oProxyCommand=x'}),async()=>true),/主机/);
  await assert.rejects(s.save(sshInput({},{port:'70000'}),async()=>true),/端口/);
  await assert.rejects(s.save(sshInput({},{username:'a b'}),async()=>true),/用户名/);
  await assert.rejects(s.save(sshInput({},{method:'key',keyPath:key+'.pub'}),async()=>true),/公钥/);
  await assert.rejects(s.save(sshInput({},{method:'key',keyPath:key+'.none'}),async()=>true),/找不到/);
  assert.equal(s.view().targets.length,0);assert.equal(f.values.size,0);
  await s.save(sshInput({},{method:'key',keyPath:key}),async()=>true);assert.equal(s.view().targets[0].ssh.method,'key');
});
test('a saved secret is kept only for the same server, user and method',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),id=await s.save(sshInput({},{secret:'old'}),async()=>true),first=s.sshFor(id).credentialId;
  await s.save(sshInput({id}),async()=>true);assert.equal(s.sshFor(id).credentialId,first);assert.equal(f.values.get(first),'old');
  await s.save(sshInput({id},{host:'198.51.100.7'}),async()=>true);assert.equal(s.sshFor(id).credentialId,undefined);assert.equal(f.values.size,0);
  await s.save(sshInput({id},{secret:'new'}),async()=>true);const second=s.sshFor(id).credentialId;
  await s.save(sshInput({id},{username:'admin'}),async()=>true);assert.equal(s.sshFor(id).credentialId,undefined);
  await s.save(sshInput({id},{secret:'again'}),async()=>true);
  await s.save(sshInput({id},{forgetSecret:true}),async()=>true);assert.equal(s.sshFor(id).credentialId,undefined);assert.equal(f.values.size,0);assert.ok(second);
});
test('web and SSH live side by side; switching and SSH edits leave a running connection alone',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),id=await s.save(web(),async()=>true);
  assert.equal(s.view().targets[0].ssh,null);s.setLogin(id,true);assert.equal(s.view().targets[0].loginMode,'ssh');s.setLogin(id,false);
  s.setEnabled(id,true);const revision=s.controlMap().get(id).revision;
  await s.save({...web(),id,ssh:ssh(),preferSsh:false},()=>assert.fail('SSH edits must not probe the address'));
  let device=s.view({[id]:{state:'connected',message:'ok'}}).targets[0];
  assert.equal(device.ssh.active,false);assert.equal(device.state,'connected');
  s.setLogin(id,true);device=s.view({[id]:{state:'connected',message:'ok'}}).targets[0];
  assert.equal(device.ssh.active,true);assert.equal(device.state,'connected');assert.equal(s.controlMap().get(id).revision,revision);assert.equal(s.linkTargets().length,1);
  await assert.rejects(s.save({...web(''),id,ssh:ssh()},async()=>true),/先停止/);
  s.setEnabled(id,false);await s.save({...web(''),id,label:'Kept',ssh:ssh()},async()=>true);
  assert.equal(s.targets.length,0);assert.equal(s.view().targets[0].id,id);assert.equal(s.view().targets[0].label,'Kept');assert.equal(s.view().targets[0].ssh.active,true);
  await s.save({...web('https://again.invalid'),id,ssh:ssh(),preferSsh:true},async()=>true);
  assert.equal(s.targets[0].id,id);assert.equal(s.view().targets[0].url,'https://again.invalid');assert.equal(s.view().targets.length,1);
});
test('order covers SSH-only devices and deleting removes the saved secret',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),a=await s.save(web(),async()=>true),b=await s.save(sshInput({},{secret:'x'}),async()=>true),c=await s.save(web('https://c.invalid'),async()=>true);
  assert.deepEqual(s.view().targets.map(t=>t.id),[a,c,b]);
  s.reorder([b,c,a]);assert.deepEqual(s.view().targets.map(t=>t.id),[b,c,a]);assert.deepEqual(s.targets.map(t=>t.id),[c,a]);
  assert.deepEqual(new ManagerState(f.directory,f.secrets).view().targets.map(t=>t.id),[b,c,a]);
  assert.throws(()=>s.reorder([a,c]));
  await s.remove(b);assert.equal(f.values.size,0);assert.deepEqual(s.view().targets.map(t=>t.id),[c,a]);await assert.rejects(s.remove(b));
});
test('a damaged SSH file is refused and left in place',t=>{
  const f=fixture(t),file=path.join(f.directory,'ssh-logins.json');
  fs.writeFileSync(file,'{broken');assert.throws(()=>new ManagerState(f.directory,f.secrets),/损坏/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  fs.writeFileSync(file,JSON.stringify({schema:1,order:[],logins:[{id:randomUUID(),host:'-oProxyCommand=x',port:22,username:'root',method:'password'}]}));assert.throws(()=>new ManagerState(f.directory,f.secrets),/损坏/);
});
test('the manager opens the terminal, lists terminals and marks SSH cards for the menu bar',async t=>{
  const f=fixture(t);let opened;
  const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},terminals:()=>[{id:'terminal',label:'Terminal',path:'/T.app'}],launchTerminal:async(value,directory,chosen)=>{opened={value,directory,chosen};return 'terminal';}});t.after(()=>m.close());
  const call=(route,body={})=>fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});
  const id=(await (await call('targets/save',sshInput({},{secret:'TESTONLY'}))).json()).id;
  const state=await (await fetch(m.origin+'/api/state',{headers:{'x-cmcp-token':m.token}})).text();
  assert.deepEqual(JSON.parse(state).terminals,[{id:'terminal',label:'Terminal'}]);assert.ok(!state.includes('path')&&!state.includes('TESTONLY')&&!state.includes('credentialId'));
  assert.equal(JSON.parse(state).targets[0].ssh.active,true);
  const tray=await (await call('tray')).json();assert.equal(tray.targets[0].ssh,true);assert.equal(tray.targets[0].enabled,false);
  assert.equal((await call('settings',{terminal:'terminal'})).status,200);
  assert.equal((await call('targets/terminal',{id})).status,200);assert.equal(opened.value.id,id);assert.equal(opened.chosen,'terminal');assert.equal(opened.directory,f.directory);
  assert.equal((await call('targets/terminal',{id:randomUUID()})).status,400);
  assert.equal((await call('targets/start',{id})).status,400,'an SSH-only device has no connection to start');
  const webId=(await (await call('targets/save',web())).json()).id;assert.equal((await (await call('tray')).json()).targets.find(x=>x.id===webId).ssh,undefined);
  assert.equal((await call('targets/login',{id:webId,active:true})).status,200);
  const missing=await call('targets/terminal',{id:webId});assert.equal(missing.status,400);assert.match((await missing.json()).error,/还没有填写 SSH/);
});

test('missing SSH mode persists through restart and edits without touching a web connection',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),id=await s.save(web(),async()=>true);
  s.setEnabled(id,true);const controls=fs.readFileSync(path.join(f.directory,'target-controls.json'),'utf8');
  const config=fs.readFileSync(path.join(f.directory,'targets.json'),'utf8');s.setLogin(id,true);
  assert.equal(s.view().targets[0].loginMode,'ssh');assert.equal(s.view().targets[0].ssh,null);
  assert.equal(fs.readFileSync(path.join(f.directory,'target-controls.json'),'utf8'),controls);
  assert.equal(fs.readFileSync(path.join(f.directory,'targets.json'),'utf8'),config);
  const again=new ManagerState(f.directory,f.secrets);assert.equal(again.view().targets[0].loginMode,'ssh');
  await again.save({...web(),id,label:'Renamed',ssh:null},()=>assert.fail('edit must not log in'));
  assert.equal(again.view().targets[0].loginMode,'ssh');assert.equal(again.view().targets[0].ssh,null);
  await again.save({...web(),id,ssh:ssh()},async()=>true);assert.equal(again.view().targets[0].ssh.active,true);
  await again.save({...web(),id,ssh:null},async()=>true);assert.equal(again.view().targets[0].loginMode,'ssh');
  assert.equal(again.view().targets[0].ssh,null);
  await again.remove(id);assert.equal(again.ssh.modes[id],undefined);
});

test('SSH-only mode can select missing web and survives restart and credential edits',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),id=await s.save(sshInput({},{secret:'fixture-secret'}),async()=>true);
  s.setLogin(id,false);assert.equal(s.view().targets[0].loginMode,'web');assert.equal(s.view().targets[0].ssh.active,false);
  assert.throws(()=>s.setEnabled(id,true),/还没有填写共享网页地址/);
  const again=new ManagerState(f.directory,f.secrets);assert.equal(again.view().targets[0].loginMode,'web');
  const secret=again.sshFor(id).credentialId;await again.save(sshInput({id,label:'Renamed'}),async()=>true);
  assert.equal(again.view().targets[0].loginMode,'web');assert.equal(again.sshFor(id).credentialId,secret);
  again.setLogin(id,true);assert.equal(again.view().targets[0].ssh.active,true);
});

test('invalid persisted sign-in choices are rejected without replacing the file',t=>{
  const f=fixture(t),file=path.join(f.directory,'ssh-logins.json');
  const original=JSON.stringify({schema:1,logins:[],order:[],modes:{[randomUUID()]:'other'}});
  fs.writeFileSync(file,original);assert.throws(()=>new ManagerState(f.directory,f.secrets),/损坏/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('a real worker reports its state and stops for this device only',async t=>{
  const f=fixture(t),id='device-a';
  fs.writeFileSync(path.join(f.directory,'ssh-logins.json'),JSON.stringify({logins:[{id,host:'203.0.113.24',port:22,username:'root',method:'password',keyPath:''},{id:'device-b',host:'203.0.113.25',port:22,username:'root',method:'password',keyPath:''}]}));
  assert.equal(sshWorkerState(f.directory,id),'');
  let aborted=false;
  const worker=runWorker({directory:f.directory,id,owner:process.pid,createDispatcher:async()=>({forward:async()=>({result:{}}),close:async()=>{}}),connect:({signal,status})=>new Promise(resolve=>{status('ready','ok');signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});})});
  for(let i=0;i<100&&sshWorkerState(f.directory,id)!=='ready';i++)await new Promise(done=>setTimeout(done,50));
  assert.equal(sshWorkerState(f.directory,id),'ready');assert.equal(sshWorkerState(f.directory,'device-b'),'');
  assert.equal(sshWorkerState(f.directory,id,Date.now()+60000),'','a record nobody refreshes counts as stopped');
  await assert.rejects(stopSshWorker(f.directory,'device-b'));assert.equal(sshWorkerState(f.directory,id),'ready');
  await stopSshWorker(f.directory,id);await worker;
  assert.ok(aborted);assert.equal(sshWorkerState(f.directory,id),'');
});
test('the manager reports and stops one SSH channel without touching a web connection',async t=>{
  const f=fixture(t),channels=new Map(),stops=[];
  const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},terminals:()=>[],channelState:(directory,id)=>channels.get(id)||'',stopChannel:async(directory,id)=>{stops.push(id);channels.delete(id);}});t.after(()=>m.close());
  const call=(route,body={})=>fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});
  const state=async()=>(await (await fetch(m.origin+'/api/state',{headers:{'x-cmcp-token':m.token}})).json()).targets;
  const id=(await (await call('targets/save',{...web(),ssh:ssh(),preferSsh:true})).json()).id;
  const plain=(await (await call('targets/save',web('https://second.invalid'))).json()).id;
  assert.equal((await call('targets/start',{id})).status,200);
  channels.set(id,'ready');
  let list=await state();assert.equal(list.find(x=>x.id===id).sshState,'ready');assert.equal(list.find(x=>x.id===plain).sshState,undefined);
  assert.equal((await call('targets/ssh-stop',{id})).status,200);assert.deepEqual(stops,[id]);
  list=await state();assert.equal(list.find(x=>x.id===id).sshState,'');assert.equal(list.find(x=>x.id===id).enabled,true,'the web connection keeps running');
  assert.equal((await call('targets/ssh-stop',{id:plain})).status,400);assert.deepEqual(stops,[id]);
});
