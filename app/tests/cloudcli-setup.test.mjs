import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {discoverCloudcli,readCloudcliKinds,recordCloudcliKind,cloudcliDevice,createLaunchPage} from '../cloudcli.mjs';
import {managedTargetFactory,SELF_HOSTED_READY} from '../managed-target.mjs';
import {planSetup,runSetup,runRemote,setupCommand} from '../cloudcli-setup.mjs';
import {remoteCommand,runAsHandoff,validRunAs,sharedSessionHandoff,SshPipe} from '../ssh-mcp.mjs';
import {profileRevision,readSshLogin,sshWorkerRecord} from '../ssh-terminal.mjs';

async function serve(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return 'http://127.0.0.1:'+s.address().port;}
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-cloudcli-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const login={host:'203.0.113.9',port:22,username:'root',method:'password',secret:'ENCRYPTED-PLACEHOLDER'};
const report=(extra={})=>({ok:true,os:{id:'ubuntu',pretty:'Ubuntu 24.04 LTS',supported:true},python:'3.12',me:{uid:0,user:'root',home:'/root'},privilege:'root',webdesktop:false,
  instances:[{source:'systemd',unit:'cloudcli',user:'ubuntu',port:3001,running:true,portKnown:true}],chosen:{source:'systemd',unit:'cloudcli',user:'ubuntu',port:3001,running:true,portKnown:true,node:'/usr/bin/node'},
  account:{uid:1000,user:'ubuntu',home:'/home/ubuntu'},claude:{found:true,version:'2.1.0 (Claude Code)'},npm:{path:'/usr/bin/npm',prefix:'/usr',userWritable:false},mcp:{readable:true,present:true},...extra});

test('a self-hosted CloudCLI page is told apart from WebDesktop and from errors on the way',async t=>{
  let reply={status:200,type:'text/html',body:'<!doctype html><div id="root"></div>'};
  const origin=await serve(t,(_req,res)=>{res.writeHead(reply.status,{'content-type':reply.type});res.end(reply.body);});
  for(const value of [reply,{status:401,type:'application/json',body:'{"error":"Access denied. No token provided."}'},{status:404,type:'text/plain',body:'Not found'}]){reply=value;await assert.rejects(discoverCloudcli(origin),e=>e.code==='CLOUDCLI_PROTOCOL_REQUIRED'&&e.selfHosted===true);}
  for(const value of [{status:200,type:'application/json',body:'{"protocol":"cmcp-cloudcli","version":2}'},{status:502,type:'text/html',body:'Bad gateway'}]){reply=value;await assert.rejects(discoverCloudcli(origin),e=>e.code==='CLOUDCLI_PROTOCOL_REQUIRED'&&e.selfHosted===false);}
  reply={status:200,type:'application/json',body:JSON.stringify({protocol:'cmcp-cloudcli',version:1,desktopOrigin:'http://127.0.0.1:3000'})};assert.equal((await discoverCloudcli(origin)).desktopOrigin,'http://127.0.0.1:3000');
});

