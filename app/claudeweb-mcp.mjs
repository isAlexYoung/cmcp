// Standalone ClaudeWeb's authenticated web bridge. Reuses the connector's framing,
// request recovery and local tool dispatcher without an SSH account or TCP listener.
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {requestBuffered} from './desktop-auth.mjs';
import {bootstrapPayload,startSshMcp} from './ssh-mcp.mjs';
import {platformConnector} from './connection-policy.mjs';
import {finishSocketRequest} from './connection-transport.mjs';

class WebPipe extends EventEmitter {
  constructor({url,agent,token,payload,signal}){
    super();this.ended=false;
    const address=new URL('/cmcp-ws',url);address.protocol=address.protocol==='https:'?'wss:':'ws:';
    this.socket=new WebSocket(address,{agent,headers:{authorization:'Bearer '+token},rejectUnauthorized:true,perMessageDeflate:false,maxPayload:48*1024*1024,handshakeTimeout:30000,finishRequest:finishSocketRequest});
    this.socket.once('open',()=>{if(!this.ended)this.socket.send(JSON.stringify({t:'bootstrap',data:payload}));});
    this.socket.on('message',(data,binary)=>this.emit('message',data,binary));
    this.socket.on('error',error=>this.emit('error',error));
    this.socket.on('unexpected-response',(_request,response)=>{
      response.resume();this.emit('error',Object.assign(Error('ClaudeWeb authentication expired'),{code:[401,403].includes(response.statusCode)?'SSH_AUTH':'SSH_SETUP'}));this.close();
    });
    this.socket.on('close',(code,reason)=>{
      if(this.ended)return;this.ended=true;
      if(code===4401)this.emit('error',Object.assign(Error('Signed out'),{code:'SSH_AUTH'}));
      this.emit('close',code,reason);
    });
    this.abort=()=>this.close();signal.addEventListener('abort',this.abort,{once:true});
    this.socket.on('close',()=>signal.removeEventListener('abort',this.abort));
  }
  get readyState(){return this.ended?3:this.socket.readyState;}
  get bufferedAmount(){return this.socket.bufferedAmount;}
  send(text){this.socket.send(text);}
  close(){if(this.ended)return;this.ended=true;if(this.socket.readyState===1)this.socket.close();else this.socket.terminate();queueMicrotask(()=>this.emit('close',1000,'closed'));}
  terminate(){this.close();this.socket.terminate();}
}

// Used by managedTargetFactory when discovery advertises webMcp. The token stays
// in memory, and stop signs out only this connection's own session.
export function startClaudewebMcp({url,agent,passwordFor,machine,catalog,forward,signal,status,device='',policy}){
  const controller=new AbortController();let token=null,stopping;
  let authenticated;
  const authentication=new Promise(resolve=>{authenticated=resolve;});
  const request=async(path,body,authenticated=false,requestSignal=controller.signal)=>{
    const result=await requestBuffered(new URL(path,url),{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body),agent,signal:requestSignal,timeout:15000,limit:32768});
    let value;try{value=JSON.parse(result.body);}catch{}
    if(result.status!==200)throw Object.assign(Error('ClaudeWeb authentication or connection refused'),{status:result.status,code:value?.error?.code});
    return value;
  };
  const ready=(state,message)=>status(state==='ready'?'connected':state==='failed'?'config-error':'connecting',state==='ready'?'本机工具已连接；开始新的对话后可使用。':state==='failed'?'本机工具连接失败，请重新连接设备并检查 ClaudeWeb 密码。':state==='recovering'?'本机工具连接暂时中断，正在恢复。':'正在连接 ClaudeWeb 的本机工具通道…');
  const running=(async()=>{
    ready('connecting');
    controller.signal.throwIfAborted();
    let abortPassword;
    let password;
    try{
      password=await Promise.race([passwordFor(),new Promise((_,reject)=>{abortPassword=()=>reject(Error('Stopped'));controller.signal.addEventListener('abort',abortPassword,{once:true});})]);
    }finally{controller.signal.removeEventListener('abort',abortPassword);}
    let code;
    try {
      // A standby URL can be temporarily unreachable while SSH is already
      // working. Retry only getting a code, never a rejected credential or
      // a redeem whose result may have been lost.
      for (let attempt=0;;attempt++) {
        try { code=await request('/api/auth/cmcp/code',{password}); break; }
        catch(error) {
          if (!policy?.dual || controller.signal.aborted || (error.status && error.status<500)) throw error;
          await delay(Math.min(30000,3000*2**Math.min(attempt,4)),undefined,{signal:controller.signal});
        }
      }
    } finally { password=undefined; }
    const session=await request('/api/auth/cmcp/redeem',{code:code.code,mode:'join'});
    if(typeof session?.token!=='string')throw Error('Missing ClaudeWeb session');
    token=session.token;
    authenticated(true);
    const key=policy?.key || machine;
    await startSshMcp({key,legacyMachine:machine,catalog:catalog.list(device),changes:catalog,device,forward,signal:controller.signal,status:ready,
      transport:()=>new WebPipe({url,agent,token,payload:{...bootstrapPayload(key,catalog.list(device),process.platform,policy),name:platformConnector()},signal:controller.signal})});
  })().catch(()=>{authenticated(false);if(!controller.signal.aborted)ready('failed');});
  const stop=()=>stopping??=(async()=>{
    controller.abort();await running;
    if(token){try{await request('/api/auth/logout',{},true,AbortSignal.timeout(5000));}catch{}token=null;}
    signal.removeEventListener('abort',stop);
  })();
  signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted)void stop();
  return {stop,async browserCode(){await authentication;if(!token)return null;return (await request('/api/auth/cmcp/session-code',{},true)).code;}};
}
