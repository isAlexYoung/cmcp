import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runFile,privateDir,safeFile,atomicWrite} from './platform.mjs';
import {inspectZip,validateBundle,replaceBundle,completeUpdate} from './update-transaction.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const file=process.argv[2];
let request,staged;
const launch=async(app,rollback=false)=>runFile('/usr/bin/open',['-n',app,...(rollback?[]:['--args','--updated',file])]);
const exited=async()=>{const deadline=Date.now()+30000;while(alive(request.managerPid)&&Date.now()<deadline)await sleep(200);return !alive(request.managerPid);};
try{
  if(process.platform!=='darwin'||!file||!path.isAbsolute(file))throw Error('macOS update request required');
  safeFile(file);const parsed=JSON.parse(fs.readFileSync(file,'utf8'));privateDir(parsed.state);
  if(path.dirname(file)!==parsed.state||!/^update-request-[a-f0-9-]+\.json$/.test(path.basename(file))||!Number.isSafeInteger(parsed.managerPid)||parsed.managerPid<2||!/^[a-f0-9-]{36}$/i.test(parsed.nonce))throw Error('Invalid update request');
  if(path.dirname(parsed.zip)!==parsed.folder||path.dirname(parsed.folder)!==parsed.state||!/^update-[a-f0-9-]+$/.test(path.basename(parsed.folder)))throw Error('Invalid update staging path');
  request=parsed;
  safeFile(request.zip);const bytes=fs.readFileSync(request.zip);if(createHash('sha256').update(bytes).digest('hex')!==request.sha256)throw Error('Update package changed');inspectZip(bytes);
  const stage=path.join(request.folder,'unpacked');fs.mkdirSync(stage,{mode:0o700});
  await runFile('/usr/bin/ditto',['-x','-k',request.zip,stage],{timeout:120000});
  const candidate=path.join(stage,'CMCP.app');validateBundle(candidate,{version:request.version,arch:process.arch});
  await runFile('/usr/bin/codesign',['--verify','--deep','--strict',candidate]);
  // The data folder can be on another volume than the application; a copy beside it keeps the swap a plain rename.
  staged=path.join(path.dirname(request.installRoot),'.cmcp-staged-'+randomUUID()+'.app');
  await runFile('/usr/bin/ditto',[candidate,staged],{timeout:120000});
  validateBundle(staged,{version:request.version,arch:process.arch});
  if(!await exited())throw Error('Application has not exited');
  const ack=file+'.ack';
  const backup=await replaceBundle({installRoot:request.installRoot,staged,version:request.version,arch:process.arch,launch,
    healthy:async()=>{for(let i=0;i<150;i++){try{safeFile(ack);if(fs.readFileSync(ack,'utf8')===request.nonce)return true;}catch{};await sleep(200);}return false;},
    stopFailed:async()=>{try{const instance=JSON.parse(fs.readFileSync(path.join(request.state,'manager-instance.json'),'utf8'));if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(instance.origin)||!/^[a-f0-9]{64}$/.test(instance.token))throw Error();await fetch(instance.origin+'/api/restart',{method:'POST',headers:{'x-cmcp-token':instance.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});await sleep(1500);}catch{}}});
  atomicWrite(path.join(request.state,'update-result.json'),JSON.stringify({ok:true,version:request.version}));
  const cleanup={state:request.state,installRoot:request.installRoot,backup,folder:request.folder,requestFile:file};
  const pending=path.join(request.state,'update-cleanup.json');atomicWrite(pending,JSON.stringify(cleanup));
  try{completeUpdate(cleanup);fs.unlinkSync(pending);}catch{}
}catch(error){
  try{const r=JSON.parse(fs.readFileSync(file,'utf8'));if(path.dirname(file)===r.state)atomicWrite(path.join(r.state,'update-result.json'),JSON.stringify({ok:false,message:'Update failed; the previous version was kept.'}));}catch{};
  if(request){
    try{if(staged)fs.rmSync(staged,{recursive:true,force:true});}catch{};
    // The app quits as soon as this helper starts, so a failure before the swap must reopen it too.
    try{if(!error.restored&&await exited())await launch(request.installRoot,true);}catch{};
    try{fs.rmSync(request.folder,{recursive:true,force:true});fs.rmSync(file,{force:true});fs.rmSync(file+'.ack',{force:true});}catch{};
  }
  process.exitCode=1;
}
