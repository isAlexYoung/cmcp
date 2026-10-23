// Keeps one outbound WebSocket per cloud computer. The PC logs in to WebDesktop with the
// desktop access password, then the cloud computer relays Claude's MCP requests over it.
// No inbound port or third-party relay is involved, and the address never changes.
//
// Node does not read the Windows network settings by itself, while PowerShell (used for the
// first login check) does. So the HTTP proxy that Windows would use for the cloud address is
// looked up by the caller and applied here to both the login request and the WebSocket.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import WebSocket from 'ws';
import { openTerminalLink } from './terminal-link.mjs';
import { authHeaders, authSocketUrl, requiresSharedSession, requestBuffered } from './desktop-auth.mjs';

const LINK_PATH = '/api/pclink/ws';

export class LoginError extends Error {
  constructor(kind, message, retryAfter = 0, detail = '') {
    super(message);
    this.kind = kind; // password | expired | locked | notset | url | network
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

// Network failures as short Chinese text for the user; the raw error goes to the log.
export function describeNetworkError(error) {
  const code = error?.code || error?.cause?.code || error?.name || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '找不到云电脑地址（域名解析失败）';
  if (code === 'ECONNREFUSED') return '连接被拒绝';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被中断';
  if (code === 'ETIMEDOUT' || code === 'TimeoutError' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return '安全证书验证失败（可能被安全软件或网络拦截）';
  if (code === 'PROXY_FAILED') return '通过系统网络设置连接失败，请检查加速或网络软件是否正常运行';
  return '网络连接失败';
}

/* ---------------- HTTP CONNECT agent (Windows proxy setting) ---------------- */

function connectAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Only HTTP/HTTPS CONNECT proxies are supported');
  const auth = proxy.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : '';
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const host = options.host || options.hostname;
    const port = options.port || 443;
    let done = false;
    const fail = error => {
      if (done) return;
      done = true;
      clearTimeout(tunnelTimer);
      socket.destroy();
      // Anything before the tunnel is up is a problem with the system network setting, not the cloud computer.
      const wrapped = new Error(`proxy ${proxy.host}: ${error?.code || ''} ${error?.message || error}`);
      wrapped.code = 'PROXY_FAILED';
      callback(wrapped);
    };
    const proxyOptions = { port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80), host: proxy.hostname.replace(/^\[|\]$/g, '') };
    const socket = proxy.protocol === 'https:' ? tls.connect({ ...proxyOptions, rejectUnauthorized: true, servername: net.isIP(proxyOptions.host) ? undefined : proxyOptions.host }) : net.connect(proxyOptions);
    const tunnelTimer = setTimeout(() => fail(Object.assign(new Error('proxy timeout'), { code: 'ETIMEDOUT' })), 20000);
    socket.setTimeout(20000, () => fail(Object.assign(new Error('proxy timeout'), { code: 'ETIMEDOUT' })));
    socket.once('error', fail);
    socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` + (auth ? `Proxy-Authorization: ${auth}\r\n` : '') + '\r\n');
    });
    let head = Buffer.alloc(0);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 16384) fail(new Error('proxy response too large')); return; }
      socket.removeListener('data', onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1]);
      if (status !== 200) return fail(new Error('proxy CONNECT status ' + status));
      if (head.length > end + 4) return fail(new Error('Unexpected proxy tunnel bytes'));
      socket.setTimeout(0);
      clearTimeout(tunnelTimer);
      socket.removeListener('error', fail);
      const secure = tls.connect({ ...options, socket, rejectUnauthorized: true, servername: options.servername || host, ALPNProtocols: ['http/1.1'] });
      done = true;
      callback(null, secure);
    };
    socket.on('data', onData);
    return undefined;
  };
  return agent;
}

export function agentFor(url, proxyUrl) {
  if (!proxyUrl || !url.startsWith('https:')) return undefined;
  return connectAgent(proxyUrl);
}

/* ---------------- Login ---------------- */

function postJson(url, body, agent, timeout, signal) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST', agent, signal, rejectUnauthorized: true,
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size <= 1048576) chunks.push(c); else req.destroy(new Error('Login response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('request deadline'), {code:'ETIMEDOUT'})), timeout);
    req.once('close', () => clearTimeout(timer));
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}

// POST /api/auth/login; returns either a legacy cookie or a modern desktop session.
// remember=false asks for a 12-hour login (used by the one-off session mode); the link logs in again when it ends.
export async function login(baseUrl, password, agent, remember = true, signal) {
  // Even stale target settings must never make a background login on an
  // exclusive-session desktop. Only the browser gateway may submit its password.
  if (await requiresSharedSession(baseUrl, agent, signal)) throw new LoginError('shared', '请通过 Open-CloudPC.bat 打开云电脑，与 MCP 共用网页登录');
  let res;
  try {
    res = await postJson(baseUrl + '/api/auth/login', { password, remember }, agent, 30000, signal);
  } catch (error) {
    throw new LoginError('network', '无法访问云电脑：' + describeNetworkError(error), 0, `${error.code || ''} ${error.message}`);
  }
  let body = {};
  try { body = JSON.parse(res.text); } catch {}
  if(!body || typeof body !== 'object' || Array.isArray(body))body={};
  if (res.status >= 200 && res.status < 300) {
    const cookies = [].concat(res.headers['set-cookie'] ?? []);
    const cookie = cookies.map(c => c.split(';')[0]).find(c => c.startsWith('wd_session='));
    if (cookie) return cookie;
    if (typeof body.sessionId === 'string' && /^[A-Za-z0-9._~-]{16,4096}$/.test(body.sessionId)) return {sessionId: body.sessionId};
    throw new LoginError('url', '该地址没有返回云电脑登录信息');
  }
  const message = typeof body.error === 'string' ? body.error.slice(0, 1000) : `HTTP ${res.status}`;
  if (res.status === 401) throw new LoginError('password', message);
  if (res.status === 429) { const retry = Number(body.retryAfter) || Number(res.headers['retry-after']) || 600; throw new LoginError('locked', message, Number.isFinite(retry) ? Math.max(30, Math.min(retry, 86400)) : 600); }
  if (res.status === 403 && body.expired) throw new LoginError('expired', message);
  if (res.status === 503 && body.notSet) throw new LoginError('notset', message);
  if (res.status >= 500) throw new LoginError('network', '云电脑暂时不可用（可能正在启动或已关闭），稍后自动重试', 0, `HTTP ${res.status} ${res.text.slice(0, 200)}`);
  throw new LoginError('url', '该地址不是云电脑连接地址', 0, `HTTP ${res.status} ${res.text.slice(0, 200)}`);
}

/* ---------------- Status file read by Start-Claude-MCP ---------------- */

export class StatusBoard {
  constructor(file) {
    this.file = file;
    this.data = {};
    // Rewrite regularly: a write can fail while the start window happens to be reading the file.
    setInterval(() => this.write(), 5000).unref();
  }
  set(name, state, message = '', revision) {
    const prev = this.data[name];
    if (prev && prev.state === state && prev.message === message && prev.revision === revision) return;
    this.data[name] = { state, message, at: new Date().toISOString(), revision };
    this.write();
  }
  // On Windows, replacing a file fails while another program has it open (the start window
  // polls it every second; antivirus scans new files). Fall back to overwriting it in place;
  // the reader tolerates a half-written file and simply reads again a second later.
  write() {
    const text = JSON.stringify({ pid: process.pid, controlProtocol: 1, autoLoginProtocol:1, at: new Date().toISOString(), targets: this.data }, null, 2);
    const tmp = this.file + '.tmp';
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, this.file);
        return true;
      } catch {}
      try {
        fs.writeFileSync(this.file, text);
        try { fs.unlinkSync(tmp); } catch {}
        return true;
      } catch {}
      const until = Date.now() + 50;
      while (Date.now() < until) { /* brief retry pause */ }
    }
    return false;
  }
}

/* ---------------- One cloud computer ---------------- */

// `target()` re-reads the saved settings (URL / password may change); it also resolves the
// Windows network setting for the address each time a login starts.
// session=true (short-term version): short logins, and `onReplaced` ends the whole service instead of
// leaving it idle when another PC takes over.
export function startLink({ name, target, machine, version, forward, askPassword, notify, status, log, session = false, onReplaced, onConnected }) {
  let stopped = false;
  const controller = new AbortController();
  const sleep = ms => delay(ms, undefined, { signal: controller.signal }).catch(() => {});
  let socket = null;
  let lastLog = '';
  const say = (state, message, detail = '') => {
    status.set(name, state, message);
    const line = `[${name}] ${state} ${message}${detail ? ' | ' + detail : ''}`;
    if (line !== lastLog) { lastLog = line; log(line); }
  };

  const connect = async (url, auth, agent, terminal = false) => {
    let ws;
    try {
      const wsUrl = authSocketUrl(url.replace(/^http/, 'ws') + LINK_PATH, auth);
      ws = terminal ? await openTerminalLink(url, auth, agent, controller.signal) : new WebSocket(wsUrl, {
        headers: authHeaders(auth), agent, rejectUnauthorized: true, perMessageDeflate: false, maxPayload: 48 * 1024 * 1024, handshakeTimeout: 30000,
      });
    } catch (error) { return { error, http: error.status, welcomed: false, lasted: 0 }; }
    if (stopped) { ws.on('error', () => {}); ws.close(); return { welcomed: false, lasted: 0 }; }
    return new Promise(resolve => {
      socket = ws;
      let lastPong = Date.now();
      let opened = 0;
      let welcomed = false;
      let heartbeat;
      let welcomeTimer;
      let sessionWatcher;
      let sessionChanged = false;
      let finished = false;
      let pending = 0;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(welcomeTimer);
        clearInterval(sessionWatcher);
        socket = null;
        resolve({ ...result, sessionChanged, welcomed, lasted: opened ? Date.now() - opened : 0 });
      };
      if (auth?.sessionId) {
        sessionWatcher = setInterval(() => {
          Promise.resolve(target()?.getSessionId?.()).then(current => {
            if (!finished && current !== auth.sessionId) { sessionChanged = true; ws.close(1000, 'session changed'); }
          }).catch(() => {});
        }, 1000);
      }
      ws.on('unexpected-response', (req, res) => {
        res.resume();
        finish({ http: res.statusCode });
        ws.terminate();
      });
      ws.on('open', () => {
        opened = Date.now();
        ws.send(JSON.stringify({ t: 'hello', machine, name: process.env.COMPUTERNAME || 'Windows', version }));
        welcomeTimer = setTimeout(() => { if (!welcomed) { log(`[${name}] no welcome within 15s`); ws.terminate(); } }, 15000);
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 50000) { log(`[${name}] heartbeat lost`); return ws.terminate(); }
          try { ws.ping(); } catch {}
        }, 20000);
      });
      ws.on('pong', () => { lastPong = Date.now(); });
      ws.on('ping', () => { lastPong = Date.now(); });
      ws.on('message', async (data, isBinary) => {
        if (stopped) return;
        lastPong = Date.now();
        if (isBinary) return;
        if (data.length > 8 * 1024 * 1024) { ws.close(1009, 'Request too large'); return; }
        let m;
        try { m = JSON.parse(data.toString()); } catch { return; }
        if (!m || typeof m !== 'object' || Array.isArray(m)) return;
        if (m.t === 'welcome') {
          if (welcomed) return;
          welcomed = true; clearTimeout(welcomeTimer);
          say('connected', terminal ? '已连接（兼容模式）' : '已连接');
          Promise.resolve(onConnected?.(auth)).catch(() => log(`[${name}] connector setup failed`));
          return;
        }
        if (m.t !== 'req' || typeof m.id !== 'string' || m.id.length > 256) return;
        if ((ws.bufferedAmount || 0) > 64 * 1024 * 1024) { ws.terminate(); return; }
        if (pending >= 16) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({t:'res',id:m.id,error:'Too many requests'})); return; }
        pending++;
        let reply;
        try { reply = { t: 'res', id: m.id, msg: await forward(m.msg) }; }
        catch (error) { reply = { t: 'res', id: m.id, error: error.message || String(error) }; }
        pending--;
        if (!stopped && ws.readyState === WebSocket.OPEN) {
          const encoded=JSON.stringify(reply);
          if ((ws.bufferedAmount || 0) > 64 * 1024 * 1024) { ws.terminate(); return; }
          ws.send(Buffer.byteLength(encoded) <= 40*1024*1024 ? encoded : JSON.stringify({t:'res',id:m.id,error:'Response exceeds 40 MiB; request a smaller chunk'}));
        }
      });
      ws.on('close', (code, reason) => finish({ code, reason: reason.toString() }));
      ws.on('error', error => {
        if (finished) return;
        log(`[${name}] socket error: ${error.code || ''} ${describeNetworkError(error)}`);
        finish({ error });
        ws.terminate();
      });
    });
  };

  let agent;
  const done = (async () => {
    let backoff = 1000;
    let credential = null;
    let url = '';
    let stamp;
    let proxyDirty = true;
    let terminal = false;
    while (!stopped) {
      const settings = target();
      if (!settings) { say('stopped', '这台云电脑的设置已被删除'); return; }
      const nextStamp = JSON.stringify(settings.stamp ?? null);
      if (settings.url !== url || nextStamp !== stamp) {
        if (settings.url !== url) terminal = false;
        url = settings.url; stamp = nextStamp; credential = null; proxyDirty = true;
      }
      if (proxyDirty) {
        try {
          const proxy = await settings.proxy();
          agent?.destroy(); agent = agentFor(url, proxy); proxyDirty = false;
        } catch (error) {
          say('offline', '无法读取或使用系统网络设置，稍后重试', describeNetworkError(error));
          await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue;
        }
      }
      if (settings.authMode === 'shared-browser') {
        credential = null;
        try {
          const auth = settings.getSessionAuth ? await settings.getSessionAuth() : {sessionId:await settings.getSessionId?.()};
          if (auth?.sessionId) { authHeaders(auth); credential = auth; }
        } catch (error) {
          say('waiting-login', '无法读取网页会话，请在 MCP 打开的云电脑网页中登录', error.message);
          await sleep(2000); continue;
        }
        if (!credential) {
          const issue=settings.getLoginIssue?.();
          if(issue){say(issue.state,issue.message);await sleep(1500);continue;}
          say('waiting-login', '请在 MCP 打开的云电脑网页中登录；MCP 会共用该会话');
          await sleep(1500); continue;
        }
      }
      if (!credential && settings.authMode !== 'shared-browser') {
        let password;
        try {
          say('connecting', '正在读取保存的密码');
          password = await settings.password();
        } catch (error) {
          say('error', '无法读取保存的云电脑密码，请重新双击 Start-Claude-MCP.bat', error.message);
          await sleep(30000); continue;
        }
        if (stopped) break;
        say('connecting', agent ? '正在登录云电脑（已使用系统网络设置）' : '正在登录云电脑');
        try {
          credential = await login(url, password, agent, !session, controller.signal);
        } catch (error) {
          if (!(error instanceof LoginError)) { say('error', '登录云电脑时发生意外错误，稍后自动重试', error.stack || error.message); await sleep(30000); continue; }
          if (error.kind === 'shared') { say('waiting-login', error.message); await sleep(30000); continue; }
          if (error.kind === 'password') {
            // Never retry a rejected password: five failures lock the desktop for everyone.
            say('password', '云电脑密码已变更，请在弹出的窗口中输入新密码');
            const changed = await askPassword(name, error.message);
            if (!changed) await waitForSettingsChange(target, controller.signal);
            continue;
          }
          if (error.kind === 'locked') { say('locked', error.message); await sleep((error.retryAfter + 5) * 1000); continue; }
          if (error.kind === 'expired') { say('expired', error.message); notify('云电脑访问密码已过期', error.message); await sleep(10 * 60000); continue; }
          if (error.kind === 'notset') { say('notset', error.message); await sleep(5 * 60000); continue; }
          if (error.kind === 'url') { say('url', error.message, error.detail); await sleep(5 * 60000); continue; }
          proxyDirty = true;
          say('offline', error.message + '，稍后自动重试', error.detail);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60000);
          continue;
        }
      }
      if (stopped) break;
      if (!credential) continue;
      say('connecting', '登录成功，正在建立连接');
      const result = await connect(url, credential, agent, terminal);
      if (stopped) break;
      if (result.sessionChanged) { credential = null; backoff = 1000; continue; }
      if (result.lasted > 60000) backoff = 1000;
      if (result.http === 401 || result.code === 4001) {
        const invalid = credential;
        if (settings.authMode === 'shared-browser') {
          // Some desktops upgraded browser/terminal authentication but retained
          // cookie-only auth on /api/pclink/ws. That endpoint's 401 must not
          // destroy the valid browser session or cause a second password login.
          let sessionStatus = 0;
          try {
            sessionStatus = (await requestBuffered(new URL('/api/auth/session', url), {
              headers: authHeaders(invalid), agent, signal: controller.signal,
              timeout: 10000, limit: 65536,
            })).status;
          } catch {}
          if (stopped) break;
          let current;
          try { current = await settings.getSessionId?.(); } catch {}
          if (current !== invalid.sessionId) { credential = null; continue; }
          if (sessionStatus >= 200 && sessionStatus < 300 && !terminal) {
            terminal = true;
            say('connecting', '网页登录仍然有效；专用接口不支持共享认证，正在切换兼容连接');
            continue;
          }
          if (sessionStatus !== 401) {
            say('offline', sessionStatus >= 200 && sessionStatus < 300
              ? '云电脑连接接口拒绝访问，已保留网页登录，稍后重试'
              : '暂时无法验证网页会话，已保留登录，稍后重试');
            await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue;
          }
        }
        credential = null;
        if (settings.authMode === 'shared-browser') {
          try { await settings.invalidateSession?.(invalid.sessionId); } catch {}
          say('waiting-login', '网页会话已失效；请在 MCP 打开的云电脑网页中重新登录');
        } else {
          proxyDirty = true;
          say('offline', '云端要求重新验证登录，稍后重试', `http=${result.http || 0} close=${result.code || 0}`);
        }
        if (settings.authMode === 'shared-browser') backoff = 1000;
        await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue;
      }
      if (result.http === 404 && !terminal) {
        terminal = true;
        say('connecting', '云电脑没有专用直连接口，正在切换兼容连接');
        continue;
      }
      if (result.code === 4002 && ['replaced','reconnected'].includes(result.reason)) {
        // This reports PC-link ownership, not browser authentication. Leave the
        // shared browser session intact and stop competing with the new link.
        say('replaced', result.reason === 'reconnected' ? '本机另一个连接已接管，当前连接已停止，避免重复抢占' : '另一台电脑已连接到这台云电脑，本机已停止连接');
        if (onReplaced) return onReplaced();
        notify('云电脑连接已切换', '另一台电脑已连接到这台云电脑。如需改回本机，请双击 Start-Claude-MCP.bat。');
        return;
      }
      if (result.error && !result.welcomed) {
        say('offline', '建立连接失败：' + describeNetworkError(result.error) + '，稍后自动重试');
        // A TLS/proxy reset is not evidence of an expired login. Keep the cookie.
        proxyDirty = true;
      } else if (result.http) {
        say('offline', `建立连接失败（HTTP ${result.http}），稍后自动重试`);
      } else {
        proxyDirty = true;
        say('offline', '连接中断，正在重连', `close=${result.code || 0}`);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  })().catch(error => { if (!stopped) say('error', '连接程序发生意外错误', error.stack || error.message); }).finally(() => agent?.destroy());

  return { done, stop() { stopped = true; controller.abort(); try { socket?.close(1000, 'stop'); } catch {} } };
}

async function waitForSettingsChange(target, signal) {
  const before = JSON.stringify(target()?.stamp ?? null);
  while (!signal.aborted) {
    await delay(15000, undefined, {signal}).catch(() => {});
    if (JSON.stringify(target()?.stamp ?? null) !== before) return;
  }
}

export function machineId(stateDir) {
  const file = path.join(stateDir, 'machine-id');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const id = globalThis.crypto.randomUUID();
  fs.writeFileSync(file, id);
  return id;
}
