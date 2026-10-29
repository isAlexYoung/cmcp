import http from 'node:http';
import {once} from 'node:events';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {requestBuffered,authHeaders} from './desktop-auth.mjs';

const digest=s=>createHash('sha256').update(s).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const same=(a,b)=>{if(typeof a!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const endpoint='/api/auth/cmcp';
export async function supportsDirectBrowser(baseUrl,agent,signal) {
  const result=await requestBuffered(new URL(endpoint,baseUrl),{agent,signal,timeout:10000,limit:131072});
  if([404,405].includes(result.status))return false;
  if(result.status!==200)throw Error('无法确认云桌面直连能力，请稍后重试');
  let body;try{body=JSON.parse(result.body);}catch{return false;}
  if(body.protocol!=='cmcp-direct')return false;
  if(body.version!==1)throw Error('此云桌面的直连协议需要更新 CMCP');
  return true;
}

// A local launch page only. It never proxies HTML, files, APIs or GUI WebSockets.
export async function createDirectBrowser({baseUrl,agent,autoPassword,diagnostic=()=>{},pollMs=2000}) {
  const remote=new URL(baseUrl);
  if((remote.protocol!=='https:'&&!(remote.protocol==='http:'&&remote.hostname==='127.0.0.1'))||remote.pathname!=='/'||remote.search||remote.hash||remote.username||remote.password)throw Error('干净的 HTTPS 地址 required');
  const token=secret(),controller=new AbortController();
  let id=randomBytes(16).toString('hex'),control=secret(),auth=null,issue=null,closed=false,opening,pending;
  let prepared=false,polling=false;
  const api=async(body,signal=controller.signal)=>{
    const result=await requestBuffered(new URL(endpoint,remote),{method:'POST',agent,signal,timeout:10000,limit:16384,
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    let value;try{value=JSON.parse(result.body);}catch{throw Error('无法读取直连登录响应');}
    return {status:result.status,value};
  };
  const poll=async()=>{
    if(polling||closed||!prepared)return;polling=true;
    const probeId=id;
    try{
      const r=await api({op:'poll',id,secret:control});if(closed||id!==probeId)return;
      if(r.status===200&&typeof r.value.sessionId==='string'&&typeof r.value.cookie==='string'){
        const next={sessionId:r.value.sessionId,cookie:r.value.cookie};authHeaders(next);
        if(!next.cookie.startsWith('wd_cmcp='))throw Error('Expected tool credential');
        auth=next;issue=null;
      }else if([409,410].includes(r.status)){auth=null;issue={state:'waiting-login',message:'网页登录已失效或入口已过期，请重新打开云电脑。'};prepared=false;}
      // Transient failures retain the previous credential; startLink validates it.
    }catch{diagnostic('direct session probe delayed');}finally{polling=false;}
  };
  // Once paired, the existing tool transport owns liveness checks. Do not add
  // continuous HTTPS polling alongside its heartbeat and session validation.
  const loop=(async()=>{while(!closed){await delay(pollMs,undefined,{signal:controller.signal}).catch(()=>{});if(!closed&&!auth)await poll();}})();
  async function launch(){
    if(opening)return opening;
    opening=(async()=>{
      if(closed)throw Error('CMCP 正在退出');
      if(!pending){
        const launchSecret=secret();let password;
        if(!auth&&typeof autoPassword==='function')try{password=await autoPassword(controller.signal);}catch{issue={state:'waiting-login',message:'无法读取保存的密码，请在网页输入。'};}
        if(closed)throw Error('CMCP 正在退出');
        pending={launchSecret,body:{op:'prepare',id,control,launch:digest(launchSecret),...(password===undefined?{}:{password})}};
      }
      let r=await api(pending.body);
      if(closed)throw Error('连接已停止');
      if(r.status===409&&r.value.code==='SESSION_REPLACED'){
        // Only a deliberate Open action may take over again, never the poller.
        auth=null;id=randomBytes(16).toString('hex');control=secret();
        pending.body={...pending.body,id,control};
        if(typeof autoPassword==='function'&&pending.body.password===undefined)pending.body.password=await autoPassword(controller.signal);
        if(closed)throw Error('连接已停止');r=await api(pending.body);
      }
      if(r.status===401&&r.value.code==='PASSWORD_REJECTED'){
        // One rejected automatic submission; let Chrome show manual sign-in.
        delete pending.body.password;r=await api(pending.body);
        issue={state:'password',message:'保存的密码不正确，请在网页输入正确密码。'};
      }
      if(r.status!==200)throw Error(r.status===429?'登录暂时受限，请稍后重试。':r.value.code==='PASSWORD_EXPIRED'?'访问密码已过期，请联系管理员。':'直连登录暂时不可用，请重试。');
      if(r.value.sessionId!==undefined||r.value.cookie!==undefined){
        const next={sessionId:r.value.sessionId,cookie:r.value.cookie};authHeaders(next);
        if(!next.cookie?.startsWith('wd_cmcp='))throw Error('Expected tool credential');auth=next;issue=null;
      }
      const url=new URL(remote);url.hash='cmcp='+id+'.'+pending.launchSecret;
      // Chrome need not wait for a second remote request to start displaying.
      pending=null;prepared=true;if(!auth)void poll();return url.href;
    })().finally(()=>{opening=null;});
    return opening;
  }
  let localOrigin;
  const reply=(res,status,body)=>{const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);};
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(localOrigin).host)return reply(res,421,{error:'Invalid host'});
      if(req.method==='GET'&&req.url==='/__mcp/open'){
        const body=Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>正在打开云电脑</title><p id="message">正在准备直连登录…</p><button hidden id="retry">重试</button><script>(()=>{const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let busy=false;const button=document.querySelector('#retry'),message=document.querySelector('#message');const open=async()=>{if(busy)return;busy=true;button.hidden=true;try{const r=await fetch('/__mcp/direct',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(v.error);location.replace(v.url);}catch(e){message.textContent=e.message||'连接暂时不可用';button.hidden=false;busy=false;}};button.onclick=open;open();})();</script>`);
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':body.length,'cache-control':'no-store','referrer-policy':'no-referrer',
          'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});return res.end(body);
      }
      if(req.method!=='POST'||req.url!=='/__mcp/direct')return reply(res,404,{error:'Not found'});
      if(req.headers.origin!==localOrigin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(res,403,{error:'Browser entry required'});
      const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>512){reply(res,413,{error:'Too large'});req.destroy();return;}chunks.push(c);}
      const b=JSON.parse(Buffer.concat(chunks));if(!same(b.token,token))return reply(res,403,{error:'Browser entry required'});
      const url=await launch();if(!closed&&!res.destroyed)reply(res,200,{url});
    }catch(error){if(!res.headersSent&&!res.destroyed)reply(res,503,{error:error.message?.includes('密码')||error.message?.includes('登录暂时')?error.message:'连接暂时不可用，请重试。'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.on('clientError',(_e,s)=>s.destroy());
  server.listen(0,'127.0.0.1');await once(server,'listening');localOrigin='http://127.0.0.1:'+server.address().port;
  return {direct:true,localOrigin,launchUrl:localOrigin+'/__mcp/open#'+token,
    getSessionId:()=>auth?.sessionId||null,getSessionAuth:()=>auth?{...auth}:null,getLoginIssue:()=>issue,
    invalidateSession:expected=>{if(!expected||expected===auth?.sessionId){auth=null;issue={state:'waiting-login',message:'网页登录已失效，请重新打开云电脑。'};}},
    async close(){if(closed)return;closed=true;controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r));await loop;
      // Revoking this tool credential does not log Chrome out of the desktop.
      if(prepared)await api({op:'stop',id,secret:control},AbortSignal.timeout(2000)).catch(()=>{});auth=null;pending=null;},
  };
}
