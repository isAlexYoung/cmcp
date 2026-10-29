import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {cloudApi,prepareRelay,isTransientCloudError} from '../terminal-link.mjs';

const auth={sessionId:'test-session-123456789',cookie:'wd_cmcp=fixture-only'};
const home='/home/guest',dir=home+'/.local/share/cloudpc-link';
const source=fs.readFileSync(new URL('../cloudpc-relay.py',import.meta.url),'utf8');
async function fixture(t,handler=()=>false){
  const state={counts:new Map(),folders:new Set([home+'/.local',home+'/.local/share',dir]),content:source};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');let raw='';for await(const b of req)raw+=b;
    const body=raw?JSON.parse(raw):undefined;
    const key=req.method+' '+url.pathname+' '+(url.searchParams.get('path')||'');
    state.counts.set(key,(state.counts.get(key)||0)+1);
    assert.equal(req.headers['x-desktop-session'],auth.sessionId);
    if(await handler({req,res,url,body,key,state}))return;
    res.setHeader('content-type','application/json');
    if(url.pathname==='/api/sys/info')return res.end(JSON.stringify({home,cmcp:{protocol:1,available:true}}));
    if(req.method==='GET'){
      if(url.searchParams.has('read'))return res.end(JSON.stringify({content:state.content}));
      const parent=url.searchParams.get('path');const entries=[];
      for(const name of ['.local','share','cloudpc-link'])if(state.folders.has(parent+'/'+name))entries.push({name,kind:'folder'});
      if(parent===dir&&state.content!==undefined)entries.push({name:'cloudpc-relay.py',kind:'file'});
      return res.end(JSON.stringify({entries}));
    }
    if(body.kind==='folder')state.folders.add(body.dir+'/'+body.name);else state.content=body.content;
    res.end('{}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {state,url:`http://127.0.0.1:${server.address().port}`,count:(method,path)=>state.counts.get(method+' /api/sys/fs '+path)||0};
}

test('relay read recovery retries the failing request without replaying completed directory checks',async t=>{
  const events=[];let failures=2;
  const d=await fixture(t,({req,res,url})=>{if(req.method==='GET'&&url.searchParams.get('path')===dir&&failures-->0){res.destroy();return true;}});
  const result=await prepareRelay(d.url,auth,undefined,undefined,{onProgress:e=>events.push(e)});
  assert.equal(result.file,dir+'/cloudpc-relay.py');assert.equal(d.count('GET',home),1);assert.equal(d.count('GET',dir),3);
  assert.deepEqual(events.filter(e=>e.state==='retry').map(e=>[e.stage,e.attempt,e.code]),[['relay-check',2,'ECONNRESET'],['relay-check',3,'ECONNRESET']]);
  assert(!JSON.stringify(events).includes(auth.cookie));assert(!JSON.stringify(events).includes('path='));
});

test('an exhausted read resumes verified preparation checkpoints on the next attempt',async t=>{
  let failures=4;const cache={};
  const d=await fixture(t,({res,url})=>{if(url.searchParams.get('path')===dir&&failures-->0){res.destroy();return true;}});
  await assert.rejects(prepareRelay(d.url,auth,undefined,undefined,{cache}),e=>e.attempts===4&&e.stage==='relay-check');
  await prepareRelay(d.url,auth,undefined,undefined,{cache});
  assert.equal(d.state.counts.get('GET /api/sys/info '),1);assert.equal(d.count('GET',home),1);assert.equal(d.count('GET',dir),5);
});

test('ready preparation is reused briefly, while session changes and expiry require fresh checks',async t=>{
  const d=await fixture(t),cache={};
  await prepareRelay(d.url,auth,undefined,undefined,{cache});const first=[...d.state.counts];
  await prepareRelay(d.url,auth,undefined,undefined,{cache});assert.deepEqual([...d.state.counts],first);
  await prepareRelay(d.url,{...auth,cookie:'wd_cmcp=other-grant'},undefined,undefined,{cache});assert.equal(d.count('GET',home),2);
  cache.entry.until=0;await prepareRelay(d.url,auth,undefined,undefined,{cache});assert.equal(d.count('GET',home),3);
});

test('a committed folder creation with a lost response is read back, never blindly repeated',async t=>{
  const d=await fixture(t,({req,res,body,state})=>{if(req.method==='POST'&&body.kind==='folder'){state.folders.add(body.dir+'/'+body.name);res.destroy();return true;}});
  d.state.folders.delete(home+'/.local');await prepareRelay(d.url,auth);
  assert.equal(d.state.counts.get('POST /api/sys/fs '),1);assert.equal(d.count('GET',home),2);
});

for(const method of ['POST','PUT'])test(`a committed relay ${method} with a lost response is verified by content with one write`,async t=>{
  const d=await fixture(t,({req,res,body,state})=>{if(req.method===method){state.content=body.content;res.destroy();return true;}});
  d.state.content=method==='POST'?undefined:'older relay';await prepareRelay(d.url,auth);
  assert.equal(d.state.counts.get(method+' /api/sys/fs '),1);assert.equal(d.state.content,source);
});

test('an unconfirmed write is not resent when read-back does not prove its result',async t=>{
  const d=await fixture(t,({req,res})=>{if(req.method==='POST'){res.destroy();return true;}});d.state.content=undefined;
  await assert.rejects(prepareRelay(d.url,auth),e=>e.code==='ECONNRESET'&&e.method==='POST');
  assert.equal(d.state.counts.get('POST /api/sys/fs '),1);
});

test('authentication and unavailable-route responses do not trigger automatic read retries',async t=>{
  for(const status of [401,403,404]){
    const d=await fixture(t,({res})=>{res.writeHead(status);res.end('{}');return true;});
    await assert.rejects(cloudApi(d.url,auth,undefined,'/api/sys/info'),e=>e.status===status&&e.attempts===1);
    assert.equal(d.state.counts.get('GET /api/sys/info '),1);
  }
});

test('temporary HTTP failure honors Retry-After without repeating a write',async t=>{
  let count=0;const started=Date.now();
  const d=await fixture(t,({res})=>{if(count++===0){res.writeHead(503,{'retry-after':'1'});res.end('{}');return true;}});
  assert.equal((await cloudApi(d.url,auth,undefined,'/api/sys/info')).home,home);assert(Date.now()-started>=950);assert.equal(count,2);
});

test('a long server cooldown is preserved for the caller instead of ignored by a tight retry',async t=>{
  const d=await fixture(t,({res})=>{res.writeHead(429,{'retry-after':'60'});res.end('{}');return true;});
  await assert.rejects(cloudApi(d.url,auth,undefined,'/api/sys/info'),e=>e.status===429&&e.retryAfterMs===60000&&e.attempts===1);
});

test('stop during retry cancels the current preparation and sends no further requests',async t=>{
  const controller=new AbortController();const d=await fixture(t,({res})=>{res.destroy();return true;});
  await assert.rejects(prepareRelay(d.url,auth,undefined,controller.signal,{onProgress:e=>{if(e.state==='retry')controller.abort();}}),e=>e.name==='AbortError');
  await delay(300);assert.equal(d.state.counts.get('GET /api/sys/info '),1);
});

test('certificate, proxy authentication and oversized-response errors are not transient',()=>{
  for(const code of ['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','RESPONSE_TOO_LARGE'])assert(!isTransientCloudError({code}));
  assert(!isTransientCloudError({code:'PROXY_FAILED',cause:new Error('proxy CONNECT status 407')}));
  assert(isTransientCloudError({code:'PROXY_FAILED',cause:{code:'ECONNRESET'}}));
});
