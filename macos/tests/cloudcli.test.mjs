import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ManagerState} from '../state.mjs';
import {cloudcliName} from '../../app/cloudcli.mjs';

function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-cloudcli-')),values=new Map(),calls=[];t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const secrets=async(op,id,value)=>{calls.push(op);if(op==='set')values.set(id,value);if(op==='get')return values.get(id);if(op==='delete')values.delete(id);};return {directory,values,calls,secrets,state:new ManagerState(directory,secrets)};}
const cloud=(changes={})=>({url:'https://desktop-claude.example.com',password:'',autoLogin:false,...changes});
const device=(changes={})=>({url:'',password:'',autoLogin:false,label:'Cloud work',icon:'',note:'',ssh:null,cloudcli:cloud(),...changes});

test('a CloudCLI-only device saves without a login attempt and persists all three selectable modes',async t=>{
  const f=fixture(t),id=await f.state.save(device(),()=>assert.fail('saving CloudCLI must not log in'));
  assert.equal(f.state.view().targets.length,1);assert.equal(f.state.loginMode(id),'cloudcli');assert.equal(f.state.view().targets[0].cloudcli.url,cloud().url);assert.equal(f.calls.length,0);
  for(const mode of ['web','ssh','cloudcli']){f.state.setLogin(id,mode);assert.equal(new ManagerState(f.directory,f.secrets).loginMode(id),mode);}
  assert.equal(f.state.linkTargets()[0].name,cloudcliName(id));assert.equal(f.state.linkTargets()[0].authMode,'cloudcli');
});
test('CloudCLI passwords stay in Keychain, survive metadata edits and never transfer to a changed address',async t=>{
  const f=fixture(t),id=await f.state.save(device({cloudcli:cloud({password:'PRIVATE-CLOUDCLI-PASSWORD',autoLogin:true})}),()=>assert.fail());
  assert.equal(await f.state.password(cloudcliName(id)),'PRIVATE-CLOUDCLI-PASSWORD');assert.ok(!JSON.stringify(f.state.view()).includes('PRIVATE-CLOUDCLI-PASSWORD'));assert.ok(!fs.readFileSync(path.join(f.directory,'cloudcli-logins.json'),'utf8').includes('PRIVATE-CLOUDCLI-PASSWORD'));
  await f.state.save(device({id,label:'Renamed',cloudcli:cloud({autoLogin:true})}),()=>assert.fail());assert.equal(await f.state.password(cloudcliName(id)),'PRIVATE-CLOUDCLI-PASSWORD');
  await assert.rejects(f.state.save(device({id,cloudcli:cloud({url:'https://other.example.com',autoLogin:true})}),()=>assert.fail()),/更换地址/);assert.equal(f.state.cloudcliFor(id).url,cloud().url);
  await f.state.save(device({id}),()=>assert.fail());assert.equal(f.values.size,0);assert.equal(f.state.cloudcliFor(id).autoLogin,false);
});
test('CloudCLI and desktop switches stay independent and live credentials cannot change',async t=>{
  const f=fixture(t),id=await f.state.save(device({url:'https://desktop.example.com'}),async()=>true);
  f.state.setLogin(id,'cloudcli');f.state.setEnabled(id,true);assert.equal(f.state.controlMap().get(cloudcliName(id)).enabled,true);assert.equal(f.state.controlMap().get(id).enabled,false);
  await assert.rejects(f.state.save(device({id,url:'https://desktop.example.com',cloudcli:cloud({password:'changed',autoLogin:true})}),async()=>true),/先停止 CloudCLI/);
  await f.state.save(device({id,url:'https://desktop.example.com',note:'New note'}),()=>assert.fail());assert.equal(f.state.view().targets[0].note,'New note');
  f.state.setLogin(id,'web');f.state.setEnabled(id,true);assert.equal(f.state.controlMap().get(cloudcliName(id)).enabled,true);assert.equal(f.state.controlMap().get(id).enabled,true);
  f.state.setEnabled(null,false);assert.ok([...f.state.controlMap().values()].every(v=>!v.enabled));
});
test('a CloudCLI write failure removes the newly created Keychain secret',async t=>{
  const f=fixture(t),write=f.state.write.bind(f.state);f.state.write=(name,value)=>{if(name==='cloudcli-logins.json')throw Error('write fixture');return write(name,value);};
  await assert.rejects(f.state.save(device({cloudcli:cloud({password:'secret',autoLogin:true})}),()=>assert.fail()),/write fixture/);assert.equal(f.values.size,0);assert.equal(f.state.cloudcli.logins.length,0);
});
test('a combined desktop and CloudCLI save rolls back files and both new secrets if either profile cannot be saved',async t=>{
  const f=fixture(t),write=f.state.write.bind(f.state);f.state.write=(name,value)=>{if(name==='cloudcli-logins.json')throw Error('cloud write fixture');return write(name,value);};
  await assert.rejects(f.state.save(device({url:'https://desktop.example.com',password:'desktop-secret',autoLogin:true,cloudcli:cloud({password:'cloud-secret',autoLogin:true})}),async()=>true),/cloud write fixture/);
  assert.equal(f.values.size,0);assert.equal(f.state.view().targets.length,0);assert.equal(fs.existsSync(path.join(f.directory,'targets.json')),false);assert.equal(fs.existsSync(path.join(f.directory,'cloudcli-logins.json')),false);
});
test('removing a CloudCLI device removes its secret and switching missing modes never creates credentials',async t=>{
  const f=fixture(t),id=await f.state.save(device({cloudcli:cloud({password:'secret',autoLogin:true})}),()=>assert.fail());
  f.state.setLogin(id,'web');assert.throws(()=>f.state.setEnabled(id,true),/网页桌面地址/);f.state.setLogin(id,'ssh');assert.equal(f.values.size,1);
  await f.state.remove(id);assert.equal(f.values.size,0);assert.equal(f.state.view().targets.length,0);
});
