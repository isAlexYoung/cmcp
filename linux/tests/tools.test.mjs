import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createLinuxTools, createLinuxBinaryTools} from '../tools.mjs';
import {createDispatcher} from '../dispatcher.mjs';
import {connectorSource} from '../connector-source.mjs';
import {VERSION} from '../platform.mjs';
import {windowsToolDefinitions} from '../../app/windows-tools.mjs';
import {applySwitches} from '../../app/mcp-tools-cli.mjs';
test('Linux binary uploads verify hash before publishing and reject paths outside roots', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-binary-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const binary = createLinuxBinaryTools({roots: [root]}); t.after(() => binary.close());
  const bytes = Buffer.from('Linux binary\0中文'), file = path.join(root, 'out.bin'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const begin = (await binary.call('linux_binary_begin', {path: file, size: bytes.length, sha256})).structuredContent;
  assert.equal(fs.existsSync(file), false);
  await binary.call('linux_binary_write', {upload_id: begin.upload_id, offset: 0, data: bytes.toString('base64')});
  await binary.call('linux_binary_finish', {upload_id: begin.upload_id});
  assert.deepEqual(fs.readFileSync(file), bytes);
  await assert.rejects(binary.call('linux_binary_info', {path: path.join(root, '..', 'not-allowed')}), /outside/);
});
test('dispatcher exposes Linux names and real filesystem tools, with remote/local instructions', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-dispatch-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'local-file');
  const dispatcher = await createDispatcher({roots: [root], stateDir: root, registryOptions: {watch: false}}); t.after(() => dispatcher.close());
  const initialized = await dispatcher.forward({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25'}});
  assert.match(initialized.result.instructions, /physical Linux PC/);
  const names = dispatcher.definitions.map(item => item.name);
  assert.ok(names.includes('linux_execute')); assert.ok(names.includes('read_file'));
  assert.ok(!names.some(name => /^mac_|^windows_/.test(name)));
  assert.deepEqual(windowsToolDefinitions.map(tool => tool.name.replace(/^windows_/, 'linux_')).filter(name => !names.includes(name)), []);
  assert.ok(!names.includes('blender_connection_status'));
  const response = await dispatcher.forward({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'read_file', arguments: {path: path.join(root, 'fixture.txt')}}});
  assert.match(JSON.stringify(response.result), /local-file/);
});
test('Linux connector installs with the default catalog and serves Claude file writes and Bash', {skip: process.platform !== 'linux', timeout: 15000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-posix-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const local = path.join(root, 'local'), home = path.join(root, 'cloud');
  fs.mkdirSync(local);
  fs.mkdirSync(home);
  const dispatcher = await createDispatcher({roots: [local], stateDir: path.join(root, 'state'), registryOptions: {watch: false}});
  t.after(() => dispatcher.close());
  const socketPath = path.join(root, 'link.sock');
  const relay = net.createServer(socket => {
    const input = createInterface({input: socket});
    input.once('line', async line => {
      input.close();
      const request = JSON.parse(line);
      const reply = request.op === 'status' ? {ok: true, connected: true} :
        request.op === 'call' ? {ok: true, msg: await dispatcher.forward(request.msg)} :
          {ok: false, code: 'unsupported'};
      socket.end(JSON.stringify(reply) + '\n', () => socket.destroy());
    });
  }).listen(socketPath);
  t.after(() => new Promise(resolve => relay.close(resolve)));
  await once(relay, 'listening');
  const source = path.join(root, 'connector.py');
  fs.writeFileSync(source, connectorSource());
  const codeConfig = path.join(home, '.claude.json');
  const desktopConfig = path.join(home, '.config/Claude/claude_desktop_config.json');
  const existing = {'windows-pc-files': {command: '/legacy/connector'}};
  fs.writeFileSync(codeConfig, JSON.stringify({mcpServers: existing}));
  const env = {...process.env, CLOUDPC_LINK_SOCKET: socketPath, CLOUDPC_CC_SHARED: '0'};
  await promisify(execFile)('python3', ['-B', source, 'install', '--home', home, '--client', 'both', '--wait', '3'], {env, timeout: 8000});
  const readServers = file => JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
  const codeServers = readServers(codeConfig), entry = codeServers['linux-pc-files'];
  assert.deepEqual(entry, readServers(desktopConfig)['linux-pc-files']);
  assert.deepEqual(codeServers['windows-pc-files'], existing['windows-pc-files']);

  const client = new Client({name: 'claude-code', version: '2.1.304'});
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({...entry, env: {...env, ...entry.env}, stderr: 'ignore'}));
  assert.equal(client.getServerVersion().name, 'linux-pc-files');
  assert.equal(client.getServerVersion().version, VERSION);
  const names = (await client.listTools()).tools.map(item => item.name);
  assert.ok(names.includes('write_file') && names.includes('linux_execute'));
  assert.ok(names.includes('linux_screenshot') && names.includes('linux_desktop_action'));
  assert.ok(!names.includes('windows_execute'));
  const localFile = path.join(local, 'fixture.txt');
  const answer = await client.callTool({name: 'write_file', arguments: {path: localFile, content: 'written through MCP'}});
  assert.ok(!answer.isError);
  assert.equal(fs.readFileSync(localFile, 'utf8'), 'written through MCP');
  const denied = await client.callTool({name: 'write_file', arguments: {path: path.join(home, 'outside.txt'), content: 'denied'}});
  assert.equal(denied.isError, true);
  const executed = await client.callTool({name: 'linux_execute', arguments: {command: 'printf linux-bash', cwd: local}});
  assert.equal(executed.structuredContent.output, 'linux-bash');
});
test('real Linux command and process supervisor run locally and clean up', {skip: process.platform !== 'linux'}, async t => {
  const tools = createLinuxTools({roots: [os.homedir()]}); t.after(() => tools.close());
  const command = await tools.call('linux_execute', {command: 'printf local-linux'});
  assert.equal(command.structuredContent.output, 'local-linux');
  const job = (await tools.call('linux_start_process', {program: process.execPath, args: ['-e', 'setTimeout(()=>{},30000)']})).structuredContent;
  assert.equal(job.running, true);
  await tools.call('linux_stop_process', {session_id: job.session_id});
});

