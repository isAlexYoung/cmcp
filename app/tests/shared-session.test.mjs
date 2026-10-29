import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket, {WebSocketServer} from 'ws';
import {createSharedSessionGateway} from '../shared-session-gateway.mjs';
import {requestBuffered,requiresSharedSession} from '../desktop-auth.mjs';
import {startLink,login} from '../link-client.mjs';
import {cloudApi} from '../terminal-link.mjs';

async function until(check, timeout=7000) { const end=Date.now()+timeout; while(!check()){if(Date.now()>end)throw Error('condition timeout');await delay(10);} }
async function fixture(t, {cookieRequired=false}={}) {
  const state={session:'',logins:0,requests:[],sockets:[],sessionStatus:200,failedUpgrade:0};
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://upstream');
    state.requests.push({path:u.pathname,cookie:req.headers.cookie,auth:req.headers['x-desktop-session']});
    const chunks=[];for await(const c of req)chunks.push(c);
    res.setHeader('content-type','application/json');
    if(u.pathname==='/api/auth/login') {
      state.logins++;
      const {password}=JSON.parse(Buffer.concat(chunks));
      await delay(25);
      if(!['correct','new-password'].includes(password)){res.writeHead(401);return res.end('{"error":"wrong password"}');}
      state.session=randomBytes(24).toString('hex');
      if (cookieRequired) res.setHeader('set-cookie','wd_session=fixture-cookie; Path=/; HttpOnly; Secure; SameSite=Strict');
      return res.end(JSON.stringify({sessionId:state.session}));
    }
    if(u.pathname==='/api/auth/session') {
      const ok=state.session && req.headers['x-desktop-session']===state.session && (!cookieRequired || req.headers.cookie==='wd_session=fixture-cookie');
      if (!ok && state.holdUnauthorized) { state.unauthorizedPending=true; await state.holdUnauthorized; }
      res.writeHead(ok?state.sessionStatus:401);
      return res.end(JSON.stringify(ok?{ok:true}:{error:'其他设备已登录或登录已过期，请重新输入密码'}));
    }
    if(u.pathname==='/redirect') {res.writeHead(302,{location:'https://unrelated.invalid/?access=secret'});return res.end();}
    res.end(JSON.stringify({ok:true}));
  });
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    if(state.failedUpgrade>0){state.failedUpgrade--;socket.destroy();return;}
    if (state.rejectSockets) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    const auth=new URL(req.url,'http://test').searchParams.get('access');
    if(auth!==state.session || req.headers['x-desktop-session']!==state.session || (cookieRequired && req.headers.cookie!=='wd_session=fixture-cookie')){socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');return;}
    assert.equal(req.headers.cookie,cookieRequired?'wd_session=fixture-cookie':undefined);
    wss.handleUpgrade(req,socket,head,ws=>{
      state.sockets.push(ws);
      ws.on('message',raw=>{let m;try{m=JSON.parse(raw);}catch{};ws.send(m?.t==='hello'?JSON.stringify({t:'welcome'}):raw,{binary:false});});
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  const gateway=await createSharedSessionGateway({name:'test',baseUrl:url});
  const origin=gateway.localOrigin;
  const token=new URL(gateway.launchUrl).hash.slice(1);
  const claim=await requestBuffered(origin+'/__mcp/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})});
  assert.equal(claim.status,204);
  const cookie=claim.headers['set-cookie'][0].split(';')[0];
  const browser=(p,options={})=>requestBuffered(origin+p,{...options,headers:{cookie,origin,...options.headers}});
  const signIn=(password='correct')=>browser('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
  t.after(async()=>{await gateway.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {state,server,gateway,url,origin,cookie,browser,signIn};
}

test('browser refresh and concurrent logins reuse one session; wrong password does not reveal it', {timeout:6000}, async t=>{
  const d=await fixture(t);
  const results=await Promise.all([d.signIn(),d.signIn(),d.signIn()]);
  assert.equal(d.state.logins,1);
  assert.ok(results.every(r=>JSON.parse(r.body).sessionId===d.gateway.getSessionId()));
  await d.signIn();assert.equal(d.state.logins,1);
  const wrong=await d.signIn('wrong');assert.equal(wrong.status,401);
  assert.ok(!wrong.body.includes(d.gateway.getSessionId()));
  assert.equal((await d.browser('/api/auth/session')).status,200);
  assert.ok(d.state.requests.every(r=>r.cookie===undefined));
});

test('loopback gate blocks foreign hosts, origins, paths, redirects and unauthenticated access', async t=>{
  const d=await fixture(t);
  assert.equal((await requestBuffered(d.origin+'/api/sys/info')).status,403);
  assert.equal((await d.browser('/api/sys/info',{headers:{host:'evil.invalid'}})).status,421);
  assert.equal((await d.browser('/api/sys/info',{headers:{origin:'https://evil.invalid'}})).status,403);
  assert.equal((await d.browser('//evil.invalid/path')).status,400);
  assert.equal((await d.browser('/redirect')).status,502);
  const launch=await d.browser('/__mcp/open');assert.equal(launch.status,200);
  assert.match(launch.body.toString(),/history.replaceState/);
  assert.ok(!d.state.requests.some(r=>r.path.startsWith('/__mcp')));
  await assert.rejects(cloudApi(d.url,{sessionId:'test-session-123456'},undefined,'https://evil.invalid/api/sys/info'));
});

test('temporary session checks never trigger another login; expiration waits for browser', async t=>{
  const d=await fixture(t);await d.signIn();
  d.state.sessionStatus=503;
  assert.equal((await d.signIn()).status,503);assert.equal(d.state.logins,1);
  d.state.sessionStatus=200;d.state.session='external-login-session';
  assert.equal((await d.browser('/api/auth/session')).status,401);
  assert.equal(d.gateway.getSessionId(),null);
  await delay(200);assert.equal(d.state.logins,1);
  await d.signIn();assert.equal(d.state.logins,2);
});

test('browser and MCP sockets share authentication; reconnect and session changes never log in', {timeout:12000}, async t=>{
  const d=await fixture(t);await d.signIn();
  const browserSocket=new WebSocket(d.origin.replace('http:','ws:')+'/api/browser/ws',{headers:{origin:d.origin,cookie:d.cookie}});
  await once(browserSocket,'open');t.after(()=>browserSocket.terminate());
  const echoed=once(browserSocket,'message');browserSocket.send('browser-ready');assert.equal((await echoed)[0].toString(),'browser-ready');
  const states=[],logs=[];d.state.failedUpgrade=1;
  const link=startLink({name:'shared',machine:'test',version:'test',
    target:()=>({url:d.url,authMode:'shared-browser',getSessionId:d.gateway.getSessionId,invalidateSession:d.gateway.invalidateSession,proxy:async()=>'',password:()=>{throw Error('must never read password');}}),
    forward:async()=>null,askPassword:()=>{throw Error('must not ask password');},notify:()=>{},status:{set:(n,s)=>states.push(s)},log:s=>logs.push(s)});
  t.after(async()=>{link.stop();await link.done;});
  await until(()=>states.at(-1)==='connected');assert.equal(d.state.logins,1);
  const first=d.gateway.getSessionId();await d.signIn('new-password');
  await until(()=>states.filter(s=>s==='connected').length===2);
  assert.equal(d.state.logins,2);assert.notEqual(d.gateway.getSessionId(),first);
  d.gateway.invalidateSession(d.gateway.getSessionId());
  await until(()=>states.at(-1)==='waiting-login');await delay(1200);assert.equal(d.state.logins,2);
  assert.ok(!logs.some(s=>s.includes(first)||s.includes('access=')));
});

test('modern desktop detection and background login guard use GET only', async t=>{
  const d=await fixture(t);
  assert.equal(await requiresSharedSession(d.url),true);
  await assert.rejects(login(d.url,'correct'),e=>e.kind==='shared');
  assert.equal(d.state.logins,0);
});

test('a delayed 401 from an old session cannot invalidate a later browser login', {timeout:5000}, async t=>{
  const d=await fixture(t);await d.signIn();
  d.state.session='external-session';
  let release;d.state.holdUnauthorized=new Promise(resolve=>{release=resolve;});
  const oldCheck=d.browser('/api/auth/session');
  await until(()=>d.state.unauthorizedPending);
  await d.signIn('new-password');
  const newer=d.gateway.getSessionId();
  release();assert.equal((await oldCheck).status,401);
  assert.equal(d.gateway.getSessionId(),newer);
  assert.equal((await d.browser('/api/auth/session')).status,200);
});

test('a rejected browser socket cannot clear the shared session', {timeout:5000}, async t=>{
  const d=await fixture(t);await d.signIn();d.state.rejectSockets=true;
  const before=d.gateway.getSessionId();
  const ws=new WebSocket(d.origin.replace('http:','ws:')+'/api/legacy/ws',{headers:{origin:d.origin,cookie:d.cookie}});
  ws.on('error',()=>{});t.after(()=>ws.terminate());
  const code=await new Promise(resolve=>ws.once('unexpected-response',(req,res)=>{res.resume();resolve(res.statusCode);ws.terminate();}));
  assert.equal(code,401);
  assert.equal(d.gateway.getSessionId(),before);
  assert.equal((await d.browser('/api/auth/session')).status,200);
  assert.equal(d.state.logins,1);
});

test('MCP preserves a session when validation is unavailable and clears it only on authoritative 401', {timeout:8000}, async t=>{
  const d=await fixture(t);await d.signIn();d.state.rejectSockets=true;d.state.sessionStatus=503;
  const before=d.gateway.getSessionId(),states=[];
  const link=startLink({name:'shared',machine:'test',version:'test',
    target:()=>({url:d.url,authMode:'shared-browser',getSessionId:d.gateway.getSessionId,invalidateSession:d.gateway.invalidateSession,proxy:async()=>''}),
    forward:async()=>null,askPassword:()=>{throw Error('must not log in');},notify:()=>{},log:()=>{},status:{set:(n,s)=>states.push(s)}});
  t.after(async()=>{link.stop();await link.done;});
  await until(()=>states.at(-1)==='offline');
  assert.equal(d.gateway.getSessionId(),before);assert.equal(d.state.logins,1);
  d.state.sessionStatus=401;
  await until(()=>states.at(-1)==='waiting-login');
  assert.equal(d.gateway.getSessionId(),null);assert.equal(d.state.logins,1);
});

test('PC link takeover stops reconnection without invalidating browser login', {timeout:5000}, async t=>{
  const d=await fixture(t);await d.signIn();
  const before=d.gateway.getSessionId(),states=[];
  const link=startLink({name:'shared',machine:'test',version:'test',
    target:()=>({url:d.url,authMode:'shared-browser',getSessionId:d.gateway.getSessionId,invalidateSession:d.gateway.invalidateSession,proxy:async()=>''}),
    forward:async()=>null,askPassword:()=>{throw Error('must not log in');},notify:()=>{},log:()=>{},status:{set:(n,s)=>states.push(s)}});
  t.after(async()=>{link.stop();await link.done;});
  await until(()=>states.at(-1)==='connected');
  d.state.sockets[0].close(4002,'reconnected');await link.done;
  assert.equal(states.at(-1),'replaced');assert.equal(d.gateway.getSessionId(),before);
  assert.equal((await d.browser('/api/auth/session')).status,200);assert.equal(d.state.logins,1);
});

test('dual authentication shares the upstream cookie and page session across browser and MCP', {timeout:7000}, async t=>{
  const d=await fixture(t,{cookieRequired:true});
  const response=await d.signIn();
  assert.equal(response.headers['set-cookie'],undefined);
  assert.equal((await d.browser('/api/auth/session')).status,200);
  assert.equal((await cloudApi(d.url,d.gateway.getSessionAuth(),undefined,'/api/auth/session')).ok,true);
  const browserWs=new WebSocket(d.origin.replace('http:','ws:')+'/api/browser/ws',{headers:{origin:d.origin,cookie:d.cookie}});
  await once(browserWs,'open');t.after(()=>browserWs.terminate());
  const states=[];let connectedAuth;
  const link=startLink({name:'shared',machine:'test',version:'test',
    target:()=>({url:d.url,authMode:'shared-browser',getSessionId:d.gateway.getSessionId,getSessionAuth:d.gateway.getSessionAuth,invalidateSession:d.gateway.invalidateSession,proxy:async()=>''}),
    onConnected:auth=>{connectedAuth=auth;},forward:async()=>null,askPassword:()=>{throw Error('must not log in');},notify:()=>{},log:()=>{},status:{set:(n,s)=>states.push(s)}});
  t.after(async()=>{link.stop();await link.done;});
  await until(()=>states.at(-1)==='connected');
  assert.equal(connectedAuth.cookie,'wd_session=fixture-cookie');
  await d.signIn();assert.equal(d.state.logins,1);
  assert.ok(d.state.requests.every(r=>!r.cookie || r.cookie==='wd_session=fixture-cookie'));
  d.gateway.invalidateSession(d.gateway.getSessionId());assert.equal(d.gateway.getSessionAuth(),null);
});

test('proxied documents permit same-origin download referrers and bootstrap retains no-referrer', async t=>{
  const d=await fixture(t);
  const page=await d.browser('/');assert.equal(page.headers['referrer-policy'],'same-origin');
  const launch=await d.browser('/__mcp/open');assert.equal(launch.headers['referrer-policy'],'no-referrer');
  assert.match(launch.body.toString(),/name="referrer" content="no-referrer"/);
});
