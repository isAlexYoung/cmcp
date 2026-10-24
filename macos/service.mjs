import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {STATE,VERSION,privateDir,safeFile,atomicWrite,readConfig,keychain,proxyFor} from './platform.mjs';
import {createDispatcher} from './dispatcher.mjs';
import {startLink} from './link-client.mjs';
if(process.platform!=='darwin')throw Error('This service is for macOS');
process.umask(0o077);privateDir(STATE);
const logFile=path.join(STATE,'service.log');
function log(text){
  // No remote response bodies, passwords, cookies, command arguments or proxy URLs.
  try{safeFile(logFile);if(fs.existsSync(logFile)&&fs.statSync(logFile).size>2*1024*1024){safeFile(logFile+'.1');fs.renameSync(logFile,logFile+'.1');}const label=/^\[([a-f0-9-]{36})\] ([a-z]+)/.exec(text);fs.appendFileSync(logFile,new Date().toISOString()+' '+(label?label[1]+' '+label[2]:'transport event')+'\n',{mode:0o600});}catch{}
}
const config=readConfig(),dispatcher=await createDispatcher({roots:config.roots});
const idFile=path.join(STATE,'machine-id');let machine;
safeFile(idFile);
try{machine=fs.readFileSync(idFile,'utf8').trim();if(!/^[a-f0-9-]{36}$/.test(machine))throw Error('Invalid machine ID');}catch{machine=randomUUID();atomicWrite(idFile,machine);}
const states={};const status={set(id,state,message){states[id]={state,message,at:new Date().toISOString()};atomicWrite(path.join(STATE,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),targets:states},null,2));}};
const heartbeat=setInterval(()=>atomicWrite(path.join(STATE,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),targets:states},null,2)),5000);
const links=config.targets.map(t=>startLink({name:t.id,machine,version:VERSION,status,log,forward:dispatcher.forward,
  target:()=>{const current=readConfig().targets.find(x=>x.id===t.id);return current?{url:current.url,stamp:current.changed,password:()=>keychain('get',t.id),proxy:proxyFor}:null;},
  askPassword:async()=>false,notify:()=>{},
}));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;clearInterval(heartbeat);for(const l of links)l.stop();await dispatcher.close();process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('uncaughtException',e=>{log('服务异常：'+e.name);shutdown();});
process.on('unhandledRejection',()=>{log('服务异步错误');shutdown();});
