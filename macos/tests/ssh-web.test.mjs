import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ManagerState} from '../state.mjs';
const ssh=()=>({host:'example.test',port:22,username:'user',method:'password',keyPath:'',secret:'SSH-SECRET',webTunnel:true,webPort:3000,webAutoLogin:true,webPassword:'WEB-SECRET',cloudcliTunnel:true,cloudcliPort:3001,cloudcliAutoLogin:true,cloudcliPassword:'CLOUD-SECRET'});
function fixture(t){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-ssh-web-'))),values=new Map();t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const secrets=async(op,id,v)=>{if(op==='set')values.set(id,v);if(op==='get')return values.get(id);if(op==='delete')values.delete(id);};return {directory,values,state:new ManagerState(directory,secrets),secrets};}
const input=(value)=>({url:'',password:'',autoLogin:false,label:'Tunnel device',icon:'',cloudcli:null,ssh:ssh(),...value});
test('SSH web routes persist independently, switch without connecting and expose no secrets',async t=>{
  const f=fixture(t),s=f.state,id=await s.save(input(),()=>assert.fail('save must not connect'));
  assert.equal(s.loginMode(id),'web');assert.equal(s.route(id),'ssh');s.setLogin(id,'web');s.setRoute(id,'ssh');assert.equal(s.connectionName(id),'tunnel:web:'+id);assert.equal(s.controlMap().size,0);s.setEnabled(id,true);assert.equal(s.controlMap().get(s.connectionName(id)).enabled,true);
  s.setLogin(id,'cloudcli');assert.equal(s.route(id),'url');s.setRoute(id,'ssh');assert.equal(s.connectionName(id),'tunnel:cloudcli:'+id);assert.equal(s.controlMap().get('tunnel:web:'+id).enabled,true);
  const copy=new ManagerState(f.directory,f.secrets);assert.equal(copy.route(id,'web'),'ssh');assert.equal(await copy.password('tunnel:web:'+id),'WEB-SECRET');assert.equal(await copy.password('tunnel:cloudcli:'+id),'CLOUD-SECRET');assert.equal(f.values.size,3);const text=JSON.stringify(copy.view());assert.ok(!text.includes('SECRET'));assert.ok(!fs.readFileSync(path.join(f.directory,'ssh-logins.json'),'utf8').includes('SECRET'));
  s.setLogin(id,'ssh');assert.equal(s.route(id),'ssh');s.setRoute(id,'url');assert.equal(s.loginMode(id),'web');assert.equal(s.route(id),'url');assert.equal(s.connectionName(id),id);assert.equal(new ManagerState(f.directory,f.secrets).loginMode(id),'web');s.setEnabled(null,false);assert.ok([...s.controlMap().values()].every(v=>!v.enabled));
});
test('new servers and ports never inherit web credentials and failed edits preserve previous secrets',async t=>{
  const f=fixture(t),s=f.state,id=await s.save(input(),()=>assert.fail());
  await assert.rejects(s.save(input({id,ssh:{...ssh(),host:'other.test',secret:'',webPassword:'',cloudcliPassword:''}}),()=>assert.fail()),/重新填写/);assert.equal(s.sshFor(id).host,'example.test');assert.equal(f.values.size,3);
  s.setLogin(id,'web');s.setRoute(id,'ssh');s.setEnabled(id,true);await assert.rejects(s.save(input({id,ssh:{...ssh(),host:'other.test'}}),()=>assert.fail()),/先停止/);assert.equal(f.values.size,3);s.setEnabled(null,false);await s.remove(id);assert.equal(f.values.size,0);
});
