import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runFile,privateDir,safeFile,atomicWrite} from './platform.mjs';
import {inspectZip,validateBundle,replaceBundle} from './update-transaction.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const file=process.argv[2];
try{
  if(process.platform!=='darwin'||!file||!path.isAbsolute(file))throw Error('macOS update request required');
  safeFile(file);const request=JSON.parse(fs.readFileSync(file,'utf8'));privateDir(request.state);
  if(path.dirname(file)!==request.state||!/^update-request-[a-f0-9-]+\.json$/.test(path.basename(file))||!Number.isSafeInteger(request.managerPid)||request.managerPid<2||!/^[a-f0-9-]{36}$/i.test(request.nonce))throw Error('Invalid update request');
  if(path.dirname(request.zip)!==request.folder||path.dirname(request.folder)!==request.state||!/^update-[a-f0-9-]+$/.test(path.basename(request.folder)))throw Error('Invalid update staging path');
  safeFile(request.zip);const bytes=fs.readFileSync(request.zip);if(createHash('sha256').update(bytes).digest('hex')!==request.sha256)throw Error('Update package changed');inspectZip(bytes);
  const stage=path.join(request.folder,'unpacked');fs.mkdirSync(stage,{mode:0o700});
  await runFile('/usr/bin/ditto',['-x','-k',request.zip,stage],{timeout:120000});
  const candidate=path.join(stage,'CMCP.app');validateBundle(candidate,{version:request.version,arch:process.arch});
  await runFile('/usr/bin/codesign',['--verify','--deep','--strict',candidate]);
  const deadline=Date.now()+30000;while(alive(request.managerPid)&&Date.now()<deadline)await sleep(200);if(alive(request.managerPid))throw Error('Application has not exited');
  const ack=file+'.ack';
  const launch=async(app,rollback=false)=>runFile('/usr/bin/open',['-n',app,...(rollback?[]:['--args','--updated',file])]);
  const backup=await replaceBundle({installRoot:request.installRoot,staged:candidate,version:request.version,arch:process.arch,launch,
    healthy:async()=>{for(let i=0;i<150;i++){try{safeFile(ack);if(fs.readFileSync(ack,'utf8')===request.nonce)return true;}catch{};await sleep(200);}return false;},
    stopFailed:async()=>{try{const instance=JSON.parse(fs.readFileSync(path.join(request.state,'manager-instance.json'),'utf8'));if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(instance.origin)||!/^[a-f0-9]{64}$/.test(instance.token))throw Error();await fetch(instance.origin+'/api/restart',{method:'POST',headers:{'x-cmcp-token':instance.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});await sleep(1500);}catch{}}});
  atomicWrite(path.join(request.state,'update-result.json'),JSON.stringify({ok:true,version:request.version,backup}));
}catch{try{const r=JSON.parse(fs.readFileSync(file,'utf8'));if(path.dirname(file)===r.state)atomicWrite(path.join(r.state,'update-result.json'),JSON.stringify({ok:false,message:'Update failed; inspect the retained backup before retrying.'}));}catch{};process.exitCode=1;}
