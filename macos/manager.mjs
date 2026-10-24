import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ManagerState} from './state.mjs';
import {STATE,VERSION,keychain,proxyFor,atomicWrite,safeFile} from './platform.mjs';
import {createDispatcher} from './dispatcher.mjs';
import {Cloud} from './cloud-api.mjs';
import {agentFor} from '../app/link-client.mjs';
import {requiresSharedSession} from '../app/desktop-auth.mjs';
import {createTargetConnections} from '../app/target-connections.mjs';
import {managedTargetFactory} from '../app/managed-target.mjs';
import {checkRelease,downloadUpdate} from './updates.mjs';

const resources=path.join(path.dirname(fileURLToPath(import.meta.url)),'ui');
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function createManager({directory=STATE,secrets=keychain,proxy=proxyFor,dispatcher:injected,detectShared,install,version=VERSION,platform=process.platform,arch=process.arch}={}){
  const store=new ManagerState(directory,secrets),token=randomBytes(32).toString('hex'),states={};
  const dispatcher=injected||await createDispatcher({roots:store.config.roots});
  const machineFile=path.join(directory,'machine-id');safeFile(machineFile);
  let machine;try{machine=fs.readFileSync(machineFile,'utf8').trim();if(!/^[a-f0-9-]{36}$/.test(machine))throw Error();}catch{machine=randomUUID();atomicWrite(machineFile,machine);}
  const status={set(name,state,message){if(state==='password')message='保存的密码不正确或不可用。请停止此连接后编辑密码。';states[name]={state,message,at:new Date().toISOString()};}};
  const log=text=>{try{const file=path.join(directory,'service.log');safeFile(file);if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024){safeFile(file+'.1');fs.renameSync(file,file+'.1');}const name=/^\[([a-f0-9-]{36})\] ([a-z-]+)/.exec(text),close=/\bclose=(\d{1,4})\b/.exec(text);fs.appendFileSync(file,new Date().toISOString()+' '+(name?name[1]+' '+name[2]:'transport event')+(close?' close='+close[1]:'')+'\n',{mode:0o600});}catch{}};
  const connections=createTargetConnections({readTargets:()=>store.linkTargets(),readControls:()=>store.controlMap(),status,
    create:managedTargetFactory({proxyFor:proxy,machine,deviceName:os.hostname(),recoveryOptions:{limit:16384},version,forward:dispatcher.forward,
      askPassword:async()=>false,notify:()=>{},log,passwordFor:id=>store.password(id),
      install:install||((target,auth,agent,signal)=>new Cloud(target.url,auth,agent,signal).install())})});
  let origin='',closing=false,updates={state:'unchecked',version:null},updating=false;
  const snapshot=()=>({...store.view(states),version,platform:'macos-'+arch,updates});
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  const readBody=async req=>{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('请求过大');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');};
  const protocol=detectShared|| (async url=>{const agent=agentFor(url,await proxy(url));try{return await requiresSharedSession(url,agent);}finally{agent?.destroy();}});
  async function entry(id){for(let i=0;i<100;i++){if(closing)throw Error('程序正在退出');const record=connections.values().find(t=>t.name===id);if(record)return record.gateway?.launchUrl||record.url;if(!store.controlMap().get(id)?.enabled)throw Error('请先启动连接');await delay(100);}throw Error('连接尚未准备好，请查看卡片进度');}
  async function close({disable=false}={}){if(closing)return;closing=true;if(disable)await store.serial(()=>store.setEnabled(null,false));clearInterval(publish);await connections.close();await dispatcher.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
  const routes={
    '/api/state':async()=>snapshot(),
    '/api/targets/save':input=>store.serial(async()=>({id:await store.save(input,protocol)})),
    '/api/targets/start':input=>store.serial(()=>{if(typeof input.id!=='string')throw Error('请选择连接');store.setEnabled(input.id,true);connections.tick();return {started:true};}),
    '/api/targets/stop':input=>store.serial(()=>{if(typeof input.id!=='string')throw Error('请选择连接');store.setEnabled(input.id,false);connections.tick();return {stopped:true};}),
    '/api/targets/delete':input=>store.serial(async()=>{await store.remove(input.id);connections.tick();return {deleted:true};}),
    '/api/targets/order':input=>store.serial(()=>{store.reorder(input.ids);return {saved:true};}),
    '/api/targets/open':async input=>({url:await entry(input.id)}),
    '/api/settings':input=>store.serial(()=>{store.settings(input);return {saved:true};}),
    '/api/update/check':async()=>{if(updating)return updates;try{const release=await checkRelease(version,arch,await proxy('https://api.github.com'));updates={state:release?'available':'latest',version:release?.version||null};}catch{updates={state:'error',version:null};}return updates;},
    '/api/update/download':async()=>{if(updating)throw Error('更新正在进行');updating=true;try{return {directory:await downloadUpdate({current:version,arch,proxy:await proxy('https://api.github.com'),directory,onProgress:value=>{updates={state:'updating',...value};}})};}catch(error){updates={state:'failed',code:error.code||'prepare',phase:error.phase||'release'};throw error;}finally{updating=false;}},
  };
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(origin).host)return json(res,421,{error:'Host not allowed'});
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&['/','/ui/app.js','/ui/style.css'].includes(url.pathname)){
        const file=url.pathname==='/'?'index.html':url.pathname.split('/').at(-1);
        res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store',
          'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});
        return res.end(fs.readFileSync(path.join(resources,file)));
      }
      if(!equal(req.headers['x-cmcp-token'],token))return json(res,403,{error:'Authorization required'});
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Origin not allowed'});
      if(req.method!=='POST'&&!(req.method==='GET'&&url.pathname==='/api/state'))return json(res,405,{error:'Method not allowed'});
      if(req.method==='POST'&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'JSON required'});
      if(url.pathname==='/api/exit'||url.pathname==='/api/restart'){
        if(req.method!=='POST')return json(res,405,{error:'POST required'});
        if(url.pathname==='/api/exit')await store.serial(()=>store.setEnabled(null,false));
        json(res,200,{stopped:true});setImmediate(()=>close().catch(()=>{}));return;
      }
      const route=routes[url.pathname];if(!route)return json(res,404,{error:'Not found'});
      const body=req.method==='POST'?await readBody(req):{};
      if(closing)return json(res,503,{error:'程序正在退出'});
      return json(res,200,await route(body));
    }catch(error){return json(res,400,{error:String(error.message||'操作失败').slice(0,300)});}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  origin='http://127.0.0.1:'+server.address().port;
  const publish=setInterval(()=>{try{atomicWrite(path.join(directory,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),targets:states}));}catch{}},2000);publish.unref();
  return {origin,token,url:origin+'/#'+token,store,connections,snapshot,close};
}
