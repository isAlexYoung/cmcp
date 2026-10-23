// Explicit live diagnostic, never run by npm test. JSON credentials arrive on stdin.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {startLink,login,agentFor} from '../link-client.mjs';
import {cloudApi} from '../terminal-link.mjs';
const parts=[];for await(const b of process.stdin)parts.push(b);
const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
const links=[],agents=[],checks=[],states=new Map();let calls=0;
function forward(msg){
  calls++;
  return new Promise((resolve,reject)=>{
    const data=Buffer.from(JSON.stringify(msg));
    const req=http.request({hostname:'127.0.0.1',port:input.local.port,path:'/mcp',method:'POST',headers:{authorization:'Bearer '+input.local.token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26','content-length':data.length}},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(e);}});
    });req.setTimeout(15000,()=>req.destroy(Error('local MCP timeout')));req.on('error',reject);req.end(data);
  });
}
function checkCloud(target,cookie,agent){
  return new Promise((resolve,reject)=>{
    const u=new URL(target.url.replace(/^http/,'ws')+'/api/term/ws');
    u.search=new URLSearchParams({sid:'mcp-verify-'+randomUUID(),cols:'200',rows:'30',cwd:'/home/user',cmd:'python3 "$HOME/.local/share/cloudpc-link/windows-pc-files/connector.py" check --wait 15; exit $?'}).toString();
    const ws=new WebSocket(u,{headers:{cookie},agent,rejectUnauthorized:true,handshakeTimeout:20000});let output='',done=false;
    const end=(error)=>{if(done)return;done=true;clearTimeout(timer);if(ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify({t:'kill'}));ws.close();}else ws.terminate();error?reject(error):resolve(output.match(/Connected: \d+ Windows tools/)?.[0]??'');};
    const timer=setTimeout(()=>end(Error('cloud MCP check timeout')),35000);
    ws.on('message',(raw,binary)=>{if(binary){output+=raw.toString();return;}let m;try{m=JSON.parse(raw);}catch{return;}if(m?.t==='exit')end(m.code===0&&/Connected: \d+ Windows tools/.test(output)?null:Error('cloud MCP check failed'));});
    ws.on('error',()=>end(Error('cloud terminal connection failed')));ws.on('close',()=>end(Error('cloud terminal closed before result')));
  });
}
try{
  for(const t of input.targets){
    const agent=agentFor(t.url,t.proxy||'');agents.push(agent);
    // Retain an independent login and check that MCP login does not invalidate it.
    const browserCookie=await login(t.url,t.password,agent,false);checks.push({target:t,cookie:browserCookie,agent});
    links.push(startLink({name:t.name,machine:input.machine,version:'3.2.1-live-check',target:()=>({url:t.url,password:async()=>t.password,proxy:async()=>t.proxy||''}),forward,askPassword:async()=>false,notify:()=>{},log:()=>{},status:{set(name,state,message){states.set(name,state);console.log(JSON.stringify({name,state,message}));}}}));
  }
  const deadline=Date.now()+60000;
  while(!input.targets.every(t=>states.get(t.name)==='connected')){if(Date.now()>deadline)throw Error('connections did not become ready');await delay(250);}
  for(const c of checks)console.log(c.target.name+': '+await checkCloud(c.target,c.cookie,c.agent));
  console.log('Observing both connections for 60 seconds');await delay(60000);
  for(const c of checks){await cloudApi(c.target.url,c.cookie,c.agent,'/api/sys/info?lite=1');if(states.get(c.target.name)!=='connected')throw Error('connection no longer ready');console.log(c.target.name+': still connected; independent login still valid');}
  console.log('Live MCP requests forwarded: '+calls);
}finally{
  for(const l of links)l.stop();await Promise.allSettled(links.map(l=>l.done));for(const a of agents)a?.destroy();
}
