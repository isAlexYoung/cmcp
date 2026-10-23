import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { TerminalLink } from '../terminal-link.mjs';
import { startLink } from '../link-client.mjs';

const prefix = 'CPCMCP1:';
const frame = message => Buffer.from(prefix + Buffer.from(JSON.stringify(message)).toString('base64') + '\n');
const hash = text => createHash('sha256').update(text).digest('hex');
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('condition timeout'); await delay(10); }
}
async function terminal(t, handler) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  wss.on('connection', ws => { handler(ws); ws.send(frame({ t: 'ready' })); });
  const link = new TerminalLink(`ws://127.0.0.1:${wss.address().port}`, {});
  link.on('error', () => {});
  t.after(async () => { link.terminate(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); });
  await once(link, 'open');
  return link;
}

test('terminal output accepts split frames, coalesced frames and shell noise', { timeout: 5000 }, async t => {
  let remote;
  const link = await terminal(t, ws => { remote = ws; });
  const received = [];
  link.on('message', data => received.push(JSON.parse(data)));
  const bytes = Buffer.concat([Buffer.from('\x1b[?2004l\r\n'), frame({ t: 'req', id: '一', msg: '中文 🌱' }), frame({ t: 'welcome' })]);
  remote.send(bytes.subarray(0, 25));
  remote.send(bytes.subarray(25, 64));
  remote.send(bytes.subarray(64));
  await until(() => received.length === 2);
  assert.deepEqual(received, [{ t: 'req', id: '一', msg: '中文 🌱' }, { t: 'welcome' }]);
});

test('multi-megabyte responses retain content and bound packets awaiting acknowledgement', { timeout: 15000 }, async t => {
  let result;
  let maximum = 0;
  let outstanding = 0;
  const chunks = [];
  const link = await terminal(t, ws => ws.on('message', raw => {
    const input = JSON.parse(raw);
    if (input.t !== 'i') return;
    const packet = JSON.parse(input.d.slice(prefix.length));
    chunks.push(packet.data);
    maximum = Math.max(maximum, ++outstanding);
    setTimeout(() => { outstanding--; ws.send(frame({ t: 'ack', id: packet.id, n: packet.n })); }, 2);
    if (packet.end) result = Buffer.from(chunks.join(''), 'base64').toString('utf8');
  }));
  const source = JSON.stringify({ t: 'res', id: 'large', msg: randomBytes(3 * 1024 * 1024).toString('base64') + '中文' });
  link.send(source);
  await link.queue;
  assert.equal(hash(result), hash(source));
  assert.ok(maximum <= 8 && maximum > 1, `in-flight window: ${maximum}`);
  assert.equal(link.acks.size, 0);
});

test('disconnect cancels outstanding chunks and queued responses', { timeout: 5000 }, async t => {
  const link = await terminal(t, ws => ws.on('message', () => ws.terminate()));
  link.send(JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }));
  link.send('queued');
  await link.queue;
  assert.equal(link.ended, true);
  assert.equal(link.acks.size, 0);
});

test('synchronous send failure clears acknowledgements for unsent chunks', { timeout: 5000 }, async t => {
  const link = await terminal(t, () => {});
  link.packet = () => { throw new Error('simulated send failure'); };
  link.send(JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }));
  await link.queue;
  assert.equal(link.ended, true);
  assert.equal(link.acks.size, 0);
});

