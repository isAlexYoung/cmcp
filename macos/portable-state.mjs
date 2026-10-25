import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDir,safeFile,atomicWrite} from './platform.mjs';
import {validateBundle} from './update-transaction.mjs';

export async function migratePortableState(destination,legacy,{stop=stopLegacy}={}) {
  if(fs.existsSync(destination)){privateDir(destination);return false;}
  const parent=path.dirname(destination);privateDirCheck(parent);
  const stage=path.join(parent,'.cmcp-user-'+randomUUID());
  privateDir(stage);
  try {
    if(fs.existsSync(legacy)){
      privateDir(legacy);await stop(legacy);
      for(const name of ['targets.json','application-preferences.json','target-controls.json','dashboard-preferences.json','machine-id']){
        const file=path.join(legacy,name);safeFile(file);
        if(fs.existsSync(file)){const to=path.join(stage,name);fs.copyFileSync(file,to,fs.constants.COPYFILE_EXCL);fs.chmodSync(to,0o600);}
      }
    }
    if(fs.existsSync(destination))throw Error('Portable data directory appeared during migration');
    fs.renameSync(stage,destination);return true;
  } finally {if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true});}
}
function privateDirCheck(directory){let p=directory;while(p!==path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('Unsafe portable directory');p=path.dirname(p);}}
async function stopLegacy(directory){
  const lock=path.join(directory,'manager.lock');safeFile(lock);if(!fs.existsSync(lock))return;
  const pid=Number(fs.readFileSync(lock,'utf8'));
  const alive=()=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
  if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid legacy manager identity');
  if(!alive())return;
  const instanceFile=path.join(directory,'manager-instance.json');safeFile(instanceFile);
  const previous=JSON.parse(fs.readFileSync(instanceFile,'utf8'));
  if(previous.pid!==pid||!/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.origin)||!/^[a-f0-9]{64}$/.test(previous.token))throw Error('Invalid legacy manager identity');
  const response=await fetch(previous.origin+'/api/restart',{method:'POST',headers:{'x-cmcp-token':previous.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Legacy backend did not stop');
  for(let i=0;i<100&&alive();i++)await new Promise(resolve=>setTimeout(resolve,100));
  if(alive())throw Error('Legacy backend did not stop');
}

export function completePortableUpdate({state,installRoot,backup,folder,requestFile,dataState=state}) {
  const parent=path.dirname(installRoot);if(dataState!==state&&dataState!==path.join(parent,'user'))throw Error('Invalid portable data path');
  const record=path.join(dataState,'update-backup.json');privateDir(state);privateDir(dataState);
  const validBackup=value=>typeof value==='string'&&path.dirname(value)===parent&&/^\.cmcp-backup-[a-f0-9-]{36}\.app$/.test(path.basename(value));
  if(!validBackup(backup)||path.dirname(folder)!==state||!/^update-[a-f0-9-]{36}$/.test(path.basename(folder))||path.dirname(requestFile)!==state||!/^update-request-[a-f0-9-]{36}\.json$/.test(path.basename(requestFile)))throw Error('Invalid cleanup paths');
  validateBundle(backup);
  let previous;safeFile(record);try{previous=JSON.parse(fs.readFileSync(record,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const assertTree=directory=>{const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unsafe cleanup directory');for(const item of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isSymbolicLink()||!item.isDirectory()&&!item.isFile())throw Error('Unsafe cleanup file');if(item.isDirectory())assertTree(file);}};
  if(previous?.installRoot===installRoot&&previous.backup!==backup&&validBackup(previous.backup)&&fs.existsSync(previous.backup)){
    validateBundle(previous.backup);assertTree(previous.backup);fs.rmSync(previous.backup,{recursive:true});
  }
  atomicWrite(record,JSON.stringify({installRoot,backup}));
  if(fs.existsSync(folder)){assertTree(folder);fs.rmSync(folder,{recursive:true});}
  for(const file of [requestFile,requestFile+'.ack']){safeFile(file);if(fs.existsSync(file))fs.unlinkSync(file);}
}

export function retryPortableCleanup(state,installRoot){
  const file=path.join(state,'update-cleanup.json');safeFile(file);if(!fs.existsSync(file))return;
  try{const request=JSON.parse(fs.readFileSync(file,'utf8'));if((request.dataState||request.state)!==state||request.installRoot!==installRoot)throw Error('Cleanup installation mismatch');completePortableUpdate(request);fs.unlinkSync(file);}catch{}
}
