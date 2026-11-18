// Run against the packaged dispatcher under Xvfb. Never target the user's active display.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const install = process.env.CMCP_SMOKE_ROOT || '/opt/cmcp';
const {createDispatcher} = await import(pathToFileURL(path.join(install, 'linux/dispatcher.mjs')));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-native-tools-'));
const root = path.join(base, 'allowed');
fs.mkdirSync(root);
let dispatcher, child, lines;
try {
  dispatcher = await createDispatcher({roots: [root], stateDir: path.join(base, 'state'), registryOptions: {watch: false}});
  async function call(name, args) {
    const value = await dispatcher.forward({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
    return value.result ?? value.error;
  }
  async function ok(name, args) {
    const value = await call(name, args);
    assert.ok(!value.isError && value.structuredContent, JSON.stringify(value));
    return value.structuredContent;
  }

  const screenshot = path.join(root, 'screen.png');
  const captured = await ok('linux_screenshot', {path: screenshot, monitor: 0, x: 12, y: 14, width: 100, height: 70});
  const image = fs.readFileSync(screenshot);
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [100, 70]);
  assert.deepEqual([captured.x, captured.y, captured.width, captured.height], [12, 14, 100, 70]);
  assert.equal(fs.statSync(screenshot).mode & 0o777, 0o600);
  assert.ok((await call('linux_screenshot', {path: screenshot})).isError);
  assert.ok((await call('linux_screenshot', {path: path.join(base, 'outside.png')})).isError);
  fs.symlinkSync(base, path.join(root, 'outside'));
  assert.ok((await call('linux_screenshot', {path: path.join(root, 'outside', 'escaped.png')})).isError);
  assert.ok((await call('linux_screenshot', {path: path.join(root, 'invalid.png'), monitor: 255})).isError);

  child = spawn('/usr/bin/python3', ['-B', '-u', '-c', `
import gi
gi.require_version('Gtk','3.0')
gi.require_version('GdkX11','3.0')
from gi.repository import Gtk, GdkX11, GLib
import json
window = Gtk.Window(title='CMCP X11 smoke text entry')
window.set_default_size(350, 70)
entry = Gtk.Entry()
window.add(entry)
entry.connect('activate', lambda value: print(json.dumps(value.get_text()), flush=True))
window.show_all()
entry.grab_focus()
def ready():
    native = window.get_window()
    _, x, y = native.get_origin()
    print(json.dumps([native.get_xid(), x + 80, y + 30]), flush=True)
GLib.idle_add(ready)
Gtk.main()
`], {stdio: ['ignore', 'pipe', 'inherit']});
  lines = createInterface({input: child.stdout});
  const next = () => once(lines, 'line', {signal: AbortSignal.timeout(6000)}).then(([line]) => JSON.parse(line));
  const [xid, x, y] = await next();
  await ok('linux_run_program', {program: 'xdotool', args: ['windowfocus', '--sync', String(xid)]});
  await ok('linux_desktop_action', {action: 'move_mouse', x, y});
  await ok('linux_desktop_action', {action: 'click', x, y});
  await ok('linux_desktop_action', {action: 'double_click', x, y});
  const text = '-- CMCP 中文输入测试：截图与键盘';
  await ok('linux_desktop_action', {action: 'type_text', text});
  let entered = next();
  await ok('linux_desktop_action', {action: 'press_keys', keys: ['Return']});
  assert.equal(await entered, text);
  await ok('linux_desktop_action', {action: 'hotkey', keys: ['Ctrl', 'a']});
  await ok('linux_desktop_action', {action: 'type_text', text: 'hotkey replaced entry'});
  entered = next();
  await ok('linux_desktop_action', {action: 'press_keys', keys: ['Return']});
  assert.equal(await entered, 'hotkey replaced entry');
  console.log('Packaged Linux MCP X11 screenshot, file-root protection, mouse and Unicode keyboard passed');
} finally {
  lines?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'close');
    child.kill();
    await exited;
  }
  await dispatcher?.close();
  fs.rmSync(base, {recursive: true, force: true});
}
