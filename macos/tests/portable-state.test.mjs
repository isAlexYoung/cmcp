import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {migratePortableState,completePortableUpdate,retryPortableCleanup} from '../portable-state.mjs';
import {replaceBundle,validateBundle} from '../update-transaction.mjs';
function directory(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-portable-')));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function put(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
function bundle(root,version){
  const files=[];
  for(const name of ['Contents/Info.plist','Contents/MacOS/CMCP','Contents/Resources/runtime/node','Contents/Resources/macos/desktop.mjs']){
    put(path.join(root,name),version);files.push({path:name,sha256:createHash('sha256').update(version).digest('hex')});
  }
  put(path.join(root,'Contents/Resources/distribution-manifest.json'),JSON.stringify({schema:1,version,platform:'macos-arm64',files}));return root;
}
function cleanupFixture(d){
  const state=path.join(d,'user'),installRoot=path.join(d,'CMCP.app'),backup=bundle(path.join(d,'.cmcp-backup-'+randomUUID()+'.app'),'4.2.1');
  const folder=path.join(state,'update-'+randomUUID()),requestFile=path.join(state,'update-request-'+randomUUID()+'.json');
  put(path.join(folder,'download.zip'),'fixture zip');put(requestFile,'{}');put(requestFile+'.ack','nonce');put(path.join(state,'targets.json'),'KEYCHAIN-REFERENCE-UNCHANGED');
  return {state,installRoot,backup,folder,requestFile};
}
test('portable migration preserves keychain references, remarks, preferences and machine identity',async t=>{
  const d=directory(t),old=path.join(d,'legacy'),user=path.join(d,'user');let stopped=0;
  const entries={'targets.json':'{"targets":[{"secret":"keychain-id","label":"remark","icon":"data"}]}','application-preferences.json':'{"language":"en"}','target-controls.json':'{"enabled":true}','machine-id':'same-machine'};
  for(const [name,bytes] of Object.entries(entries))put(path.join(old,name),bytes);
  for(const name of ['status.json','manager-instance.json','manager.lock','update-old/download.zip'])put(path.join(old,name),'stale runtime');
  assert.equal(await migratePortableState(user,old,{stop:async()=>stopped++}),true);assert.equal(stopped,1);
  assert.deepEqual(fs.readdirSync(user).sort(),Object.keys(entries).sort());
  for(const [name,bytes] of Object.entries(entries)){assert.equal(fs.readFileSync(path.join(user,name),'utf8'),bytes);assert.equal(fs.readFileSync(path.join(old,name),'utf8'),bytes);}
  if(process.platform!=='win32')assert.equal(fs.statSync(user).mode&0o777,0o700);
});
test('existing portable configuration is authoritative and never reimports legacy data',async t=>{
  const d=directory(t),user=path.join(d,'user'),old=path.join(d,'legacy');put(path.join(user,'targets.json'),'new');put(path.join(old,'targets.json'),'old');
  assert.equal(await migratePortableState(user,old,{stop:async()=>{throw Error('must not stop');}}),false);assert.equal(fs.readFileSync(path.join(user,'targets.json'),'utf8'),'new');
});
test('failed migration preserves source and leaves no partial destination',async t=>{
  const d=directory(t),old=path.join(d,'legacy'),user=path.join(d,'user');put(path.join(old,'targets.json'),'preserve');
  await assert.rejects(migratePortableState(user,old,{stop:async()=>{throw Error('busy');}}));assert.equal(fs.existsSync(user),false);assert.equal(fs.readFileSync(path.join(old,'targets.json'),'utf8'),'preserve');assert.deepEqual(fs.readdirSync(d),['legacy']);
  fs.unlinkSync(path.join(old,'targets.json'));fs.mkdirSync(path.join(old,'targets.json'));
  await assert.rejects(migratePortableState(user,old,{stop:async()=>{}}));assert.equal(fs.existsSync(user),false);
});
test('symlinked portable data and migration files are rejected',{skip:process.platform==='win32'},async t=>{
  const d=directory(t),old=path.join(d,'legacy'),user=path.join(d,'user');put(path.join(d,'outside','targets.json'),'preserve');fs.mkdirSync(old);fs.symlinkSync(path.join(d,'outside','targets.json'),path.join(old,'targets.json'));
  await assert.rejects(migratePortableState(user,old,{stop:async()=>{}}));assert.equal(fs.existsSync(user),false);
  fs.symlinkSync(path.join(d,'outside'),user);await assert.rejects(migratePortableState(user,old));assert.equal(fs.readFileSync(path.join(d,'outside','targets.json'),'utf8'),'preserve');
});
test('bundle replacement and rollback preserve sibling user data including changes during startup',async t=>{
  const d=directory(t),user=path.join(d,'user/targets.json'),installRoot=bundle(path.join(d,'CMCP.app'),'4.2.1');put(user,'original');
  await replaceBundle({installRoot,staged:bundle(path.join(d,'staging','CMCP.app'),'4.3.0'),version:'4.3.0',arch:'arm64',launch:async()=>assert.equal(fs.readFileSync(user,'utf8'),'original'),healthy:async()=>true});
  await assert.rejects(replaceBundle({installRoot,staged:bundle(path.join(d,'next','CMCP.app'),'4.4.0'),version:'4.4.0',arch:'arm64',launch:async()=>{},healthy:async()=>{put(user,'latest');return false;},stopFailed:async()=>{}}));assert.equal(validateBundle(installRoot).version,'4.3.0');assert.equal(fs.readFileSync(user,'utf8'),'latest');
});
test('successful cleanup removes downloads and retains exactly the recorded previous program',t=>{
  const d=directory(t),first=cleanupFixture(d);put(path.join(d,'unrelated.zip'),'preserve');completePortableUpdate(first);
  assert.equal(fs.existsSync(first.folder),false);assert.equal(fs.existsSync(first.requestFile),false);assert.equal(fs.existsSync(first.backup),true);
  const second=cleanupFixture(d);completePortableUpdate(second);assert.equal(fs.existsSync(first.backup),false);assert.equal(fs.existsSync(second.backup),true);assert.equal(fs.readFileSync(path.join(second.state,'targets.json'),'utf8'),'KEYCHAIN-REFERENCE-UNCHANGED');assert.equal(fs.existsSync(path.join(d,'unrelated.zip')),true);
  completePortableUpdate(second);
});
test('cleanup refuses modified backup contents and retries only for its own installation',t=>{
  const d=directory(t),first=cleanupFixture(d);completePortableUpdate(first);put(path.join(first.backup,'personal.txt'),'preserve');const second=cleanupFixture(d);
  assert.throws(()=>completePortableUpdate(second));assert.equal(fs.existsSync(second.folder),true);assert.equal(fs.existsSync(path.join(first.backup,'personal.txt')),true);
  put(path.join(second.state,'update-cleanup.json'),JSON.stringify(second));retryPortableCleanup(second.state,path.join(d,'other.app'));assert.equal(fs.existsSync(second.folder),true);
  fs.unlinkSync(path.join(first.backup,'personal.txt'));retryPortableCleanup(second.state,second.installRoot);assert.equal(fs.existsSync(second.folder),false);assert.equal(fs.existsSync(path.join(second.state,'update-cleanup.json')),false);
});

test('first portable upgrade cleans legacy downloads and keeps both migrated data and the legacy source',t=>{
  const d=directory(t),original=cleanupFixture(d),legacy=path.join(d,'legacy');fs.mkdirSync(legacy);
  const folder=path.join(legacy,path.basename(original.folder)),requestFile=path.join(legacy,path.basename(original.requestFile));
  fs.renameSync(original.folder,folder);fs.renameSync(original.requestFile,requestFile);fs.renameSync(original.requestFile+'.ack',requestFile+'.ack');put(path.join(legacy,'targets.json'),'legacy config');
  completePortableUpdate({...original,state:legacy,dataState:original.state,folder,requestFile});
  assert.equal(fs.existsSync(folder),false);assert.equal(fs.existsSync(requestFile),false);assert.equal(fs.readFileSync(path.join(legacy,'targets.json'),'utf8'),'legacy config');assert.equal(fs.readFileSync(path.join(original.state,'targets.json'),'utf8'),'KEYCHAIN-REFERENCE-UNCHANGED');assert.equal(fs.existsSync(path.join(original.state,'update-backup.json')),true);assert.equal(fs.existsSync(path.join(legacy,'update-backup.json')),false);
});