test('a self-hosted CloudCLI connects without a web MCP link and opens through a plain local entrance',async t=>{
  const origin=await serve(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html>');});
  const kinds=[],states=[],controller=new AbortController();
  const create=managedTargetFactory({proxyFor:async()=>'',machine:'test',version:'test',forward:()=>assert.fail('no web MCP for a self-hosted CloudCLI'),askPassword:async()=>false,notify:()=>{},log:()=>{},passwordFor:()=>assert.fail('CloudCLI signs in by itself'),onCloudcliKind:(id,kind)=>kinds.push([id,kind]),selfHostedProbeMs:20});
  const record=await create({name:'cloudcli:device',url:origin,authMode:'cloudcli',autoLogin:true},{signal:controller.signal,current:()=>!controller.signal.aborted,status:{set:(name,state,message)=>states.push([name,state,message])}});
  t.after(()=>{controller.abort();return record.stop();});
  assert.deepEqual(kinds,[['device','self-hosted']]);assert.equal(record.link,undefined);assert.equal(record.selfHosted,true);
  assert.deepEqual(states[states.length-1],['cloudcli:device','connected',SELF_HOSTED_READY]);
  const entrance=new URL(record.gateway.launchUrl);assert.equal(entrance.hostname,'127.0.0.1');assert.equal(entrance.pathname,'/__mcp/open');
  assert.equal((await fetch(entrance.origin+'/__mcp/direct',{method:'POST',headers:{'content-type':'application/json'},body:'{"token":"x"}'})).status,403);
  const opened=await fetch(entrance.origin+'/__mcp/direct',{method:'POST',headers:{origin:entrance.origin,'content-type':'application/json'},body:JSON.stringify({token:entrance.hash.slice(1)})});
  assert.equal((await opened.json()).url,origin+'/');
  const shown=states.length;await new Promise(r=>setTimeout(r,60));assert.ok(states.length>shown,'the page keeps being checked');assert.ok(states.slice(shown).every(([,state])=>state==='connected'));
});

test('CloudCLI kinds are recorded per device and unreadable records count as unknown',t=>{
  const d=temp(t);assert.deepEqual(readCloudcliKinds(d),{});
  assert.equal(recordCloudcliKind(d,'device','self-hosted'),true);assert.equal(recordCloudcliKind(d,'device','self-hosted'),false);recordCloudcliKind(d,'other','webdesktop');
  assert.deepEqual(readCloudcliKinds(d),{device:'self-hosted',other:'webdesktop'});assert.throws(()=>recordCloudcliKind(d,'device','other'));
  fs.writeFileSync(path.join(d,'cloudcli-kinds.json'),'{broken');assert.deepEqual(readCloudcliKinds(d),{});
  assert.equal(cloudcliDevice('cloudcli:a'),'a');assert.equal(cloudcliDevice('tunnel:cloudcli:b'),'b');assert.equal(cloudcliDevice('tunnel:web:c'),null);
});

test('root hands the SSH channel to the CloudCLI account, and nothing else changes without one',()=>{
  const bootstrap='print(1)';assert.equal(remoteCommand(bootstrap),remoteCommand(bootstrap,undefined));assert.ok(remoteCommand(bootstrap).includes(sharedSessionHandoff.replace(/'/g,"'\\''")));
  const handed=remoteCommand(bootstrap,'ubuntu');assert.ok(handed.includes('runuser -u ubuntu'));assert.ok(!handed.includes('wd-claude-session'));
  for(const bad of ['root','Ubuntu','a;b','-x','a b',''])assert.equal(validRunAs(bad),false);assert.throws(()=>runAsHandoff('a;id'));
  assert.equal(profileRevision(login),profileRevision({...login,cloudcliUser:''}),'devices without a CloudCLI account keep their channel revision');assert.notEqual(profileRevision(login),profileRevision({...login,cloudcliUser:'ubuntu'}));
  let args;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  new SshPipe({login:{...login,cloudcliUser:'ubuntu'},payload:{},spawnProcess:(_f,a)=>{args=a;return child;}});assert.ok(args.at(-1).includes('runuser -u ubuntu'));
});

test('saved CloudCLI accounts are validated with the SSH profile and channel records report their message',t=>{
  const d=temp(t);fs.writeFileSync(path.join(d,'ssh-logins.json'),JSON.stringify({schema:1,logins:[{...login,name:'good',cloudcliUser:'ubuntu'},{...login,name:'bad',cloudcliUser:'a;id'}]}));
  assert.equal(readSshLogin(d,'good').cloudcliUser,'ubuntu');assert.throws(()=>readSshLogin(d,'bad'));
  assert.deepEqual(sshWorkerRecord(d,'good'),{state:'',message:''});
});

test('the plan refuses other systems, foreign accounts and missing rights before anything changes',()=>{
  const plan=(r,l=login,o={})=>planSetup(r,{login:l,connector:'cmcp-ssh-0123456789abcdef',...o});
  assert.match(plan({ok:false,code:'PYTHON'}).blocker,/python3/);
  assert.match(plan(report({os:{id:'centos',pretty:'CentOS Stream 9',supported:false}})).blocker,/只支持 Ubuntu 和 Debian；这台 VPS 是 CentOS Stream 9/);
  assert.match(plan(report({python:'3.8'})).blocker,/3\.9/);
  assert.match(plan(report({webdesktop:true})).blocker,/WebDesktop/);
  assert.match(plan(report({chosen:undefined,instances:[]})).blocker,/没有在这台 VPS 上找到 CloudCLI/);
  assert.match(plan(report({me:{uid:1001,user:'deploy',home:'/home/deploy'},privilege:'sudo-password'})).blocker,/改为 ubuntu 或 root/);
  const user={me:{uid:1000,user:'ubuntu',home:'/home/ubuntu'},claude:{found:false},npm:{path:'/usr/bin/npm',prefix:'/usr',userWritable:false}};
  assert.match(plan(report({...user,privilege:'none'}),{...login,username:'ubuntu'}).blocker,/需要 root 或 sudo 权限/);
  assert.match(plan(report({...user,npm:null,privilege:'root'})).blocker,/npm/);
  assert.match(plan(report({mcp:{readable:true,present:false,invalid:true}})).blocker,/不是有效的 JSON/);
});

test('the plan lists only what is missing and what CMCP will save',()=>{
  const plan=(r,l=login,o={})=>planSetup(r,{login:l,connector:'cmcp-ssh-0123456789abcdef',...o});
  const root=plan(report({claude:{found:false},mcp:{readable:true,present:false}}));
  assert.equal(root.blocker,undefined);assert.equal(root.save.cloudcliUser,'ubuntu');assert.equal(root.save.sshAutoStart,true);assert.equal(root.save.cloudcliTunnel,true);
  assert.deepEqual(root.install,{account:'ubuntu',mode:'root',node:'/usr/bin/node'});assert.equal(root.needsPassword,false);
  assert.ok(root.steps.some(s=>s.includes('安装 Claude CLI')));assert.ok(root.steps.some(s=>s.includes('~/.claude.json')));assert.ok(root.steps.some(s=>s.includes('以 ubuntu')));
  const sudo=plan(report({me:{uid:1000,user:'ubuntu',home:'/home/ubuntu'},privilege:'sudo-password',claude:{found:false}}),{...login,username:'ubuntu'});
  assert.equal(sudo.needsPassword,true);assert.equal(sudo.save.cloudcliUser,'');assert.equal(sudo.install.mode,'root');
  const own=plan(report({me:{uid:1000,user:'ubuntu',home:'/home/ubuntu'},privilege:'none',claude:{found:false},npm:{path:'/home/ubuntu/.nvm/versions/node/v22/bin/npm',prefix:'/home/ubuntu/.nvm/versions/node/v22',userWritable:true}}),{...login,username:'ubuntu'});
  assert.equal(own.blocker,undefined);assert.equal(own.install.mode,'user');assert.equal(own.needsPassword,false);
  const ready=plan(report(),{...login,cloudcliUser:'ubuntu',cloudcliTunnel:true,sshAutoStart:true});assert.deepEqual(ready.steps,[]);assert.equal(ready.clean,true);
  const direct=plan(report(),{...login,cloudcliUser:'ubuntu',sshAutoStart:true},{hasDirectUrl:true,directUrl:'https://cli.example.com'});assert.deepEqual(direct.steps,[]);assert.equal(direct.save.cloudcliTunnel,false);assert.equal(direct.url,'https://cli.example.com');
  const clash=plan(report({chosen:{...report().chosen,port:3000}}));assert.equal(clash.save.webPort,3002);assert.match(plan(report({chosen:{...report().chosen,port:3000}}),{...login,webTunnel:true}).blocker,/端口/);
});

test('setup asks once, keeps the sudo password out of arguments and confirms the result on the VPS',async t=>{
  const d=temp(t),calls=[],saved=[],asked=[];let inspected=0;
  const remote=async(_login,request)=>{calls.push(request);if(request.action==='install')return {ok:true};inspected++;return report(inspected===1?{me:{uid:1000,user:'ubuntu',home:'/home/ubuntu'},privilege:'sudo-password',claude:{found:false},mcp:{readable:true,present:false}}:{me:{uid:1000,user:'ubuntu',home:'/home/ubuntu'}});};
  const result=await runSetup({directory:d,id:'device',login:{...login,username:'ubuntu'},owner:process.pid,remote,ensure:async()=>{},save:async v=>saved.push(v),confirm:async plan=>{asked.push(plan.steps);return {ok:true,password:'SUDO-FIXTURE'};}});
  assert.equal(result.ok,true,result.message);assert.equal(asked.length,1);assert.equal(saved.length,1);assert.equal(readCloudcliKinds(d).device,'self-hosted');
  assert.equal(calls.filter(c=>c.action==='install').length,1);assert.equal(calls.find(c=>c.action==='install').password,'SUDO-FIXTURE');assert.equal(calls.filter(c=>c.action==='inspect').length,2);
  const cancelled=await runSetup({directory:d,id:'device',login,owner:process.pid,remote:async()=>report({claude:{found:false}}),ensure:()=>assert.fail('nothing runs after cancel'),save:()=>assert.fail('nothing is saved after cancel'),confirm:async()=>({ok:false})});
  assert.equal(cancelled.ok,false);assert.equal(cancelled.cancelled,true);
  const refused=await runSetup({directory:d,id:'device',login,owner:process.pid,remote:async()=>report({os:{id:'fedora',pretty:'Fedora 40',supported:false}}),confirm:()=>assert.fail('no question for a refused system')});
  assert.match(refused.message,/Fedora 40/);
  let args,input='';const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};child.stdin.on('data',c=>input+=c);
  const pending=runRemote(login,{action:'install',connector:'cmcp-ssh-0123456789abcdef',account:'ubuntu',mode:'root',password:'SUDO-FIXTURE'},{spawnProcess:(_f,a,o)=>{args=[...a,JSON.stringify(o.env||{})];return child;}});
  child.stdout.end('{"ok":true}\n');child.emit('close',0);assert.deepEqual(await pending,{ok:true});
  assert.ok(!args.join(' ').includes('SUDO-FIXTURE'));assert.ok(input.includes('SUDO-FIXTURE'));assert.equal(args.at(-2),setupCommand(fs.readFileSync(new URL('../cloudcli-setup.py',import.meta.url),'utf8')));
});
