import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {RequestRecovery} from '../request-recovery.mjs';
import {startLink} from '../link-client.mjs';

const id = 'a'.repeat(32), other = 'b'.repeat(32);
const message = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'simulated-write'}};
test('duplicate execution and result query return one retained result', async () => {
  const r = new RequestRecovery(); let calls = 0;
  const forward = async () => {calls++; return {result: 'done'};};
  const first = await r.handle(id, message, 'execute', forward);
  assert.equal(first.recovery.state, 'done');
  assert.deepEqual((await r.handle(id, message, 'execute', forward)).msg, first.msg);
  assert.deepEqual((await r.handle(id, null, 'query', forward)).msg, first.msg);
  assert.equal(calls, 1);
});
test('query and duplicate while running never dispatch a second operation', async () => {
  const r = new RequestRecovery(); let release, calls = 0;
  const executing = r.handle(id, message, 'execute', () => {calls++; return new Promise(resolve => {release = resolve;});});
  assert.equal((await r.handle(id, message, 'execute')).recovery.state, 'running');
  assert.equal((await r.handle(id, null, 'query')).recovery.state, 'running');
  release({done: true}); await executing; assert.equal(calls, 1);
});
test('ID collision cannot execute a different operation', async () => {
  const r = new RequestRecovery(); await r.handle(id, message, 'execute', async () => null);
  assert.equal((await r.handle(id, {different: true}, 'execute', () => assert.fail())).recovery.state, 'conflict');
});
test('unknown and expired query never run a tool', async () => {
  let now = 0; const r = new RequestRecovery({now: () => now, ttl: 10});
  assert.equal((await r.handle(id, message, 'query', () => assert.fail())).recovery.state, 'missing');
  await r.handle(id, message, 'execute', async () => 'done'); now = 11;
  assert.equal((await r.handle(id, null, 'query', () => assert.fail())).recovery.state, 'missing');
  assert.equal(r.bytes, 0);
});
test('cache limits refuse new work and retain tombstones for oversized results', async () => {
  const r = new RequestRecovery({limit: 1, byteLimit: 8}); let calls = 0;
  const forward = async () => {calls++; return 'x'.repeat(100);};
  assert.equal((await r.handle(id, message, 'execute', forward)).recovery.state, 'done');
  assert.equal((await r.handle(id, null, 'query')).recovery.state, 'unavailable');
  assert.equal((await r.handle(id, message, 'execute', forward)).recovery.state, 'unavailable');
  assert.equal((await r.handle(other, message, 'execute', forward)).recovery.state, 'not_sent');
  assert.equal(calls, 1); assert.equal(r.bytes, 0);
});
test('session reset invalidates pending and completed results', async () => {
  const r = new RequestRecovery(); let release;
  const oldEpoch = r.epoch;
  const pending = r.handle(id, message, 'execute', () => new Promise(resolve => {release = resolve;}));
  r.reset(); release('old sensitive result');
  assert.notEqual(r.epoch, oldEpoch);
  assert.equal((await pending).recovery.state, 'missing');
  assert.equal((await r.handle(id, null, 'query')).recovery.state, 'missing');
  assert.equal(r.bytes, 0);
});
test('separate targets cannot query each other and invalid IDs never execute', async () => {
  const first = new RequestRecovery(), second = new RequestRecovery();
  await first.handle(id, message, 'execute', async () => 'private');
  assert.equal((await second.handle(id, null, 'query')).recovery.state, 'missing');
  assert.equal((await first.handle('invalid', message, 'execute', () => assert.fail())).recovery.state, 'invalid');
});
test('forward failure is retained without exposing or replaying its raw error', async () => {
  const r = new RequestRecovery(); let calls = 0;
  const first = await r.handle(id, message, 'execute', () => {calls++; throw Error('secret=do-not-return');});
  const again = await r.handle(id, null, 'query');
  assert.equal(again.error, first.error); assert.ok(!again.error.includes('secret'));
  assert.equal(calls, 1);
});

async function until(check) {const deadline = Date.now() + 7000; while (!check()) {if (Date.now() > deadline) throw Error('timeout'); await delay(10);}}
test('real reconnect recovers an in-flight result without replay, then clears it on stop', {timeout: 12000}, async t => {
  const server = http.createServer((req, res) => {res.writeHead(404); res.end();});
  const wss = new WebSocketServer({noServer: true}), connections = [], results = [], states = [];
  let forwards = 0, release;
  const gate = new Promise(resolve => {release = resolve;});
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    connections.push(ws);
    ws.on('message', raw => {const m = JSON.parse(raw); if (m.t === 'hello') ws.send(JSON.stringify({t: 'welcome'})); else results.push(m);});
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const link = startLink({name: 'isolated', machine: 'test', version: 'test',
    target: () => ({url: `http://127.0.0.1:${server.address().port}`, authMode: 'shared-browser', proxy: async () => '',
      getSessionAuth: async () => ({sessionId: 'test-session-123456789'}), getSessionId: async () => 'test-session-123456789'}),
    forward: async () => {forwards++; await gate; return {jsonrpc: '2.0', id: 1, result: {done: true}};},
    status: {set: (name, state) => states.push(state)}, log: () => {}, notify: () => {}, askPassword: () => assert.fail()});
  t.after(async () => {release(); await link.stop(); for (const ws of wss.clients) ws.terminate(); await link.done; await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));});
  const send = (wire, action) => connections.at(-1).send(JSON.stringify({t: 'req', id: wire, msg: message, recovery: {protocol: 1, requestId: id, action}}));
  await until(() => states.at(-1) === 'connected'); send('first', 'execute'); await until(() => forwards === 1);
  connections[0].terminate(); await until(() => connections.length === 2 && states.at(-1) === 'connected');
  send('query-running', 'query'); await until(() => results.some(m => m.id === 'query-running'));
  assert.equal(results.find(m => m.id === 'query-running').recovery.state, 'running');
  release(); await delay(20); send('query-done', 'query'); await until(() => results.some(m => m.id === 'query-done'));
  assert.equal(results.find(m => m.id === 'query-done').msg.result.done, true);
  send('duplicate', 'execute'); await until(() => results.some(m => m.id === 'duplicate'));
  assert.equal(forwards, 1); assert.equal(results.find(m => m.id === 'duplicate').recovery.state, 'done');
});
