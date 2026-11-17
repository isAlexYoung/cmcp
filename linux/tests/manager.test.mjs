import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createManager} from '../manager.mjs';
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
  assert.match(snapshot.platform, /^linux-/); assert.equal(snapshot.capabilities.tray, false); assert.equal(snapshot.capabilities.selfUpdate, true);
  assert.ok(!JSON.stringify(snapshot).includes('private-password'));
  assert.ok(!fs.readFileSync(path.join(dir, 'targets.json'), 'utf8').includes('private-password'));
  const checked = await call('update/check', {});
  assert.equal(checked.status, 200); assert.equal(checked.value.state, 'latest');
  assert.equal((await call('uninstall', {})).status, 400);
  assert.equal((await call('targets/delete', {id: result.value.id})).status, 200);
  assert.equal(saved.size, 0);
});
