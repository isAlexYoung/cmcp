import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {removeInstallation,checkInstallation,waitForExit} from '../uninstall.mjs';
import {createManager} from '../manager.mjs';
function directory(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-uninstall-')));t.after(()=>{fs.chmodSync(d,0o700);fs.rmSync(d,{recursive:true,force:true});});return d;}
function put(file,text='x'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
function fixture(d){
  const applications=path.join(d,'Applications'),bundle=path.join(applications,'CMCP.app'),home=path.join(d,'home'),state=path.join(home,'Library/Application Support/CMCP');
  put(path.join(bundle,'Contents/Info.plist'));put(path.join(state,'targets.json'));
  return {applications,bundle,home,state};
}
test('data folder is the per-user Application Support folder unless overridden',t=>{
  const d=directory(t),platform=new URL('../platform.mjs',import.meta.url).href;
  const read=env=>execFileSync(process.execPath,['--input-type=module','-e',`const {STATE}=await import(${JSON.stringify(platform)});process.stdout.write(STATE);`],{env:{...process.env,HOME:d,CMCP_STATE_DIR:'',...env},encoding:'utf8'});
  assert.equal(read({}),path.join(d,'Library/Application Support/CMCP'));
  assert.equal(read({CMCP_STATE_DIR:path.join(d,'override')}),path.join(d,'override'));
});
test('uninstall removes the application, its data, earlier update copies and its own shortcut',t=>{
  const d=directory(t),{applications,bundle,home,state}=fixture(d);
  const copies=['backup','failed','staged'].map(kind=>path.join(applications,'.cmcp-'+kind+'-'+randomUUID()+'.app'));for(const copy of copies)put(path.join(copy,'file'));
  const neighbours=[path.join(applications,'Other.app/file'),path.join(applications,'.cmcp-backup-notes.app/file'),path.join(home,'Library/Application Support/Other/file')];for(const file of neighbours)put(file);
  const generated=[path.join(home,'Library/Caches/com.cmcp.manager/cache'),path.join(home,'Library/WebKit/com.cmcp.manager/data'),path.join(home,'Library/Preferences/com.cmcp.manager.plist')];for(const file of generated)put(file);
  fs.mkdirSync(path.join(home,'Desktop'));fs.symlinkSync(bundle,path.join(home,'Desktop/CMCP.app'));
  removeInstallation({bundle,state,defaultState:state,home});
  for(const gone of [bundle,state,...copies,...generated,path.join(home,'Desktop/CMCP.app')])assert.equal(fs.existsSync(gone)||fs.lstatSync(gone,{throwIfNoEntry:false})!==undefined,false,gone);
  for(const file of neighbours)assert.equal(fs.existsSync(file),true,file);
});
test('a shortcut to another application and an overridden data folder are left alone',t=>{
  const d=directory(t),{bundle,home,state}=fixture(d),other=path.join(d,'other/CMCP.app');
  put(path.join(other,'file'));fs.mkdirSync(path.join(home,'Desktop'));fs.symlinkSync(other,path.join(home,'Desktop/CMCP.app'));
  removeInstallation({bundle,state,defaultState:path.join(home,'Library/Application Support/CMCP-default'),home});
  assert.equal(fs.existsSync(bundle),false);assert.equal(fs.existsSync(path.join(state,'targets.json')),true);assert.equal(fs.readlinkSync(path.join(home,'Desktop/CMCP.app')),other);
});
test('uninstall refuses anything but an application bundle and a read-only location',t=>{
  const d=directory(t);assert.throws(()=>removeInstallation({bundle:path.join(d,'not-an-app'),state:path.join(d,'state'),home:d}));
  assert.throws(()=>checkInstallation(path.join(d,'missing.app')));
});
test('waiting for exit tells whether the processes really stopped',async()=>{
  assert.equal(await waitForExit([0,1,undefined,2147483646],{timeout:10}),true);
  assert.equal(await waitForExit([process.pid],{timeout:30,poll:5}),false);
});
function managerFixture(t,installation,removeCloud){
  const d=directory(t),deleted=[];
  const secrets=async(op,id)=>{if(op==='delete')deleted.push(id);return 'password';};
  return createManager({directory:d,secrets,installation,removeCloud,detectShared:async()=>true,proxy:async()=>'',dispatcher:{forward:async()=>null,close:async()=>{}}}).then(m=>{t.after(()=>m.close());return {m,deleted};});
}
const post=(m,token=m.token)=>fetch(m.origin+'/api/uninstall',{method:'POST',headers:{'content-type':'application/json','x-cmcp-token':token},body:JSON.stringify({appPid:12345})});
const target=(url,password='')=>({url,label:'Mac',password,autoLogin:!!password,icon:''});
test('uninstall route stops connections, deletes saved passwords, reports cloud failures and starts the helper',async t=>{
  const launched=[],removed=[];
  const {m,deleted}=await managerFixture(t,{check(){},launch:pids=>launched.push(pids)},async value=>{removed.push(value.url);if(value.url.includes('second'))throw Error('unreachable');});
  await m.store.save(target('https://first.invalid','secret'),async()=>true);await m.store.save(target('https://second.invalid'),async()=>true);m.store.setEnabled(null,true);
  assert.equal((await post(m,'wrong')).status,403);assert.equal(launched.length,0);
  const response=await post(m);assert.equal(response.status,200);assert.deepEqual(await response.json(),{uninstalled:true,cloudFailed:1});
  assert.deepEqual(removed.sort(),['https://first.invalid','https://second.invalid']);assert.equal(deleted.length,1);
  assert.deepEqual(launched,[[process.pid,process.ppid,12345]]);assert.ok([...m.store.controlMap().values()].every(value=>!value.enabled));
});
test('uninstall changes nothing when the application cannot be removed',async t=>{
  let launched=0;
  const {m,deleted}=await managerFixture(t,{check(){throw Error('read-only');},launch(){launched++;}},async()=>assert.fail('cloud must stay configured'));
  await m.store.save(target('https://first.invalid','secret'),async()=>true);m.store.setEnabled(null,true);
  assert.equal((await post(m)).status,400);assert.equal(launched,0);assert.equal(deleted.length,0);
  assert.equal([...m.store.controlMap().values()][0].enabled,true);assert.equal(m.store.targets.length,1);
});
test('uninstall helper stops waiting and removes files when started as a program',{skip:process.platform==='win32'},t=>{
  const d=directory(t),{bundle,state}=fixture(d);
  execFileSync(process.execPath,[fileURLToPath(new URL('../uninstall.mjs',import.meta.url)),JSON.stringify({bundle,state,pids:[]})],{env:{...process.env,HOME:path.join(d,'home')}});
  assert.equal(fs.existsSync(bundle),false);assert.equal(fs.existsSync(state),false);
});
