import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

import { createWindowsTools, windowsToolDefinitions } from '../windows-tools.mjs';

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
  assert.equal(exit.exit_code, 7); assert.match(exit.stderr, /command exited with code 7/);
});

test('Windows command tools no longer advertise a memory budget', () => {
  for (const name of ['windows_execute', 'windows_run_program', 'windows_start_process']) {
    const tool = windowsToolDefinitions.find(tool => tool.name === name);
    assert.ok(tool);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'memory_limit_mb'), false);
  }
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

test('managed commands have no job memory cap and ignore cached legacy budgets', { skip: !windows, timeout: 30000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-memory-'));
  const tools = createWindowsTools({ defaultCwd: folder, roots: [folder], stateDir: folder });
  t.after(async () => { await tools.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const source = path.join(folder, 'allocator.cs'), executable = path.join(folder, 'allocator.exe');
  fs.writeFileSync(source, `using System;using System.Runtime.InteropServices;class Allocate{
[StructLayout(LayoutKind.Sequential)]struct Basic{public long UserTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint ActiveLimit;public UIntPtr Affinity;public uint Priority,Scheduling;}
[StructLayout(LayoutKind.Sequential)]struct Io{public ulong A,B,C,D,E,F;}
[StructLayout(LayoutKind.Sequential)]struct Extended{public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
[DllImport("kernel32.dll",SetLastError=true)]static extern bool QueryInformationJobObject(IntPtr job,int kind,out Extended limits,int size,IntPtr length);
[DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr VirtualAlloc(IntPtr address,UIntPtr size,uint type,uint protect);
[DllImport("kernel32.dll")]static extern bool VirtualFree(IntPtr address,UIntPtr size,uint type);
static int Main(){Extended limits;if(!QueryInformationJobObject(IntPtr.Zero,9,out limits,Marshal.SizeOf(typeof(Extended)),IntPtr.Zero))return 2;
var p=VirtualAlloc(IntPtr.Zero,(UIntPtr)(256UL*1024*1024),0x3000,4);
Console.Write("FLAGS="+limits.Basic.Flags+";JOB_MEMORY="+limits.JobMemory.ToUInt64()+";COMMIT="+(p==IntPtr.Zero?"DENIED":"OK"));
if(p!=IntPtr.Zero)VirtualFree(p,UIntPtr.Zero,0x8000);return p==IntPtr.Zero?3:0;}}`);
  execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/platform:x64', `/out:${executable}`, source], { windowsHide: true });
  for (const memory_limit_mb of [undefined, 128, 16384]) {
    const result = await tools.call('windows_run_program', { executable, ...(memory_limit_mb === undefined ? {} : { memory_limit_mb }) });
    assert.equal(result.structuredContent.exit_code, 0, result.structuredContent.stderr);
    const match = /^FLAGS=(\d+);JOB_MEMORY=(\d+);COMMIT=OK$/.exec(result.structuredContent.stdout);
    assert.ok(match, result.structuredContent.stdout);
    assert.equal(Number(match[1]) & 0x300, 0, 'neither process nor job memory is capped');
    assert.equal(match[2], '0');
  }
  for (const name of ['windows_execute', 'windows_start_process']) {
    const result = await tools.call(name, { command: 'Write-Output legacy-budget-ignored', memory_limit_mb: 16384 });
    const output = name === 'windows_start_process'
      ? (await tools.call('windows_process_status', { session_id: result.structuredContent.session_id, wait_ms: 10000 })).structuredContent
      : result.structuredContent;
    assert.equal(output.exit_code, 0, output.stderr);
    assert.match(output.stdout, /legacy-budget-ignored/);
  }
});

test('managed Node commands inherit the chosen NODE_OPTIONS without an injected heap limit', { skip: !windows, timeout: 20000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-node-memory-'));
  const tools = createWindowsTools({ defaultCwd: folder, roots: [folder], stateDir: folder });
  t.after(async () => { await tools.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  for (const NODE_OPTIONS of ['', '--max-old-space-size=3072']) {
    const result = await tools.call('windows_run_program', {
      executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.env.NODE_OPTIONS))'], env: { NODE_OPTIONS },
    });
    assert.equal(result.structuredContent.exit_code, 0, result.structuredContent.stderr);
    assert.equal(JSON.parse(result.structuredContent.stdout), NODE_OPTIONS);
  }
});
