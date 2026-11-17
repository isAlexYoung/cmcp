import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keychain, proxyFor} from '../platform.mjs';
import {groupOf, parseManifest, defaultSecretStore} from '../../app/mcp-tools.mjs';
import {connectorSource} from '../connector-source.mjs';
import {bootstrapPayload} from '../../app/ssh-mcp.mjs';

test('Linux secrets cross stdin only and retain Unicode and trailing newlines', async () => {
  const id = randomUUID(), secret = '密钥 " $()\n\n', calls = [];
  let saved;
  const runner = async (file, args, options) => {
    calls.push({file, args, options});
    if (args[0] === 'store') saved = options.input;
    if (args[0] === 'lookup') return saved + '\n';
    return '';
  };
  await keychain('set', id, secret, runner);
  assert.equal(await keychain('get', id, undefined, runner), secret);
  await keychain('delete', id, undefined, runner);
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes(secret)));
  assert.equal(calls[0].file, 'secret-tool');
  await assert.rejects(keychain('get', '../invalid', undefined, runner), /无效/);
});
test('missing or locked Secret Service reports failure without a plaintext fallback', async () => {
  await assert.rejects(keychain('set', randomUUID(), 'secret', async () => { throw Object.assign(Error('stderr with secrets'), {code: 'ENOENT'}); }), /不会回退到明文/);
  await assert.rejects(keychain('get', randomUUID(), undefined, async () => 'unrecognized secret\n'), /无法访问/);
  assert.ok(defaultSecretStore('linux'));
});
test('Linux proxy selection honors explicit settings, environment and GNOME, with no PAC fallback', async () => {
  const never = () => assert.fail('must not read system settings');
  assert.equal(await proxyFor('', {preferences: {proxyMode: 'direct'}, runner: never}), '');
  assert.equal(await proxyFor('', {preferences: {proxyMode: 'manual', proxyHost: '127.0.0.1', proxyPort: 7897}, runner: never}), 'http://127.0.0.1:7897');
  assert.equal(await proxyFor('', {env: {HTTPS_PROXY: 'http://localhost:7897'}, runner: never}), 'http://localhost:7897/');
  assert.equal(await proxyFor('', {env: {}, runner: async () => "'none'\n"}), '');
  await assert.rejects(proxyFor('', {env: {}, runner: async () => "'auto'"}), /PAC/);
  await assert.rejects(proxyFor('', {env: {HTTPS_PROXY: 'socks5://localhost:7897'}}), /仅支持/);
});
test('Linux builtins respect group switches and Linux-only manifests cannot run on other platforms', () => {
  assert.equal(groupOf('linux_execute'), 'commands');
  assert.equal(groupOf('linux_binary_write'), 'files');
  assert.equal(groupOf('linux_start_process'), 'processes');
  const manifest = JSON.stringify({schema: 1, name: 'Fixture', description: 'Linux platform fixture', version: '1.0.0', transport: 'stdio', command: 'node', args: [], capabilities: ['exec'], platforms: ['linux']});
  assert.deepEqual(parseManifest(manifest, {id: 'fixture', dir: process.cwd(), platform: 'linux'}).errors, []);
  assert.ok(parseManifest(manifest, {id: 'fixture', dir: process.cwd(), platform: 'darwin'}).errors.some(error => error.includes('not available')));
});
test('Linux relay payload identifies the physical Linux PC and includes Linux transfer tools', () => {
  const source = connectorSource();
  assert.ok(source.includes('linux_download_to_cloud'));
  assert.ok(source.includes('linux_path'));
  assert.ok(source.includes('linux-pc-files'));
  assert.ok(!source.includes('mac_binary_info'));
  assert.equal(bootstrapPayload('fixture', {}, 'linux').connector, source);
  assert.ok(bootstrapPayload('fixture', {}, 'darwin').connector.includes('mac_binary_info'));
  assert.ok(bootstrapPayload('fixture', {}, 'win32').connector.includes('windows_binary_info'));
});
