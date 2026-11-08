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

test('a self-hosted CloudCLI asks for SSH, starts its channel by default and keeps the setup result',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:null},()=>assert.fail());
  assert.equal(state.autoChannel(id),false,'without SSH there is no channel');assert.equal(state.view().targets[0].cloudcliKind,'');
  recordCloudcliKind(f.directory,id,'self-hosted');assert.equal(state.view().targets[0].cloudcliKind,'self-hosted');
  await assert.rejects(state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:null},()=>assert.fail()),/需要 SSH 信息/);
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh},()=>assert.fail());
  assert.equal(state.autoChannel(id),true);assert.equal(state.view().targets[0].ssh.sshAutoStart,true);
  state.applyCloudcliSetup(id,{cloudcliUser:'ubuntu',cloudcliPort:3005,cloudcliTunnel:false,sshAutoStart:true});
  const saved=new ManagerState(f.directory,f.secrets).sshFor(id);assert.equal(saved.cloudcliUser,'ubuntu');assert.equal(saved.cloudcliPort,3005);assert.equal(saved.sshAutoStart,true);
  assert.throws(()=>state.applyCloudcliSetup(id,{cloudcliUser:'a;b',cloudcliPort:3005,cloudcliTunnel:false}));
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:{...ssh,sshAutoStart:false}},()=>assert.fail());
  assert.equal(state.autoChannel(id),false,'the user can turn the channel off');assert.equal(state.sshFor(id).cloudcliUser,'ubuntu','editing keeps the CloudCLI account for the same server');
  await state.save({id,label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh:{...ssh,host:'203.0.113.25'}},()=>assert.fail());
  assert.equal(state.sshFor(id).cloudcliUser,undefined,'another server never inherits the account');
});

test('setup over SSH without a direct address turns on the CloudCLI tunnel for the device',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({label:'VPS',url:'',password:'',autoLogin:false,icon:'',ssh},()=>assert.fail());
  state.applyCloudcliSetup(id,{cloudcliUser:'',cloudcliPort:3001,cloudcliTunnel:true});
  assert.equal(state.loginMode(id),'cloudcli');assert.equal(state.route(id),'ssh');assert.equal(state.connectionName(id),tunnelName(id,'cloudcli'));
  assert.ok(state.linkTargets().some(t=>t.name===tunnelName(id,'cloudcli')));
});

test('the manager starts channels at launch, asks once during setup and keeps no sudo password',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const id=await state.save({label:'CLI',url:'',password:'',autoLogin:false,icon:'',cloudcli:{url:'https://cli.example.com',password:'',autoLogin:false},ssh},()=>assert.fail());
  const other=await state.save({label:'Web',url:'https://web.example.com',password:'',autoLogin:false,icon:'',ssh},async()=>true);
  recordCloudcliKind(f.directory,id,'self-hosted');
  const started=[];let seen;
  const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}},terminals:()=>[],browsers:()=>[],
    startChannel:async login=>{started.push(login.id);},
    setupCloudcli:async options=>{const answer=await options.confirm({summary:['系统：Ubuntu 24.04 LTS'],steps:['为 ubuntu 安装 Claude CLI'],needsPassword:true});seen=answer;if(!answer.ok)return {ok:false,cancelled:true,message:'已取消，未做任何修改。'};
      await options.save({cloudcliUser:'ubuntu',cloudcliPort:3001,cloudcliTunnel:false,sshAutoStart:true});options.progress('正在启动本机工具的 SSH 后台通道…');return {ok:true,message:'CloudCLI 连接已就绪',url:'https://cli.example.com'};}});
  t.after(()=>m.close());
  assert.ok(await until(()=>started.length>0));assert.deepEqual(started,[id],'only the self-hosted device starts its channel');
  const call=async(route,body={})=>{const res=await fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const first=await call('targets/cloudcli-setup',{id});assert.equal(first.body.phase,'confirm');assert.deepEqual(first.body.plan.steps,['为 ubuntu 安装 Claude CLI']);assert.equal(first.body.plan.needsPassword,true);
  assert.equal((await call('targets/cloudcli-setup',{id})).body.phase,'confirm','a second click shows the same question');
  await call('targets/cloudcli-setup/answer',{id,ok:true,password:'SUDO-FIXTURE'});assert.equal(seen.password,'SUDO-FIXTURE');
  assert.ok(await until(async()=>(await call('targets/cloudcli-setup/status',{id})).body.phase==='done'));
  const done=(await call('targets/cloudcli-setup/status',{id})).body;assert.equal(done.result.ok,true);
  assert.ok(!JSON.stringify(done).includes('SUDO-FIXTURE'));assert.ok(!fs.readdirSync(f.directory).some(name=>fs.statSync(path.join(f.directory,name)).isFile()&&fs.readFileSync(path.join(f.directory,name),'utf8').includes('SUDO-FIXTURE')));
  assert.equal(new ManagerState(f.directory,f.secrets).sshFor(id).cloudcliUser,'ubuntu');
  assert.equal((await call('targets/cloudcli-setup/answer',{id,ok:true})).status,400,'nothing waits for an answer any more');
  await call('targets/login',{id,mode:'cloudcli'});await call('targets/start',{id});assert.ok(await until(()=>started.length===2),'starting the CloudCLI connection also starts its channel');assert.equal(new ManagerState(f.directory,f.secrets).controlMap().get(cloudcliName(id)).enabled,true);
  assert.equal((await call('targets/cloudcli-setup',{id:other})).body.phase,'confirm');await call('targets/cloudcli-setup/answer',{id:other,ok:false});
  assert.ok(await until(async()=>(await call('targets/cloudcli-setup/status',{id:other})).body.result?.cancelled===true));
});
