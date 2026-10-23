// Read-only local browser diagnostic: exposes only public noVNC modules, never
// authenticated cloud APIs, cookies or sessions. Does not log into the cloud.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {requestBuffered} from '../desktop-auth.mjs';
const state=JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA,'ClaudeLocalMcp','browser-entries.json'),'utf8'));
const entry=state.targets.find(t=>new URL(t.url).origin===new URL(process.argv[2]).origin);
if(!entry)throw Error('Shared gateway entry missing');
const launch=new URL(entry.launchUrl);
if(launch.protocol!=='http:'||launch.hostname!=='127.0.0.1'||launch.pathname!=='/__mcp/open')throw Error('Invalid entry');
const claim=await requestBuffered(launch.origin+'/__mcp/claim',{method:'POST',headers:{origin:launch.origin,'content-type':'application/json'},body:JSON.stringify({token:launch.hash.slice(1)})});
if(claim.status!==204)throw Error('Entry expired');
const headers={origin:launch.origin,cookie:claim.headers['set-cookie'][0].split(';')[0]};
const failures=[];
let count=0;
const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(421);return res.end();}
  if(req.method!=='GET'){res.writeHead(405);return res.end();}
  if(req.url==='/'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    return res.end(`<!doctype html><meta charset="utf-8"><title>云电脑显示组件检查</title><h1>云电脑显示组件检查</h1><pre id="result">正在加载 noVNC…</pre><script type="module">const result=document.getElementById('result');try{const m=await import('/novnc/core/rfb.js');result.textContent='PASS: noVNC loaded; RFB='+typeof m.default+'; secureContext='+window.isSecureContext}catch(e){result.textContent='FAIL: '+e.name+': '+e.message+'; secureContext='+window.isSecureContext}</script>`);
  }
  if(!/^\/novnc\/[A-Za-z0-9_./-]+\.js$/.test(req.url)||req.url.includes('..')){res.writeHead(404);return res.end();}
  try{
    const reply=await requestBuffered(launch.origin+req.url,{headers,limit:2*1024*1024,timeout:30000});
    count++;
    if(reply.status!==200){failures.push({path:req.url,status:reply.status});console.log(JSON.stringify(failures.at(-1)));}
    res.writeHead(reply.status,{'content-type':reply.headers['content-type']||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(reply.body);
  }catch{failures.push({path:req.url,status:502});console.log(JSON.stringify(failures.at(-1)));res.writeHead(502);res.end();}
});
server.listen(0,'127.0.0.1',()=>console.log('DIAGNOSTIC_URL=http://127.0.0.1:'+server.address().port+'/'));
setTimeout(()=>{console.log(JSON.stringify({count,failures}));server.closeAllConnections();server.close();},180000).unref();
