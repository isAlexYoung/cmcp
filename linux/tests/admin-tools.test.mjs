import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLinuxAdminTools} from '../admin-tools.mjs';
import {groupOf} from '../../app/mcp-tools.mjs';

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-admin-test-'));
  t.after(() => fs.rmSync(stateDir, {recursive:true, force:true}));
  return {stateDir, enable(value = true) {
    fs.writeFileSync(path.join(stateDir, 'application-preferences.json'), JSON.stringify({schema:1, linuxAdminRequests:value}));
  }};
}

test('Linux administrator requests require the switch and accept only supported packages', async t => {
  const {stateDir, enable} = fixture(t);
  const tools = createLinuxAdminTools({stateDir, run:async () => assert.fail('Unexpected local operation')});
  assert.ok(tools.definitions.every(tool => groupOf(tool.name) === 'commands'));
  for (const setting of [undefined, false, 'true']) {
    if (setting !== undefined) enable(setting);
    await assert.rejects(tools.call('linux_admin_kernel_log', {}), /已关闭/);
  }
  enable();
  await assert.rejects(tools.call('linux_admin_install_package', {package:'/tmp/example.deb'}), /Invalid arguments/);
  await assert.rejects(tools.call('linux_admin_kernel_log', {command:'id'}), /Invalid arguments/);
});

test('cancelled or revoked confirmation does not reach administrator execution', async t => {
  const {stateDir, enable} = fixture(t);
  enable();
  let calls = 0;
  let cancelled = true;
  const tools = createLinuxAdminTools({stateDir, run:async (_file, args) => {
    assert.equal(args.at(-1), 'admin');
    calls++;
    if (!cancelled) enable(false);
    return JSON.stringify({cancelled});
  }});
  assert.equal((await tools.call('linux_admin_kernel_log', {})).structuredContent.status, 'cancelled');
  cancelled = false;
  await assert.rejects(tools.call('linux_admin_kernel_log', {}), /已关闭/);
  assert.equal(calls, 2);
});

test('approved requests run fixed kernel diagnostics or open an interactive package installation', async t => {
  const {stateDir, enable} = fixture(t);
  enable();
  const calls = [];
  const tools = createLinuxAdminTools({stateDir, run:async (file, args, options) => {
    calls.push({file, args, options});
    return file === '/usr/bin/pkexec' ? 'kernel warning\n' : '{"cancelled":false}';
  }});
  const log = await tools.call('linux_admin_kernel_log', {});
  assert.deepEqual(log.structuredContent, {status:'completed', log:'kernel warning\n'});
  const install = await tools.call('linux_admin_install_package', {package:'lm-sensors'});
  assert.equal(install.structuredContent.status, 'local_terminal_opened');
  assert.equal(calls[0].args.at(-1), 'admin');
  assert.deepEqual(calls[1].args, ['--disable-internal-agent', '/usr/bin/dmesg', '--color=never', '--level=warn,err,crit,alert,emerg']);
  assert.match(JSON.parse(calls[2].options.input).message, /lm-sensors/);
  assert.deepEqual(calls[3], {file:'/usr/bin/gnome-terminal',
    args:['--', '/usr/bin/sudo', '-k', '--', '/usr/bin/apt-get', '--no-remove', 'install', '--', 'lm-sensors'],
    options:{timeout:10000}});
});
