import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import WebSocket,{WebSocketServer} from 'ws';
import {loopbackBridge,acquireWebTunnel,webTunnelTargets,tunnelIdentity,sshWebRevision} from '../ssh-web.mjs';

async function serve(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return s;}
test('SSH web profiles keep independent scopes and validate remote ports',async t=>{
  assert.equal(sshWebRevision({host:'a',active:true,label:'old'}),sshWebRevision({host:'a',active:false,label:'new'}),'switching applications and editing appearance never reconnects a tunnel');
  const {managedTargetFactory}=await import('../managed-target.mjs');const server=await serve(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}');}),origin='http://127.0.0.1:'+server.address().port,controller=new AbortController();let closed=0;
  const create=managedTargetFactory({proxyFor:()=>assert.fail('loopback tunnel traffic must not reach an external proxy'),openTunnel:async()=>({web:origin,getIssue:()=>null,close:async()=>closed++}),machine:'test',version:'test',forward:async()=>null,askPassword:async()=>false,notify:()=>{},log:()=>{},passwordFor:async()=>''});const record=await create({name:'tunnel:web:device',url:origin,authMode:'shared-browser',tunnel:{id:'device',app:'web'}},{signal:controller.signal,current:()=>true,status:{set(){}}});await record.stop();assert.equal(closed,1);
  const login={name:'device',webTunnel:true,cloudcliTunnel:true,webPort:3000,cloudcliPort:3001,cloudcliAutoLogin:true};const targets=webTunnelTargets([login]);assert.deepEqual(targets.map(t=>t.name),['tunnel:web:device','tunnel:cloudcli:device']);assert.equal(targets[0].autoLogin,false);assert.equal(targets[1].autoLogin,true);assert.deepEqual(tunnelIdentity(targets[1].name),{id:'device',app:'cloudcli'});assert.throws(()=>webTunnelTargets([{...login,webPort:0}]));
});
test('loopback forwarding preserves trusted origins, isolates per-device cookies and rejects foreign origins',async t=>{
  const seen=[],s=await serve(t,(req,res)=>{seen.push(req.headers);res.writeHead(200,{'set-cookie':['wd_session=fixture; HttpOnly; SameSite=Lax; Path=/']});res.end('ok');});
  const a=await loopbackBridge(s.address().port,3000),b=await loopbackBridge(s.address().port,3000);t.after(()=>Promise.all([a.close(),b.close()]));
  const first=await fetch(a.origin,{headers:{origin:a.origin,'x-webdesktop-https':'1','x-forwarded-host':'evil'}}),cookie=first.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^cmcp_[a-f0-9]+_wd_session=/);await fetch(a.origin,{headers:{cookie,origin:a.origin}});assert.equal(seen[1].cookie,'wd_session=fixture');assert.equal(seen[1].host,'127.0.0.1:3000');assert.equal(seen[1].origin,'http://127.0.0.1:3000');assert.equal(seen[0]['x-webdesktop-https'],undefined);await fetch(b.origin,{headers:{cookie}});assert.equal(seen[2].cookie,'');assert.equal((await fetch(a.origin,{headers:{origin:'https://evil.test'}})).status,403);
});
test('WebSocket traffic uses the same tunnel and stops when its bridge closes',async t=>{
  const s=await serve(t,(_req,res)=>res.end()),wss=new WebSocketServer({server:s});t.after(()=>new Promise(r=>wss.close(r)));let origin;wss.on('connection',(ws,req)=>{origin=req.headers.origin;ws.on('message',v=>ws.send(v));});
  const b=await loopbackBridge(s.address().port,3000);const ws=new WebSocket(b.origin.replace('http:','ws:'),{origin:b.origin});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});const reply=new Promise(r=>ws.once('message',v=>r(String(v))));ws.send('mcp-fixture');assert.equal(await reply,'mcp-fixture');assert.equal(origin,'http://127.0.0.1:3000');const closed=new Promise(r=>ws.once('close',r));await b.close();await closed;
});
test('one device reuses its SSH process for both webpages and releases it only after both stop',async t=>{
  const s=await serve(t,(_req,res)=>res.end('through SSH')),login={host:'example.test',port:22,username:'user',method:'password',webPort:s.address().port,cloudcliPort:s.address().port+1};let starts=0,kills=0,args;const forwards=[];
  const spawnProcess=(_exe,argv)=>{starts++;args=argv;const child=new EventEmitter();child.stderr=new PassThrough();for(let i=0;i<argv.length;i++)if(argv[i]==='-L'){const [,p,,remote]=argv[i+1].split(':');const f=net.createServer(socket=>{const up=net.connect(Number(remote),'127.0.0.1');socket.pipe(up).pipe(socket);socket.on('error',()=>up.destroy());up.on('error',()=>socket.destroy());socket.on('close',()=>up.destroy());up.on('close',()=>socket.destroy());});f.listen(Number(p),'127.0.0.1');forwards.push(f);}child.kill=()=>{kills++;for(const f of forwards)f.close();child.emit('exit',0);};return child;};
  const opts={directory:'test-state',id:'test-device',login,spawnProcess},a=await acquireWebTunnel(opts),b=await acquireWebTunnel(opts);assert.equal(starts,1);assert.equal(a.web,b.web);assert.ok(args.includes('-N'));assert.ok(args.includes('ForwardAgent=no'));assert.equal(await(await fetch(a.web)).text(),'through SSH');await a.close();assert.equal(kills,0);assert.equal(await(await fetch(b.web)).text(),'through SSH');await b.close();assert.equal(kills,1);
});
test('cancelling a pending SSH tunnel returns immediately and never starts it again',async()=>{
  const controller=new AbortController();let starts=0;const spawnProcess=()=>{starts++;const child=new EventEmitter();child.stderr=new PassThrough();child.kill=()=>child.emit('exit',0);return child;};
  const promise=acquireWebTunnel({directory:'test-pending',id:'device',login:{host:'example.test',port:22,username:'user',method:'password'},spawnProcess,signal:controller.signal});setTimeout(()=>controller.abort(),40);await assert.rejects(promise,{name:'AbortError'});assert.ok(starts<=1);
});
test('bad SSH credentials pause automatic factory retries until the user reconnects',async()=>{
  const {createTargetConnections}=await import('../target-connections.mjs');let starts=0;const target={name:'tunnel:web:device',url:'http://127.0.0.1:3000'},controls=new Map([[target.name,{enabled:true,revision:'1'}]]),status=[];
  const c=createTargetConnections({readTargets:()=>[target],readControls:()=>controls,status:{set:(_n,state,msg)=>status.push([state,msg])},retryMs:1,interval:5,create:async()=>{starts++;throw Object.assign(Error('auth'),{code:'SSH_AUTH'});}});
  try{await new Promise(r=>setTimeout(r,70));assert.equal(starts,1);assert.ok(status.some(([s,m])=>s==='error'&&m.includes('SSH')));controls.get(target.name).revision='2';c.tick();await new Promise(r=>setTimeout(r,30));assert.equal(starts,2);}finally{await c.close();}
});
