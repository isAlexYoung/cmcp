// Runs the released disk image as a user would: mount it, copy the app to /Applications, open it,
// then update it, roll a broken update back, and uninstall it. Changes /Applications and the
// account's real CMCP data, so it only runs on a disposable CI virtual machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateBundle} from '../update-transaction.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='darwin')throw Error('Only runs on a CI macOS virtual machine');
const [packages,report]=process.argv.slice(2).map(value=>path.resolve(value));
const arch=process.arch,app='/Applications/CMCP.app',state=path.join(os.homedir(),'Library/Application Support/CMCP');
const packageTool=fileURLToPath(new URL('../../tools/package-macos.py',import.meta.url));
const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-installed-'))),mount=path.join(work,'mount');
const checks=[],check=(name,value,detail)=>{assert.ok(value,name+(detail===undefined?'':': '+JSON.stringify(detail)));checks.push(name);console.log('ok - '+name);};
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','inherit']});
const sha256=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
async function waitFor(name,read,timeout=120000){const deadline=Date.now()+timeout;for(;;){const value=await read();if(value)return value;if(Date.now()>deadline)throw Error('Timed out waiting for '+name);await sleep(250);}}
const instanceIn=directory=>{try{const value=JSON.parse(fs.readFileSync(path.join(directory,'manager-instance.json'),'utf8'));return alive(value.pid)?value:null;}catch{return null;}};
const call=(instance,route,body={})=>fetch(instance.origin+route,{method:'POST',headers:{'x-cmcp-token':instance.token,'content-type':'application/json'},body:JSON.stringify(body)});
const parentOf=pid=>Number(run('/bin/ps',['-o','ppid=','-p',String(pid)]).trim());
const commandOf=pid=>run('/bin/ps',['-o','command=','-p',String(pid)]).trim();
const leftovers=directory=>fs.readdirSync(directory).filter(name=>name.startsWith('.cmcp-'));
const preferences=()=>JSON.parse(fs.readFileSync(path.join(state,'application-preferences.json'),'utf8'));
const open=async root=>{run('/usr/bin/open',['-n',root]);return waitFor('backend from '+root,()=>{const value=instanceIn(state);return value&&commandOf(value.pid).startsWith(root+'/')?value:null;});};
async function stop(instance){
  const owner=parentOf(instance.pid);
  assert.equal((await call(instance,'/api/exit')).status,200);
  await waitFor('application exit',()=>!alive(instance.pid)&&!alive(owner),60000);
}
function variant(name,version,change){
  const copy=path.join(work,name,'CMCP.app'),manifestFile=path.join(copy,'Contents/Resources/distribution-manifest.json');
  run('/usr/bin/ditto',[app,copy]);
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));manifest.version=version;change?.(copy,manifest);
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
  run('/usr/bin/codesign',['--force','--sign','-',copy]);
  const output=path.join(work,name+'-package');
  run('/usr/bin/python3',[packageTool,copy,output,'--zip-only']);
  return {zip:path.join(output,`CMCP-${version}-macos-${arch}.zip`),version};
}
// The same request the native app writes, followed by the same restart call.
async function applyUpdate(root,{zip,version},instance){
  const folder=path.join(state,'update-'+randomUUID()),staged=path.join(folder,path.basename(zip)),requestFile=path.join(state,'update-request-'+randomUUID()+'.json'),result=path.join(state,'update-result.json');
  fs.mkdirSync(folder,{mode:0o700});fs.copyFileSync(zip,staged);fs.chmodSync(staged,0o600);fs.rmSync(result,{force:true});
  fs.writeFileSync(requestFile,JSON.stringify({folder,zip:staged,version,sha256:sha256(zip),installRoot:root,managerPid:parentOf(instance.pid),state,nonce:randomUUID()}),{mode:0o600});
  const helper=spawn(path.join(root,'Contents/Resources/runtime/node'),[path.join(root,'Contents/Resources/macos/apply-update.mjs'),requestFile],{detached:true,stdio:'ignore'});
  const exit=new Promise(resolve=>helper.on('exit',resolve));
  assert.equal((await call(instance,'/api/restart')).status,200);
  const code=await Promise.race([exit,sleep(240000).then(()=>'timeout')]);
  return {code,folder,requestFile,result:JSON.parse(fs.readFileSync(result,'utf8'))};
}
let attached=false,failure;
try{
  for(const stale of [app,state,'/Applications/user'])check('starts without '+stale,!fs.existsSync(stale));

  const image=path.join(packages,fs.readdirSync(packages).find(name=>name.endsWith(`-macos-${arch}.dmg`)));
  check('disk image checksum matches its .sha256 file',fs.readFileSync(image+'.sha256','ascii').trim()===sha256(image)+'  '+path.basename(image));
  fs.mkdirSync(mount);run('/usr/bin/hdiutil',['attach',image,'-nobrowse','-readonly','-mountpoint',mount]);attached=true;
  check('disk image holds the app and an Applications link',fs.existsSync(path.join(mount,'CMCP.app'))&&fs.readlinkSync(path.join(mount,'Applications'))==='/Applications',fs.readdirSync(mount));
  run('/usr/bin/ditto',[path.join(mount,'CMCP.app'),app]);
  run('/usr/bin/hdiutil',['detach',mount]);attached=false;
  const installed=validateBundle(app,{arch});
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  check('copied app keeps a valid signature and every file',installed.platform==='macos-'+arch);

  const next=variant('next','99.0.0');
  const broken=variant('broken','100.0.0',(copy,manifest)=>{
    const name='Contents/Resources/macos/desktop.mjs',bad='process.exit(3);\n';
    fs.writeFileSync(path.join(copy,name),bad);manifest.files.find(file=>file.path===name).sha256=createHash('sha256').update(bad).digest('hex');
  });

  // CMCP_STATE_DIR still wins. Started directly, because open does not pass the environment on.
  const override=path.join(work,'override');
  const direct=spawn(path.join(app,'Contents/MacOS/CMCP'),[],{env:{...process.env,CMCP_STATE_DIR:override},stdio:'ignore'});
  const overridden=await waitFor('backend using CMCP_STATE_DIR',()=>instanceIn(override));
  check('CMCP_STATE_DIR overrides the data folder',fs.existsSync(path.join(override,'machine-id'))&&!fs.existsSync(state));
  await stop(overridden);direct.unref();

  let instance=await open(app);
  check('first start writes to ~/Library/Application Support/CMCP',fs.existsSync(path.join(state,'machine-id'))&&fs.existsSync(path.join(state,'manager-instance.json')));
  check('data folder is private',(fs.statSync(state).mode&0o777)===0o700);
  check('nothing is written beside the app',!fs.existsSync('/Applications/user'));
  check('backend runs from /Applications',commandOf(instance.pid).startsWith(app+'/Contents/Resources/runtime/node'),commandOf(instance.pid));
  check('app process runs from /Applications',commandOf(parentOf(instance.pid)).startsWith(app+'/Contents/MacOS/CMCP'),commandOf(parentOf(instance.pid)));
  const shown=await (await fetch(instance.origin+'/api/state',{headers:{'x-cmcp-token':instance.token}})).json();
  check('backend reports this package',shown.version===installed.version&&shown.platform==='macos-'+arch,shown.version);
  assert.equal((await call(instance,'/api/settings',{language:'en'})).status,200);
  check('a settings change lands in the data folder',preferences().language==='en');
  const machine=fs.readFileSync(path.join(state,'machine-id'),'utf8');

  let outcome=await applyUpdate(app,next,instance);
  check('update inside /Applications completes',outcome.code===0&&outcome.result.ok===true&&outcome.result.version==='99.0.0',outcome);
  check('updated app replaced the old one',validateBundle(app,{arch}).version==='99.0.0');
  check('update leaves no extra copy in /Applications',leftovers('/Applications').length===0,leftovers('/Applications'));
  check('update removes its download and request',!fs.existsSync(outcome.folder)&&!fs.existsSync(outcome.requestFile)&&!fs.existsSync(path.join(state,'update-cleanup.json')));
  check('update keeps the data',fs.readFileSync(path.join(state,'machine-id'),'utf8')===machine&&preferences().language==='en');
  instance=await waitFor('updated backend',()=>instanceIn(state));

  outcome=await applyUpdate(app,broken,instance);
  check('an update that cannot start is reported as failed',outcome.code===1&&outcome.result.ok===false,outcome);
  check('rollback restores the previous app',validateBundle(app,{arch}).version==='99.0.0');
  check('rollback leaves no extra copy in /Applications',leftovers('/Applications').length===0,leftovers('/Applications'));
  check('rollback removes the failed download',!fs.existsSync(outcome.folder)&&!fs.existsSync(outcome.requestFile));
  instance=await waitFor('backend after rollback',()=>instanceIn(state));
  check('rollback reopens the app with its data',commandOf(instance.pid).startsWith(app+'/')&&fs.readFileSync(path.join(state,'machine-id'),'utf8')===machine&&preferences().language==='en');

  // A folder the user cannot change, as for a standard account in /Applications.
  await stop(instance);
  const locked=path.join(work,'locked'),lockedApp=path.join(locked,'CMCP.app');
  fs.mkdirSync(locked);run('/usr/bin/ditto',[app,lockedApp]);fs.chmodSync(locked,0o555);
  try{
    instance=await open(lockedApp);
    outcome=await applyUpdate(lockedApp,next,instance);
    check('an update in a read-only folder is reported as failed',outcome.code===1&&outcome.result.ok===false,outcome);
    check('a failed update in a read-only folder changes nothing',validateBundle(lockedApp,{arch}).version==='99.0.0'&&fs.readdirSync(locked).length===1,fs.readdirSync(locked));
    instance=await waitFor('app reopened after the refused update',()=>{const value=instanceIn(state);return value&&commandOf(value.pid).startsWith(lockedApp+'/')?value:null;});
    check('a failed update in a read-only folder reopens the app',true);
    assert.equal((await call(instance,'/api/uninstall',{})).status,400);
    check('uninstall refuses a folder it cannot change and leaves everything',fs.existsSync(lockedApp)&&fs.existsSync(path.join(state,'machine-id')));
    await stop(instance);
  }finally{fs.chmodSync(locked,0o755);}

  instance=await open(app);
  const owner=parentOf(instance.pid),stray=path.join('/Applications','.cmcp-failed-'+randomUUID()+'.app');
  fs.mkdirSync(stray);
  const removed=await call(instance,'/api/uninstall',{appPid:owner});
  check('uninstall is accepted',removed.status===200);
  check('uninstall reports no cloud failure',(await removed.json()).cloudFailed===0);
  await waitFor('app and data removal',()=>!fs.existsSync(app)&&!fs.existsSync(state),90000);
  await waitFor('app exit after uninstall',()=>!alive(owner)&&!alive(instance.pid),60000);
  check('uninstall removes the app and its data',!fs.existsSync(app)&&!fs.existsSync(state));
  check('uninstall removes stray update copies',!fs.existsSync(stray)&&leftovers('/Applications').length===0);
  check('uninstall stops the app',!alive(owner)&&!alive(instance.pid));
  check('uninstall leaves nothing beside the app',!fs.existsSync('/Applications/user'));
}catch(error){
  failure=error;
  console.error(error);
  for(const directory of [state,'/Applications'])try{console.error(directory,fs.readdirSync(directory));}catch{}
  try{console.error(fs.readFileSync(path.join(state,'service.log'),'utf8').slice(-4000));}catch{}
  process.exitCode=1;
}finally{
  if(attached)try{run('/usr/bin/hdiutil',['detach','-force',mount]);}catch{}
  fs.mkdirSync(path.dirname(report),{recursive:true});
  fs.writeFileSync(report,JSON.stringify({passed:checks.length,failed:failure?1:0,error:failure?String(failure.message):'',checks,not_executed:['Gatekeeper prompt for a downloaded (quarantined) app','dragging in Finder','the uninstall button and its login item removal','real Keychain deletion','removing configuration from a real cloud PC'],},null,2));
}
process.exit(process.exitCode||0);
