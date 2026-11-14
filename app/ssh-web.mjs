// SSH credentials are shared with Terminal; web passwords have their own scope.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {sshArguments,sshExitCode} from './ssh-mcp.mjs';
import {spawnSshWithRecovery,HOST_KEY_RECOVERY_ERROR} from './ssh-host-key.mjs';

export const tunnelName=(id,app)=>'tunnel:'+app+':'+id;
export const sshWebRevision=l=>createHash('sha256').update(JSON.stringify([l.host,l.port,l.username,l.method,l.keyPath,l.secret,l.credentialId,...['web','cloudcli'].flatMap(app=>[l[app+'Tunnel'],l[app+'Port'],l[app+'AutoLogin'],l[app+'Secret'],l[app+'CredentialId']])])).digest('hex');
export function tunnelIdentity(name){const m=/^tunnel:(web|cloudcli):(.+)$/.exec(name);return m?{app:m[1],id:m[2]}:null;}
export function webTunnelTargets(logins){return logins.flatMap(l=>['web','cloudcli'].filter(app=>l[app+'Tunnel']===true).map(app=>{
  const port=l[app+'Port']??(app==='web'?3000:3001);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SSH web port');
  return {name:tunnelName(l.id??l.name,app),url:'http://127.0.0.1:'+port,authMode:app==='web'?'shared-browser':'cloudcli',autoLogin:l[app+'AutoLogin']===true,tunnel:{id:l.id??l.name,app},stamp:sshWebRevision(l)};
}));}
export function readTunnelTargets(directory){try{const file=path.join(directory,'ssh-logins.json'),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>1024*1024)throw Error('Invalid SSH state');const data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));if(data.schema!==1||!Array.isArray(data.logins)||data.logins.length>100)throw Error('Invalid SSH state');return webTunnelTargets(data.logins);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
const pools=new Map();
const sshIssue=code=>({state:'error',message:({SSH_AUTH:'SSH 认证失败，请检查密码或密钥。',SSH_HOST_KEY:HOST_KEY_RECOVERY_ERROR,SSH_START:'无法启动 SSH 客户端，请检查系统的 OpenSSH 安装。'})[code]||'SSH 隧道未能建立，请检查 SSH 配置。'});
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function freePort(){const s=net.createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p;}
const reachable=port=>new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.setTimeout(200);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});});