async function desktop(t, native, shared = false, nativeStatus = 404, requiredCookie = '') {
  const counts = { login: 0, native: 0, terminal: 0, uploads: 0, invalidations: 0, sessionChecks: 0 };
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let body = '';
    for await (const bytes of req) body += bytes;
    if (req.url === '/api/auth/session') {
      counts.sessionChecks++;
      res.writeHead(shared && req.headers['x-desktop-session'] === 'shared-desktop-session-123' && (!requiredCookie || req.headers.cookie === requiredCookie) ? 200 : 404);
      res.end('{}');
    }
    else if (shared && req.url.startsWith('/api/sys') && (req.headers['x-desktop-session'] !== 'shared-desktop-session-123' || (requiredCookie && req.headers.cookie !== requiredCookie))) { res.writeHead(401); res.end('{}'); }
    else if (req.url === '/api/auth/login') {
      counts.login++; res.setHeader('set-cookie', 'wd_session=test; HttpOnly'); res.end('{}');
    } else if (req.url.startsWith('/api/sys/info')) res.end(JSON.stringify({ home: '/home/user' }));
    else if (req.url.startsWith('/api/sys/fs') && req.method === 'GET') {
      res.end(JSON.stringify({ entries: ['.local', 'share', 'cloudpc-link'].map(name => ({ name, kind: 'folder' })) }));
    } else { counts.uploads++; res.end('{}'); }
  });
  const wss = new WebSocketServer({ noServer: true });
  const connections = [];
  const replies = [];
  server.on('upgrade', (req, socket, head) => {
    if (shared) {
      assert.equal(new URL(req.url, 'http://test').searchParams.get('access'), 'shared-desktop-session-123');
      assert.equal(req.headers['x-desktop-session'], 'shared-desktop-session-123');
      if (requiredCookie) assert.equal(req.headers.cookie, requiredCookie);
    }
    if (req.url.startsWith('/api/pclink/ws')) {
      counts.native++;
      if (!native) return socket.end(`HTTP/1.1 ${nativeStatus} Unavailable\r\nContent-Length: 0\r\n\r\n`);
    } else counts.terminal++;
    wss.handleUpgrade(req, socket, head, ws => {
      connections.push(ws);
      const parts = [];
      const send = m => ws.send(native ? JSON.stringify(m) : frame(m));
      ws.on('message', raw => {
        let m = JSON.parse(raw);
        if (!native) {
          if (m.t !== 'i') return;
          const packet = JSON.parse(m.d.slice(prefix.length));
          if (packet.t === 'ping') return send({ t: 'pong' });
          parts.push(packet.data);
          send({ t: 'ack', id: packet.id, n: packet.n });
          if (!packet.end) return;
          m = JSON.parse(Buffer.from(parts.join(''), 'base64'));
          parts.length = 0;
        }
        if (m.t === 'hello') {
          send({ t: 'welcome' });
          send({ t: 'req', id: 'test-call', msg: { jsonrpc: '2.0', id: 7, method: 'tools/list' } });
        } else if (m.t === 'res') replies.push(m);
      });
      if (!native) send({ t: 'ready' });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const states = [];
  const link = startLink({ name: 'test', machine: 'test-machine', version: 'test',
    target: () => ({ url: `http://127.0.0.1:${server.address().port}`, authMode: shared ? 'shared-browser' : 'legacy', getSessionId: () => 'shared-desktop-session-123', getSessionAuth: () => ({sessionId:'shared-desktop-session-123', ...(requiredCookie ? {cookie:requiredCookie} : {})}), invalidateSession: () => { counts.invalidations++; }, password: async () => 'test', proxy: async () => '' }),
    forward: async msg => ({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }),
    askPassword: async () => false, notify: () => {}, log: () => {}, status: { set: (name, state, message) => states.push({ state, message }) },
  });
  t.after(async () => { link.stop(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  await until(() => replies.length === 1);
  return { counts, connections, replies, states };
}

test('native desktop stays on dedicated transport and forwards JSON-RPC', { timeout: 5000 }, async t => {
  const d = await desktop(t, true);
  assert.equal(d.counts.native, 1);
  assert.equal(d.counts.terminal, 0);
  assert.equal(d.states.at(-1).message, '已连接');
  assert.deepEqual(d.replies[0].msg, { jsonrpc: '2.0', id: 7, result: { tools: [] } });
});

test('shared session authenticates terminal APIs and WebSocket without password login', { timeout:5000 }, async t => {
  const d = await desktop(t, false, true);
  assert.equal(d.counts.login, 0);
  assert.equal(d.counts.terminal, 1);
  assert.equal(d.replies.length, 1);
});

test('a dedicated socket 401 with a valid browser session selects terminal without logging the browser out', { timeout:7000 }, async t => {
  const d = await desktop(t, false, true, 401);
  assert.equal(d.counts.native, 1);
  assert.equal(d.counts.terminal, 1);
  assert.equal(d.counts.sessionChecks, 1);
  assert.equal(d.counts.invalidations, 0);
  assert.equal(d.counts.login, 0);
  assert.equal(d.replies.length, 1);
});

test('terminal fallback preserves both cookie and exclusive-session credentials', {timeout:7000}, async t=>{
  const d=await desktop(t,false,true,401,'wd_session=fixture-cookie');
  assert.equal(d.counts.invalidations,0);assert.equal(d.counts.login,0);
  assert.equal(d.counts.terminal,1);assert.equal(d.replies.length,1);
});

test('HTTP 404 selects terminal transport; reconnect remembers it; takeover stops retrying', { timeout: 10000 }, async t => {
  const d = await desktop(t, false);
  assert.equal(d.counts.native, 1);
  assert.equal(d.counts.terminal, 1);
  assert.equal(d.counts.uploads, 1);
  assert.equal(d.states.at(-1).message, '已连接（兼容模式）');
  d.connections[0].terminate();
  await until(() => d.replies.length === 2);
  assert.equal(d.counts.native, 1);
  assert.equal(d.counts.terminal, 2);
  d.connections[1].send(frame({ t: 'close', code: 4002, reason: 'replaced' }));
  await until(() => d.states.at(-1).state === 'replaced');
  await delay(1250);
  assert.equal(d.counts.terminal, 2);
});
