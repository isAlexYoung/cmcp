import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ManagerState} from '../state.mjs';
import {createManager} from '../manager.mjs';
import {recordCloudcliKind,cloudcliName} from '../../app/cloudcli.mjs';
import {tunnelName} from '../../app/ssh-web.mjs';

function fixture(t){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-selfhosted-'))),values=new Map();t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const secrets=async(op,id,value)=>{if(op==='set')values.set(id,value);if(op==='get')return values.get(id);if(op==='delete')values.delete(id);};return {directory,secrets};}
const ssh={host:'203.0.113.24',port:'22',username:'root',method:'password',keyPath:'',secret:''};
const until=async check=>{for(let i=0;i<200;i++){if(await check())return true;await new Promise(r=>setTimeout(r,20));}return false;};

test('a URL profile can be saved without SSH and dual transport persists only with both profiles',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:null},()=>assert.fail());
  assert.equal(state.autoChannel(id),false,'without SSH there is no channel');assert.equal(state.view().targets[0].cloudcliKind,'');
  recordCloudcliKind(f.directory,id,'self-hosted');assert.equal(state.view().targets[0].cloudcliKind,'self-hosted');
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:null},()=>assert.fail());
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh},()=>assert.fail());
  assert.equal(state.view().targets[0].ssh.dualConnection,false);
  state.applyCloudcliSetup(id,{cloudcliUser:'ubuntu',cloudcliPort:3005,cloudcliTunnel:false,sshAutoStart:true});
  const saved=new ManagerState(f.directory,f.secrets).sshFor(id);assert.equal(saved.cloudcliUser,'ubuntu');assert.equal(saved.cloudcliPort,3005);assert.equal(saved.sshAutoStart,true);
  assert.throws(()=>state.applyCloudcliSetup(id,{cloudcliUser:'a;b',cloudcliPort:3005,cloudcliTunnel:false}));
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:{...ssh,dualConnection:true}},()=>assert.fail());
  assert.equal(new ManagerState(f.directory,f.secrets).sshFor(id).dualConnection,true);
  assert.equal(state.sshFor(id).cloudcliUser,'ubuntu','editing keeps the ClaudeWeb account for the same server');
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:{...ssh,host:'203.0.113.25'}},()=>assert.fail());
  assert.equal(state.sshFor(id).cloudcliUser,undefined,'another server never inherits the account');
});

test('setup over SSH without a direct address turns on the ClaudeWeb tunnel for the device',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({label:'VPS',url:'',password:'',autoLogin:false,icon:'',ssh},()=>assert.fail());
  state.applyCloudcliSetup(id,{cloudcliUser:'',cloudcliPort:3001,cloudcliTunnel:true});
  assert.equal(state.loginMode(id),'cloudcli');assert.equal(state.route(id),'ssh');assert.equal(state.connectionName(id),tunnelName(id,'cloudcli'));
  assert.ok(state.linkTargets().some(t=>t.name===tunnelName(id,'cloudcli')));
});

test('ClaudeWeb start does not launch a separate SSH worker, and setup keeps no sudo password',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh},()=>assert.fail());
  const other=await state.save({label:'Web',url:'https://web.example.com',password:'',autoLogin:false,icon:'',ssh},async()=>true);
  recordCloudcliKind(f.directory,id,'self-hosted');
  state.setLogin(id,'cloudcli');
  const started=[];let seen;
  const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},terminals:()=>[],browsers:()=>[],
    startChannel:async login=>{started.push(login.id);},
    setupCloudcli:async options=>{const answer=await options.confirm({summary:['系统：Ubuntu 24.04 LTS'],steps:['为 ubuntu 安装 Claude CLI'],needsPassword:true});seen=answer;if(!answer.ok)return {ok:false,cancelled:true,message:'已取消，未做任何修改。'};
      await options.save({cloudcliUser:'ubuntu',cloudcliPort:3001,cloudcliTunnel:false,sshAutoStart:true});options.progress('正在启动本机工具的 SSH 后台通道…');return {ok:true,message:'ClaudeWeb 连接已就绪',url:'https://cli.example.com'};}});
  t.after(()=>m.close());
  assert.deepEqual(started,[],'a website profile has no independent SSH worker');
  const call=async(route,body={})=>{const res=await fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const first=await call('targets/cloudcli-setup',{id});assert.equal(first.body.phase,'confirm');assert.deepEqual(first.body.plan.steps,['为 ubuntu 安装 Claude CLI']);assert.equal(first.body.plan.needsPassword,true);
  assert.equal((await call('targets/cloudcli-setup',{id})).body.phase,'confirm','a second click shows the same question');
  await call('targets/cloudcli-setup/answer',{id,ok:true,password:'SUDO-FIXTURE'});assert.equal(seen.password,'SUDO-FIXTURE');
  assert.ok(await until(async()=>(await call('targets/cloudcli-setup/status',{id})).body.phase==='done'));
  const done=(await call('targets/cloudcli-setup/status',{id})).body;assert.equal(done.result.ok,true);
  assert.ok(!JSON.stringify(done).includes('SUDO-FIXTURE'));assert.ok(!fs.readdirSync(f.directory).some(name=>fs.statSync(path.join(f.directory,name)).isFile()&&fs.readFileSync(path.join(f.directory,name),'utf8').includes('SUDO-FIXTURE')));
  assert.equal(new ManagerState(f.directory,f.secrets).sshFor(id).cloudcliUser,'ubuntu');
  assert.equal((await call('targets/cloudcli-setup/answer',{id,ok:true})).status,400,'nothing waits for an answer any more');
  await call('targets/start',{id});assert.deepEqual(started,[],'the selected website is managed by its connection only');assert.equal(new ManagerState(f.directory,f.secrets).controlMap().get(cloudcliName(id)).enabled,true);
  assert.equal((await call('targets/cloudcli-setup',{id:other})).body.phase,'confirm');await call('targets/cloudcli-setup/answer',{id:other,ok:false});
  assert.ok(await until(async()=>(await call('targets/cloudcli-setup/status',{id:other})).body.result?.cancelled===true));
});
