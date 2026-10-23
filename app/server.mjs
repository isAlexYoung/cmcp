import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compatibleToolDefinitions } from './tool-schemas.mjs';
import { createWindowsTools } from './windows-tools.mjs';
import { createBinaryTools } from './binary-tools.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { StatusBoard, machineId } from './link-client.mjs';
import { managedTargetFactory } from './managed-target.mjs';
import { createTargetConnections, readTargetControls } from './target-connections.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeVersion = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
// --selftest：由 start.ps1 在前台调用，只验证能否启动并连上文件后端，然后退出，把真实错误显示给用户。
const selfTest = process.argv.includes('--selftest');
// --session：短期连接版的一次性连接（由 run-session.ps1 启动）。被另一台电脑替换时以退出码 4 结束。
const sessionMode = process.argv.includes('--session');
const stateDir = path.join(process.env.LOCALAPPDATA, 'ClaudeLocalMcp');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const config = readJson(path.join(stateDir, 'config.json'));

/* ---------------- Logging (appended; survives restarts) ---------------- */

const logFile = path.join(stateDir, 'service.log');
function log(text) {
  const line = `${new Date().toISOString()} ${text}\n`;
  process.stdout.write(line);
  try {
    if (fs.statSync(logFile, { throwIfNoEntry: false })?.size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch {}
}
process.on('uncaughtException', error => { log('FATAL ' + (error.stack || error.message)); process.exit(1); });
process.on('unhandledRejection', error => { log('FATAL ' + (error?.stack || error)); process.exit(1); });

// Only one service per Windows account: a named pipe can be owned by one process only.
// Exit code 3 tells run-service.ps1 not to restart (another copy is already running).
// Pipe names are machine-wide, so the account part includes a hash of the account's own data folder:
// two accounts whose non-ASCII names map to the same letters must not block each other.
const accountKey = createHash('sha256').update(stateDir.toLowerCase()).digest('hex').slice(0, 12);
const instanceName = `claude-cloudpc-link-${(process.env.USERNAME || process.env.USER || 'user').replace(/[^A-Za-z0-9_-]/g, '_')}-${accountKey}`;
const instancePipe = process.platform === 'win32' ? `\\\\.\\pipe\\${instanceName}` : path.join(os.tmpdir(), instanceName + '.sock');
const ownerAlive = () => new Promise(resolve => {
  const probe = net.connect(instancePipe, () => { probe.destroy(); resolve(true); });
  probe.on('error', () => resolve(false));
});
for (let attempt = 0; !selfTest; attempt++) {
  const error = await new Promise(resolve => {
    const guard = net.createServer(socket => socket.destroy());
    guard.once('error', resolve);
    guard.listen(instancePipe, () => { guard.unref(); resolve(null); });
  });
  if (!error) break;
  if (error.code === 'EADDRINUSE' && await ownerAlive()) { log('another service instance is already running; exiting'); process.exit(3); }
  if (error.code === 'EADDRINUSE' && attempt === 0 && process.platform !== 'win32') { try { fs.unlinkSync(instancePipe); } catch {} continue; }
  log('instance guard unavailable: ' + error.message);
  break;
}
log(`service ${bridgeVersion} starting${sessionMode ? ' (session)' : ''} (pid ${process.pid}, node ${process.version})`);
const windows = createWindowsTools({ defaultCwd: here, roots: config.roots, stateDir });
const binary = createBinaryTools({ roots: config.roots });
const expected = Buffer.from(`Bearer ${config.token}`);
if (config.token.length < 40 || !config.roots.length) throw new Error('Missing credentials or allowed roots');
const backend = new Client({ name: 'windows-filesystem-bridge', version: '1.0.0' });
const stdio = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'), ...config.roots],
  stderr: 'pipe',
});
stdio.stderr?.on('data', chunk => process.stderr.write(chunk));
try {
  await backend.connect(stdio);
} catch (error) {
  log('backend connect failed: ' + (error.stack || error.message));
  if (selfTest) { process.stderr.write('SELFTEST-FAIL 无法启动文件服务：' + error.message + '\n'); process.exit(21); }
  throw error;
}
const backendTools = compatibleToolDefinitions(await backend.listTools());
if (selfTest) {
  const total = backendTools.tools.length + windows.definitions.length + binary.definitions.length;
  process.stdout.write(`SELFTEST-OK ${total} tools; node ${process.version}\n`);
  await backend.close().catch(() => {});
  process.exit(0);
}
const instructions = `These tools operate on the user's physical Windows PC. File roots: ${config.roots.join(', ')}. Use absolute Windows paths such as D:\\work\\my-project. To run commands on that Windows PC, use windows_execute (PowerShell/CMD), windows_run_program (an installed executable), or windows_start_process (background work). Read output with windows_process_status and stop managed jobs with windows_stop_process. Use windows_toolchain_info to discover installed C/C++, CMake, Node, Python, Java, Android and other tools. Use windows_adb or windows_adb_devices for Android devices. Use windows_browser_open for local web previews, windows_screenshot for visual checks, and windows_desktop_action for basic interactive Windows GUI input. For MP4, MP3, WAV, PDF, Office, ZIP and other binary files use windows_binary_info plus the chunked windows_binary_begin/write/finish tools; do not put whole files in text or in the cloud computer's Bash. These tools run as the current Windows account without automatic elevation. Bash and terminals built into this cloud computer run on Linux; use the windows_* MCP tools for Windows work. Session IDs belong to the Windows bridge. Other applications' or other agents' private connector tools are not automatically exported.`;
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.origin) return res.status(403).json({ error: 'Browser-origin requests are not accepted' });
  const actual = Buffer.from(req.headers.authorization || '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Only the local link client talks to this server; the cloud computer reaches it over the outbound link.
  if (!['127.0.0.1', 'localhost'].includes(req.hostname)) {
    return res.status(403).json({ error: 'Host not allowed' });
  }
  next();
});
app.get('/health', (req, res) => res.json({ ok: true, bridgeVersion, schemaDialect: '2020-12', tools: backendTools.tools.length + windows.definitions.length + binary.definitions.length, roots: config.roots, capabilities: ['files','windows_commands','background_processes','toolchains','browser','desktop','android','binary_transfer'] }));
app.use(express.json({ limit: '8mb' }));
let active = 0;
app.post('/mcp', async (req, res) => {
  if (active >= 16) return res.status(429).json({ error: 'Too many concurrent requests' });
  active++;
  const server = new Server({ name: 'windows-pc-files', version: bridgeVersion }, {
    capabilities: { tools: {} }, instructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const files = compatibleToolDefinitions(await backend.listTools());
    return { ...files, tools: [...files.tools, ...windows.definitions, ...binary.definitions] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    log(`tool=${request.params.name}`);
    if (binary.owns(request.params.name)) {
      try { return await binary.call(request.params.name, request.params.arguments ?? {}); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    }
    if (windows.owns(request.params.name)) {
      try { return await windows.call(request.params.name, request.params.arguments ?? {}); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    }
    return backend.callTool(request.params, undefined, { timeout: 120000 });
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    active--;
    server.close().catch(() => {});
  };
  res.on('close', cleanup);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP request failed' }, id: req.body?.id ?? null });
    cleanup();
  }
});
app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
app.use((error, req, res, next) => {
  if (!res.headersSent) res.status(error.status || 500).json({ error: 'Request rejected' });
});
// Port 0 = any free port. Only this process talks to it, so it can never collide with other programs.
let localPort = 0;
const listener = app.listen(0, '127.0.0.1', () => {
  localPort = listener.address().port;
  log(`Windows MCP ready on 127.0.0.1:${localPort}; ${backendTools.tools.length + windows.definitions.length + binary.definitions.length} tools`);
  startLinks();
});
listener.on('error', async error => { log('listen failed: ' + error.message); await backend.close(); process.exit(1); });

/* ---------------- Outbound links to the cloud computers ---------------- */

const targetsFile = path.join(stateDir, 'cloudpc-targets.json');
const status = new StatusBoard(path.join(stateDir, 'link-status.json'));
let connections;
const entriesFile = path.join(stateDir, 'browser-entries.json');
let browserEntriesCache = '';
function writeBrowserEntries() {
  const targets = (connections?.values() || []).filter(r => r.gateway).map(r => ({ name:r.name, url:r.url, launchUrl:r.gateway.launchUrl }));
  const body = JSON.stringify({pid:process.pid,version:bridgeVersion,targets});
  if (body === browserEntriesCache) return;
  try {
    fs.writeFileSync(entriesFile+'.tmp',body);
    fs.renameSync(entriesFile+'.tmp',entriesFile);
    browserEntriesCache = body;
  } catch { log('cannot save browser entries; will retry'); }
}
const dialogs = new Map();
const readTargets = () => { try { const list = readJson(targetsFile); return Array.isArray(list) ? list : [list]; } catch { return []; } };

const powershellExe = process.env.CLOUDPC_POWERSHELL || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// timeoutMs = 0 means wait as long as it takes (the password dialog waits for the user).
function powershell(script, args, { capture = false, timeoutMs = 60000, signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({code:-1, out:'', err:''});
    const child = spawn(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, script), ...args],
      { cwd: here, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'] });
    let out = '';
    let err = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, {once:true});
    child.stdout?.on('data', chunk => { out += chunk; });
    child.stderr?.on('data', chunk => { err += chunk; });
    const timer = timeoutMs ? setTimeout(() => { log(`${script} timed out`); child.kill(); }, timeoutMs) : null;
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); log(`${script} failed to start: ${error.message}`); resolve({ code: -1, out, err }); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (code !== 0) log(`${script} exit ${code} ${err.trim().slice(0, 300)}`); resolve({ code, out, err }); });
  });
}