// Translate only this loopback origin to the VPS's fixed, trusted loopback origin.
// This keeps its existing Origin checks and works with arbitrary local free ports.
export async function loopbackBridge(upstreamPort,remotePort){
  let origin;const sockets=new Set(),prefix='cmcp_'+randomBytes(12).toString('hex')+'_';
  const headers=req=>{if(req.headers.host!==new URL(origin).host)throw Error('Invalid loopback host');if(req.headers.origin&&req.headers.origin!==origin)throw Error('Invalid loopback origin');const h={...req.headers,host:'127.0.0.1:'+remotePort};for(const k of Object.keys(h))if(/^(forwarded|x-forwarded-|x-real-ip|x-webdesktop-)/i.test(k))delete h[k];if(h.origin)h.origin='http://127.0.0.1:'+remotePort;
    // Cookies ignore TCP ports. Namespace browser cookies so two VPS sessions on
    // 127.0.0.1 cannot overwrite each other; the MCP credential stays tool-only.
    h.cookie=String(h.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(prefix)||v.startsWith('wd_cmcp=')).map(v=>v.startsWith(prefix)?v.slice(prefix.length):v).join('; ');return h;};
  const server=http.createServer((req,res)=>{let h;try{h=headers(req);}catch{res.writeHead(403);res.end();return;}const proxy=http.request({host:'127.0.0.1',port:upstreamPort,agent:false,path:req.url,method:req.method,headers:h},up=>{const out={...up.headers};if(out['set-cookie'])out['set-cookie']=out['set-cookie'].map(v=>prefix+v);if(typeof out.location==='string'&&out.location.startsWith('http://127.0.0.1:'+remotePort+'/'))out.location=origin+out.location.slice(('http://127.0.0.1:'+remotePort).length);res.writeHead(up.statusCode,out);up.pipe(res);});proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());req.pipe(proxy);});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  server.on('upgrade',(req,socket,head)=>{let h;try{h=headers(req);}catch{socket.destroy();return;}const proxy=http.request({host:'127.0.0.1',port:upstreamPort,agent:false,path:req.url,headers:h});proxy.on('upgrade',(up,remote,rest)=>{sockets.add(remote);remote.on('close',()=>sockets.delete(remote));socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(up.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(rest.length)socket.write(rest);if(head.length)remote.write(head);socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());});proxy.on('response',()=>socket.destroy());proxy.on('error',()=>socket.destroy());socket.on('close',()=>proxy.destroy());proxy.end();});
  const port=await listen(server);origin='http://127.0.0.1:'+port;return {origin,close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
export async function acquireWebTunnel({directory,id,login,env=process.env,ssh='ssh',signal,spawnProcess=spawn,knownHostsFile}){
  sshArguments(login);const key=path.resolve(directory)+'\0'+id,revision=sshWebRevision(login);let pool=pools.get(key);
  if(pool&&pool.revision!==revision)throw Error('请先停止此设备的 SSH 隧道，再修改 SSH 信息。');
  if(!pool){pool={revision,refs:0,closed:false,bridges:[],child:null};pool.killAtExit=()=>pool.child?.kill();process.once('exit',pool.killAtExit);pools.set(key,pool);pool.ready=(async()=>{
    const remote=[login.webPort??3000,login.cloudcliPort??3001];if(remote.some(p=>!Number.isInteger(p)||p<1||p>65535)||remote[0]===remote[1])throw Error('WebDesktop 和 CloudCLI 的服务端口必须有效且不同。');
    const local=[await freePort(),await freePort()];for(let i=0;i<2;i++)pool.bridges.push(await loopbackBridge(local[i],remote[i]));
    const args=sshArguments(login,{background:true});args.unshift('-F','none');const at=args.indexOf('ClearAllForwardings=yes');args[at]='ClearAllForwardings=no';args.splice(args.indexOf('--'),0,'-N','-o','ExitOnForwardFailure=yes',...local.flatMap((p,i)=>['-L',`127.0.0.1:${p}:127.0.0.1:${remote[i]}`]));
    const start=()=>{let stderr='';const child=pool.child=spawnSshWithRecovery(ssh,args,{env,windowsHide:true,stdio:['ignore','ignore','pipe']},{login,spawnProcess,knownHostsFile});child.stderr.on('data',c=>stderr=(stderr+c).slice(-8192));const ended=new Promise(resolve=>{child.once('error',()=>resolve('SSH_START'));child.once('exit',()=>resolve(sshExitCode(stderr)));});return {child,ended};};
    let active=start(),failure;active.ended.then(code=>failure=code);const until=Date.now()+90000;
    while(!pool.closed&&!failure&&Date.now()<until){if(await reachable(local[0]))break;await delay(100);}
    if(pool.closed||failure||!await reachable(local[0]))throw Object.assign(Error(failure==='SSH_HOST_KEY'?HOST_KEY_RECOVERY_ERROR:failure==='SSH_AUTH'?'SSH 认证失败，请检查密码或密钥。':'SSH 隧道未能建立，请检查 SSH 配置。'),{code:failure||'SSH_TIMEOUT'});
    pool.background=(async()=>{while(!pool.closed){const code=await active.ended;if(pool.closed)return;if(['SSH_HOST_KEY','SSH_AUTH','SSH_START'].includes(code)){pool.error=code;return;}await delay(3000);if(!pool.closed)active=start();}})();
    return {web:pool.bridges[0].origin,cloudcli:pool.bridges[1].origin};
  })();pool.ready.catch(()=>{if(pools.get(key)===pool)pools.delete(key);pool.closed=true;process.removeListener('exit',pool.killAtExit);pool.child?.kill();for(const b of pool.bridges)b.close().catch(()=>{});});}
  pool.refs++;let released=false,rejectAborted;const cancelled=new Promise((_,reject)=>rejectAborted=reject);const close=async()=>{if(released)return;released=true;signal?.removeEventListener('abort',abort);if(--pool.refs===0){pool.closed=true;if(pools.get(key)===pool)pools.delete(key);process.removeListener('exit',pool.killAtExit);pool.child?.kill();await Promise.allSettled(pool.bridges.map(b=>b.close()));}};const abort=()=>{rejectAborted(signal.reason);close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{if(signal?.aborted)throw signal.reason;const urls=await Promise.race([pool.ready,cancelled]);if(signal?.aborted)throw signal.reason;return {...urls,close,getIssue:()=>pool.error?sshIssue(pool.error):null};}catch(e){await close();throw e;}
}
