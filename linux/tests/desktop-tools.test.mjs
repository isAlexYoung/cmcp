import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinuxDesktopTools} from '../desktop-tools.mjs';

test('Linux browser tool uses argument arrays for the default or explicitly selected browser', async () => {
  const calls = [];
  const tools = createLinuxDesktopTools({roots: [], browsers: () => [{id: 'firefox', path: '/test/bin/firefox'}],
    open: async (file, args) => { calls.push([file, args]); }});
  const url = 'https://example.test/?q=$(test)';
  await tools.call('linux_browser_open', {url});
  await tools.call('linux_browser_open', {url, browser: 'firefox'});
  assert.deepEqual(calls, [['xdg-open', [url]], ['/test/bin/firefox', ['--new-window', url]]]);
  await assert.rejects(tools.call('linux_browser_open', {url, browser: 'edge'}), /Browser unavailable/);
  await assert.rejects(tools.call('linux_browser_open', {url: 'file:///etc/passwd'}), /HTTP\/HTTPS/);
});

test('X11-only tools report unavailable on Wayland and headless sessions without trying a capture', async () => {
  for (const env of [{}, {DISPLAY: ':10', XDG_SESSION_TYPE: 'wayland'}]) {
    const tools = createLinuxDesktopTools({roots: [], env, run: async () => assert.fail('unexpected desktop action')});
    await assert.rejects(tools.call('linux_screenshot', {path: '/tmp/test.png'}), /X11 desktop session/);
    await assert.rejects(tools.call('linux_desktop_action', {action: 'press_keys', keys: ['Return']}), /X11 desktop session/);
  }
});
