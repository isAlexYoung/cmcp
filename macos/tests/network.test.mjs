import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {proxySettings,proxyAddress,proxyKey} from '../ui/network-settings.js';
import {proxyFor} from '../platform.mjs';
import {ManagerState} from '../state.mjs';
import {createManager} from '../manager.mjs';

function folder(t){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-mac-network-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
test('proxy settings validate drafts, normalize IPv6 and ignore inactive address changes',()=>{
  assert.equal(proxySettings().proxyMode,'auto');
  assert.equal(proxyAddress({proxyMode:'manual',proxyHost:'::1',proxyPort:7897}),'http://[::1]:7897');
  assert.equal(proxyKey({}),proxyKey({proxyMode:'auto',proxyHost:'other.test',proxyPort:1234}));
  for(const value of [{proxyMode:'wrong'},{proxyPort:65536},{proxyPort:'7897'},{proxyHost:'http://localhost'},{proxyHost:'u:p@host'},{proxyHost:'host\r\nheader'},{proxyHost:''}])assert.throws(()=>proxySettings(value));
});
test('manual and direct settings override environment and never consult the system',async()=>{
  const env={HTTPS_PROXY:'http://127.0.0.1:9'};const runner=()=>assert.fail('manual/direct must not consult system settings');
  const preferences={proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:7897};
  assert.equal(await proxyFor('https://example.test',{preferences,env,runner}),'http://127.0.0.1:7897');
  assert.equal(await proxyFor('https://example.test',{preferences:{proxyMode:'direct'},env,runner}),'');
  await assert.rejects(proxyFor('https://example.test',{preferences:{proxyMode:'manual',proxyPort:0},env,runner}));
});
test('automatic mode keeps environment precedence and otherwise uses macOS system settings',async()=>{
  assert.equal(await proxyFor('',{preferences:{},env:{ALL_PROXY:'http://127.0.0.1:7897'},runner:()=>assert.fail()}),'http://127.0.0.1:7897/');
  assert.equal(await proxyFor('',{preferences:{},env:{},runner:async()=> 'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'}),'http://127.0.0.1:7897');
  await assert.rejects(proxyFor('',{preferences:{},env:{HTTPS_PROXY:'socks5://127.0.0.1:7897'},runner:()=>assert.fail()}));
});
test('saved policies survive reload; invalid edits and malformed files never replace or bypass them',async t=>{
  const directory=folder(t),store=new ManagerState(directory,async()=>{});
  store.settings({proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:7897});
  const file=path.join(directory,'application-preferences.json'),before=fs.readFileSync(file,'utf8');
  assert.throws(()=>store.settings({proxyPort:0}));assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(new ManagerState(directory,async()=>{}).preferences.proxyPort,7897);
  assert.equal(await proxyFor('',{directory,env:{HTTPS_PROXY:'http://127.0.0.1:9'}}),'http://127.0.0.1:7897');
  fs.writeFileSync(file,'{');await assert.rejects(proxyFor('',{directory,env:{HTTPS_PROXY:'http://127.0.0.1:9'}}));
});
test('settings API supplies the saved proxy to updates and rejects bad input without losing it',async t=>{
  const directory=folder(t),seen=[];
  const manager=await createManager({directory,secrets:async()=>{},dispatcher:{forward:async()=>null,close:async()=>{}},checkUpdate:async(version,arch,proxy)=>{seen.push(proxy);return null;}});
  t.after(()=>manager.close());
  const call=async(route,value={})=>{const response=await fetch(manager.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':manager.token},body:JSON.stringify(value)});return {status:response.status,data:await response.json()};};
  assert.equal((await call('settings',{proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:7897})).status,200);
  await call('update/check');assert.equal(seen.at(-1),'http://127.0.0.1:7897');
  assert.equal((await call('settings',{proxyPort:0})).status,400);assert.equal(manager.store.preferences.proxyPort,7897);
  assert.equal((await call('settings',{proxyMode:'direct'})).status,200);await call('update/check');assert.equal(seen.at(-1),'');
});
