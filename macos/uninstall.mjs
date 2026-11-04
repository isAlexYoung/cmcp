import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE,KIT} from './platform.mjs';
import {validateBundle} from './update-transaction.mjs';

const identifier='com.cmcp.manager',leftover=/^\.cmcp-(?:backup|failed|staged)-[a-f0-9-]{36}\.app$/;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};

export function checkInstallation(bundle){
  validateBundle(bundle);
  fs.accessSync(path.dirname(bundle),fs.constants.W_OK);
}
export function removeInstallation({bundle,state,defaultState=DEFAULT_STATE,home=os.homedir()}){
  if(!path.isAbsolute(bundle)||!bundle.endsWith('.app'))throw Error('Application directory required');
  const failures=[],remove=file=>{try{fs.rmSync(file,{recursive:true,force:true});}catch(error){failures.push(error);}};
  // CMCP_STATE_DIR may name a folder that also holds other files, so only the default folder is removed.
  if(state===defaultState)remove(state);
  for(const name of ['Caches/'+identifier,'HTTPStorages/'+identifier,'HTTPStorages/'+identifier+'.binarycookies','WebKit/'+identifier,'Preferences/'+identifier+'.plist','Saved Application State/'+identifier+'.savedState'])remove(path.join(home,'Library',name));
  const shortcut=path.join(home,'Desktop','CMCP.app');
  try{if(fs.readlinkSync(shortcut)===bundle)fs.unlinkSync(shortcut);}catch{}
  const parent=path.dirname(bundle);
  for(const name of fs.readdirSync(parent))if(leftover.test(name))remove(path.join(parent,name));
  remove(bundle);
  if(failures.length)throw failures[0];
}
export function launchUninstaller({bundle,state,pids}){
  // The helper outlives this backend and the app, and must not keep the bundle as its working directory.
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),JSON.stringify({bundle,state,pids})],{detached:true,stdio:'ignore',cwd:'/'});
  child.on('error',()=>{});child.unref();
}
export function currentInstallation(state){
  const bundle=path.resolve(KIT,'../../..');
  return {check:()=>checkInstallation(bundle),launch:pids=>launchUninstaller({bundle,state,pids})};
}
export async function waitForExit(pids,{timeout=30000,poll=200}={}){
  const waiting=pids.filter(pid=>Number.isSafeInteger(pid)&&pid>1);
  const deadline=Date.now()+timeout;
  while(waiting.some(alive)&&Date.now()<deadline)await delay(poll);
  return !waiting.some(alive);
}
if(fs.realpathSync(process.argv[1]||'/')===fileURLToPath(import.meta.url)){
  try{
    const {bundle,state,pids}=JSON.parse(process.argv[2]);
    // The first PID is the backend: a stuck one could write to the data folder again after it is removed.
    if(!await waitForExit(pids)&&alive(pids[0])){process.kill(pids[0],'SIGKILL');await waitForExit([pids[0]],{timeout:5000});}
    removeInstallation({bundle,state});
  }catch{process.exitCode=1;}
}
