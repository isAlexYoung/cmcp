import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectBrowsers, openPage, pageFolder, profileFolder, closePages} from '../browsers.mjs';
import {openTerminal, webTunnelEnvironment} from '../ssh.mjs';
const fixture = t => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-'))); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; };
test('Snap browser profiles use their own writable common area and remain device-isolated', t => {
  const dir = fixture(t), browser = {id: 'firefox', snap: 'firefox'};
  const first = profileFolder(dir, 'one', browser, dir);
  assert.ok(first.startsWith(path.join(dir, 'snap/firefox/common/cmcp')));
  assert.notEqual(first, profileFolder(dir, 'two', browser, dir));
  assert.notEqual(first, profileFolder(dir + '-other', 'one', browser, dir));
});
test('browser detection and launch keep paths and metacharacters in separate arguments', async t => {
  const dir = fixture(t), calls = [], run = async (...args) => { calls.push(args); };
  const firefox = path.join(dir, 'firefox');
  fs.writeFileSync(firefox, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const found = detectBrowsers(name => name === 'firefox' ? firefox : null);
  assert.deepEqual(found.map(item => item.id), ['firefox']);
  const url = 'https://example.test/?value=$(echo+bad)';
  await openPage({}, dir, 'one', url, {found, run});
  assert.deepEqual(calls.pop(), ['xdg-open', [url]]);
  await openPage({browser: 'firefox', closeWeb: true}, dir, 'one', url, {found, run});
  const call = calls.pop(); assert.equal(call[0], firefox);
  assert.deepEqual(call[1], ['--no-remote', '--profile', pageFolder(dir, 'one', 'firefox'), '--new-window', url]);
  await assert.rejects(openPage({}, dir, 'one', 'file:///etc/passwd', {found, run}), /Invalid/);
});
test('Ubuntu 22.04 GNOME launches Chrome and Edge with a separate direct-keyring profile', async t => {
  const dir = fixture(t), calls = [], run = async (...args) => { calls.push(args); };
  const url = 'https://example.test/';
  const found = ['chrome', 'edge'].map(id => ({id, path: '/usr/bin/' + id}));
  for (const browser of found) {
    const profile = pageFolder(dir, 'one', browser.id);
    fs.mkdirSync(profile, {recursive: true});
    const original = path.join(profile, 'Local State');
    fs.writeFileSync(original, 'Existing browser state');
    for (const closeWeb of [false, true]) {
      await openPage({browser: browser.id, closeWeb}, dir, 'one', url, {found, run, jammyGnome: true});
      assert.deepEqual(calls.pop(), [browser.path, [
        '--disable-features=DbusSecretPortal', '--user-data-dir=' + profile + '-direct-keyring',
        '--no-first-run', '--no-default-browser-check', '--new-window', url,
      ]]);
    }
    assert.equal(fs.readFileSync(original, 'utf8'), 'Existing browser state');
    assert.ok(fs.statSync(profile + '-direct-keyring').isDirectory());
    await openPage({browser: browser.id}, dir, 'one', url, {found, run, jammyGnome: false});
    assert.deepEqual(calls.pop(), [browser.path, ['--new-window', url]]);
  }
  const snap = {id: 'chrome', path: '/snap/bin/chromium', snap: 'chromium'};
  await openPage({browser: 'chrome'}, dir, 'one', url, {found: [snap], run, jammyGnome: true});
  assert.deepEqual(calls.pop(), [snap.path, ['--new-window', url]]);
});
test('disconnect only closes exact owned profiles and refuses a recycled PID', async t => {
  const dir = fixture(t), folder = pageFolder(dir, 'one', 'chrome'), kills = [];
  let processes = [
    {pid: 1201, started: 'old', argv: ['chrome', '--user-data-dir=' + folder]},
    {pid: 1202, started: '2', argv: ['chrome', '--user-data-dir=' + folder + '-other']},
    {pid: 1203, started: '3', argv: ['firefox', '--profile', pageFolder(dir, 'two', 'firefox')]},
    {pid: 1204, started: '4', argv: ['chrome']},
  ];
  await closePages({browser: 'chrome', closeWeb: true}, dir, 'one', {list: async () => processes, wait: async () => {}, kill: (pid, signal) => {
    kills.push([pid, signal]); processes = processes.map(item => item.pid === pid ? {...item, started: 'recycled'} : item);
  }});
  assert.deepEqual(kills, [[1201, 'SIGTERM']]);
});
test('disconnect recognizes a Chromium process title only with the matching local profile lock', async t => {
  const dir = path.join(fixture(t), 'state with spaces');
  const oldFolder = pageFolder(dir, 'one', 'chrome');
  const folder = oldFolder + '-direct-keyring';
  for (const profile of [oldFolder, folder]) fs.mkdirSync(profile, {recursive: true});
  const lock = path.join(folder, 'SingletonLock');
  const title = (profile, flag = '') => `/opt/google/chrome/chrome ${flag}--user-data-dir=${profile} --no-first-run --no-default-browser-check --new-window https://example.test/`;
  const flag = '--disable-features=DbusSecretPortal ';
  const kills = [];
  let processes = [
    {pid: 1201, started: '1', argv: [title(folder, flag)]},
    {pid: 1202, started: '2', argv: [title(folder + '-other', flag)]},
    {pid: 1203, started: '3', argv: [title(folder, flag)]},
    {pid: 1204, started: '4', argv: [title(oldFolder)]},
  ];
  const options = {jammyGnome: true, list: async () => processes, wait: async () => {}, kill: (pid, signal) => {
    kills.push([pid, signal]);
    processes = processes.filter(item => item.pid !== pid);
  }};
  const preferences = {browser: 'chrome', closeWeb: true};
  fs.symlinkSync(os.hostname() + '-1202', lock);
  assert.equal(await closePages(preferences, dir, 'one', options), 0);
  fs.unlinkSync(lock);
  fs.symlinkSync(os.hostname() + '-1201', lock);
  fs.symlinkSync(os.hostname() + '-1204', path.join(oldFolder, 'SingletonLock'));
  assert.equal(await closePages({...preferences, closeWeb: false}, dir, 'one', options), 0);
  assert.equal(await closePages(preferences, dir, 'one', options), 2);
  assert.deepEqual(kills, [[1201, 'SIGTERM'], [1204, 'SIGTERM']]);
});
test('Linux SSH launcher uses the Linux askpass path and never puts a password into argv or script', async t => {
  const dir = fixture(t), login = {id: 'd', host: 'example.test', port: 22, username: 'ubuntu', method: 'password', credentialId: 'secret-reference'};
  const env = webTunnelEnvironment(login, dir);
  assert.ok(fs.readFileSync(env.SSH_ASKPASS, 'utf8').includes('ssh-askpass.mjs'));
  assert.ok(fs.readFileSync(env.SSH_ASKPASS, 'utf8').includes('linux'));
  let call;
  await openTerminal(login, dir, 'gnome-terminal', {found: [{id: 'gnome-terminal', path: '/usr/bin/gnome-terminal'}], run: async (...args) => { call = args; }, closeTerminal: true});
  assert.deepEqual(call[1].slice(0, 3), ['--wait', '--', '/bin/sh']);
  const text = fs.readFileSync(call[1][3], 'utf8');
  assert.ok(text.includes('ssh-terminal.mjs')); assert.ok(!text.includes('secret-reference')); assert.ok(!text.includes('osascript'));
});
