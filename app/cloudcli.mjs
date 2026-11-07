import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {requestBuffered} from './desktop-auth.mjs';

export const cloudcliName=id=>'cloudcli:'+id;
export function cloudcliOrigin(value){
  const url=new URL(value);
  if(!(url.protocol==='https:'&&!url.port||url.protocol==='http:'&&url.hostname==='127.0.0.1')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('请输入完整的 CloudCLI HTTPS 地址，不含路径或登录信息。');
  return url.origin;
}
export async function discoverCloudcli(url,agent,signal){
  const origin=cloudcliOrigin(url),r=await requestBuffered(new URL('/api/auth/cmcp',origin),{agent,signal,timeout:10000,limit:16384});
  let data;try{data=JSON.parse(r.body);}catch{}
  // A CloudCLI installed without WebDesktop answers with its own page or an auth error, never a cmcp- protocol.
  // Its tools then go through the device's SSH channel instead (selfHosted).
  const selfHosted=[200,401,403,404].includes(r.status)&&!(typeof data?.protocol==='string'&&data.protocol.startsWith('cmcp-'));
  if(r.status!==200||data?.protocol!=='cmcp-cloudcli'||data.version!==1)throw Object.assign(Error('CloudCLI 尚未提供 CMCP 登录接口，请升级 VPS 上的 WebDesktop。'),{code:'CLOUDCLI_PROTOCOL_REQUIRED',selfHosted});
  const desktopOrigin=cloudcliOrigin(data.desktopOrigin);
  if(new URL(origin).protocol==='https:'&&new URL(desktopOrigin).protocol!=='https:')throw Error('CloudCLI 的工具连接地址必须使用 HTTPS。');
  return {origin,desktopOrigin};
}
// Windows stores only DPAPI ciphertext here; macOS stores only a Keychain reference.
export function readCloudcliLogins(directory){
  const file=path.join(directory,'cloudcli-logins.json');let value;
  try{const meta=fs.lstatSync(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.size>1024*1024)throw Error('Invalid CloudCLI state');value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(value?.schema!==1||!Array.isArray(value.logins)||value.logins.length>100)throw Error('Invalid CloudCLI state');
  const seen=new Set();return value.logins.map(login=>{const id=login.id??login.name;if(typeof id!=='string'||!id||id.length>480||seen.has(id)||typeof login.autoLogin!=='boolean')throw Error('Invalid CloudCLI login');seen.add(id);return {...login,id,url:cloudcliOrigin(login.url)};});
}
export function cloudcliTargets(logins){return logins.map(l=>({name:cloudcliName(l.id??l.name),url:l.url,authMode:'cloudcli',autoLogin:l.autoLogin===true,stamp:JSON.stringify([l.url,l.autoLogin,l.secret,l.credentialId])}));}

// What each device's CloudCLI turned out to be: 'webdesktop' (CMCP sign-in through WebDesktop) or
// 'self-hosted' (installed by other means; tools go through the SSH channel). Written by the
// backend when it probes and by the setup action; the windows only read it.
export const SELF_HOSTED='self-hosted',WEBDESKTOP='webdesktop';
export function readCloudcliKinds(directory){
  const file=path.join(directory,'cloudcli-kinds.json');
  try{const meta=fs.lstatSync(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>256*1024)return {};const value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));
    if(value?.schema!==1||!value.kinds||typeof value.kinds!=='object'||Array.isArray(value.kinds))return {};
    return Object.fromEntries(Object.entries(value.kinds).filter(([id,kind])=>id.length<=480&&[SELF_HOSTED,WEBDESKTOP].includes(kind)));
  }catch{return {};}
}
export function recordCloudcliKind(directory,id,kind){
  if(typeof id!=='string'||!id||id.length>480||/[\x00-\x1f]/.test(id)||![SELF_HOSTED,WEBDESKTOP].includes(kind))throw Error('Invalid CloudCLI kind');
  const kinds=readCloudcliKinds(directory);if(kinds[id]===kind)return false;
  const file=path.join(directory,'cloudcli-kinds.json'),temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify({schema:1,kinds:{...kinds,[id]:kind}}),{flag:'wx',mode:0o600});
    // A window reading the file can briefly hold it on Windows; the next probe writes it again.
    try{fs.renameSync(temporary,file);}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;return false;}
  }finally{try{fs.unlinkSync(temporary);}catch{}}
  return true;
}
// The device id behind a backend connection name: cloudcli:<id> or tunnel:cloudcli:<id>.
export const cloudcliDevice=name=>/^(?:tunnel:)?cloudcli:(.+)$/.exec(name)?.[1]||null;

// A local entrance for a self-hosted CloudCLI. It only sends the browser on to the page; the
// sign-in is CloudCLI's own. Same /__mcp/open shape as the WebDesktop entrance, so every opener works.
export async function createLaunchPage({url}){
  const remote=new URL(url);if(!['https:','http:'].includes(remote.protocol)||remote.protocol==='http:'&&remote.hostname!=='127.0.0.1'||remote.username||remote.password)throw Error('Invalid CloudCLI address');
  const token=randomBytes(32).toString('base64url');let origin;
  const reply=(res,status,body)=>{const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);};
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(origin).host)return reply(res,421,{error:'Invalid host'});
      if(req.method==='GET'&&req.url==='/__mcp/open'){
        const body=Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>正在打开 CloudCLI</title><p id="message">正在打开 CloudCLI…</p><script>(async()=>{const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{const r=await fetch('/__mcp/direct',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(v.error);location.replace(v.url);}catch(e){document.querySelector('#message').textContent=e.message||'CloudCLI 暂时无法打开';}})();</script>`);
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':body.length,'cache-control':'no-store','referrer-policy':'no-referrer',
          'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});return res.end(body);
      }
      if(req.method!=='POST'||req.url!=='/__mcp/direct')return reply(res,404,{error:'Not found'});
      if(req.headers.origin!==origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(res,403,{error:'Browser entry required'});
      const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>512){reply(res,413,{error:'Too large'});req.destroy();return;}chunks.push(c);}
      const given=Buffer.from(String(JSON.parse(Buffer.concat(chunks)).token||'')),expected=Buffer.from(token);
      if(given.length!==expected.length||!timingSafeEqual(given,expected))return reply(res,403,{error:'Browser entry required'});
      reply(res,200,{url:remote.href});
    }catch{if(!res.headersSent&&!res.destroyed)reply(res,400,{error:'CloudCLI 暂时无法打开'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.on('clientError',(_e,s)=>s.destroy());
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  return {launchUrl:origin+'/__mcp/open#'+token,getSessionId:()=>null,getSessionAuth:()=>null,getLoginIssue:()=>null,invalidateSession(){},
    async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
