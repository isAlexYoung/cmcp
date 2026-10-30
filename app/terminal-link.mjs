// Older WebDesktop builds have an authenticated terminal, but no /api/pclink/ws.
// Run the same Unix-socket protocol over that terminal without changing WebDesktop.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import { authHeaders, authSocketUrl, socketHeaders } from './desktop-auth.mjs';
import {observeRequest,finishSocketRequest} from './connection-transport.mjs';

const PREFIX = 'CPCMCP1:';
const MAX_MESSAGE = 40 * 1024 * 1024;
const CHUNK_SIZE = 8192;
const WINDOW = 4;
const relaySource = () => fs.readFileSync(new URL('./cloudpc-relay.py', import.meta.url), 'utf8');

export function isTransientCloudError(error) {
  if ([408,429,500,502,503,504].includes(error?.status)) return true;
  return ['ECONNRESET','EPIPE','ETIMEDOUT','ESOCKETTIMEDOUT','EAI_AGAIN','ECONNREFUSED'].includes(error?.code)
    || error?.code === 'PROXY_FAILED' && isTransientCloudError(error.cause);
}
const failureCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : error?.status ? 'HTTP_'+error.status : 'REQUEST_FAILED';

function cloudRequest(baseUrl, auth, agent, endpoint, method, body, signal, timeout) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(endpoint, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) return reject(new Error('云电脑 API 地址无效'));
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method, agent, signal, rejectUnauthorized: true, headers: { ...authHeaders(auth), ...(data ? {
        'content-type': 'application/json', 'content-length': data.length,
      } : {}) },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) req.destroy(Object.assign(new Error('Cloud API response is too large'),{code:'RESPONSE_TOO_LARGE'}));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = JSON.parse(text); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && value) return resolve(value);
        const error = new Error(`兼容连接配置失败（HTTP ${res.statusCode}）`);
        error.status = res.statusCode;
        const retry=res.headers['retry-after'];
        if(retry){const ms=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();if(Number.isFinite(ms))error.retryAfterMs=Math.max(0,Math.min(ms,86400000));}
        reject(error);
      });
    });
    observeRequest(req);
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('request deadline'), {code:'ETIMEDOUT'})), timeout);
    req.once('close', () => clearTimeout(deadline));
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}

// Retry only reads. A write with an uncertain result is reconciled by prepareRelay.
export async function cloudApi(baseUrl, auth, agent, endpoint, method = 'GET', body, signal, options={}) {
  const started=Date.now(),budget=25000,attempts=method==='GET'?4:1;
  for(let attempt=1;attempt<=attempts;attempt++){
    signal?.throwIfAborted();
    try{return await cloudRequest(baseUrl,auth,agent,endpoint,method,body,signal,method==='GET'?Math.max(1,Math.min(8000,budget-(Date.now()-started))):30000);}
    catch(error){
      if(signal?.aborted)signal.throwIfAborted();
      Object.assign(error,{attempts:attempt,stage:options.stage||'cloud-api',endpoint:new URL(endpoint,baseUrl).pathname,method});
      const wait=Math.max([250,750,1500][attempt-1]||0,error.retryAfterMs||0);
      if(attempt===attempts || !isTransientCloudError(error) || Date.now()-started+wait>=budget)throw error;
      options.onRetry?.({attempt:attempt+1,maxAttempts:attempts,delayMs:wait,code:failureCode(error),method,endpoint:error.endpoint,connectionPhase:error.connectionPhase,connectionMs:error.connectionMs,reusedConnection:error.reusedConnection});
      await delay(wait,undefined,{signal});
    }
  }
}

