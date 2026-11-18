import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createManager} from '../manager.mjs';
import {Cloud} from '../cloud-api.mjs';
test('Linux manager uses existing management API and rejects unauthenticated or cross-origin mutations', async t => {
  const address = http.Server.prototype.address;
  let blockedOnce = false;
  t.mock.method(http.Server.prototype, 'address', function () {
    const value = address.call(this);
    if (value && !blockedOnce) { blockedOnce = true; return {...value, port: 6000}; }
    return value;
  });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-manager-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const saved = new Map(), secrets = async (op, id, value) => { if (op === 'set') saved.set(id, value); if (op === 'delete') saved.delete(id); return saved.get(id); };
  const manager = await createManager({directory: dir, dispatcher: {forward: async () => ({}), close: async () => {}}, secrets, proxy: async () => '', browsers: () => [], terminals: () => [], detectShared: async () => true, checkUpdate: async () => null});
  t.after(() => manager.close());
  assert.equal(blockedOnce, true);
  assert.notEqual(new URL(manager.origin).port, '6000', 'retry a port that browsers refuse');
  const call = async (route, body, extra = {}) => {
    const response = await fetch(manager.origin + '/api/' + route, {method: body === undefined ? 'GET' : 'POST', headers: {'x-cmcp-token': manager.token, ...(body === undefined ? {} : {'content-type': 'application/json'}), ...extra}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, value: await response.json()};
  };
  assert.equal((await fetch(manager.origin + '/api/state')).status, 403);
  assert.equal((await call('targets/save', {}, {origin: 'https://evil.invalid'})).status, 403);
  const forged = await new Promise((resolve, reject) => {
    const request = http.get(manager.origin + '/api/state', {headers: {host: 'evil.invalid', 'x-cmcp-token': manager.token}}, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  assert.equal(forged, 421);
  const result = await call('targets/save', {url: 'https://fixture.invalid', label: 'Ubuntu', password: 'private-password', autoLogin: true, icon: ''});
  assert.equal(result.status, 200);
  const snapshot = (await call('state')).value;
  assert.match(snapshot.platform, /^linux-/); assert.equal(snapshot.capabilities.tray, true); assert.equal(snapshot.capabilities.selfUpdate, true);
  assert.ok(!JSON.stringify(snapshot).includes('private-password'));
  assert.ok(!fs.readFileSync(path.join(dir, 'targets.json'), 'utf8').includes('private-password'));
  const checked = await call('update/check', {});
  assert.equal(checked.status, 200); assert.equal(checked.value.state, 'latest');
  const id = result.value.id;
  const tray = (await call('tray', {})).value;
  assert.deepEqual(tray.targets, [{id, label: 'Ubuntu', state: 'stopped', enabled: false, loginMode: 'web', connectable: true}]);
  assert.equal((await call('targets/login', {id, mode: 'ssh', expectedMode: 'cloudcli'})).status, 400);
  assert.equal((await call('targets/login', {id, mode: 'ssh', expectedMode: 'web'})).status, 200);
  assert.deepEqual((await call('tray', {})).value.targets, [{id, label: 'Ubuntu', state: 'idle-ssh', enabled: false, loginMode: 'ssh', ssh: true, connectable: false}]);
  assert.equal((await call('uninstall', {})).status, 400);
  assert.equal((await call('targets/delete', {id: result.value.id})).status, 200);
  assert.equal(saved.size, 0);
});

test('CC setup uploads the Linux connector and registers both Claude clients', async t => {
  const uploads = [];
  const home = '/home/wdguest';
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    let result;
    if (pathname === '/api/sys/info') result = {home, cmcp: {protocol: 1, available: true}};
    else if (request.method === 'GET') result = {entries: ['.local', 'share', 'cloudpc-link'].map(name => ({name, kind: 'folder'}))};
    else {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploads.push(JSON.parse(Buffer.concat(chunks)));
      result = {ok: true};
    }
    response.end(JSON.stringify(result));
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const cloud = new Cloud('http://127.0.0.1:' + server.address().port, 'test-cookie', undefined, AbortSignal.timeout(5000));
  const command = t.mock.method(cloud, 'command', async (script, cwd) => {
    assert.equal(cwd, home);
    assert.match(script, /CLOUDPC_CC_SHARED=1 python3 .*cloudpc-connector-linux\.py' install --name linux-pc-files --client both --wait 60$/);
    return 'Connected: 12 local Linux PC tools\nConfig changed: 2\nConnector updated: yes\n';
  });
  assert.equal(await cloud.install(), true);
  assert.equal(command.mock.callCount(), 1);
  const connector = uploads.find(upload => upload.name === 'cloudpc-connector-linux.py');
  assert.equal(connector.dir, home + '/.local/share/cloudpc-link');
  assert.match(connector.content, /"serverInfo": \{"name": "linux-pc-files"/);
});
