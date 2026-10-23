import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createSharedSessionGateway} from '../shared-session-gateway.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
const test=(name,fn)=>nodeTest(name,{timeout:7000},fn);

async function fixture(t,{password='exact 密码 123',provider,loginStatus=200}={}){
  const state={posts:0,reads:0,session:'',logs:[],status:loginStatus};
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"script-src 'nonce-fixturenonce123'"});return res.end('<html><head><script nonce="fixturenonce123"></script></head><body>fixture</body></html>');}
    const chunks=[];for await(const c of req)chunks.push(c);
    if(req.url==='/api/auth/login'){
      state.posts++;await delay(20);const data=JSON.parse(Buffer.concat(chunks));state.received=data.password;
      if(state.status!==200||data.password!==password){res.writeHead(state.status===200?401:state.status,{'content-type':'application/json'});return res.end(JSON.stringify({error:'DO-NOT-FORWARD '+data.password}));}
      state.session='fixture-session-'+state.posts+'-123456';res.writeHead(200,{'set-cookie':'wd_session=test-cookie; HttpOnly; Secure','content-type':'application/json'});return res.end(JSON.stringify({sessionId:state.session}));
    }
    const ok=req.headers.cookie==='wd_session=test-cookie'&&req.headers['x-desktop-session']===state.session;
    res.writeHead(ok?200:401,{'content-type':'application/json'});res.end(JSON.stringify({ok}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const gateway=await createSharedSessionGateway({name:'auto',baseUrl:`http://127.0.0.1:${server.address().port}`,diagnostic:m=>state.logs.push(m),autoPassword:provider===false?undefined:async signal=>{state.reads++;return provider?provider(signal):password;}});
  t.after(async()=>{await gateway.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=gateway.localOrigin;
  const claim=await requestBuffered(origin+'/__mcp/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(gateway.launchUrl).hash.slice(1)})});
  const cookie=claim.headers['set-cookie'][0].split(';')[0];
  const browser=(path,options={})=>requestBuffered(origin+path,{...options,headers:{origin,cookie,...options.headers}});
  const script=await browser('/__mcp/autofill.js');
  const marker=script.status===200?JSON.parse(script.body.toString().match(/"cmcp-auto-[A-Za-z0-9_-]+"/)[0]):'';
  const login=(value=marker)=>browser('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:value})});
  return {state,gateway,origin,browser,login,marker,script,password};
}
test('checked auto uses one real login, returns session to browser and shares both auth values',async t=>{
  const d=await fixture(t);const results=await Promise.all([d.login(),d.login(),d.login()]);
  assert.ok(results.every(r=>r.status===200&&JSON.parse(r.body).sessionId===d.gateway.getSessionId()));
  assert.equal(d.state.posts,1);assert.equal(d.state.reads,1);assert.equal(d.state.received,d.password);
  assert.equal((await d.browser('/api/auth/session')).status,200);
  assert.equal(d.gateway.getSessionAuth().cookie,'wd_session=test-cookie');
  assert.ok(results.every(r=>!r.body.includes(d.password)));assert.ok(!d.script.body.includes(d.password));assert.ok(!d.state.logs.join('').includes(d.password));
});
test('wrong saved password stops after one request across concurrent calls and reloads',async t=>{
  const d=await fixture(t,{loginStatus:401});const a=await d.login();assert.equal(a.status,401);assert.ok(!a.body.includes(d.password));assert.ok(!a.body.includes('DO-NOT-FORWARD'));
  await Promise.all([d.login(),d.login()]);assert.equal(d.state.posts,1);assert.equal(d.state.reads,1);assert.equal(d.gateway.getLoginIssue().state,'password');
  assert.ok(!(await d.browser('/')).body.includes('/__mcp/autofill.js'));
  d.state.status=200;assert.equal((await d.login(d.password)).status,200);assert.equal(d.gateway.getLoginIssue(),null);
});
test('disabled mode injects nothing and never reads a saved secret',async t=>{
  const d=await fixture(t,{provider:false});assert.equal(d.script.status,403);assert.ok(!(await d.browser('/')).body.includes('/__mcp/autofill.js'));assert.equal(d.state.reads,0);assert.equal(d.state.posts,0);
});
test('host, origin and gate checks protect script and sentinel login',async t=>{
  const d=await fixture(t);assert.equal((await requestBuffered(d.origin+'/__mcp/autofill.js')).status,403);
  assert.equal((await d.browser('/__mcp/autofill.js',{headers:{origin:'https://evil.invalid'}})).status,403);
  assert.equal((await d.browser('/api/auth/login',{method:'POST',headers:{origin:'https://evil.invalid','content-type':'application/json'},body:JSON.stringify({password:d.marker})})).status,403);
  assert.equal(d.state.reads,0);assert.equal(d.state.posts,0);
});
test('an obsolete placeholder is never forwarded as a password',async t=>{
  const d=await fixture(t);assert.equal((await d.login('cmcp-auto-'+'x'.repeat(43))).status,409);assert.equal(d.state.posts,0);assert.equal(d.state.reads,0);
  assert.equal((await d.login()).status,200);assert.equal(d.state.posts,1);
});
test('injected script preserves upstream CSP and nonce and contains no credential',async t=>{
  const d=await fixture(t);const page=await d.browser('/');assert.equal(page.headers['content-security-policy'],"script-src 'nonce-fixturenonce123'");
  assert.match(page.body.toString(),/defer src="\/__mcp\/autofill.js" nonce="fixturenonce123"/);assert.ok(!page.body.includes(d.password));
});
test('stop while decrypting prevents delayed credential submission',async t=>{
  let release;const held=new Promise(r=>release=r);const d=await fixture(t,{provider:()=>held});
  const pending=d.login().catch(()=>null);const end=Date.now()+3000;while(!d.state.reads){if(Date.now()>end)throw Error('Decryption fixture did not start');await delay(5);}await d.gateway.close();release(d.password);await pending;await delay(20);assert.equal(d.state.posts,0);
});
test('authoritative session loss cannot make auto mode replace another session',async t=>{
  const d=await fixture(t);await d.login();d.state.session='another-login-session';assert.equal((await d.browser('/api/auth/session')).status,401);
  await d.login();assert.equal(d.state.posts,1);assert.equal(d.gateway.getSessionId(),null);
});
test('manual login before autofill is reused without reading saved password or taking over later',async t=>{
  const d=await fixture(t);await d.login(d.password);await d.login();assert.equal(d.state.posts,1);assert.equal(d.state.reads,0);
  d.gateway.invalidateSession(d.gateway.getSessionId());assert.equal((await d.login()).status,409);assert.equal(d.state.posts,1);assert.equal(d.state.reads,0);
});
test('failed decryption and locked response do not repeat or leak server bodies',async t=>{
  const d=await fixture(t,{provider:()=>{throw Error('private decryption text');}});assert.equal((await d.login()).status,409);await d.login();assert.equal(d.state.reads,1);assert.equal(d.state.posts,0);assert.equal(d.gateway.getLoginIssue().state,'password');
  const locked=await fixture(t,{loginStatus:429});const r=await locked.login();await locked.login();assert.equal(r.status,429);assert.ok(!r.body.includes(locked.password));assert.equal(locked.state.posts,1);assert.equal(locked.gateway.getLoginIssue().state,'locked');
});
