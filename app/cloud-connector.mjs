import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {authHeaders,authSocketUrl,socketHeaders} from './desktop-auth.mjs';
import {cloudApi,prepareRelay} from './terminal-link.mjs';
import {finishSocketRequest} from './connection-transport.mjs';
export const shellQuote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
export class Cloud {
  constructor(url,cookie,agent,signal,preparation={}){Object.assign(this,{url,cookie,agent,signal,preparation});}
  api(endpoint,method,body){return cloudApi(this.url,this.cookie,this.agent,endpoint,method,body,this.signal);}
  async setFile(file,content){
    const i=file.lastIndexOf('/'),dir=file.slice(0,i),name=file.slice(i+1);
    const listing=await this.api('/api/sys/fs?hidden=1&path='+encodeURIComponent(dir));
    const entry=listing.entries?.find(x=>x.name===name);
    if(entry&&(entry.kind!=='file'||entry.link))throw Error('云端目标不是普通文件');
    return entry?this.api('/api/sys/fs','PUT',{path:file,content}):this.api('/api/sys/fs','POST',{dir,name,kind:'file',content});
  }
  command(command,cwd,timeout=180000){
    return new Promise((resolve,reject)=>{
      this.signal?.throwIfAborted();
      const u=new URL(this.url.replace(/^http/,'ws')+'/api/term/ws');
      u.search=new URLSearchParams({sid:'windows-setup-'+randomUUID(),cols:'200',rows:'30',cwd,cmd:command+'; exit $?'}).toString();
      const ws=new WebSocket(authSocketUrl(u,this.cookie),{headers:socketHeaders(this.url,this.cookie),agent:this.agent,rejectUnauthorized:true,handshakeTimeout:30000,maxPayload:2*1024*1024,finishRequest:finishSocketRequest});
      let done=false,bytes=0;const chunks=[];
      const abort=()=>finish(Error('此云电脑连接已停止'));
      const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);this.signal?.removeEventListener('abort',abort);try{if(ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify({t:'kill'}));ws.close();}else ws.terminate();}catch{};if(error)reject(error);else resolve(Buffer.concat(chunks).toString('utf8'));};
      const timer=setTimeout(()=>finish(Error('云端配置超时')),timeout);
      this.signal?.addEventListener('abort',abort,{once:true});
      ws.on('message',(data,binary)=>{if(binary){bytes+=data.length;if(bytes>2*1024*1024)return finish(Error('云端输出过大'));chunks.push(data);return;}
        let m;try{m=JSON.parse(data);}catch{return;}if(!m||typeof m!=='object'||Array.isArray(m))return;if(m.t==='exit')finish(m.code===0?null:Error('云端命令失败（退出码 '+m.code+'），请检查 Python 3.9 和 Claude 配置'));else if(m.t==='error')finish(Error('无法启动云端配置终端'));
      });
      ws.on('error',error=>finish(Object.assign(Error('云端配置连接失败'),{code:error.code,connectionPhase:error.connectionPhase,connectionMs:error.connectionMs,reusedConnection:error.reusedConnection})));ws.on('close',()=>finish(Error('云端配置连接提前关闭')));
    });
  }
  async install(){
    const {home,file,cc}=await prepareRelay(this.url,this.cookie,this.agent,this.signal,this.preparation);
    const dir=file.slice(0,file.lastIndexOf('/')),target=dir+'/cloudpc-connector.py';
    await this.setFile(target,fs.readFileSync(new URL('./cloudpc-connector.py',import.meta.url),'utf8'));
    const output=await this.command(`python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 79)' && ${cc?'env CLOUDPC_CC_SHARED=1 ':`chmod 700 ${shellQuote(dir)} && chmod 600 ${shellQuote(target)} && `}python3 ${shellQuote(target)} install ${cc?'--client desktop ':''}--wait 60`,home,240000);
    if(!/Connected: \d+ Windows tools/.test(output)||!/Config changed: \d+/.test(output))throw Error('云端未确认 Windows 工具连接，请查看连接状态后重试');
    return /Config changed: [1-9]|Connector updated: yes/.test(output);
  }
  close(){this.agent?.destroy();}
}
