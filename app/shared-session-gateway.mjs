// Loopback reverse proxy: the browser owns the one remote login, and MCP reuses
// that session. The process-lifetime launch secret stays in the URL fragment.
import http from 'node:http';
import https from 'node:https';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authHeaders, requestBuffered } from './desktop-auth.mjs';
import {autoFillSource, injectAutoFill} from './shared-autofill.mjs';
import {recoveryPage} from './web-recovery.mjs';

const SESSION_RE = /^[A-Za-z0-9._~-]{16,4096}$/;
const HOP_HEADERS = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host']);
const BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>正在打开云电脑</title><body style="font:16px sans-serif;padding:2rem">正在安全连接云电脑…<script>(()=>{const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);if(!token){document.body.textContent="请从 MCP 的“打开云电脑”入口重新打开。";return}fetch("/__mcp/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token}),cache:"no-store",credentials:"same-origin"}).then(r=>{if(!r.ok)throw Error();location.replace("/")}).catch(()=>{document.body.textContent="入口已失效，请从 MCP 的“打开云电脑”入口重新打开。"})})()</script>`;

function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a || ''));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function localPath(raw, localOrigin) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const value = new URL(raw, localOrigin);
    if (value.origin !== localOrigin || value.username || value.password) return null;
    return value;
  } catch { return null; }
}
function filteredHeaders(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower) || ['cookie','origin','referer','authorization','x-desktop-session'].includes(lower) || lower.startsWith('sec-fetch-') || lower.startsWith('x-forwarded-')) continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}
function localError(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  const body = Buffer.from(message);
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
  res.end(body);
}

