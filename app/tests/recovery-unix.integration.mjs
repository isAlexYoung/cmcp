// Linux-only end-to-end test: actual connector and relay, real Unix sockets,
// WebSocket terminal transport, and the production Windows-side link client.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {startLink} from '../link-client.mjs';

async function until(check) {const end = Date.now() + 15000; while (!check()) {if (Date.now() > end) throw Error('condition timeout'); await delay(10);}}
test('terminal replacement recovers the result of one execution through real Python components', {timeout: 25000}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-recovery-'));
  const relayDir = path.join(directory, '.local/share/cloudpc-link'); fs.mkdirSync(relayDir, {recursive: true});
  const source = fileURLToPath(new URL('../cloudpc-relay.py', import.meta.url));
  const relayFile = path.join(relayDir, 'cloudpc-relay.py'); fs.copyFileSync(source, relayFile);
  const connectorSource = fileURLToPath(new URL('../cloudpc-connector.py', import.meta.url));
  const server = http.createServer(async (req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/sys/info')) res.end(JSON.stringify({home: directory}));
    else if (req.url.includes('read=1')) res.end(JSON.stringify({content: fs.readFileSync(source, 'utf8')}));
    else if (req.url.startsWith('/api/sys/fs')) res.end(JSON.stringify({entries: [
      ...['.local', 'share', 'cloudpc-link'].map(name => ({name, kind: 'folder'})), {name: 'cloudpc-relay.py', kind: 'file'}]}));
    else {res.writeHead(404); res.end('{}');}
  });
  const wss = new WebSocketServer({noServer: true}); const sockets = [], processes = [], states = [];
  let executions = 0, release;
  const blocked = new Promise(resolve => {release = resolve;});
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/term/ws')) {socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return;}
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.push(ws);
      const child = spawn('python3', ['-u', relayFile], {env: {...process.env, HOME: directory}, stdio: ['pipe', 'pipe', 'pipe']});
      processes.push(child); child.stderr.resume(); child.stdin.on('error', () => {});
      child.stdout.on('data', data => {if (ws.readyState === 1) ws.send(data, {binary: true});});
      ws.on('message', raw => {const m = JSON.parse(raw); if (m.t === 'i' && child.stdin.writable) child.stdin.write(m.d); else if (m.t === 'kill') child.stdin.end();});
      ws.on('close', () => child.stdin.end());
      child.on('exit', code => {if (ws.readyState === 1) ws.send(JSON.stringify({t: 'exit', code}));});
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const link = startLink({name: 'isolated-python', machine: 'test', version: '4.1.1',
    target: () => ({url: `http://127.0.0.1:${server.address().port}`, authMode: 'shared-browser',
      proxy: async () => '', getSessionAuth: async () => ({sessionId: 'isolated-session-12345'}), getSessionId: async () => 'isolated-session-12345'}),
    forward: async msg => {executions++; await blocked; return {jsonrpc: '2.0', id: msg.id, result: {completed: true}};},
    status: {set: (name, state) => states.push(state)}, log: () => {}, notify: () => {}, askPassword: () => assert.fail()});
  t.after(async () => {
    release(); await link.stop(); for (const ws of wss.clients) ws.terminate(); await link.done;
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(processes.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit')));
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
    // This path is the verified mkdtemp result and contains fixture files only.
    fs.rmSync(directory, {recursive: true, force: true});
  });
  await until(() => states.at(-1) === 'connected');
  const program = `import importlib.util,json; s=importlib.util.spec_from_file_location('c',${JSON.stringify(connectorSource)}); c=importlib.util.module_from_spec(s); s.loader.exec_module(c); print(json.dumps(c.Link(recovery_wait=8,poll=0.02).request({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'simulated_write'}})),flush=True)`;
  const client = spawn('python3', ['-c', program], {env: {...process.env, HOME: directory, PYTHONDONTWRITEBYTECODE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  processes.push(client); let output = '', errors = '';
  client.stdout.on('data', data => {output += data;}); client.stderr.on('data', data => {errors += data;});
  const completed = once(client, 'exit');
  await until(() => executions === 1); sockets[0].terminate();
  await until(() => sockets.length >= 2 && states.at(-1) === 'connected');
  release(); const [code] = await completed;
  assert.equal(code, 0, errors); assert.equal(JSON.parse(output).result.completed, true);
  assert.equal(executions, 1);
  await link.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(relayDir, 'manual-stop.json'), 'utf8')).stopped, true);
});
