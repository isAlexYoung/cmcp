import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

import { createWindowsTools } from '../windows-tools.mjs';

const windows = process.platform === 'win32';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('guarded commands preserve quoting, pipes, exit codes and CMD; stop only their own job', { skip: !windows, timeout: 30000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-command-'));
  const tools = createWindowsTools({ defaultCwd: folder, roots: [folder], stateDir: folder });
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { await tools.close(); sentinel.kill(); fs.rmSync(folder, { recursive: true, force: true }); });
  const run = async (name, args) => (await tools.call(name, args)).structuredContent;
  const text = `含 空格 "double" trailing\\ and 'quote'`;
  const echo = await run('windows_run_program', { executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', text] });
  assert.equal(echo.exit_code, 0, echo.stderr); assert.deepEqual(JSON.parse(echo.stdout), [text]);
  const shell = await run('windows_execute', { shell: 'cmd', command: 'echo command-pipe', cwd: folder });
  assert.equal(shell.exit_code, 0, shell.stderr); assert.match(shell.stdout, /command-pipe/);
  const inputFile = path.join(folder, 'stdin.ps1');
  fs.writeFileSync(inputFile, '[Console]::Write([Console]::In.ReadToEnd())');
  const piped = await run('windows_start_process', { command: `& '${inputFile.replaceAll("'", "''")}'`, cwd: folder });
  await run('windows_process_input', { session_id: piped.session_id, text: 'piped input', close_stdin: true });
  const input = await run('windows_process_status', { session_id: piped.session_id, wait_ms: 10000 });
  assert.equal(input.exit_code, 0, input.stderr); assert.equal(input.stdout, 'piped input');
  const childFile = path.join(folder, 'child.pid');
  const command = `& '${process.execPath.replaceAll("'", "''")}' -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" '${childFile}'`;
  const background = await run('windows_start_process', { command, cwd: folder });
  for (let i=0; i<50 && !fs.existsSync(childFile); i++) await sleep(100);
  assert.ok(fs.existsSync(childFile), 'guarded descendant started');
  const descendant = Number(fs.readFileSync(childFile, 'utf8'));
  assert.ok(alive(descendant));
  const stopped = await run('windows_stop_process', { session_id: background.session_id });
  for (let i=0; i<30 && alive(descendant); i++) await sleep(100);
  assert.equal(stopped.running, false); assert.equal(alive(descendant), false); assert.ok(alive(sentinel.pid));
  const exit = await run('windows_run_program', { executable: process.execPath, args: ['-e', 'process.exit(7)'] });
  assert.equal(exit.exit_code, 7); assert.match(exit.stderr, /memory cap/);
});

test('ending the MCP owner reclaims only its command job', { skip: !windows, timeout: 20000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-owner-'));
  const childFile = path.join(folder, 'child.pid');
  const script = `import {createWindowsTools} from ${JSON.stringify(new URL('../windows-tools.mjs', import.meta.url).href)};
const tools=createWindowsTools({defaultCwd:process.argv[1],stateDir:process.argv[1]});
await tools.call('windows_start_process',{command:${JSON.stringify(`& '${process.execPath.replaceAll("'", "''")}' -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" '${childFile}'`)}});
setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script, folder], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { owner.kill(); await sleep(500); fs.rmSync(folder, { recursive: true, force: true }); });
  for (let i=0; i<100 && !fs.existsSync(childFile); i++) await sleep(100);
  assert.ok(fs.existsSync(childFile), 'owner started its command');
  const child = Number(fs.readFileSync(childFile, 'utf8'));
  assert.ok(alive(child)); owner.kill();
  for (let i=0; i<50 && alive(child); i++) await sleep(100);
  assert.equal(alive(child), false, 'owner exit reclaims its descendant');
});

test('a 128 MiB job denies a 256 MiB native commit without exhausting system memory', { skip: !windows, timeout: 20000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-memory-'));
  const tools = createWindowsTools({ defaultCwd: folder, roots: [folder], stateDir: folder });
  t.after(async () => { await tools.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const source = path.join(folder, 'allocator.cs'), executable = path.join(folder, 'allocator.exe');
  fs.writeFileSync(source, `using System;using System.Runtime.InteropServices;class Allocate{[DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr VirtualAlloc(IntPtr address,UIntPtr size,uint type,uint protect);static int Main(){var p=VirtualAlloc(IntPtr.Zero,(UIntPtr)(256UL*1024*1024),0x3000,4);Console.Write(p==IntPtr.Zero?"COMMIT_DENIED":"UNEXPECTED_ALLOCATION");return p==IntPtr.Zero?0:1;}}`);
  execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/platform:x64', `/out:${executable}`, source], { windowsHide: true });
  const result = await tools.call('windows_run_program', { executable, memory_limit_mb: 128 });
  assert.equal(result.structuredContent.exit_code, 0, result.structuredContent.stderr);
  assert.equal(result.structuredContent.stdout, 'COMMIT_DENIED');
});
