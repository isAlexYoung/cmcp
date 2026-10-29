import fs from 'node:fs';
import path from 'node:path';
import {STATE,LEGACY_STATE,KIT,VERSION,privateDir,safeFile,atomicWrite,LABEL} from './platform.mjs';
import {reuseDesktopManager} from './desktop-instance.mjs';
import {migratePortableState,retryPortableCleanup} from './portable-state.mjs';
import {createManager} from './manager.mjs';
import {retireLegacyAgent} from './legacy-agent.mjs';
if(process.platform!=='darwin')throw Error('CMCP desktop requires macOS');
if(process.getuid()===0)throw Error('Do not run CMCP as root');
process.umask(0o077);
if(process.env.CMCP_NATIVE_SELF_TEST!=='1'&&!fs.existsSync(STATE)){
  await retireLegacyAgent({home:process.env.HOME,state:LEGACY_STATE,uid:process.getuid()});
  await migratePortableState(STATE,LEGACY_STATE);
}
privateDir(STATE);
if(process.env.CMCP_NATIVE_SELF_TEST!=='1'){
  const bundleRoot=path.resolve(KIT,'../../..');
  retryPortableCleanup(STATE,bundleRoot);
}
const instanceFile=path.join(STATE,'manager-instance.json'),lockFile=path.join(STATE,'manager.lock');
safeFile(instanceFile);safeFile(lockFile);
const alive=pid=>{if(!Number.isInteger(pid)||pid<2)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
if(process.env.CMCP_NATIVE_SELF_TEST!=='1'){
  await retireLegacyAgent({home:process.env.HOME,state:STATE,uid:process.getuid()});
}
let lock;
for(let attempt=0;attempt<50;attempt++){
  try{lock=fs.openSync(lockFile,'wx',0o600);fs.writeFileSync(lock,String(process.pid));break;}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    safeFile(lockFile);let pid;try{pid=Number(fs.readFileSync(lockFile,'utf8'));}catch{throw Error('Manager startup is busy');}
    if(!alive(pid)){fs.unlinkSync(lockFile);continue;}
    if(attempt===0){
      let previous;try{previous=JSON.parse(fs.readFileSync(instanceFile,'utf8'));}catch{throw Error('A CMCP manager is already starting');}
      if(previous.pid!==pid||!/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.origin)||!/^[a-f0-9]{64}$/.test(previous.token))throw Error('Existing manager identity could not be verified');
      if(process.env.CMCP_FORCE_RESTART!=='1'&&await reuseDesktopManager(previous,{pid,version:VERSION})){
        process.stdout.write(JSON.stringify({origin:previous.origin,token:previous.token})+'\n');
        // This observer owns no backend or lock. Closing it cannot stop the owner;
        // explicit application exit still uses the existing authenticated API.
        const watcher=setInterval(()=>{if(!alive(pid))process.exit(1);},1000);
        process.once('SIGTERM',()=>{clearInterval(watcher);process.exit(0);});
        process.once('SIGINT',()=>{clearInterval(watcher);process.exit(0);});
        await new Promise(()=>{});
      }
      const response=await fetch(previous.origin+'/api/restart',{method:'POST',headers:{'x-cmcp-token':previous.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Existing manager could not stop');
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
if(lock===undefined)throw Error('Existing manager did not stop');
let manager;
function cleanup(){try{if(fs.readFileSync(lockFile,'utf8')===String(process.pid))fs.unlinkSync(lockFile);}catch{};try{if(JSON.parse(fs.readFileSync(instanceFile,'utf8')).pid===process.pid)fs.unlinkSync(instanceFile);}catch{};try{fs.closeSync(lock);}catch{}}
process.once('exit',cleanup);
try{
  manager=await createManager();
  atomicWrite(instanceFile,JSON.stringify({pid:process.pid,origin:manager.origin,token:manager.token}));
  process.stdout.write(JSON.stringify({origin:manager.origin,token:manager.token})+'\n');
  const stop=async()=>{await manager.close();cleanup();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch{cleanup();process.stderr.write('CMCP backend startup failed.\n');process.exitCode=1;}