export async function prepareRelay(url, auth, agent, signal, options={}) {
  signal?.throwIfAborted();
  const progress=event=>options.onProgress?.(event);
  const key=createHash('sha256').update(url+'\0'+JSON.stringify(authHeaders(auth))).digest('hex');
  const cache=options.cache||{};
  if(cache.entry?.key!==key || cache.entry.until<=Date.now())cache.entry={key,until:Date.now()+300000,folders:[]};
  const entry=cache.entry;
  const checkpoint=()=>{entry.until=Date.now()+300000;};
  let stage='relay-info',label='正在检查云端连接能力';
  const step=(code,text)=>{signal?.throwIfAborted();stage=code;label=text;progress({state:'start',stage,label});};
  const api = (endpoint, method='GET', body) => cloudApi(url,auth,agent,endpoint,method,body,signal,{stage,onRetry:event=>progress({...event,state:'retry',stage,label})});
  const fileEntry=async(dir,name)=>{
    const listing=await api('/api/sys/fs?hidden=1&path='+encodeURIComponent(dir));
    if(!Array.isArray(listing.entries))throw Object.assign(new Error('云电脑目录响应异常'),{code:'INVALID_RESPONSE'});
    return listing.entries.find(entry=>entry.name===name);
  };
  // A lost POST/PUT response never authorizes a second write. Read back the
  // fixed bootstrap object and continue only when its type/content are proven.
  const write=async(endpoint,method,body,confirmed)=>{
    try{await api(endpoint,method,body);}
    catch(error){
      if(!isTransientCloudError(error) || signal?.aborted)throw error;
      progress({state:'reconcile',stage,label});
      if(!await confirmed())throw error;
    }
  };
  try{
  if(entry.ready){progress({state:'cached',stage:'relay-ready',label:'连接组件已就绪，正在建立 MCP 通道'});return entry.ready;}
  step('relay-info','正在检查云端连接能力');
  const info = entry.info || await api('/api/sys/info?lite=1');
  if(info.cmcp?.protocol===1 && info.cmcp.available!==true)throw Error('CC 的终端系统层需要管理员更新，尚未启用 CMCP 兼容连接');
  const home = info.home;
  if (typeof home !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(home) || home.split('/').includes('..')) {
    throw new Error('云电脑的用户目录异常');
  }
  entry.info=info;checkpoint();
  let dir = home;
  let index=0;
  for (const name of ['.local', 'share', 'cloudpc-link']) {
    step('relay-folder','正在准备连接组件目录（'+(++index)+'/3）');
    if(!entry.folders.includes(name)){
      const found=await fileEntry(dir,name);
      const valid=e=>e?.kind==='folder'&&!e.link;
      if(!found)await write('/api/sys/fs','POST',{dir,name,kind:'folder'},async()=>valid(await fileEntry(dir,name)));
      else if(!valid(found))throw new Error('云电脑的连接组件目录异常');
      entry.folders.push(name);checkpoint();
    }
    dir += '/' + name;
  }
  const file = dir + '/cloudpc-relay.py';
  step('relay-check','正在检查云端连接组件');
  const existing = await fileEntry(dir,'cloudpc-relay.py');
  if (existing && (existing.kind !== 'file' || existing.link)) throw new Error('云电脑的连接组件文件异常');
  const content = relaySource();
  const confirmed=async()=>{
    const found=await fileEntry(dir,'cloudpc-relay.py');
    if(!found||found.kind!=='file'||found.link)return false;
    return (await api('/api/sys/fs?read=1&path='+encodeURIComponent(file))).content===content;
  };
  if (existing) {
    step('relay-read','正在校验云端连接组件');
    const previous = await api('/api/sys/fs?read=1&path=' + encodeURIComponent(file));
    if (previous.content !== content){step('relay-write','正在更新云端连接组件');await write('/api/sys/fs','PUT',{path:file,content},confirmed);}
  } else {
    step('relay-write','正在更新云端连接组件');
    await write('/api/sys/fs','POST',{dir,name:'cloudpc-relay.py',kind:'file',content},confirmed);
  }
  signal?.throwIfAborted();entry.ready={home,file,cc:info.cmcp?.protocol===1};checkpoint();
  progress({state:'ready',stage:'relay-ready',label:'连接组件已就绪，正在建立 MCP 通道'});
  return entry.ready;
  }catch(error){
    if(!isTransientCloudError(error))delete cache.entry;
    Object.assign(error,{stage: error.stage||stage,preparationLabel:label});throw error;
  }
}