test('Linux process input and incremental output match Windows operations while keeping the legacy response', {skip: process.platform !== 'linux'}, async t => {
  const tools = createLinuxTools({roots: [os.homedir()]});
  t.after(() => tools.close());
  const {structuredContent: job} = await tools.call('linux_start_process', {
    command: 'IFS= read -r value; printf "%s%s" "$value" "$FILL"; printf "stderr" >&2',
    env: {FILL: 'x'.repeat(1500)},
  });
  assert.ok(job.running);
  assert.ok((await tools.call('linux_list_sessions', {})).structuredContent.sessions.some(session => session.session_id === job.session_id));
  const {structuredContent: input} = await tools.call('linux_process_input', {session_id: job.session_id, text: '中文\n', close_stdin: true});
  assert.equal(input.stdin_closed, true);
  const {structuredContent: first} = await tools.call('linux_process_status', {session_id: job.session_id, stdout_offset: 0, wait_ms: 5000, output_limit: 1000});
  assert.equal(first.exit_code, 0);
  assert.equal(first.stdout.length, 1000);
  assert.equal(first.stdout.slice(0, 2), '中文');
  assert.equal(first.stderr, 'stderr');
  assert.equal(first.stdout_more, true);
  assert.match(first.output, /中文/);
  const {structuredContent: last} = await tools.call('linux_process_status', {session_id: job.session_id, stdout_offset: first.next_stdout_offset, stderr_offset: first.next_stderr_offset});
  assert.equal(first.stdout + last.stdout, '中文' + 'x'.repeat(1500));
  assert.equal(last.stderr, '');
  const direct = await tools.call('linux_run_program', {executable: '/bin/bash', args: ['-c', 'printf "%s" "$MESSAGE"; exit 4'], env: {MESSAGE: 'direct'}});
  assert.equal(direct.structuredContent.stdout, 'direct');
  assert.equal(direct.structuredContent.exit_code, 4);
  assert.equal(direct.isError, true);
  const timeout = (await tools.call('linux_start_process', {command: 'sleep 30', timeout_ms: 400})).structuredContent;
  const expired = (await tools.call('linux_process_status', {session_id: timeout.session_id, wait_ms: 5000})).structuredContent;
  assert.equal(expired.running, false);
  assert.equal(expired.timed_out, true);
});

test('Linux locates SDK tools and sends an adb serial as a separate argv element', {skip: process.platform !== 'linux'}, async t => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-android-'));
  const original = {ANDROID_HOME: process.env.ANDROID_HOME, PATH: process.env.PATH};
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sdk, {recursive: true, force: true});
  });
  const folder = path.join(sdk, 'platform-tools');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'adb'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {mode: 0o755});
  process.env.ANDROID_HOME = sdk;
  process.env.PATH = sdk;
  const tools = createLinuxTools({roots: [sdk]});
  t.after(() => tools.close());
  assert.equal((await tools.call('linux_toolchain_info', {})).structuredContent.tools.adb, path.join(folder, 'adb'));
  assert.equal((await tools.call('linux_adb_devices', {})).structuredContent.stdout, 'devices\n-l\n');
  const {structuredContent: command} = await tools.call('linux_adb', {serial: 'emulator-5554', args: ['shell', 'getprop', 'ro.product.model']});
  assert.equal(command.stdout, '-s\nemulator-5554\nshell\ngetprop\nro.product.model\n');
});

test('desktop and Blender groups use the existing Linux per-device switches and local Blender transport', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-linux-groups-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dispatcher = await createDispatcher({roots: [root], stateDir: root, registryOptions: {watch: false}});
  t.after(() => dispatcher.close());
  const server = net.createServer(socket => socket.once('data', data => {
    assert.equal(JSON.parse(data).type, 'get_scene_info');
    socket.end(JSON.stringify({status: 'success', result: {name: 'Linux Blender fixture'}}));
  })).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  applySwitches(root, {device: 'test-device', groups: {desktop: false, blender: true}});
  const group = new Set(dispatcher.registry.list('test-device').tools.map(tool => tool.name));
  assert.ok(!group.has('linux_screenshot'));
  assert.ok(group.has('blender_get_scene_info'));
  const response = await dispatcher.forward({jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {name: 'blender_connection_status', arguments: {port: server.address().port}}}, {device: 'test-device'});
  assert.ok(!response.result.isError, JSON.stringify(response.result));
  assert.equal(JSON.parse(response.result.content[0].text).scene.name, 'Linux Blender fixture');
  assert.ok(!dispatcher.definitions.some(tool => tool.name.startsWith('blender_')));
});
