import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {selectRelease,downloadUpdate} from '../updates.mjs';
import {inspectZip,validateBundle,replaceBundle,completeUpdate,retryUpdateCleanup} from '../update-transaction.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function directory(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac-update-')));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function release(arch='arm64'){const name='CMCP-4.2.0-macos-'+arch+'.zip';return {draft:false,prerelease:false,tag_name:'v4.2.0',assets:[name,name+'.sha256'].map((name,i)=>({name,size:i?100:3,browser_download_url:'https://github.com/isAlexYoung/cmcp/releases/download/v4.2.0/'+name}))};}
test('release selection strictly separates Mac architectures and Windows',()=>{
  const r=release();r.assets.push({name:'CMCP-4.2.0-windows-x64.zip'});assert.equal(selectRelease(r,'4.1.1','arm64').name,'CMCP-4.2.0-macos-arm64.zip');assert.throws(()=>selectRelease(r,'4.1.1','x64'));
  assert.equal(selectRelease(r,'4.2.0','arm64'),null);assert.throws(()=>selectRelease({...r,prerelease:true},'4.1.1','arm64'));
});
test('updates keep using the zip when the release also carries a disk image',()=>{
  const r=release();r.assets.push(...['CMCP-4.2.0-macos-arm64.dmg','CMCP-4.2.0-macos-arm64.dmg.sha256'].map(name=>({name,size:9,browser_download_url:'https://github.com/isAlexYoung/cmcp/releases/download/v4.2.0/'+name})));
  const selected=selectRelease(r,'4.1.1','arm64');assert.equal(selected.name,'CMCP-4.2.0-macos-arm64.zip');assert.equal(selected.checksum.name,'CMCP-4.2.0-macos-arm64.zip.sha256');
});
test('untrusted, incomplete and ambiguous update assets are rejected',()=>{
  const r=release();r.assets[0].browser_download_url='https://other.invalid/update.zip';assert.throws(()=>selectRelease(r,'4.1.1','arm64'));
  r.assets[0].browser_download_url='https://github.com/isAlexYoung/cmcp/releases/download/v4.2.0/'+r.assets[0].name;r.assets.push({...r.assets[0]});assert.throws(()=>selectRelease(r,'4.1.1','arm64'));
});
test('download verifies checksum and asset digest before staging a file',async t=>{
  const d=directory(t),r=release(),bytes=Buffer.from('zip');r.assets[0].digest='sha256:'+hash(bytes);
  const fetch=async url=>url.endsWith('/latest')?Buffer.from(JSON.stringify(r)):url.endsWith('.sha256')?Buffer.from(hash(bytes)+'  '+r.assets[0].name):bytes;
  const update=await downloadUpdate({current:'4.1.1',arch:'arm64',directory:d,fetch});assert.equal(fs.readFileSync(update.zip,'utf8'),'zip');
  r.assets[0].digest='sha256:'+'0'.repeat(64);await assert.rejects(downloadUpdate({current:'4.1.1',arch:'arm64',directory:d,fetch}));
});
test('download reports phase and byte progress before verification and restart',async t=>{
  const d=directory(t),r=release(),bytes=Buffer.from('zip'),events=[];
  const fetch=async(url,options)=>{
    if(url.endsWith('/latest'))return Buffer.from(JSON.stringify(r));
    if(url.endsWith('.sha256'))return Buffer.from(hash(bytes)+'  '+r.assets[0].name);
    options.onProgress(0,3);options.onProgress(1,3);options.onProgress(3,3);return bytes;
  };
  await downloadUpdate({current:'4.1.1',arch:'arm64',directory:d,fetch,onProgress:value=>events.push(value)});
  assert.equal(events[0].phase,'release');assert.equal(events.at(-1).phase,'restart');
  assert.deepEqual(events.filter(v=>v.phase==='download').map(v=>v.received),[0,0,1,3]);
  assert.ok(events.findIndex(v=>v.phase==='verify')>events.findIndex(v=>v.received===3));
});
test('download failures expose a safe reason and never stage corrupt bytes',async t=>{
  const d=directory(t),r=release(),secret='DO-NOT-DISPLAY';
  const fetch=async(url)=>url.endsWith('/latest')?Buffer.from(JSON.stringify(r)):url.endsWith('.sha256')?Buffer.from('0'.repeat(64)+'  '+r.assets[0].name):Buffer.from('zip');
  await assert.rejects(downloadUpdate({current:'4.1.1',arch:'arm64',directory:d,fetch}),e=>e.code==='checksum'&&!e.message.includes(secret));
  assert.equal(fs.readdirSync(d).filter(n=>n.startsWith('update-')).length,0);
});
function bundle(root,version){
  const app=path.join(root,'CMCP.app');fs.mkdirSync(app,{recursive:true});const files=[];
  for(const name of ['Contents/Info.plist','Contents/MacOS/CMCP','Contents/Resources/runtime/node','Contents/Resources/macos/desktop.mjs']){const file=path.join(app,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,version);files.push({path:name,sha256:hash(Buffer.from(version))});}
  fs.writeFileSync(path.join(app,'Contents/Resources/distribution-manifest.json'),JSON.stringify({schema:1,version,platform:'macos-arm64',files}));return app;
}
test('modified, missing and user-added bundle files prevent replacement',t=>{
  const d=directory(t),app=bundle(d,'4.1.1');assert.equal(validateBundle(app).version,'4.1.1');fs.writeFileSync(path.join(app,'extra.txt'),'mine');assert.throws(()=>validateBundle(app));fs.unlinkSync(path.join(app,'extra.txt'));fs.writeFileSync(path.join(app,'Contents/Info.plist'),'changed');assert.throws(()=>validateBundle(app));
});
test('transaction retains a verified backup after successful launch',async t=>{
  const d=directory(t),old=bundle(path.join(d,'install'),'4.1.1'),staged=bundle(path.join(d,'staging'),'4.2.0');let calls=0;
  const backup=await replaceBundle({installRoot:old,staged,version:'4.2.0',arch:'arm64',launch:async()=>{calls++;},healthy:async()=>true});assert.equal(validateBundle(old).version,'4.2.0');assert.equal(validateBundle(backup).version,'4.1.1');assert.equal(calls,1);
});
test('failed launch rolls back files and starts the previous application',async t=>{
  const d=directory(t),old=bundle(path.join(d,'install'),'4.1.1'),staged=bundle(path.join(d,'staging'),'4.2.0');const calls=[];
  await assert.rejects(replaceBundle({installRoot:old,staged,version:'4.2.0',arch:'arm64',launch:async(app,rollback)=>calls.push(rollback===true),healthy:async()=>false,stopFailed:async()=>calls.push('stop')}));assert.equal(validateBundle(old).version,'4.1.1');assert.deepEqual(calls,[false,'stop',true]);
  assert.deepEqual(fs.readdirSync(path.join(d,'install')),['CMCP.app']);
});
test('rollback marks the error so the helper does not reopen the application twice',async t=>{
  const d=directory(t),old=bundle(path.join(d,'install'),'4.1.1'),staged=bundle(path.join(d,'staging'),'4.2.0');
  await assert.rejects(replaceBundle({installRoot:old,staged,version:'4.2.0',arch:'arm64',launch:async()=>{},healthy:async()=>false}),error=>error.restored===true);
});
test('a folder the user cannot change fails before anything moves',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
  const d=directory(t),old=bundle(path.join(d,'install'),'4.1.1'),staged=bundle(path.join(d,'staging'),'4.2.0'),parent=path.dirname(old);let launched=0;
  fs.chmodSync(parent,0o555);
  try{
    await assert.rejects(replaceBundle({installRoot:old,staged,version:'4.2.0',arch:'arm64',launch:async()=>{launched++;},healthy:async()=>true}),error=>error.restored===undefined);
    assert.equal(validateBundle(old).version,'4.1.1');assert.equal(validateBundle(staged).version,'4.2.0');assert.equal(launched,0);assert.deepEqual(fs.readdirSync(parent),['CMCP.app']);
  }finally{fs.chmodSync(parent,0o755);}
});
function cleanupFixture(d){
  const state=path.join(d,'CMCP'),installRoot=path.join(d,'install/CMCP.app');fs.mkdirSync(state,{recursive:true});fs.mkdirSync(path.dirname(installRoot),{recursive:true});
  const backup=path.join(path.dirname(installRoot),'.cmcp-backup-'+randomUUID()+'.app');fs.renameSync(bundle(path.join(d,'old-'+randomUUID()),'4.1.1'),backup);
  const folder=path.join(state,'update-'+randomUUID()),requestFile=path.join(state,'update-request-'+randomUUID()+'.json');
  fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'download.zip'),'zip');fs.writeFileSync(requestFile,'{}');fs.writeFileSync(requestFile+'.ack','nonce');fs.writeFileSync(path.join(state,'targets.json'),'KEEP');
  return {state,installRoot,backup,folder,requestFile};
}
test('after a healthy update nothing but the application and the data remains',t=>{
  const d=directory(t),cleanup=cleanupFixture(d);fs.writeFileSync(path.join(d,'install/unrelated.zip'),'keep');completeUpdate(cleanup);
  for(const gone of [cleanup.backup,cleanup.folder,cleanup.requestFile,cleanup.requestFile+'.ack'])assert.equal(fs.existsSync(gone),false,gone);
  assert.equal(fs.readFileSync(path.join(cleanup.state,'targets.json'),'utf8'),'KEEP');assert.equal(fs.existsSync(path.join(d,'install/unrelated.zip')),true);
  completeUpdate(cleanup);
});
test('cleanup keeps a changed backup and retries only for its own installation',t=>{
  const d=directory(t),cleanup=cleanupFixture(d),extra=path.join(cleanup.backup,'personal.txt');fs.writeFileSync(extra,'keep');
  assert.throws(()=>completeUpdate(cleanup));assert.equal(fs.existsSync(extra),true);assert.equal(fs.existsSync(cleanup.folder),true);
  const pending=path.join(cleanup.state,'update-cleanup.json');fs.writeFileSync(pending,JSON.stringify(cleanup));
  retryUpdateCleanup(cleanup.state,path.join(d,'other.app'));assert.equal(fs.existsSync(cleanup.folder),true);
  fs.unlinkSync(extra);retryUpdateCleanup(cleanup.state,cleanup.installRoot);assert.equal(fs.existsSync(cleanup.backup),false);assert.equal(fs.existsSync(cleanup.folder),false);assert.equal(fs.existsSync(pending),false);
});
test('cleanup refuses paths outside the installation and data folders',t=>{
  const d=directory(t),cleanup=cleanupFixture(d);
  for(const change of [{backup:path.join(d,'.cmcp-backup-'+randomUUID()+'.app')},{backup:path.join(d,'install/CMCP.app')},{folder:path.join(d,'update-'+randomUUID())},{requestFile:path.join(d,'update-request-'+randomUUID()+'.json')}])assert.throws(()=>completeUpdate({...cleanup,...change}),/Invalid cleanup paths/);
  assert.equal(fs.existsSync(cleanup.backup),true);
});
function zip(name,localName=name,mode=0o100644){const a=Buffer.from(localName),b=Buffer.from(name),local=Buffer.alloc(30+a.length),central=Buffer.alloc(46+b.length),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(a.length,26);a.copy(local,30);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(b.length,28);central.writeUInt32LE((mode<<16)>>>0,38);b.copy(central,46);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length,16);return Buffer.concat([local,central,end]);}
test('ZIP inspection rejects traversal, symlinks and local-header mismatches',()=>{
  assert.equal(inspectZip(zip('CMCP.app/Contents/file')).count,1);
  for(const bytes of [zip('../bad'),zip('CMCP.app/../../bad'),zip('CMCP.app/Contents/file','../../outside'),zip('CMCP.app/Contents/link',undefined,0o120777),zip('CMCP.app/Contents/fifo',undefined,0o010600),Buffer.from('invalid')])assert.throws(()=>inspectZip(bytes));
});

test('signature verification cannot replace resource hashes or bypass verification on another OS',t=>{
  const d=directory(t),app=bundle(d,'4.1.1'),file=path.join(app,'Contents/Resources/distribution-manifest.json');
  const manifest=JSON.parse(fs.readFileSync(file));
  const native=manifest.files.find(f=>f.path==='Contents/MacOS/CMCP');delete native.sha256;native.codeSignature=true;
  fs.writeFileSync(file,JSON.stringify(manifest));assert.throws(()=>validateBundle(app));
  native.path='Contents/Info.plist';fs.writeFileSync(file,JSON.stringify(manifest));assert.throws(()=>validateBundle(app),/Invalid manifest/);
});
