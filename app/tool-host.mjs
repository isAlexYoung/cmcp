// One process per third-party tool for the whole computer. The main CMCP process (the Windows
// service, the Mac manager) hosts the tools; SSH channel workers, separate processes, reach them
// over a private local socket instead of starting copies of their own. The token lives in a
// file only this account can read. When the host cannot be reached, a worker runs its own copy.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {atomicWrite} from './mcp-tools.mjs';
import {ProxyServer,readToolCache,UNCERTAIN} from './mcp-proxy.mjs';

const recordFile=stateDir=>path.join(stateDir,'tool-host.json');
export function hostEndpoint(stateDir,platform=process.platform){
  const key=createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0,20);
  if(platform==='win32')return '\\\\.\\pipe\\cmcp-tools-'+key;
  return path.join(os.tmpdir(),'cmcp-tools-'+(process.getuid?.()??'user')+'-'+key+'.sock');
}
const same=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function lines(socket,handle){
  let buffer='';socket.setEncoding('utf8');
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>48*1024*1024){socket.destroy();return;}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let value;try{value=JSON.parse(line);}catch{socket.destroy();return;}handle(value);}});
}
const write=(socket,value)=>{try{if(!socket.destroyed)socket.write(JSON.stringify(value)+'\n');}catch{}};

// Host side: serves the registry's own tool processes.
export async function startToolHost({stateDir,registry,log=()=>{},endpoint=hostEndpoint(stateDir)}){
  const token=randomBytes(32).toString('hex'),clients=new Set();
  const server=net.createServer(socket=>{
    let trusted=false;const asks=new Map();clients.add(socket);
    socket.on('error',()=>{});socket.on('close',()=>{clients.delete(socket);for(const w of asks.values())w.reject(Error('Worker went away'));asks.clear();});
    socket.setTimeout(10000,()=>{if(!trusted)socket.destroy();});
    lines(socket,async message=>{
      if(!trusted){if(same(message.token,token)){trusted=true;socket.setTimeout(0);write(socket,{ok:true});}else socket.destroy();return;}
      if(message.answer!==undefined||message.question!==undefined){const w=asks.get(message.question);if(w){asks.delete(message.question);message.error?w.reject(Error(String(message.error))):w.resolve(message.answer);}return;}
      const {id,op,tool}=message,proxy=registry.proxy(tool);
      if(!proxy){write(socket,{id,error:'Tool is not on in the main CMCP process'});return;}
      try{
        if(op==='refresh'){write(socket,{id,tools:await proxy.refresh(),status:proxy.status()});return;}
        if(op==='status'){write(socket,{id,status:proxy.status(),tripped:proxy.tripped()});return;}
        if(op==='call'){
          // A question during this call goes back to the worker, which asks its cloud user.
          const ask=params=>new Promise((resolve,reject)=>{const question=randomBytes(12).toString('hex');asks.set(question,{resolve,reject});write(socket,{id,question,params});});
          write(socket,{id,result:await proxy.call(message.name,message.args||{},{ask})});return;
        }
        write(socket,{id,error:'Unknown operation'});
      }catch(error){write(socket,{id,error:error.message});}
    });
  });
  if(process.platform!=='win32'){try{const s=fs.lstatSync(endpoint);if(s.isSocket()&&s.uid===process.getuid())fs.unlinkSync(endpoint);}catch{}}
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
  if(process.platform!=='win32')fs.chmodSync(endpoint,0o600);
  atomicWrite(recordFile(stateDir),JSON.stringify({schema:1,pid:process.pid,endpoint,token})+'\n');
  log('tool host listening');
  return {endpoint,async close(){
    try{const record=JSON.parse(fs.readFileSync(recordFile(stateDir),'utf8'));if(record.token===token)fs.unlinkSync(recordFile(stateDir));}catch{}
    for(const socket of clients)socket.destroy();await new Promise(resolve=>server.close(()=>resolve()));
  }};
}

// Worker side: one connection to the host, shared by the worker's remote tools.
export function hostClient(stateDir,{connectTimeout=2000}={}){
  let socket=null,ready=null,next=1;const pending=new Map();
  const fail=error=>{for(const p of pending.values())p.reject(error);pending.clear();socket=null;ready=null;};
  function connect(){
    if(ready)return ready;
    ready=new Promise((resolve,reject)=>{
      let record;try{record=JSON.parse(fs.readFileSync(recordFile(stateDir),'utf8'));}catch{reject(Error('No tool host'));return;}
      if(record.schema!==1||typeof record.token!=='string'||typeof record.endpoint!=='string'){reject(Error('No tool host'));return;}
      const s=net.connect(record.endpoint);let opened=false;
      const timer=setTimeout(()=>{s.destroy();reject(Error('Tool host did not answer'));},connectTimeout);
      s.on('error',error=>{clearTimeout(timer);if(!opened)reject(error);fail(error);});
      s.on('close',()=>{clearTimeout(timer);if(!opened)reject(Error('Tool host closed'));fail(Error('Tool host closed'));});
      s.on('connect',()=>write(s,{token:record.token}));
      lines(s,message=>{
        if(!opened){if(message.ok){opened=true;clearTimeout(timer);socket=s;resolve(s);}return;}
        const p=pending.get(message.id);if(!p)return;
        if(message.question){Promise.resolve(p.ask?p.ask(message.params):Promise.reject(Error('No client can show this question'))).then(answer=>write(s,{question:message.question,answer}),error=>write(s,{question:message.question,answer:null,error:error.message}));return;}
        pending.delete(message.id);message.error?p.reject(Object.assign(Error(message.error),{host:true})):p.resolve(message);
      });
    }).catch(error=>{ready=null;throw error;});
    return ready;
  }
  return {
    available:async()=>{try{await connect();return true;}catch{return false;}},
    async request(body,ask){const s=await connect();const id=next++;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,ask});write(s,{...body,id});});},
    close(){socket?.destroy();fail(Error('Closed'));},
  };
}

// A tool reached through the host. Same surface as ProxyServer for the registry; falls back to a
// local ProxyServer when the host is not there (or does not have the tool on).
export class HostedProxy {
  constructor(options,client){
    Object.assign(this,{id:options.id,hash:options.hash,idleMs:options.idleMs,stateDir:options.stateDir,options,client});
    this.local=null;this.failures=[];this.state='stopped';this.error=null;
  }
  cachedTools(){return readToolCache(this.stateDir,this.id,this.hash);}
  status(){return this.local?this.local.status():{state:this.state,error:this.error};}
  tripped(){return this.local?this.local.tripped():false;}
  fallback(){if(!this.local)this.local=new ProxyServer(this.options);return this.local;}
  async refresh(){
    if(this.local)return this.local.refresh();
    try{const reply=await this.client.request({op:'refresh',tool:this.id});this.state=reply.status?.state||'running';this.error=null;this.options.onToolsChanged?.();return reply.tools;}
    catch(error){if(error.host&&!/not on/.test(error.message))throw error;return this.fallback().refresh();}
  }
  async call(name,args,ctx={}){
    if(this.local)return this.local.call(name,args,ctx);
    if(!(await this.client.available()))return this.fallback().call(name,args,ctx);
    try{return (await this.client.request({op:'call',tool:this.id,name,args},ctx.ask)).result;}
    catch(error){
      if(error.host&&/not on/.test(error.message))return this.fallback().call(name,args,ctx);
      // The call may have reached the tool before the host went away: never resent.
      return {isError:true,content:[{type:'text',text:UNCERTAIN+' ('+error.message+')'}]};
    }
  }
  async close(){await this.local?.close();}
}
