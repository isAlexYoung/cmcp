import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {networkRevision} from '../network-policy.mjs';
import {agentFor} from '../connection-transport.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
import {key,cert} from './fixtures/tls-material.mjs';

const windows=process.platform==='win32';
const app=fileURLToPath(new URL('../',import.meta.url));
const execute=promisify(execFile);
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function fixture(t){
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-proxy-'));
  t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  const file=path.join(state,'application-preferences.json');
  return {state,write:settings=>fs.writeFileSync(file,JSON.stringify({schema:1,...settings})),file};
}
async function listen(t,server){
  const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
  return server.address().port;
}
function env(state){return {...process.env,CMCP_STATE_DIR:state,HTTPS_PROXY:'http://127.0.0.1:9',HTTP_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9'};}
function resolve(state){return execute(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(app,'get-proxy.ps1'),'-Url','https://example.test'],{env:env(state),windowsHide:true,timeout:10000}).then(r=>r.stdout.trim());}
function shell(state,script){return execute(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:env(state),windowsHide:true,timeout:15000});}

test('network revisions ignore appearance and inactive proxy drafts, but notice policy changes',t=>{
  const f=fixture(t),automatic=networkRevision(f.state);
  f.write({theme:'dark'});assert.equal(networkRevision(f.state),automatic);
  f.write({proxyMode:'auto',proxyHost:'example.test',proxyPort:1234});assert.equal(networkRevision(f.state),automatic);
  f.write({proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:7897});assert.notEqual(networkRevision(f.state),automatic);
  fs.writeFileSync(f.file,'{');assert.equal(networkRevision(f.state),'invalid');
});

test('manual policy overrides environment; direct overrides proxies; invalid policy fails closed', {skip:!windows},async t=>{
  const f=fixture(t);
  f.write({proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:7897});assert.equal(await resolve(f.state),'http://127.0.0.1:7897');
  f.write({proxyMode:'manual',proxyHost:'::1',proxyPort:7897});assert.equal(new URL(await resolve(f.state)).href,'http://[::1]:7897/');
  f.write({proxyMode:'direct'});assert.equal(await resolve(f.state),'');
  f.write({proxyMode:'auto'});assert.equal(await resolve(f.state),'http://127.0.0.1:9');
  for(const bad of [{proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:0},{proxyMode:'manual',proxyHost:'http://127.0.0.1',proxyPort:7897},{proxyMode:'unexpected'}]){
    f.write(bad);await assert.rejects(resolve(f.state),e=>e.code===1&&!e.stdout.trim());
  }
  fs.writeFileSync(f.file,'{');await assert.rejects(resolve(f.state),e=>e.code===1);
});

test('selected proxy carries TLS requests and a rejected proxy never contacts the origin', {skip:!windows},async t=>{
  const f=fixture(t);let requests=0,connects=0,reject=false;
  const origin=https.createServer({key,cert},(req,res)=>{requests++;res.end('origin');});
  const originPort=await listen(t,origin),url=`https://127.0.0.1:${originPort}`;
  const proxy=http.createServer();proxy.on('connect',(req,socket)=>{
    connects++;if(reject){socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');return;}
    const upstream=net.connect(originPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(upstream).pipe(socket);});
    socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });const port=await listen(t,proxy);
  f.write({proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:port});
  const agent=agentFor(url,await resolve(f.state));agent.options.ca=cert;t.after(()=>agent.destroy());
  assert.equal((await requestBuffered(new URL('/',url),{agent})).body.toString(),'origin');assert.equal(connects,1);
  reject=true;agent.destroy();
  const failed=agentFor(url,await resolve(f.state));failed.options.ca=cert;t.after(()=>failed.destroy());
  await assert.rejects(requestBuffered(new URL('/',url),{agent:failed}));assert.equal(requests,1);assert.equal(connects,2);
});

test('legacy PowerShell HTTP requests use manual proxy and respect explicit direct mode', {skip:!windows},async t=>{
  const f=fixture(t);let proxied=0,direct=0;
  const origin=http.createServer((req,res)=>{direct++;res.setHeader('content-type','text/plain; charset=utf-8');res.end('DIRECT');});const originPort=await listen(t,origin);
  const proxy=http.createServer((req,res)=>{proxied++;res.setHeader('content-type','text/plain; charset=utf-8');res.end('PROXY');});const port=await listen(t,proxy);
  const script=url=>`$ErrorActionPreference='Stop';. ${quote(path.join(app,'network-settings.ps1'))};$s=New-CmcpWebSession ${quote(url)};[Console]::Write((Invoke-WebRequest -UseBasicParsing -Uri ${quote(url)} -WebSession $s -TimeoutSec 5).Content)`;
  // .NET intentionally bypasses proxies for loopback destinations. An unresolvable
  // external name proves the manual proxy handles the request without local DNS.
  f.write({proxyMode:'manual',proxyHost:'127.0.0.1',proxyPort:port});assert.equal((await shell(f.state,script(`http://cmcp-fixture.invalid:${originPort}/`))).stdout,'PROXY');assert.equal(proxied,1);assert.equal(direct,0);
  f.write({proxyMode:'direct'});assert.equal((await shell(f.state,script(`http://127.0.0.1:${originPort}/`))).stdout,'DIRECT');assert.equal(proxied,1);assert.equal(direct,1);
});
