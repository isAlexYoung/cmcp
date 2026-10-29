import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createSharedSessionGateway} from '../shared-session-gateway.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
import {StaticAssetCache} from '../static-assets.mjs';

const ASSET='/_next/static/chunks/build-12345678.js';
const policy='public, max-age=31536000, immutable';
const until=async fn=>{for(let n=0;n<200;n++){if(fn())return;await delay(5);}throw Error('fixture timeout');};
async function fixture(t,handler=()=>({body:'public-build'}),cache=new StaticAssetCache()) {
  const seen=[],gateways=[];
  const server=http.createServer(async(req,res)=>{
    seen.push({url:req.url,method:req.method,encoding:req.headers['accept-encoding']});
    const value=await handler(req,res,seen.length);
    if(!value||res.destroyed)return;
    const body=Buffer.from(value.body??'public-build');
    res.writeHead(value.status??200,{'content-type':'application/javascript','cache-control':policy,'content-length':body.length,...value.headers});
    res.end(body);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  async function open(){
    const gateway=await createSharedSessionGateway({name:'cache',baseUrl:base,assetCache:cache,httpRecoveryOptions:{delays:[],headerTimeout:2000}});gateways.push(gateway);
    const origin=gateway.localOrigin;
    const claim=await requestBuffered(origin+'/__mcp/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(gateway.launchUrl).hash.slice(1)})});
    const cookie=claim.headers['set-cookie'][0].split(';')[0];
    return {gateway,origin,cookie,browser:(url=ASSET,options={})=>requestBuffered(origin+url,{...options,headers:{cookie,origin,...options.headers}})};
  }
  t.after(async()=>{for(const g of gateways)await g.close();cache.clear();server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {...await open(),open,base,cache,seen};
}

test('static GETs reuse complete public immutable bytes while browser disk caching remains disabled',async t=>{
  const d=await fixture(t);const first=await d.browser();const second=await d.browser();
  assert.equal(d.seen.length,1);assert.deepEqual(first.body,second.body);assert.equal(second.headers['cache-control'],'no-store');
  assert.equal(Number(second.headers['content-length']),second.body.length);
});

test('HEAD can reuse cached GET; ranges and conditional requests still reach the origin',async t=>{
  const d=await fixture(t,req=>req.headers.range?{status:206,body:'pu',headers:{'content-range':'bytes 0-1/12'}}:{});
  await d.browser();const head=await d.browser(ASSET,{method:'HEAD'});assert.equal(head.body.length,0);assert.equal(d.seen.length,1);
  assert.equal((await d.browser(ASSET,{headers:{range:'bytes=0-1'}})).status,206);
  await d.browser(ASSET,{headers:{'if-none-match':'"fixture"'}});assert.equal(d.seen.length,3);
});

test('compressed variants never reuse bytes for a different Accept-Encoding',async t=>{
  const encoded=gzipSync('public-build');const d=await fixture(t,req=>req.headers['accept-encoding']==='gzip'?{body:encoded,headers:{'content-encoding':'gzip',vary:'Accept-Encoding'}}:{});
  const a=await d.browser(ASSET,{headers:{'accept-encoding':'gzip'}});const b=await d.browser(ASSET,{headers:{'accept-encoding':'gzip'}});
  assert.deepEqual(a.body,encoded);assert.deepEqual(b.body,encoded);assert.equal(b.headers['content-encoding'],'gzip');
  const plain=await d.browser();assert.equal(plain.body.toString(),'public-build');assert.equal(plain.headers['content-encoding'],undefined);assert.equal(d.seen.length,2);
});

test('HTML, API calls, downloads, query credentials and non-build files are never cached',async t=>{
  const d=await fixture(t);
  for(const url of ['/','/api/auth/session','/api/sys/download?path=file','/assets/icon.js',ASSET+'?access=not-a-cache-key',ASSET+'?v=2']){await d.browser(url);await d.browser(url);}
  assert.equal(d.seen.length,12);assert.equal(d.cache.entries.size,0);
});

test('private, mutable, cookie-varying and attachment responses are not retained',async t=>{
  const variants=[{'cache-control':'private, max-age=31536000, immutable'},{'cache-control':'public, no-store, max-age=31536000, immutable'},{'cache-control':'public, max-age=31536000'},{'set-cookie':'session=not-to-cache'},{vary:'Cookie'},{vary:'Authorization'},{vary:'*'},{'content-disposition':'attachment; filename="file.js"'},{'content-type':'text/html'}];
  for(const headers of variants){const d=await fixture(t,()=>({headers}));await d.browser();await d.browser();assert.equal(d.seen.length,2,JSON.stringify(headers));assert.equal(d.cache.entries.size,0);}
});

test('failed responses do not poison a later successful build asset',async t=>{
  const d=await fixture(t,(req,res,n)=>n===1?{status:503,body:'failure'}:{body:'complete'});
  assert.equal((await d.browser()).status,503);assert.equal((await d.browser()).body.toString(),'complete');await d.browser();assert.equal(d.seen.length,2);
});

test('truncated transfers never enter the cache and release their staging reservation',async t=>{
  const d=await fixture(t,(req,res,n)=>{if(n!==1)return {body:'complete'};res.writeHead(200,{'content-type':'application/javascript','cache-control':policy,'content-length':40});res.write('partial');setTimeout(()=>res.destroy(),10);});
  await assert.rejects(d.browser());await until(()=>d.cache.pendingBytes===0);assert.equal(d.cache.entries.size,0);
  assert.equal((await d.browser()).body.toString(),'complete');await d.browser();assert.equal(d.seen.length,2);
});

test('cached assets still require the current gateway entry and same-origin checks',async t=>{
  const d=await fixture(t);await d.browser();
  assert.equal((await requestBuffered(d.origin+ASSET)).status,403);
  assert.equal((await d.browser(ASSET,{headers:{origin:'https://other.invalid'}})).status,403);
  assert.equal((await d.browser(ASSET,{headers:{'sec-fetch-site':'cross-site'}})).status,403);assert.equal(d.seen.length,1);
});

test('cache persists across target stop/reopen but is isolated by cloud origin',async t=>{
  const cache=new StaticAssetCache(),a=await fixture(t,()=>({body:'A'}),cache),b=await fixture(t,()=>({body:'B'}),cache);
  assert.equal((await a.browser()).body.toString(),'A');await a.gateway.close();const reopened=await a.open();
  assert.equal((await reopened.browser()).body.toString(),'A');assert.equal(a.seen.length,1);
  assert.equal((await b.browser()).body.toString(),'B');assert.equal(b.seen.length,1);
});

test('memory and entry-count budgets evict old resources without failing downloads',async t=>{
  const cache=new StaticAssetCache({maxBytes:8,maxEntryBytes:8,maxPendingBytes:8,maxEntries:2});
  const d=await fixture(t,()=>({body:'1234'}),cache);
  await d.browser('/_next/static/a.js');await d.browser('/_next/static/b.js');await d.browser('/_next/static/a.js');await d.browser('/_next/static/c.js');
  assert.equal(cache.bytes,8);assert.equal(cache.entries.size,2);await d.browser('/_next/static/a.js');assert.equal(d.seen.length,3);
  await d.browser('/_next/static/b.js');assert.equal(d.seen.length,4);
  const empty=await fixture(t,()=>({body:''}),new StaticAssetCache({maxEntries:2}));
  for(let n=0;n<5;n++)await empty.browser('/_next/static/'+n+'.js');assert.equal(empty.cache.entries.size,2);
});

test('oversized assets stream normally and bypass the cache',async t=>{
  const d=await fixture(t,()=>({body:'large-for-this-budget'}),new StaticAssetCache({maxEntryBytes:4}));
  assert.equal((await d.browser()).body.toString(),'large-for-this-budget');await d.browser();assert.equal(d.seen.length,2);assert.equal(d.cache.bytes,0);
});

test('concurrent staging stays bounded and clear prevents in-flight cache repopulation',async t=>{
  let release,started=false;const cache=new StaticAssetCache({maxEntryBytes:8,maxPendingBytes:8});
  const d=await fixture(t,async(req,res)=>{
    if(req.url.includes('slow')){res.writeHead(200,{'content-type':'application/javascript','cache-control':policy,'content-length':8});res.write('1234');started=true;await new Promise(r=>release=r);res.end('5678');return;}
    return {body:'12345678'};
  },cache);
  const slow=d.browser('/_next/static/slow.js');await until(()=>started&&cache.pendingBytes===8);
  await d.browser('/_next/static/fast.js');assert.equal(cache.pendingBytes,8);assert.equal(cache.entries.size,0);
  cache.clear();release();assert.equal((await slow).status,200);assert.equal(cache.pendingBytes,0);assert.equal(cache.entries.size,0);
});

test('quitting the backend drops the cache: a fresh process fetches the same asset again',async t=>{
  const d=await fixture(t);const gatewayModule=new URL('../shared-session-gateway.mjs',import.meta.url).href,authModule=new URL('../desktop-auth.mjs',import.meta.url).href;
  const code=`import {createSharedSessionGateway} from ${JSON.stringify(gatewayModule)};import {requestBuffered} from ${JSON.stringify(authModule)};
  const g=await createSharedSessionGateway({name:'child',baseUrl:${JSON.stringify(d.base)}});const u=new URL(g.launchUrl);
  const claim=await requestBuffered(u.origin+'/__mcp/claim',{method:'POST',headers:{origin:u.origin,'content-type':'application/json'},body:JSON.stringify({token:u.hash.slice(1)})});
  const headers={origin:u.origin,cookie:claim.headers['set-cookie'][0].split(';')[0]};
  for(let i=0;i<2;i++)await requestBuffered(u.origin+${JSON.stringify(ASSET)},{headers});await g.close();`;
  for(let n=0;n<2;n++)await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:5000});
  assert.equal(d.seen.length,2);
});