// WebSocket-shaped adapter: startLink keeps its existing login, heartbeat, reconnect,
// takeover and MCP forwarding logic for both transports.
export class TerminalLink extends EventEmitter {
  constructor(url, options) {
    super();
    this.ws = new WebSocket(url, options);
    this.ready = false;
    this.ended = false;
    this.acks = new Map();
    this.queue = Promise.resolve();
    this.queuedBytes = 0;
    this.queuedMessages = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.timer = setTimeout(() => this.fail(Object.assign(new Error('云电脑兼容连接启动超时，请确认已安装 Python 3.9 或更新版本'),{code:'RELAY_START_FAILED'})), 30000);
    this.ws.on('unexpected-response', (req, res) => this.emit('unexpected-response', req, res));
    this.ws.on('error', error => this.fail(error));
    this.ws.on('close', (code, reason) => this.finish(code, reason));
    this.ws.on('message', (data, binary) => {
      try {
        if (!binary) {
          const message = JSON.parse(data.toString());
          if(!message || typeof message !== 'object' || Array.isArray(message))return;
          if (message.t === 'error') this.fail(Object.assign(new Error(message.message || '无法启动云电脑终端'),{code:'RELAY_START_FAILED'}));
          if (message.t === 'exit' && !this.ended) this.fail(Object.assign(new Error(`云电脑兼容连接已退出（${message.code}）`),{code:'RELAY_EXITED'}));
          return;
        }
        this.buffer += this.decoder.write(data);
        if (this.buffer.length > 16 * 1024 * 1024) throw new Error('兼容连接消息过大');
        let end;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).replace(/\r$/, '');
          this.buffer = this.buffer.slice(end + 1);
          // Ignore shell prompts and echoed startup commands.
          if (!line.startsWith(PREFIX)) continue;
          const message = JSON.parse(Buffer.from(line.slice(PREFIX.length), 'base64').toString('utf8'));
          if(!message || typeof message !== 'object' || Array.isArray(message))continue;
          if (message.t === 'ready') {
            if (!this.ready) { this.ready = true; clearTimeout(this.timer); this.emit('open'); }
          } else if (message.t === 'ack') {
            const key = `${message.id}:${message.n}`;
            const ack = this.acks.get(key);
            if (ack) { this.acks.delete(key); clearTimeout(ack.timer); ack.resolve(); }
          } else if (message.t === 'pong') {
            this.emit('pong',Buffer.from(typeof message.nonce==='string'?message.nonce:''));
          } else if (message.t === 'close') {
            this.close(message.code || 1000, message.reason || 'closed');
          } else if (message.t === 'error') {
            this.fail(Object.assign(new Error(message.error || '云电脑兼容连接失败'),{code:'RELAY_START_FAILED'}));
          } else {
            this.emit('message', Buffer.from(JSON.stringify(message)), false);
          }
        }
      } catch (error) { this.fail(error); }
    });
  }

  get readyState() { return this.ended ? WebSocket.CLOSED : this.ready ? this.ws.readyState : WebSocket.CONNECTING; }

  packet(value) {
    if (this.ended || this.ws.readyState !== WebSocket.OPEN) throw new Error('兼容连接已断开');
    const line = PREFIX + JSON.stringify(value) + '\n';
    this.ws.send(JSON.stringify({ t: 'i', d: line }));
  }

  send(text) {
    const size = Buffer.byteLength(text);
    if (this.ended) return;
    if (this.queuedBytes + size > 64 * 1024 * 1024 || this.queuedMessages >= 64) { this.fail(new Error('兼容连接发送队列已满')); return; }
    this.queuedBytes += size; this.queuedMessages++;
    this.queue = this.queue.then(() => this.sendMessage(text)).catch(error => {
      if (!this.ended) this.fail(error);
    }).finally(() => { this.queuedBytes -= size; this.queuedMessages--; });
  }

  async sendMessage(text) {
    if (Buffer.byteLength(text) > MAX_MESSAGE) throw new Error('MCP response exceeds the 40 MiB limit');
    const encoded = Buffer.from(text).toString('base64');
    const id = randomUUID();
    // Bound PTY input in flight. Acknowledgements prevent large file responses from
    // overflowing the terminal input buffers, while a window avoids per-chunk latency.
    for (let offset = 0; offset < encoded.length;) {
      if (this.ended) throw new Error('兼容连接已断开');
      const pending = [];
      const packets = [];
      for (let n = 0; n < WINDOW && offset < encoded.length; n++) {
        const index = offset / CHUNK_SIZE;
        const data = encoded.slice(offset, offset + CHUNK_SIZE);
        offset += data.length;
        const key = `${id}:${index}`;
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.acks.delete(key);
            reject(new Error('兼容连接传输超时'));
          }, 30000);
          this.acks.set(key, { resolve, reject, timer });
        });
        pending.push(promise);
        packets.push({ t: 'data', id, n: index, data, end: offset === encoded.length });
      }
      // Attach rejection handlers before sending: a synchronous send failure
      // cancels every acknowledgement in this window, including unsent packets.
      const received = Promise.all(pending);
      try { for (const packet of packets) this.packet(packet); }
      catch (error) { this.fail(error); }
      await received;
    }
  }

  ping(data=Buffer.alloc(0)) { this.packet({ t: 'ping',nonce:Buffer.from(data).toString() }); }

  shutdown() {
    this.send(JSON.stringify({t: 'stop'}));
    return new Promise(resolve => {
      const finish = () => {this.close(1000, 'stop'); resolve();};
      const timer = setTimeout(finish, 1000);
      this.queue.finally(() => {clearTimeout(timer); finish();});
    });
  }

  finish(code, reason) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    for (const ack of this.acks.values()) { clearTimeout(ack.timer); ack.reject(new Error('兼容连接已断开')); }
    this.acks.clear();
    this.emit('close', code, Buffer.from(reason || ''));
  }

  close(code = 1000, reason = 'stop') {
    if (this.ended) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ t: 'kill' })); } catch {}
      this.ws.close();
    } else this.ws.terminate();
    this.finish(code, reason);
  }

  terminate() { this.close(1006, 'terminated'); this.ws.terminate(); }

  fail(error) {
    if (this.ended) return;
    this.emit('error', error);
    this.terminate();
  }
}

export async function openTerminalLink(baseUrl, auth, agent, signal, options) {
  const { home, file,cc } = await prepareRelay(baseUrl, auth, agent, signal, options);
  signal?.throwIfAborted();
  const url = new URL(baseUrl.replace(/^http/, 'ws') + '/api/term/ws');
  url.search = new URLSearchParams({ sid: 'pclink-' + randomUUID(), cols: '200', rows: '30', cwd: home,
    cmd: `exec ${cc?'env CLOUDPC_CC_SHARED=1 ':''}python3 -u '${file}'` }).toString();
  return new TerminalLink(authSocketUrl(url, auth), { headers: socketHeaders(baseUrl,auth), agent, rejectUnauthorized: true, perMessageDeflate: false,
    maxPayload: 48 * 1024 * 1024, handshakeTimeout: 30000, finishRequest:finishSocketRequest });
}
