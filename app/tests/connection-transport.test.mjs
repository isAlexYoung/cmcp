import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {agentFor,finishSocketRequest,connectionDetail} from '../connection-transport.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
import {cloudApi} from '../terminal-link.mjs';
import {key,cert} from './fixtures/tls-material.mjs';

async function listen(t,server){
  const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
  return server.address().port;
}
async function fixture(t,{rejectConnect=false,stallConnect=false}={}){
  const counts={tls:0,connect:0,http:0};
  const origin=https.createServer({key,cert},(req,res)=>{counts.http++;req.resume();res.setHeader('content-type','application/json');res.end('{"ok":true}');});
  origin.on('secureConnection',()=>counts.tls++);
  const port=await listen(t,origin),url=`https://127.0.0.1:${port}`;
  const proxy=http.createServer();
  proxy.on('connect',(req,socket,head)=>{
    counts.connect++;
    if(stallConnect)return;
    if(rejectConnect)return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});
    socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  const proxyPort=await listen(t,proxy);
  const makeAgent=proxied=>{const a=agentFor(url,proxied?`http://127.0.0.1:${proxyPort}`:'');a.options.ca=cert;t.after(()=>a.destroy());return a;};
  return {url,origin,counts,makeAgent};
}

for(const proxied of [false,true])test(`${proxied?'CONNECT':'direct'} pool reuses verified TLS across authenticated requests`,async t=>{
  const d=await fixture(t),agent=d.makeAgent(proxied);
  for(let i=0;i<12;i++)assert.equal((await cloudApi(d.url,'wd_session=fixture',agent,'/api/sys/info')).ok,true);
  assert.equal(d.counts.tls,1);assert.equal(d.counts.connect,proxied?1:0);assert.equal(d.counts.http,12);
});

test('a lost reused connection is replaced and the read succeeds without resetting the whole pool',async t=>{
  const d=await fixture(t),agent=d.makeAgent(true);
  await cloudApi(d.url,'wd_session=fixture',agent,'/api/sys/info');
  d.origin.removeAllListeners('request');let failed=false;const retries=[];
  d.origin.on('request',(req,res)=>{if(!failed){failed=true;req.socket.destroy();}else{res.end('{"ok":true}');}});
  assert((await cloudApi(d.url,'wd_session=fixture',agent,'/api/sys/info','GET',undefined,undefined,{onRetry:e=>retries.push(e)})).ok);
  assert.equal(d.counts.connect,2);assert.equal(retries.length,1);
  assert.equal(retries[0].connectionPhase,'http-response');assert.equal(retries[0].reusedConnection,true);
});

test('TLS resets are distinguished from an HTTP response and diagnostics omit sensitive data',async t=>{
  let requests=0;const broken=net.createServer(s=>{s.once('data',()=>s.destroy());});const port=await listen(t,broken);
  const agent=agentFor(`https://127.0.0.1:${port}`,'');t.after(()=>agent.destroy());
  await assert.rejects(requestBuffered(`https://127.0.0.1:${port}/?token=SECRET`,{agent,headers:{cookie:'private-cookie'},timeout:2000}),error=>{
    assert.equal(error.connectionPhase,'tls-handshake');assert.equal(error.code,'ECONNRESET');
    const line=connectionDetail(error);assert(!/SECRET|cookie|127\.|token=/.test(line));assert.match(line,/elapsedMs=\d+/);requests++;return true;
  });assert.equal(requests,1);
});

test('proxy authentication rejection is not mislabeled as TLS and exposes no credentials',async t=>{
  const d=await fixture(t,{rejectConnect:true}),agent=d.makeAgent(true);
  await assert.rejects(requestBuffered(d.url,{agent}),e=>e.code==='PROXY_FAILED'&&e.cause.status===407&&e.connectionPhase==='proxy-connect');
  assert.equal(d.counts.connect,1);assert.equal(d.counts.tls,0);
});

test('WebSocket handshake errors retain the same TLS phase before ws forwards the error',async t=>{
  const broken=net.createServer(s=>s.once('data',()=>s.destroy()));const port=await listen(t,broken);
  const ws=new WebSocket(`wss://127.0.0.1:${port}/api/term/ws`,{finishRequest:finishSocketRequest});t.after(()=>ws.terminate());
  const [error]=await once(ws,'error');assert.equal(error.code,'ECONNRESET');assert.equal(error.connectionPhase,'tls-handshake');
});

test('destroying a pool promptly closes a pending CONNECT, rather than waiting twenty seconds',async t=>{
  const d=await fixture(t,{stallConnect:true}),agent=d.makeAgent(true);
  const request=requestBuffered(d.url,{agent,timeout:2000});
  while(!d.counts.connect)await new Promise(r=>setTimeout(r,5));
  agent.destroy();await assert.rejects(request,e=>e.code==='PROXY_FAILED'&&e.connectionPhase==='proxy-connect');
});

test('certificate verification remains enabled through the CONNECT pool',async t=>{
  const d=await fixture(t),agent=d.makeAgent(true);delete agent.options.ca;
  await assert.rejects(requestBuffered(d.url,{agent}),e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code)&&e.connectionPhase==='tls-handshake');
});

test('an HTTP pool can upgrade a reused TLS socket into the real WebSocket transport',async t=>{
  const d=await fixture(t),agent=d.makeAgent(true);
  const wss=new WebSocketServer({server:d.origin});wss.on('connection',ws=>ws.on('message',data=>ws.send(data.toString())));
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
  await requestBuffered(d.url,{agent});
  const ws=new WebSocket(d.url.replace('https:','wss:')+'/api/term/ws',{agent,rejectUnauthorized:true,finishRequest:finishSocketRequest});t.after(()=>ws.terminate());
  await once(ws,'open');const message=once(ws,'message');ws.send('tool-roundtrip');assert.equal((await message)[0].toString(),'tool-roundtrip');
  assert.equal(d.counts.connect,1);ws.close();await once(ws,'close');
});

test('each cloud target owns an independent pool',async t=>{
  const d=await fixture(t),a=d.makeAgent(true),b=d.makeAgent(true);
  await requestBuffered(d.url,{agent:a});await requestBuffered(d.url,{agent:b});assert.equal(d.counts.connect,2);
  a.destroy();assert.equal((await requestBuffered(d.url,{agent:b})).status,200);assert.equal(d.counts.connect,2);
});