async function forward(msg) {
  const res = await fetch(`http://127.0.0.1:${localPort}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(170000),
  });
  const text = await res.text();
  if (!('id' in msg)) return null;
  if (!text) throw new Error(`Windows MCP returned HTTP ${res.status} without a body`);
  return JSON.parse(text);
}

// One dialog per cloud computer at a time; resolves true when a new password was verified and saved.
function askPassword(name, reason) {
  if (!dialogs.has(name)) {
    dialogs.set(name, powershell('ask-password.ps1', ['-Name', name, '-Reason', reason], { timeoutMs: 0 }).then(r => r.code === 0).finally(() => dialogs.delete(name)));
  }
  return dialogs.get(name);
}

function notify(title, message) {
  spawn(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(here, 'notify.ps1'), '-Title', title, '-Message', message],
    { cwd: here, stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function startLinks() {
  const proxyFor = async (url, signal) => {
    const r = await powershell('get-proxy.ps1', ['-Url', url], {capture:true, timeoutMs:30000, signal});
    if (r.code !== 0) throw new Error('Cannot read Windows proxy settings');
    return r.out.trim();
  };
  connections = createTargetConnections({readTargets,
    readControls:() => readTargetControls(path.join(stateDir, 'target-controls.json')),
    status, onChange:writeBrowserEntries,
    create:managedTargetFactory({proxyFor, machine:machineId(stateDir), version:bridgeVersion,
      forward, askPassword, notify, log, session:sessionMode, onReplaced:sessionMode ? () => stop(4) : undefined,
      passwordFor:async name => {
        const r = await powershell('get-password.ps1', ['-Name', name], {capture:true, timeoutMs:45000});
        if (r.code !== 0 || !r.out.trim()) throw new Error('Cannot read saved password');
        return Buffer.from(r.out.trim(), 'base64').toString('utf8');
      },
    }),
  });
  writeBrowserEntries();
}
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  listener.close();
  await connections?.close();
  try { fs.unlinkSync(entriesFile); } catch {}
  await windows.close().catch(() => {});
  try { binary.close(); } catch {}
  await backend.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
// A non-elevated Start/Stop window can request shutdown of a service previously
// started as administrator through this account's private state directory.
setInterval(() => { if (fs.existsSync(path.join(stateDir, 'stopped.flag'))) stop(); }, 1000).unref();
