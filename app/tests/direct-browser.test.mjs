import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createDirectBrowser,supportsDirectBrowser} from '../direct-browser.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
async function until(check){for(let i=0;i<150&&!check();i++)await delay(10);assert.ok(check());}
async function fixture(t,{password='saved-password',automatic=true,provider,capability=1}={}){
  const records=new Map(),state={passwordReads:0,passwordPosts:0,logins:0,requests:[],drop:false,replaced:false};
  const server=http.createServer(async(req,res)=>{
    state.requests.push({method:req.method,path:req.url});
    if(req.method==='GET'){res.writeHead(capability===0?404:capability===503?503:200,{'content-type':'application/json'});return res.end(JSON.stringify({protocol:'cmcp-direct',version:capability}));}
    const chunks=[];for await(const c of req)chunks.push(c);const b=JSON.parse(Buffer.concat(chunks));state.last=b;
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    let r=records.get(b.id);
    if(b.op==='prepare'){
      if(b.password!==undefined)state.passwordPosts++;
      if(r&&state.replaced)return reply(409,{code:'SESSION_REPLACED'});
      if(r&&r.launch===b.launch)return reply(200,{ok:true,...(r.ready?{sessionId:r.sessionId,cookie:r.cookie}:{})});
      if(b.password!==undefined&&b.password!==password)return reply(401,{code:'PASSWORD_REJECTED'});
      r||={control:digest(b.control),sessionId:'fixture-session-123456789',cookie:'wd_cmcp=fixture-token'};
      if(!r.ready&&b.password!==undefined){r.ready=true;state.logins++;}r.launch=b.launch;records.set(b.id,r);
      if(state.drop){state.drop=false;res.destroy();return;}return reply(200,{ok:true,...(r.ready?{sessionId:r.sessionId,cookie:r.cookie}:{})});
    }
    if(!r)return reply(410,{});
    if(b.op==='stop'){records.delete(b.id);return reply(200,{ok:true});}
    if(b.op==='poll')return reply(state.replaced?409:200,r.ready?{sessionId:r.sessionId,cookie:r.cookie}:{pending:true});
    return reply(400,{});
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const gate=await createDirectBrowser({baseUrl:base,pollMs:25,autoPassword:automatic?async signal=>{state.passwordReads++;return provider?provider(signal):password;}:undefined});
  t.after(async()=>{await gate.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const open=(headers={},token=new URL(gate.launchUrl).hash.slice(1))=>requestBuffered(gate.localOrigin+'/__mcp/direct',{method:'POST',headers:{origin:gate.localOrigin,'content-type':'application/json',...headers},body:JSON.stringify({token})});
  return {base,gate,state,records,open};
}
test('capability detection falls back only on unsupported servers; outage/version mismatch is visible',async t=>{
  for(const capability of [0,1,2,503]){const d=await fixture(t,{capability});if(capability===0)assert.equal(await supportsDirectBrowser(d.base),false);else if(capability===1)assert.equal(await supportsDirectBrowser(d.base),true);else await assert.rejects(supportsDirectBrowser(d.base));}
});
test('local entry never forwards webpages/APIs and checks secret, host and browser origin before reading passwords',async t=>{
  const d=await fixture(t);await delay(40);assert.equal(d.state.passwordReads,0);assert.equal(d.state.requests.length,0);
  assert.equal((await d.open({origin:'https://evil.test'})).status,403);assert.equal((await d.open({},'bad-token')).status,403);
  assert.equal((await d.open({},'密'.repeat(43))).status,403);
  assert.equal((await d.open({host:'evil.test'})).status,421);
  for(const path of ['/','/api/gui/ws','/api/sys/download'])assert.equal((await requestBuffered(d.gate.localOrigin+path)).status,404);
  assert.equal(d.state.passwordReads,0);assert.equal(d.state.requests.length,0);
});
test('automatic login opens the remote origin with only a fragment ticket, retaining tools locally',async t=>{
  const d=await fixture(t);const r=await d.open();assert.equal(r.status,200);const u=new URL(JSON.parse(r.body).url);
  assert.equal(u.origin,d.base);assert.equal(u.pathname,'/');assert.equal(u.search,'');assert.match(u.hash,/^#cmcp=[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!r.body.includes('saved-password'));assert.equal(d.state.passwordReads,1);assert.equal(d.state.logins,1);
  assert.deepEqual(d.gate.getSessionAuth(),{sessionId:'fixture-session-123456789',cookie:'wd_cmcp=fixture-token'});
});
test('manual login never reads a saved password; tools become ready after the browser signs in',async t=>{
  const d=await fixture(t,{automatic:false});assert.equal((await d.open()).status,200);assert.equal(d.state.passwordReads,0);assert.equal(d.gate.getSessionId(),null);
  [...d.records.values()][0].ready=true;await until(()=>d.gate.getSessionId());assert.equal(d.state.passwordPosts,0);
});
test('reopening an active desktop does not log in again or expose a password',async t=>{
  const d=await fixture(t);const first=JSON.parse((await d.open()).body).url;const second=JSON.parse((await d.open()).body).url;
  assert.notEqual(first,second);assert.equal(d.state.logins,1);assert.equal(d.state.passwordReads,1);assert.equal(d.state.last.password,undefined);
});
test('a lost preparation response retries the same request without a second password read or desktop login',async t=>{
  const d=await fixture(t);d.state.drop=true;assert.equal((await d.open()).status,503);const lost=d.state.last;
  assert.equal((await d.open()).status,200);assert.equal(d.gate.getSessionId(),'fixture-session-123456789');assert.equal(d.state.passwordReads,1);assert.equal(d.state.logins,1);
  assert.ok(d.records.has(lost.id));assert.equal(d.records.size,1);
});
test('a rejected automatic password is submitted once and falls back to manual browser login',async t=>{
  const d=await fixture(t,{provider:async()=> 'wrong-password'});assert.equal((await d.open()).status,200);
  assert.equal(d.state.passwordPosts,1);assert.equal(d.state.logins,0);assert.equal(d.gate.getLoginIssue().state,'password');
});
test('session takeover is not fought by background polling; explicit Open may sign in again',async t=>{
  const d=await fixture(t);await d.open();d.state.replaced=true;d.gate.invalidateSession(d.gate.getSessionId());await until(()=>d.gate.getLoginIssue()?.state==='waiting-login');
  await delay(80);assert.equal(d.state.passwordReads,1);assert.equal(d.state.logins,1);
  assert.equal((await d.open()).status,200);assert.equal(d.state.passwordReads,2);assert.equal(d.state.logins,2);
});
test('stop while decrypting never submits the delayed password and leaves no remote browser proxy',async t=>{
  let release;const password=new Promise(r=>release=r);const d=await fixture(t,{provider:()=>password});
  const opening=d.open().catch(()=>null);await until(()=>d.state.passwordReads===1);await d.gate.close();release('saved-password');await opening;
  assert.equal(d.state.passwordPosts,0);assert.equal(d.gate.getSessionId(),null);
});
