import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createSharedSessionGateway} from '../shared-session-gateway.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
import {recoveryPage} from '../web-recovery.mjs';

async function fixture(t,handler,options={}){
  const seen=[],logs=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    seen.push({method:req.method,path:new URL(req.url,'http://fixture').pathname,auth:req.headers['x-desktop-session'],cookie:req.headers.cookie,body:Buffer.concat(chunks).toString()});
    handler(req,res,seen);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const gateway=await createSharedSessionGateway({name:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}`,diagnostic:s=>logs.push(s),httpRecoveryOptions:{delays:[10,20],headerTimeout:200},...options});
  t.after(async()=>{await gateway.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=gateway.localOrigin;
  const claim=await requestBuffered(origin+'/__mcp/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(gateway.launchUrl).hash.slice(1)})});
  const cookie=claim.headers['set-cookie'][0].split(';')[0];
  const browser=(path,opts={})=>requestBuffered(origin+path,{timeout:3000,...opts,headers:{cookie,origin,...opts.headers}});
  return {gateway,origin,cookie,browser,seen,logs};
}

test('GET stylesheet and HEAD survive two resets without leaking credentials into diagnostics',async t=>{
  let n=0;const d=await fixture(t,(req,res)=>{if(++n%3!==0)return req.socket.destroy();res.writeHead(200,{'content-type':'text/css'});res.end('body{color:red}');});
  const css=await d.browser('/_next/static/test.css?access=secret-query');assert.equal(css.status,200);assert.match(css.body.toString(),/color:red/);assert.equal(n,3);
  const head=await d.browser('/head',{method:'HEAD'});assert.equal(head.status,200);assert.equal(n,6);assert.equal(head.body.length,0);
  assert.ok(d.logs.some(s=>s.includes('ECONNRESET')));assert.ok(!d.logs.join('').includes('secret-query'));assert.ok(!d.logs.join('').includes(d.cookie));
});

test('transient upstream statuses retry safe reads while 401/403/429 do not',async t=>{
  let n=0;const d=await fixture(t,(req,res)=>{n++;res.writeHead(req.url==='/transient'?(n<3?503:200):Number(req.url.slice(1)));res.end('fixture');});
  assert.equal((await d.browser('/transient')).status,200);assert.equal(n,3);
  for(const status of [401,403,429]){assert.equal((await d.browser('/'+status)).status,status);}
  assert.equal(n,6);
});

test('mutations and password submissions are never replayed after a lost response',async t=>{
  const d=await fixture(t,(req)=>req.socket.destroy());
  for(const path of ['/api/write','/api/auth/login']){
    assert.equal((await d.browser(path,{method:'POST',body:'{"password":"not-a-log-secret"}',headers:{'content-type':'application/json'}})).status,502);
    assert.equal(d.seen.filter(r=>r.path===path).length,1);
  }
  assert.ok(!d.logs.join('').includes('not-a-log-secret'));
});

test('temporary reads preserve the shared session and never submit the password again',async t=>{
  let reads=0,logins=0;const session='fixture-session-with-enough-characters';
  const d=await fixture(t,(req,res)=>{
    if(req.url==='/api/auth/login'){logins++;res.writeHead(200,{'content-type':'application/json','set-cookie':'wd_session=fixture-cookie'});return res.end(JSON.stringify({sessionId:session}));}
    if(++reads<3)return req.socket.destroy();res.end('ready');
  });
  assert.equal((await d.browser('/api/auth/login',{method:'POST',body:'{"password":"fixture"}',headers:{'content-type':'application/json'}})).status,200);
  assert.equal((await d.browser('/api/sys/info')).status,200);assert.equal(logins,1);assert.equal(d.gateway.getSessionId(),session);
  for(const r of d.seen.slice(1)){assert.equal(r.auth,session);assert.equal(r.cookie,'wd_session=fixture-cookie');}
});

test('a response already streamed to the browser is not replayed',async t=>{
  const d=await fixture(t,(req,res)=>{res.writeHead(200);res.write('partial');setTimeout(()=>res.destroy(),10);});
  await assert.rejects(d.browser('/download'));assert.equal(d.seen.length,1);
});

test('buffered auto-login HTML retries a partial response before injecting the script',async t=>{
  let n=0;const d=await fixture(t,(req,res)=>{res.writeHead(200,{'content-type':'text/html'});if(++n<3){res.write('<html>partial');setTimeout(()=>res.destroy(),5);}else res.end('<html><head></head><body>ready</body></html>');},{autoPassword:async()=>'never-submitted'});
  const response=await d.browser('/',{headers:{accept:'text/html'}});assert.equal(response.status,200);assert.match(response.body.toString(),/__mcp\/autofill.js/);assert.equal(n,3);
});

test('exhausted safe document reads show bounded automatic recovery, not a bare error',async t=>{
  const d=await fixture(t,(req)=>req.socket.destroy());const response=await d.browser('/',{headers:{accept:'text/html'}});
  assert.equal(response.status,503);assert.equal(response.headers['x-cmcp-recovery'],'1');assert.equal(d.seen.length,3);
  const html=response.body.toString();assert.match(html,/正在恢复云电脑连接/);assert.match(html,/limit=6/);assert.match(html,/addEventListener\('online'/);
  assert.doesNotThrow(()=>new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));assert.equal(html,recoveryPage());
});

test('retry timers stop when the browser closes the request',async t=>{
  const d=await fixture(t,(req)=>req.socket.destroy(),{httpRecoveryOptions:{delays:[150,150],headerTimeout:200}});
  const request=http.get(d.origin+'/asset',{headers:{cookie:d.cookie,origin:d.origin}});request.on('error',()=>{});
  while(d.seen.length<1)await delay(5);await delay(25);request.destroy();await delay(350);assert.equal(d.seen.length,1);
});

test('header/TLS stalls have a finite retry budget',async t=>{
  const d=await fixture(t,()=>{},{httpRecoveryOptions:{delays:[5,5],headerTimeout:60}});
  const response=await d.browser('/stall');assert.equal(response.status,502);assert.equal(d.seen.length,3);assert.ok(d.logs.some(s=>s.includes('ETIMEDOUT')));
});

test('certificate and other permanent transport failures are not retried',async t=>{
  let calls=0;const agent=new http.Agent();agent.createConnection=(options,cb)=>{calls++;queueMicrotask(()=>cb(Object.assign(Error('sensitive-url-and-token'),{code:'CERT_HAS_EXPIRED'})));};t.after(()=>agent.destroy());
  const d=await fixture(t,()=>assert.fail('must not reach remote'),{agent});
  assert.equal((await d.browser('/')).status,502);assert.equal(calls,1);assert.ok(!d.logs.join('').includes('sensitive-url-and-token'));
});


function pageHarness(ready=false){
  const timers=new Map(),nodes={message:{textContent:''},retry:{}},events={},calls=[],saved=new Map();let next=0,reloads=0;
  const context={document:{getElementById:id=>nodes[id]},location:{pathname:'/',search:'',reload:()=>reloads++},sessionStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},
    Date,JSON,RegExp,AbortSignal,addEventListener:(name,fn)=>events[name]=fn,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{calls.push({url,options});return {ok:ready,headers:new Map([['content-type','text/html']]),body:{cancel:async()=>{}}};}};
  vm.runInNewContext(recoveryPage().match(/<script>([\s\S]*?)<\/script>/)[1],context);
  const tick=async()=>{const entry=timers.entries().next().value;if(entry){timers.delete(entry[0]);await entry[1]();}};
  return {tick,timers,calls,nodes,events,get reloads(){return reloads;}};
}

test('recovery page resumes automatically after a successful safe probe',async()=>{
  const p=pageHarness(true);await p.tick();assert.equal(p.reloads,1);assert.equal(p.calls.length,1);assert.equal(p.calls[0].options.body,undefined);assert.equal(p.calls[0].options.credentials,'same-origin');
});

test('recovery page stops after six probes and manual retry restarts the bounded budget',async()=>{
  const p=pageHarness();for(let i=0;i<8;i++)await p.tick();assert.equal(p.calls.length,6);assert.equal(p.timers.size,0);assert.match(p.nodes.message.textContent,/点击重试/);
  await p.events.online();await p.tick();assert.equal(p.calls.length,6);
  p.nodes.retry.onclick();await new Promise(r=>setImmediate(r));assert.equal(p.calls.length,7);assert.equal(p.timers.size,1);
});
