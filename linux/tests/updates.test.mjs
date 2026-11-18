import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {selectRelease, checkRelease, downloadUpdate} from '../updates.mjs';

function release(version = '4.24.0', platform = 'linux-x64') {
  const tag = 'v' + version, name = `CMCP-${version}-${platform}.zip`;
  return {draft: false, prerelease: false, tag_name: tag, assets: [name, name + '.sha256'].map(name => ({name, size: name.endsWith('.sha256') ? 100 : 7, browser_download_url: 'https://github.com/isAlexYoung/cmcp/releases/download/' + tag + '/' + name}))};
}
const isReleaseList = url => new URL(url).pathname === '/repos/isAlexYoung/cmcp/releases';
test('Linux updater selects only its exact stable asset and rejects other architectures or untrusted URLs', () => {
  const r = release();
  assert.equal(selectRelease(r, '4.23.2', 'x64').name, 'CMCP-4.24.0-linux-x64.zip');
  assert.equal(selectRelease(r, '4.24.0', 'x64'), null);
  for (const changed of [{...r, draft: true}, {...r, prerelease: true}, {...r, assets: [r.assets[0], ...r.assets]}, {...r, assets: r.assets.map(a => ({...a, browser_download_url: 'https://evil.invalid/' + a.name}))}]) assert.throws(() => selectRelease(changed, '4.23.2', 'x64'));
  assert.throws(() => selectRelease(r, '4.23.2', 'arm64'));
});
test('Linux checks across pages and ignores stable releases for other platforms', async () => {
  const firstPage = Array.from({length: 30}, (_, i) => release(`4.23.${30 + i}`, 'windows-x64'));
  firstPage[0] = {...release('4.27.0'), prerelease: true};
  firstPage[1] = release('4.24.0');
  const pages = [firstPage, [release('4.24.1'), release('4.25.0', 'macos-arm64')]];
  const seen = [];
  const fetch = async (url, {proxy}) => {
    assert.equal(isReleaseList(url), true);
    assert.equal(proxy, 'http://127.0.0.1:7897');
    const page = Number(new URL(url).searchParams.get('page'));
    seen.push(page);
    return Buffer.from(JSON.stringify(pages[page - 1]));
  };
  assert.equal((await checkRelease('4.23.3', 'x64', 'http://127.0.0.1:7897', fetch)).version, '4.24.1');
  assert.deepEqual(seen, [1, 2]);
  assert.equal(await checkRelease('4.24.1', 'x64', 'http://127.0.0.1:7897', fetch), null);
});
test('Linux reports incomplete local assets as an error rather than up to date', async () => {
  const r = release();
  await assert.rejects(checkRelease('4.23.3', 'x64', '', async () => Buffer.from(JSON.stringify([{...r, assets: [r.assets[0]]}]))), /校验文件无效/);
});
test('Linux download verifies measured progress, GitHub digest and checksum before staging private bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-update-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const r = release(), bytes = Buffer.from('payload'), hash = createHash('sha256').update(bytes).digest('hex'), events = [];
  r.assets[0].digest = 'sha256:' + hash;
  const fetch = async (url, options) => {
    assert.equal(options.proxy, 'http://127.0.0.1:7897');
    if (isReleaseList(url)) return Buffer.from(JSON.stringify([r]));
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
  const fetch = async url => isReleaseList(url) ? Buffer.from(JSON.stringify([r])) : url.endsWith('.sha256') ? Buffer.from('0'.repeat(64) + '  ' + r.assets[0].name) : Buffer.from('payload');
  await assert.rejects(downloadUpdate({current: '4.23.2', arch: 'x64', directory, fetch}), e => e.code === 'checksum');
  assert.deepEqual(fs.readdirSync(directory), ['targets.json']);
});
