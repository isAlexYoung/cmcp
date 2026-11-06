// The browser a shared web page opens in, and closing that window again on disconnect.
// A page that closes on disconnect runs with a profile of its own per device, so its
// processes carry that folder on their command line and no other browser window does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {privateDir,runFile} from './platform.mjs';

const KNOWN=[['safari','Safari','/Applications/Safari.app'],['chrome','Google Chrome','/Applications/Google Chrome.app'],['edge','Microsoft Edge','/Applications/Microsoft Edge.app'],['firefox','Firefox','/Applications/Firefox.app']];
// Safari cannot run with a profile CMCP owns, so only these can close their page.
export const CLOSABLE=['chrome','edge','firefox'];
export const BROWSER_IDS=KNOWN.map(([id])=>id);
// Only what is really installed is offered, from /Applications or ~/Applications.
export function detectBrowsers(exists=fs.existsSync,home=os.homedir()){
  const found=[];
  for(const [id,label,where]of KNOWN){
    const own=path.join(home,'Applications',path.basename(where)),app=[where,own].find(candidate=>exists(candidate));
    if(app)found.push({id,label,path:app});
  }
  return found;
}
export function pageFolder(directory,id,browser){return path.join(directory,'browser-windows',browser+'-'+createHash('sha256').update(String(id)).digest('hex').slice(0,16));}
export function openArguments(browser,url,folder){
  if(!folder)return ['-a',browser.path,url];
  if(browser.id==='firefox')return ['-n','-a',browser.path,'--args','-profile',folder,'-new-window',url];
  return ['-n','-a',browser.path,'--args','--user-data-dir='+folder,'--no-first-run','--no-default-browser-check','--new-window',url];
}
// False when nothing specific is chosen: the native host then opens the system default browser.
export async function openPage(preferences,directory,id,url,{found=detectBrowsers(),run=runFile}={}){
  const browser=found.find(item=>item.id===preferences.browser);
  if(!browser)return false;
  const folder=preferences.closeWeb===true&&CLOSABLE.includes(browser.id)?privateDir(pageFolder(directory,id,browser.id)):null;
  await run('/usr/bin/open',openArguments(browser,url,folder));
  return true;
}
export async function listProcesses(run=runFile){
  return String(await run('/bin/ps',['-axww','-o','pid=,ppid=,command='])).split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(match=>({pid:Number(match[1]),ppid:Number(match[2]),command:match[3]}));
}
// Politely first, as Quit would, then whatever is left. Returns how many processes it found.
export async function closePages(preferences,directory,id,{list=listProcesses,kill=(pid,signal)=>process.kill(pid,signal),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(preferences.closeWeb!==true||!CLOSABLE.includes(preferences.browser))return 0;
  const folders=CLOSABLE.map(browser=>pageFolder(directory,id,browser));
  const owned=async()=>(await list()).filter(item=>item.pid!==process.pid&&folders.some(folder=>item.command.includes(folder)));
  const found=await owned();
  for(const item of found){try{kill(item.pid,'SIGTERM');}catch{}}
  for(let i=0;i<20&&found.length;i++){if(!(await owned()).length)return found.length;await wait(200);}
  for(const item of await owned()){try{kill(item.pid,'SIGKILL');}catch{}}
  return found.length;
}
