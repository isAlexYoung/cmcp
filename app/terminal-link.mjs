// Older WebDesktop builds have an authenticated terminal, but no /api/pclink/ws.
// Run the same Unix-socket protocol over that terminal without changing WebDesktop.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import { authHeaders, authSocketUrl, socketHeaders } from './desktop-auth.mjs';

const PREFIX = 'CPCMCP1:';
const MAX_MESSAGE = 40 * 1024 * 1024;
const CHUNK_SIZE = 8192;
const WINDOW = 4;
const relaySource = () => fs.readFileSync(new URL('./cloudpc-relay.py', import.meta.url), 'utf8');

export function cloudApi(baseUrl, auth, agent, endpoint, method = 'GET', body, signal) {
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
        if (size > 2 * 1024 * 1024) req.destroy(new Error('Cloud API response is too large'));
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
        reject(error);
      });
    });
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('request deadline'), {code:'ETIMEDOUT'})), 30000);
    req.once('close', () => clearTimeout(deadline));
    req.setTimeout(30000, () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}

export async function prepareRelay(url, auth, agent, signal) {
  const api = (endpoint, method, body) => cloudApi(url, auth, agent, endpoint, method, body, signal);
  const info = await api('/api/sys/info?lite=1');
  if(info.cmcp?.protocol===1 && info.cmcp.available!==true)throw Error('CC 的终端系统层需要管理员更新，尚未启用 CMCP 兼容连接');
  const home = info.home;
  if (typeof home !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(home) || home.split('/').includes('..')) {
    throw new Error('云电脑的用户目录异常');
  }
  let dir = home;
  for (const name of ['.local', 'share', 'cloudpc-link']) {
    const listing = await api('/api/sys/fs?hidden=1&path=' + encodeURIComponent(dir));
    const entry = listing.entries?.find(entry => entry.name === name);
    if (!entry) await api('/api/sys/fs', 'POST', { dir, name, kind: 'folder' });
    else if (entry.kind !== 'folder' || entry.link) throw new Error('云电脑的连接组件目录异常');
    dir += '/' + name;
  }
  const file = dir + '/cloudpc-relay.py';
  const listing = await api('/api/sys/fs?hidden=1&path=' + encodeURIComponent(dir));
  const existing = listing.entries?.find(entry => entry.name === 'cloudpc-relay.py');
  if (existing && (existing.kind !== 'file' || existing.link)) throw new Error('云电脑的连接组件文件异常');
  const content = relaySource();
  if (existing) {
    const previous = await api('/api/sys/fs?read=1&path=' + encodeURIComponent(file));
    if (previous.content !== content) await api('/api/sys/fs', 'PUT', { path: file, content });
  } else {
    await api('/api/sys/fs', 'POST', { dir, name: 'cloudpc-relay.py', kind: 'file', content });
  }
  return { home, file, cc:info.cmcp?.protocol===1 };
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
    this.timer = setTimeout(() => this.fail(new Error('云电脑兼容连接启动超时，请确认已安装 Python 3.9 或更新版本')), 30000);
    this.ws.on('unexpected-response', (req, res) => this.emit('unexpected-response', req, res));
    this.ws.on('error', error => this.fail(error));
    this.ws.on('close', (code, reason) => this.finish(code, reason));
    this.ws.on('message', (data, binary) => {
      try {
        if (!binary) {
          const message = JSON.parse(data.toString());
          if(!message || typeof message !== 'object' || Array.isArray(message))return;
          if (message.t === 'error') this.fail(new Error(message.message || '无法启动云电脑终端'));
          if (message.t === 'exit' && !this.ended) this.fail(new Error(`云电脑兼容连接已退出（${message.code}）`));
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
            this.fail(new Error(message.error || '云电脑兼容连接失败'));
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

export async function openTerminalLink(baseUrl, auth, agent, signal) {
  const { home, file,cc } = await prepareRelay(baseUrl, auth, agent, signal);
  signal?.throwIfAborted();
  const url = new URL(baseUrl.replace(/^http/, 'ws') + '/api/term/ws');
  url.search = new URLSearchParams({ sid: 'pclink-' + randomUUID(), cols: '200', rows: '30', cwd: home,
    cmd: `exec ${cc?'env CLOUDPC_CC_SHARED=1 ':''}python3 -u '${file}'` }).toString();
  return new TerminalLink(authSocketUrl(url, auth), { headers: socketHeaders(baseUrl,auth), agent, rejectUnauthorized: true, perMessageDeflate: false,
    maxPayload: 48 * 1024 * 1024, handshakeTimeout: 30000 });
}