export async function createSharedSessionGateway({ name, baseUrl, agent, onSession = () => {}, onInvalidate = () => {}, diagnostic = () => {}, autoPassword, httpRecoveryOptions={} }) {
  const retryDelays=httpRecoveryOptions.delays??[500,1500];
  const headerTimeout=httpRecoveryOptions.headerTimeout??10000;
  if(!Array.isArray(retryDelays)||retryDelays.length>4||retryDelays.some(n=>!Number.isFinite(n)||n<0||n>5000)||!Number.isFinite(headerTimeout)||headerTimeout<50||headerTimeout>60000)throw Error('Invalid HTTP recovery policy');
  const report=message=>{try{diagnostic(message);}catch{}};
  const remote = new URL(baseUrl);
  const loopbackTest = remote.protocol === 'http:' && remote.hostname === '127.0.0.1';
  if ((!loopbackTest && remote.protocol !== 'https:') || remote.username || remote.password || remote.search || remote.hash || remote.pathname !== '/') throw new Error('共享会话只支持干净的 HTTPS 云电脑地址');
  const transport = loopbackTest ? http : https;
  const remoteOrigin = remote.origin;
  const key = randomBytes(32);
  const claimToken = randomBytes(32).toString('base64url');
  const claimDigest = createHmac('sha256', key).update(claimToken).digest();
  const gateToken = randomBytes(32).toString('base64url');
  const gateCookie = 'mcp_browser_gate_' + randomBytes(8).toString('hex');
  let sessionId = '';
  let remoteCookie;
  let passwordTag = null;
  const autoMarker = 'cmcp-auto-'+randomBytes(32).toString('base64url');
  let autoUsed = false, autoIssue = null;
  let loginQueue = Promise.resolve();
  let closed = false;
  let server;
  let localOrigin;
  const lifetime = new AbortController();
  const activeSockets = new Set();
  const requests = new Set();
  const track = request => { requests.add(request); request.once('close', () => requests.delete(request)); return request; };
  const passwordDigest = password => createHmac('sha256', key).update(password, 'utf8').digest();

  const setSession = id => {
    if (closed || typeof id !== 'string' || !SESSION_RE.test(id)) return false;
    const changed = id !== sessionId;
    sessionId = id;
    if (changed) onSession(id);
    return true;
  };
  const clearSession = expected => {
    if (!sessionId || (expected && expected !== sessionId)) return false;
    const old = sessionId;
    sessionId = '';
    remoteCookie = undefined;
    passwordTag = null;
    onInvalidate(old);
    return true;
  };
  const gateOk = req => {
    if (!localOrigin || req.headers.host !== new URL(localOrigin).host) return false;
    if (req.headers.origin && req.headers.origin !== localOrigin) return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    return safeEqual(readCookie(req.headers.cookie, gateCookie), gateToken);
  };
  const upstreamUrl = local => {
    const url = new URL(local.pathname + local.search, remoteOrigin);
    if (url.origin !== remoteOrigin) throw new Error('Invalid proxy target');
    if (url.searchParams.has('access')) {
      if (sessionId) url.searchParams.set('access', sessionId);
      else url.searchParams.delete('access');
    }
    return url;
  };
  const requestHeaders = (req, target, websocket = false) => {
    const headers = filteredHeaders(req.headers);
    headers.host = target.host;
    headers.origin = remoteOrigin;
    if (req.headers.referer) {
      try {
        const ref = new URL(req.headers.referer);
        headers.referer = ref.origin === localOrigin ? new URL(ref.pathname + ref.search, remoteOrigin).href : remoteOrigin + '/';
      } catch { headers.referer = remoteOrigin + '/'; }
    }
    if (sessionId && !target.pathname.startsWith('/api/auth/login')) Object.assign(headers, authHeaders({sessionId,cookie:remoteCookie}));
    if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  };
  const responseHeaders = (headers, status) => {
    const out = {};
    for (const [keyName, value] of Object.entries(headers || {})) {
      const lower = keyName.toLowerCase();
      if (HOP_HEADERS.has(lower) || lower.startsWith('access-control-') || ['set-cookie','strict-transport-security'].includes(lower) || (lower === 'content-length' && status === 204)) continue;
      if (lower === 'location' && typeof value === 'string') {
        let location;
        try { location = new URL(value, remoteOrigin); } catch { throw new Error('Invalid redirect'); }
        if (location.origin !== remoteOrigin) throw new Error('Cross-origin redirect blocked');
        out[keyName] = localOrigin + location.pathname + location.search + location.hash;
      } else out[keyName] = value;
    }
    out['cache-control'] = 'no-store';
    out['x-content-type-options'] = 'nosniff';
    out['referrer-policy'] = 'no-referrer';
    return out;
  };
  async function collect(req, max) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw new Error('Request too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function validateSession() {
    if (!sessionId) return false;
    const used = sessionId;
    const { status } = await requestBuffered(new URL('/api/auth/session', remoteOrigin), { agent, signal:lifetime.signal, timeout: 10000, limit: 65536,
      headers: { ...authHeaders({sessionId:used,cookie:remoteCookie}), accept: 'application/json' } });
    if (status === 401) { clearSession(used); return false; }
    if (status >= 200 && status < 300 && used === sessionId) return true;
    return null;
  }
  async function processLogin(req, res, target, body, tag, automatic=false) {
    if (closed || res.destroyed) return;
    if (sessionId && passwordTag && safeEqual(tag, passwordTag)) {
      const valid = await validateSession().catch(() => null);
      if (valid === true) {
        const output = Buffer.from(JSON.stringify({ sessionId }));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': output.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(output); return;
      }
      if (valid === null) return localError(res, 503, '暂时无法验证已有网页会话，请稍后重试');
    }
    const headers = requestHeaders(req, target);
    // Login responses must be readable JSON, regardless of browser compression.
    headers['accept-encoding'] = 'identity';
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
    const result = await requestBuffered(target, { method: 'POST', headers, body, agent, signal:lifetime.signal, timeout: 30000, limit: 1024*1024 });
    if (closed) return;
    let value; try { value = JSON.parse(result.body.toString('utf8')); } catch {}
    if (result.status >= 200 && result.status < 300) {
      // New desktops may require both wd_session (HTTP middleware) and the
      // exclusive page session. Keep the upstream cookie in memory, never in
      // the browser's loopback cookie jar or a persistent settings file.
      const cookies = [].concat(result.headers['set-cookie'] || []);
      const candidate = cookies.map(cookie=>cookie.split(';')[0]).find(cookie=>cookie.startsWith('wd_session='));
      try { authHeaders({sessionId:value?.sessionId,cookie:candidate}); } catch { return localError(res,502,'云电脑返回了无效认证信息'); }
      remoteCookie = candidate;
      if (!setSession(value?.sessionId)) return localError(res, 502, '云电脑未返回有效的共享会话');
      passwordTag = tag;
      autoIssue = null;
      // A manual login also consumes automatic login for this gateway. Later
      // revocation must never make the saved credential take over again.
      autoUsed = true;
      diagnostic(`browser login accepted; session cookie ${remoteCookie ? 'present' : 'absent'}`);
    }
    if(automatic){
      const output=Buffer.from(JSON.stringify(result.status>=200&&result.status<300?{sessionId}:{error:result.status===401?'保存的密码不正确，已停止自动尝试，请在 CMCP 更新密码':'自动登录未通过，请手动登录或检查 CMCP 提示'}));
      res.writeHead(result.status||502,{'content-type':'application/json; charset=utf-8','content-length':output.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(output);return;
    }
    let headersOut;
    try { headersOut = responseHeaders(result.headers, result.status); }
    catch { return localError(res, 502, '云电脑返回了不安全的跳转'); }
    res.writeHead(result.status || 502, headersOut);
    res.end(result.body);
  }
  async function proxyLogin(req, res, target) {
    let body;
    try { body = await collect(req, 64 * 1024); } catch { return localError(res, 413, 'Login request too large'); }
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { return localError(res, 400, 'Invalid login request'); }
    const password = parsed && !Array.isArray(parsed) ? parsed.password : null;
    if (typeof password !== 'string' || password.length < 1 || password.length > 4096) return localError(res, 400, 'Invalid login request');
    if(typeof autoPassword==='function'&&password!==autoMarker&&/^cmcp-auto-[A-Za-z0-9_-]{43}$/.test(password)){
      res.writeHead(409,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});return res.end(JSON.stringify({error:'自动填充占位已失效，请清空浏览器保存的此项后重新打开 CMCP 入口'}));
    }
    const operation = loginQueue.then(async () => {
      if (password !== autoMarker) return processLogin(req, res, target, body, passwordDigest(password));
      if (typeof autoPassword !== 'function') return localError(res,403,'未启用自动登录');
      if (closed || res.destroyed) return;
      if (sessionId) {
        const valid=await validateSession().catch(()=>null);
        if (valid===true) { res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({sessionId})); }
        if (valid===null) return localError(res,503,'暂时无法确认会话，请手动重试');
      }
      if (autoUsed) return localError(res,409,'本次自动登录已结束，请手动登录或停止后更新密码');
      autoUsed=true; // Before awaiting decryption/POST: no concurrent duplicate.
      let saved;
      try { saved=await autoPassword(lifetime.signal); }
      catch { autoIssue={state:'password',message:'无法读取保存的密码，已停止自动尝试；请停止此连接后编辑密码'}; return localError(res,409,'无法读取保存的密码，请在 CMCP 编辑后重试'); }
      if (closed || lifetime.signal.aborted || res.destroyed) return;
      if (typeof saved!=='string'||!saved.length||saved.length>256) {autoIssue={state:'password',message:'保存的密码无效，请停止此连接后编辑密码'};return localError(res,409,'保存的密码无效');}
      // The browser never receives saved, only the ordinary session response.
      const loginBody=Buffer.from(JSON.stringify({password:saved,remember:false}));
      try { await processLogin(req,res,target,loginBody,passwordDigest(saved),true); }
      catch {autoIssue={state:'waiting-login',message:'自动登录未完成，已停止自动尝试；可在网页手动登录'};throw Error('Automatic login unavailable');}
      finally{loginBody.fill(0);saved=null;}
      if (!sessionId && !closed) autoIssue={state:res.statusCode===401?'password':res.statusCode===429?'locked':res.statusCode===403?'expired':'waiting-login',message:'自动登录未通过，已停止自动尝试；请手动登录或停止后编辑密码'};
    });
    loginQueue = operation.catch(() => {});
    try { await operation; } catch { localError(res, 502, '云电脑登录请求失败，请稍后重试'); }
  }
  function proxyHttp(req, res, local) {
    const target = upstreamUrl(local);
    if (req.method === 'POST' && local.pathname === '/api/auth/login') return void proxyLogin(req, res, target);
    // Never replay submissions, uploads, or a request with a body. Streaming
    // responses cannot be replayed once headers/data reached the browser.
    const safe=['GET','HEAD'].includes(req.method)&&!req.headers['transfer-encoding']&&!Number(req.headers['content-length']||0);
    const document=safe&&req.method==='GET'&&!local.pathname.startsWith('/api/')&&
      (req.headers['sec-fetch-dest']==='document'||String(req.headers.accept||'').includes('text/html'));
    let upstream,retryTimer,headerTimer,attempt=0,cancelled=false;
    const unavailable=()=>{
      if(document){const body=Buffer.from(recoveryPage());res.writeHead(503,{
        'content-type':'text/html; charset=utf-8','content-length':body.length,'cache-control':'no-store',
        'x-cmcp-recovery':'1','retry-after':'3','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
        'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});res.end(body);}
      else localError(res,502,'连接正在恢复，请稍后重试');
    };
    const cancel=()=>{cancelled=true;clearTimeout(retryTimer);clearTimeout(headerTimer);if(upstream){req.unpipe(upstream);upstream.destroy();}};
    req.once('aborted',cancel);res.once('close',cancel);
    const transient=new Set(['ECONNRESET','EPIPE','ETIMEDOUT','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','ERR_STREAM_PREMATURE_CLOSE']);
    const category=document?'document':local.pathname.startsWith('/api/')?'api':'asset';
    function run(){
      if(cancelled||closed||res.destroyed||res.writableEnded)return;
      let settled=false;
      const retry=code=>{
        if(settled)return true;
        settled=true;clearTimeout(headerTimer);
        if(cancelled||closed||res.destroyed||res.writableEnded)return true;
        // Codes/categories only: URLs may contain session credentials.
        report(`web ${category} ${req.method} attempt=${attempt+1} code=${code} tls=${!!upstream?.socket?.encrypted&&!!upstream?.socket?._secureEstablished}`);
        if(safe&&!res.headersSent&&attempt<retryDelays.length){
          const wait=retryDelays[attempt++];retryTimer=setTimeout(run,wait);return true;
        }
        return false;
      };
      const headers=requestHeaders(req,target);
      const autoPage=typeof autoPassword==='function'&&(!autoUsed||sessionId)&&req.method==='GET'&&local.pathname==='/';
      if(autoPage)headers['accept-encoding']='identity';
      const used=sessionId;
      upstream=track(transport.request(target,{method:req.method,headers,agent,rejectUnauthorized:true,timeout:60000},upstreamRes=>{
        clearTimeout(headerTimer);
        if(cancelled||closed){upstreamRes.destroy();return;}
        if([502,503,504].includes(upstreamRes.statusCode)&&safe){
          if(retry('HTTP_'+upstreamRes.statusCode)){upstreamRes.destroy();return;}
          if(document){upstreamRes.destroy();return unavailable();}
        }
        if(upstreamRes.statusCode===401&&local.pathname==='/api/auth/session')clearSession(used);
        let outputHeaders;
        try{outputHeaders=responseHeaders(upstreamRes.headers,upstreamRes.statusCode);}
        catch{settled=true;upstreamRes.resume();return localError(res,502,'云电脑返回了不安全的跳转');}
        if(autoPage&&upstreamRes.statusCode===200&&/^text\/html\b/i.test(String(outputHeaders['content-type']))&&!outputHeaders['content-encoding']){
          const chunks=[];let size=0;
          upstreamRes.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)upstreamRes.destroy(Error('HTML too large'));else chunks.push(chunk);});
          upstreamRes.on('error',error=>{
            if(transient.has(error.code)){if(!retry(error.code))unavailable();}
            else{settled=true;localError(res,502,'无法加载页面');}
          });
          upstreamRes.on('end',()=>{
            if(settled||cancelled||closed)return;settled=true;
            const body=Buffer.from(injectAutoFill(Buffer.concat(chunks).toString('utf8')));
            delete outputHeaders['etag'];delete outputHeaders['content-md5'];outputHeaders['content-length']=body.length;
            if(attempt)report(`web ${category} recovered attempts=${attempt+1}`);
            res.writeHead(200,outputHeaders);res.end(body);
          });return;
        }
        settled=true;
        if(attempt)report(`web ${category} recovered attempts=${attempt+1}`);
        res.writeHead(upstreamRes.statusCode||502,outputHeaders);
        upstreamRes.on('error',()=>res.destroy());upstreamRes.pipe(res);
      }));
      upstream.on('timeout',()=>upstream.destroy(Object.assign(Error('timeout'),{code:'ETIMEDOUT'})));
      upstream.on('error',error=>{
        if(settled||cancelled||closed)return;
        if(transient.has(error.code)){if(!retry(error.code))unavailable();}
        else{settled=true;report(`web ${category} failed code=NON_TRANSIENT`);localError(res,502,'无法建立安全连接，请检查 CMCP 日志和网络设置');}
      });
      // Bound TLS/header stalls, without imposing that deadline on downloads.
      if(safe)headerTimer=setTimeout(()=>upstream.destroy(Object.assign(Error('header timeout'),{code:'ETIMEDOUT'})),headerTimeout);
      if(safe){req.resume();upstream.end();}
      else{
        let bytes=0;
        req.on('data',chunk=>{bytes+=chunk.length;if(bytes>64*1024*1024){cancel();localError(res,413,'Request too large');}});
        req.pipe(upstream);
      }
    }
    run();
  }

  server = http.createServer((req, res) => {
    if (!localOrigin || req.headers.host !== new URL(localOrigin).host) return localError(res, 421, 'Host not allowed');
    const local = localPath(req.url, localOrigin);
    if (!local) return localError(res, 400, 'Invalid request path');
    if (local.pathname === '/__mcp/claim' && req.method === 'POST') {
      if (req.headers.origin !== localOrigin || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] || ''))) return localError(res, 403, 'Claim origin not allowed');
      collect(req, 4096).then(data => {
        let value; try { value = JSON.parse(data.toString('utf8')); } catch {}
        const supplied = createHmac('sha256', key).update(String(value?.token || '')).digest();
        if (!safeEqual(supplied, claimDigest)) return localError(res, 404, 'Not found');
        res.writeHead(204, { 'set-cookie': `${gateCookie}=${gateToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
        res.end();
      }).catch(() => localError(res, 400, 'Invalid claim'));
      return;
    }
    if (req.method === 'GET' && (local.pathname === '/__mcp/open' || (local.pathname === '/' && !gateOk(req)))) {
      const body = Buffer.from(BOOTSTRAP_HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return res.end(body);
    }
    if(local.pathname==='/__mcp/autofill.js'&&req.method==='GET'){
      if(!gateOk(req)||typeof autoPassword!=='function')return localError(res,403,'Browser entry required');
      const body=autoFillSource(autoMarker);res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(body);
    }
    if (local.pathname.startsWith('/__mcp/')) return localError(res, 404, 'Not found');
    if (!gateOk(req)) return localError(res, 403, 'Browser entry required');
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin !== localOrigin) return localError(res, 403, 'Same-origin request required');
    const length = Number(req.headers['content-length'] || 0);
    if (length > 64 * 1024 * 1024) return localError(res, 413, 'Request too large');
    proxyHttp(req, res, local);
  });
  server.on('upgrade', (req, client, head) => {
    const local = localPath(req.url, localOrigin);
    if (!local || req.headers.host !== new URL(localOrigin).host || req.headers.origin !== localOrigin || !gateOk(req) || !sessionId) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const target = upstreamUrl(local);
    target.searchParams.set('access', sessionId);
    const headers = requestHeaders(req, target, true);
    const upstream = track(transport.request(target, { method: 'GET', headers, agent, rejectUnauthorized: true, timeout: 30000 }));
    activeSockets.add(client);
    const cleanup = () => { activeSockets.delete(client); try { upstream.destroy(); } catch {} };
    client.once('close', cleanup);
    client.on('error', cleanup);
    upstream.once('upgrade', (response, remoteSocket, remoteHead) => {
      if (response.statusCode !== 101) { remoteSocket.destroy(); client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return cleanup(); }
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage || 'Switching Protocols'}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const keyName = response.rawHeaders[i];
        if (HOP_HEADERS.has(keyName.toLowerCase()) && !['connection','upgrade'].includes(keyName.toLowerCase())) continue;
        lines.push(`${keyName}: ${response.rawHeaders[i + 1]}`);
      }
      client.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) remoteSocket.write(head);
      if (remoteHead?.length) client.write(remoteHead);
      activeSockets.add(remoteSocket);
      remoteSocket.setTimeout(0);
      client.once('close', () => remoteSocket.destroy());
      remoteSocket.once('close', () => client.destroy());
      remoteSocket.on('error', () => client.destroy());
      remoteSocket.once('close', () => activeSockets.delete(remoteSocket));
      remoteSocket.once('close', cleanup);
      client.pipe(remoteSocket).pipe(client);
    });
    upstream.once('response', response => {
      // An individual socket can use a different authentication protocol.
      // Only /api/auth/session may declare the browser session expired.
      response.resume();
      client.end(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      cleanup();
    });
    upstream.once('error', () => { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); cleanup(); });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.end();
  });
  server.on('connection', socket => { activeSockets.add(socket); socket.on('close', () => activeSockets.delete(socket)); });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    name,
    launchUrl: `${localOrigin}/__mcp/open#${claimToken}`,
    localOrigin,
    getSessionId: () => sessionId || null,
    getSessionAuth: () => sessionId ? {sessionId, ...(remoteCookie ? {cookie:remoteCookie} : {})} : null,
    invalidateSession: expected => clearSession(expected),
    hasSession: () => !!sessionId,
    getLoginIssue: () => autoIssue,
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      sessionId = ''; remoteCookie = undefined; passwordTag = null;
      for (const request of requests) request.destroy();
      for (const socket of activeSockets) { try { socket.destroy(); } catch {} }
      await new Promise(resolve => server.close(resolve));
    },
  };
}
