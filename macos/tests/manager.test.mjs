import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ManagerState} from '../state.mjs';
import {createManager} from '../manager.mjs';

function fixture(t){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-manager-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const values=new Map(),calls=[];const secrets=async(op,id,password)=>{calls.push({op,id});if(op==='set')values.set(id,password);if(op==='delete')values.delete(id);if(op==='get')return values.get(id);};return {directory,secrets,values,calls};}
const input=(url='https://first.invalid')=>({url,label:'Mac',password:'',autoLogin:false,icon:''});
test('fresh manager defaults to tray and saves manual shared login without touching Keychain',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  assert.equal(state.preferences.closeAction,'tray');const id=await state.save(input(),async()=>true);
  assert.equal(state.view().targets[0].enabled,false);assert.equal(f.calls.length,0);assert.equal(state.targets[0].authMode,'shared-browser');assert.equal(id,state.targets[0].id);
});
test('automatic password is Keychain-only and metadata edits preserve its credential reference',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets),password='secret 中文 "';
  const id=await state.save({...input(),password,autoLogin:true},async()=>true);
  const first=state.targets[0];assert.equal(await state.password(id),password);
  assert.ok(!fs.readFileSync(path.join(f.directory,'targets.json'),'utf8').includes(password));
  await state.save({...input(),id,autoLogin:true,label:'Renamed'},()=>assert.fail('metadata edit must not probe'));
  assert.equal(state.targets[0].credentialId,first.credentialId);assert.equal(state.targets[0].changed,first.changed);
  assert.equal(state.view().targets[0].hasSavedPassword,true);assert.ok(!JSON.stringify(state.view()).includes(password));
});
test('turning off remembered shared login deletes only the selected password',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets);
  const a=await state.save({...input(),autoLogin:true,password:'A'},async()=>true),b=await state.save({...input('https://second.invalid'),autoLogin:true,password:'B'},async()=>true);
  await state.save({...input(),id:a,autoLogin:false},async()=>true);
  assert.equal(state.targets[0].credentialId,undefined);assert.equal(await state.password(b),'B');assert.equal(f.values.size,1);
});
test('active targets allow notes/icons but reject address or credential changes',async t=>{
  const f=fixture(t),state=new ManagerState(f.directory,f.secrets),id=await state.save(input(),async()=>true);state.setEnabled(id,true);
  await state.save({...input(),id,label:'Live note'},()=>assert.fail());
  await assert.rejects(state.save({...input('https://changed.invalid'),id},async()=>true),/先停止/);
  await assert.rejects(state.save({...input(),id,autoLogin:true,password:'new'},async()=>true),/先停止/);
});
test('independent switches, ordering and deletion never reset another target',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),a=await s.save(input(),async()=>true),b=await s.save(input('https://second.invalid'),async()=>true);
  s.setEnabled(b,true);const revision=s.controlMap().get(b).revision;s.setEnabled(a,true);s.setEnabled(a,false);
  assert.equal(s.controlMap().get(b).enabled,true);assert.equal(s.controlMap().get(b).revision,revision);
  s.reorder([b,a]);assert.equal(s.targets[0].id,b);await s.remove(a);assert.equal(s.controlMap().get(b).revision,revision);
});
test('invalid icons, duplicate URLs and unsaved automatic passwords are rejected',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets);await s.save(input(),async()=>true);
  for(const value of [{...input(),icon:'data:image/svg+xml;base64,AAAA'},input(),{...input('http://plain.invalid')},{...input('https://second.invalid'),autoLogin:true}])await assert.rejects(s.save(value,async()=>true));
  assert.equal(s.targets.length,1);assert.equal(f.values.size,0);
});
test('configuration write failure rolls back only the newly created Keychain item',async t=>{
  const f=fixture(t),s=new ManagerState(f.directory,f.secrets),id=await s.save({...input(),password:'old',autoLogin:true},async()=>true);
  s.write=()=>{throw Error('disk full');};await assert.rejects(s.save({...input(),id,password:'new',autoLogin:true},async()=>true));assert.equal(await s.password(id),'old');assert.equal(f.values.size,1);
});
test('legacy IDs and Keychain items migrate without revealing or re-submitting the password',async t=>{
  const f=fixture(t),id=randomUUID();f.values.set(id,'legacy');fs.writeFileSync(path.join(f.directory,'targets.json'),JSON.stringify({roots:[f.directory],targets:[{id,url:'https://legacy.invalid',changed:'old'}]}));
  const s=new ManagerState(f.directory,f.secrets);assert.equal(await s.password(id),'legacy');assert.equal(s.view().targets[0].hasSavedPassword,true);assert.equal(s.view().targets[0].enabled,false);
});
test('private manager HTTP API enforces token, origin, verbs and explicit target selection',async t=>{
  const f=fixture(t);let closed=0;const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{closed++;}}});t.after(()=>m.close());
  const call=(route,body={},headers={})=>fetch(m.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token,...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(m.origin+'/api/state')).status,403);
  assert.equal((await call('settings',{}, {origin:'https://evil.invalid'})).status,403);
  assert.equal((await call('targets/start',{id:null})).status,400);
  const id=(await (await call('targets/save',input())).json()).id;
  assert.equal((await call('targets/start',{id})).status,200);assert.equal(m.store.controlMap().get(id).enabled,true);
  assert.equal((await call('targets/stop',{id})).status,200);assert.equal(m.snapshot().targets[0].state,'stopped');
  assert.equal((await call('settings',{language:'en',closeAction:'exit'})).status,200);
  assert.equal(m.snapshot().preferences.closeAction,'exit');assert.equal((await call('settings',{language:'invalid'})).status,400);
  const html=await fetch(m.origin+'/');assert.ok(html.headers.get('content-security-policy').includes("default-src 'none'"));
});
test('full application exit disables every connection and closes backend tools',async t=>{
  const f=fixture(t);let closed=0;const m=await createManager({...f,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{closed++;}}});
  await m.store.save(input(),async()=>true);await m.store.save(input('https://second.invalid'),async()=>true);m.store.setEnabled(null,true);
  const res=await fetch(m.origin+'/api/exit',{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':m.token},body:'{}'});assert.equal(res.status,200);
  for(let i=0;i<50&&closed===0;i++)await new Promise(r=>setTimeout(r,20));assert.equal(closed,1);
  assert.equal(m.store.controlMap().size,2);assert.ok([...m.store.controlMap().values()].every(t=>!t.enabled));
});
