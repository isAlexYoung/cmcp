import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {selectRelease, downloadUpdate} from '../updates.mjs';

function release() {
  const name = 'CMCP-4.24.0-linux-x64.zip';
  return {draft: false, prerelease: false, tag_name: 'v4.24.0', assets: [name, name + '.sha256'].map(name => ({name, size: name.endsWith('.sha256') ? 100 : 7, browser_download_url: 'https://github.com/isAlexYoung/cmcp/releases/download/v4.24.0/' + name}))};
}
test('Linux updater selects only its exact stable asset and rejects other architectures or untrusted URLs', () => {
  const r = release();
  assert.equal(selectRelease(r, '4.23.2', 'x64').name, 'CMCP-4.24.0-linux-x64.zip');
  assert.equal(selectRelease(r, '4.24.0', 'x64'), null);
  for (const changed of [{...r, draft: true}, {...r, prerelease: true}, {...r, assets: [r.assets[0], ...r.assets]}, {...r, assets: r.assets.map(a => ({...a, browser_download_url: 'https://evil.invalid/' + a.name}))}]) assert.throws(() => selectRelease(changed, '4.23.2', 'x64'));
  assert.throws(() => selectRelease(r, '4.23.2', 'arm64'));
});
test('Linux download verifies measured progress, GitHub digest and checksum before staging private bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-update-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const r = release(), bytes = Buffer.from('payload'), hash = createHash('sha256').update(bytes).digest('hex'), events = [];
  r.assets[0].digest = 'sha256:' + hash;
  const fetch = async (url, options) => {
    assert.equal(options.proxy, 'http://127.0.0.1:7897');
    if (url.endsWith('/latest')) return Buffer.from(JSON.stringify(r));
    if (url.endsWith('.sha256')) return Buffer.from(hash + '  ' + r.assets[0].name);
    options.onProgress(3, 7); options.onProgress(7, 7); return bytes;
  };
  const prepared = await downloadUpdate({current: '4.23.2', arch: 'x64', proxy: 'http://127.0.0.1:7897', directory, fetch, onProgress: e => events.push(e)});
  assert.equal(prepared.version, '4.24.0');
  assert.deepEqual(fs.readFileSync(prepared.zip), bytes);
  assert.ok(events.some(e => e.phase === 'download' && e.received === 3 && e.total === 7));
  assert.equal(events.at(-1).phase, 'ready');
  if (process.platform !== 'win32') assert.equal(fs.statSync(prepared.zip).mode & 0o077, 0);
});
test('corrupt Linux downloads leave no staged update and retain the existing configuration', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-bad-update-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'targets.json'), 'KEEP');
  const r = release();
  const fetch = async url => url.endsWith('/latest') ? Buffer.from(JSON.stringify(r)) : url.endsWith('.sha256') ? Buffer.from('0'.repeat(64) + '  ' + r.assets[0].name) : Buffer.from('payload');
  await assert.rejects(downloadUpdate({current: '4.23.2', arch: 'x64', directory, fetch}), e => e.code === 'checksum');
  assert.deepEqual(fs.readdirSync(directory), ['targets.json']);
});
