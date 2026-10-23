import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import Ajv2020 from 'ajv/dist/2020.js';

const cwdProperty = { type: 'string', description: 'Absolute directory on the Windows PC, e.g. D:\\work\\project. Defaults to the bridge directory.' };
const envProperty = { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment overrides for this command only.' };
const commandProperties = {
  command: { type: 'string', minLength: 1, maxLength: 200000, description: 'Command or script to execute on the Windows PC.' },
  shell: { type: 'string', enum: ['powershell', 'cmd'], default: 'powershell' },
  cwd: cwdProperty,
  env: envProperty,
};
const timeoutProperty = { type: 'integer', minimum: 100, maximum: 90000, default: 60000, description: 'Foreground command deadline in milliseconds. Use windows_start_process for longer work.' };
const outputProperty = { type: 'integer', minimum: 1000, maximum: 200000, default: 30000 };
const sessionProperty = { type: 'string', minLength: 1, description: 'Session ID returned by the Windows command tools. Never a Linux session or arbitrary PID.' };
const definition = (name, description, properties, required = [], readOnly = false) => ({
  name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
});

export const windowsToolDefinitions = [
  definition('windows_system_info', 'Identify the physical Windows PC, its current account, allowed file roots and available command shells. Commands run with this account\'s existing permissions.', {}, [], true),
  definition('windows_toolchain_info', 'Detect installed Windows development toolchains and return their executable paths and versions. Covers C/C++, CMake, Ninja, Git, Node, Python, Java, Gradle, Android SDK, adb, emulators and common package managers.', {}, [], true),
  definition('windows_execute', 'Execute PowerShell or CMD on the physical Windows PC and return stdout, stderr and exit code. Use this instead of the Linux Bash on the cloud computer for Windows tasks. Can call any installed CLI such as Python, Node.js, Git, npm, curl, winget and Windows commands. Nonzero exit or timeout is an error. This is a fresh shell per call; pass cwd explicitly.', { ...commandProperties, timeout_ms: timeoutProperty, output_limit: outputProperty }, ['command']),
  definition('windows_run_program', 'Run a Windows executable directly with an argument array, without shell string quoting. Suitable for python.exe, node.exe, git.exe or a full executable path. For .bat/.cmd scripts and pipelines use windows_execute. Use windows_start_process for long work.', {
    executable: { type: 'string', minLength: 1, maxLength: 4096 },
    args: { type: 'array', items: { type: 'string', maxLength: 200000 }, maxItems: 500, default: [] },
    cwd: cwdProperty, env: envProperty, timeout_ms: timeoutProperty, output_limit: outputProperty,
  }, ['executable']),
  definition('windows_start_process', 'Start a background PowerShell or CMD command on Windows. Returns a managed session ID; poll windows_process_status for output and use windows_stop_process to stop its process tree. Suitable for development servers, builds and commands longer than 90 seconds. Processes are owned by this temporary MCP session.', {
    ...commandProperties,
    timeout_ms: { type: 'integer', minimum: 0, maximum: 86400000, default: 0, description: 'Optional deadline; 0 means no automatic timeout.' },
  }, ['command']),
  definition('windows_process_status', 'Read output and status of a managed Windows session. Offsets count decoded characters; next offsets allow incremental polling. Only the last 1 MiB characters of each output stream are retained. wait_ms can wait briefly for completion.', {
    session_id: sessionProperty,
    stdout_offset: { type: 'integer', minimum: 0 }, stderr_offset: { type: 'integer', minimum: 0 },
    wait_ms: { type: 'integer', minimum: 0, maximum: 30000, default: 0 }, output_limit: outputProperty,
  }, ['session_id'], true),
  definition('windows_process_input', 'Write text to stdin of a running managed Windows session, optionally close stdin. This is piped input, not a Windows GUI or a PTY.', {
    session_id: sessionProperty, text: { type: 'string', maxLength: 200000, default: '' }, close_stdin: { type: 'boolean', default: false },
  }, ['session_id']),
  definition('windows_stop_process', 'Stop only a session created by these Windows tools, including its child process tree. Does not accept arbitrary PIDs.', { session_id: sessionProperty }, ['session_id']),
  definition('windows_list_sessions', 'List managed Windows command sessions and their state. Session IDs are reset when the temporary MCP service restarts.', {}, [], true),
  definition('windows_browser_open', 'Open a URL in the default Windows browser. Use for local web development previews or external documentation.', { url: { type: 'string', minLength: 1, maxLength: 8192 }, browser: { type: 'string', enum: ['default', 'chrome', 'edge', 'firefox'], default: 'default' } }, ['url']),
  definition('windows_screenshot', 'Capture a screenshot of the Windows desktop or a rectangular screen region and save it as a PNG. Returns the saved path and image metadata.', { path: { type: 'string', minLength: 1, maxLength: 4096 }, monitor: { type: 'integer', minimum: 0, default: 0 }, x: { type: 'integer', minimum: 0, default: 0 }, y: { type: 'integer', minimum: 0, default: 0 }, width: { type: 'integer', minimum: 1, maximum: 16384 }, height: { type: 'integer', minimum: 1, maximum: 16384 } }, ['path']),
  definition('windows_desktop_action', 'Perform a basic Windows desktop action: move/click the mouse, type text, press keys, or take a screenshot. Requires the interactive user desktop and affects the current session.', { action: { type: 'string', enum: ['move_mouse', 'click', 'double_click', 'type_text', 'press_keys', 'hotkey'] }, x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, text: { type: 'string', maxLength: 10000 }, keys: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 32 }, maxItems: 32 }, button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' } }, ['action']),
  definition('windows_adb_devices', 'List Android devices and emulators visible to the Windows adb executable.', {}, [], true),
  definition('windows_adb', 'Run an adb command on Windows and return its output. Use windows_adb_devices first to select a device when needed.', { args: { type: 'array', items: { type: 'string', maxLength: 2000 }, maxItems: 100, default: [] }, serial: { type: 'string', maxLength: 256 }, cwd: cwdProperty, timeout_ms: timeoutProperty, output_limit: outputProperty }, []),
];

const validators = new Map();
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const tool of windowsToolDefinitions) validators.set(tool.name, ajv.compile(tool.inputSchema));

class OutputBuffer {
  constructor() { this.value = ''; this.start = 0; this.end = 0; this.decoder = new StringDecoder('utf8'); }
  append(bytes) { this.appendText(this.decoder.write(bytes)); }
  appendText(text) {
    this.value += text;
    this.end += text.length;
    if (this.value.length > 1048576) {
      const trim = this.value.length - 1048576;
      this.value = this.value.slice(trim);
      this.start += trim;
    }
  }
  finish() { this.appendText(this.decoder.end()); }
  read(offset, limit) {
    // Without an offset show the most recent output; with one read forward.
    const requested = offset ?? Math.max(this.start, this.end - limit);
    const from = Math.max(this.start, Math.min(requested, this.end));
    const text = this.value.slice(from - this.start, from - this.start + limit);
    return { text, next: from + text.length, truncated: requested < this.start || (offset === undefined && from > 0), more: from + text.length < this.end };
  }
}

export function createWindowsTools({ defaultCwd, roots, stateDir }) {
  const sessions = new Map();
  const windowsDir = process.env.SystemRoot || 'C:\\Windows';
  const modern = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  const powershell = fs.existsSync(modern) ? modern : path.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = path.join(windowsDir, 'System32', 'cmd.exe');
  const taskkill = path.join(windowsDir, 'System32', 'taskkill.exe');
  const scriptsDir = path.join(stateDir, 'command-scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  function snapshot(session, args = {}) {
    const limit = args.output_limit ?? 30000;
    const stdout = session.stdout.read(args.stdout_offset, limit);
    const stderr = session.stderr.read(args.stderr_offset, limit);
    return {
      session_id: session.id, pid: session.child.pid ?? null, platform: process.platform, hostname: os.hostname(),
      cwd: session.cwd, running: session.running, exit_code: session.exitCode, signal: session.signal,
      timed_out: session.timedOut, stopped: session.stopped, started_at: session.startedAt,
      finished_at: session.finishedAt, stdout: stdout.text, stderr: stderr.text,
      next_stdout_offset: stdout.next, next_stderr_offset: stderr.next,
      stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated,
      stdout_more: stdout.more, stderr_more: stderr.more, error: session.error,
    };
  }

  async function stopSession(session, timedOut = false) {
    if (!session.running) return;
    if (session.stopping) return session.stopping;
    if (timedOut) session.timedOut = true;
    else session.stopped = true;
    session.stopping = (async () => {
      // The managed ChildProcess must still be live. Never kill a caller's PID.
      if (!session.child.pid || session.child.exitCode !== null || session.child.signalCode !== null) return;
      const killer = spawn(taskkill, ['/PID', String(session.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const code = await new Promise((resolve, reject) => {
        killer.once('error', reject);
        killer.once('close', resolve);
      });
      if (code !== 0 && session.running) throw new Error('Could not stop the managed Windows process tree');
      await Promise.race([session.completed, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (session.running) throw new Error('The Windows process has not stopped');
    })();
    try { await session.stopping; } finally { session.stopping = null; }
  }

  function start(args, direct = false) {
    if ([...sessions.values()].filter(s => s.running).length >= 8) throw new Error('Eight Windows commands are already running; stop a session before starting another');
    // Bound retained output for completed jobs. Live sessions are never evicted.
    for (const [id, session] of sessions) {
      if (sessions.size < 32) break;
      if (!session.running) sessions.delete(id);
    }
    const cwd = args.cwd ?? defaultCwd;
    if (!path.win32.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an existing absolute Windows directory');
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...args.env };
    const id = randomUUID();
    let executable, argv, scriptFile = null;
    if (direct) {
      executable = args.executable;
      argv = args.args ?? [];
      if (/\.(bat|cmd)$/i.test(executable)) throw new Error('Use windows_execute with shell=cmd for .bat/.cmd scripts');
    } else if ((args.shell ?? 'powershell') === 'powershell') {
      executable = powershell;
      const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $global:LASTEXITCODE=0; try { & {\n" + args.command + "\n}; if (!$?) {exit 1}; exit $global:LASTEXITCODE } catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }";
      scriptFile = path.join(scriptsDir, id + '.ps1');
      // UTF-8 BOM preserves Chinese under Windows PowerShell 5 as well as 7.
      fs.writeFileSync(scriptFile, '\uFEFF' + script, 'utf8');
      argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
    } else {
      executable = cmd;
      scriptFile = path.join(scriptsDir, id + '.cmd');
      fs.writeFileSync(scriptFile, '@echo off\r\nchcp 65001 >nul\r\n' + args.command.replace(/\r?\n/g, '\r\n') + '\r\nexit /b %errorlevel%\r\n', 'utf8');
      argv = ['/d', '/s', '/c', '""' + scriptFile + '""'];
    }
    const child = spawn(executable, argv, { cwd, env, windowsHide: true, windowsVerbatimArguments: !direct && args.shell === 'cmd', stdio: ['pipe', 'pipe', 'pipe'] });
    const session = {
      id, child, cwd, running: true, exitCode: null, signal: null, error: null,
      stdout: new OutputBuffer(), stderr: new OutputBuffer(),
      timedOut: false, stopped: false, stopping: null, timer: null,
      startedAt: new Date().toISOString(), finishedAt: null, completed: null,
    };
    session.completed = new Promise(resolve => {
      child.once('error', error => { session.error = error.message; });
      child.stdout.on('data', bytes => session.stdout.append(bytes));
      child.stderr.on('data', bytes => session.stderr.append(bytes));
      child.stdin.on('error', () => {});
      child.once('close', (code, signal) => {
        session.stdout.finish(); session.stderr.finish();
        session.running = false; session.exitCode = code; session.signal = signal;
        session.finishedAt = new Date().toISOString();
        clearTimeout(session.timer);
        if (scriptFile) { try { fs.unlinkSync(scriptFile); } catch {} }
        resolve();
      });
    });
    sessions.set(id, session);
    if (args.timeout_ms) {
      session.timer = setTimeout(() => stopSession(session, true).catch(error => { session.error = error.message; }), args.timeout_ms);
    }
    return session;
  }

  function find(id) {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown Windows session ID; it may belong to an older MCP run or have expired');
    return session;
  }

  function findExecutable(candidates) {
    for (const candidate of candidates) {
      try {
        const result = execFileSync('where.exe', [candidate], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
        if (result) return result;
      } catch {}
    }
    return null;
  }

  function toolchainInfo() {
    const names = ['cl.exe','clang.exe','clang++.exe','gcc.exe','g++.exe','cmake.exe','ninja.exe','git.exe','node.exe','npm.cmd','python.exe','py.exe','java.exe','javac.exe','gradle.bat','adb.exe','emulator.exe','winget.exe','docker.exe','wsl.exe'];
    const tools = {};
    for (const name of names) tools[name.replace(/\.(exe|cmd|bat)$/i, '')] = findExecutable([name]);
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
    return { tools, android_sdk: sdk, visual_studio_installation: process.env.VSINSTALLDIR || null, environment: { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME || null, ANDROID_HOME: sdk } };
  }

  async function desktopAction(args) {
    const psQuote = value => String(value).replace(/'/g, "''");
    const encodedText = Buffer.from(String(args.text ?? ''), 'utf8').toString('base64');
    const keyNames = (args.keys ?? []).map(key => String(key).toUpperCase());
    const sendKeys = args.action === 'hotkey'
      ? keyNames.map((key, index) => ({ CTRL: '^', CONTROL: '^', ALT: '%', SHIFT: '+', WINDOWS: '' }[key] ?? (index === keyNames.length - 1 ? (/^[A-Z0-9]$/.test(key) ? key : `{${key}}`) : ''))).join('')
      : String((args.keys ?? []).join(''));
    const mouseFlags = args.button === 'right' ? ['0x0008', '0x0010'] : args.button === 'middle' ? ['0x0020', '0x0040'] : ['0x0002', '0x0004'];
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class ClaudeLocalInput { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }\n'@; $action='${psQuote(args.action)}'; switch ($action) { 'move_mouse' { [ClaudeLocalInput]::SetCursorPos(${args.x ?? 0},${args.y ?? 0}) | Out-Null } 'click' { [ClaudeLocalInput]::SetCursorPos(${args.x ?? 0},${args.y ?? 0}) | Out-Null; [ClaudeLocalInput]::mouse_event(${mouseFlags[0]},0,0,0,[UIntPtr]::Zero); [ClaudeLocalInput]::mouse_event(${mouseFlags[1]},0,0,0,[UIntPtr]::Zero) } 'double_click' { [ClaudeLocalInput]::SetCursorPos(${args.x ?? 0},${args.y ?? 0}) | Out-Null; 1..2 | ForEach-Object { [ClaudeLocalInput]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [ClaudeLocalInput]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50 } } 'type_text' { $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}')); [System.Windows.Forms.SendKeys]::SendWait($v) } 'press_keys' { [System.Windows.Forms.SendKeys]::SendWait('${psQuote(sendKeys)}') } 'hotkey' { [System.Windows.Forms.SendKeys]::SendWait('${psQuote(sendKeys)}') } }; 'ok'`;
    const session = start({ command: script, cwd: defaultCwd, timeout_ms: 15000 });
    session.child.stdin.end();
    await waitFor(session, 22000);
    return snapshot(session, {});
  }
  async function waitFor(session, milliseconds) {
    if (!session.running || !milliseconds) return;
    let timer;
    try { await Promise.race([session.completed, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { clearTimeout(timer); }
  }

  async function call(name, args) {
    const validate = validators.get(name);
    if (!validate) throw new Error('Unknown Windows tool');
    if (!validate(args)) throw new Error('Invalid arguments: ' + ajv.errorsText(validate.errors));
    let result;
    if (name === 'windows_system_info') {
      result = { platform: process.platform, hostname: os.hostname(), os_release: os.release(), architecture: os.arch(),
        account: os.userInfo().username, home: os.homedir(), file_roots: roots, default_cwd: defaultCwd,
        shells: { powershell, cmd }, node: process.execPath, permissions: 'Current Windows account; no automatic elevation',
        capabilities: ['files', 'powershell', 'cmd', 'executables', 'background_processes', 'process_input', 'process_output', 'process_tree_stop', 'toolchain_detection', 'browser_open', 'desktop_actions', 'screenshots', 'android_adb'] };
    } else if (name === 'windows_toolchain_info') {
      result = toolchainInfo();
    } else if (name === 'windows_list_sessions') {
      result = { sessions: [...sessions.values()].map(s => ({ session_id: s.id, pid: s.child.pid ?? null, cwd: s.cwd, running: s.running, exit_code: s.exitCode, started_at: s.startedAt })) };
    } else if (name === 'windows_execute' || name === 'windows_run_program') {
      const session = start({ ...args, timeout_ms: args.timeout_ms ?? 60000 }, name === 'windows_run_program');
      // Foreground execution is non-interactive; background jobs retain stdin.
      session.child.stdin.end();
      await waitFor(session, (args.timeout_ms ?? 60000) + 7000);
      if (session.running) session.error = session.error ?? 'The command exceeded its deadline and could not be stopped';
      result = snapshot(session, args);
    } else if (name === 'windows_start_process') {
      const session = start(args);
      await waitFor(session, 150);
      result = snapshot(session);
    } else if (name === 'windows_process_status') {
      const session = find(args.session_id);
      await waitFor(session, args.wait_ms ?? 0);
      result = snapshot(session, args);
    } else if (name === 'windows_stop_process') {
      const session = find(args.session_id);
      await stopSession(session);
      result = snapshot(session);
    } else if (name === 'windows_process_input') {
      const session = find(args.session_id);
      if (!session.running || session.child.stdin.destroyed || session.child.stdin.writableEnded) throw new Error('The Windows session input is closed');
      await new Promise((resolve, reject) => { session.child.stdin.write(args.text ?? '', 'utf8', error => error ? reject(error) : resolve()); });
      if (args.close_stdin) session.child.stdin.end();
      result = { session_id: session.id, sent_characters: (args.text ?? '').length, stdin_closed: args.close_stdin ?? false };
    } else if (name === 'windows_browser_open') {
      const browsers = { chrome: 'chrome.exe', edge: 'msedge.exe', firefox: 'firefox.exe' };
      const executable = args.browser === 'default' ? 'explorer.exe' : findExecutable([browsers[args.browser]]);
      if (!executable) throw new Error(`Browser executable not found: ${args.browser}`);
      await new Promise((resolve, reject) => { const child = spawn(executable, [args.url], { detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('spawn', resolve); child.unref(); });
      result = { opened: true, browser: args.browser ?? 'default', url: args.url };
    } else if (name === 'windows_screenshot') {
      const out = path.win32.resolve(args.path);
      if (!path.win32.isAbsolute(out) || !fs.existsSync(path.win32.dirname(out))) throw new Error('Screenshot path must be absolute and its parent directory must exist');
      const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::AllScreens[${args.monitor ?? 0}].Bounds; $x=${args.x ?? 0}; $y=${args.y ?? 0}; $w=${args.width ?? 0}; $h=${args.height ?? 0}; if($w -le 0){$w=$b.Width}; if($h -le 0){$h=$b.Height}; $bmp=New-Object Drawing.Bitmap $w,$h; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X+$x,$b.Y+$y,0,0,$bmp.Size); $bmp.Save('${out.replace(/'/g, "''")}',[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); Get-Item -LiteralPath '${out.replace(/'/g, "''")}' | Select-Object FullName,Length`;
      const session = start({ command: ps, cwd: defaultCwd, timeout_ms: 30000 }); session.child.stdin.end(); await waitFor(session, 37000); result = snapshot(session, {}); result.path = out;
    } else if (name === 'windows_desktop_action') {
      result = await desktopAction(args);
    } else if (name === 'windows_adb_devices') {
      const session = start({ executable: 'adb.exe', args: ['devices', '-l'], cwd: defaultCwd, timeout_ms: 30000 }, true); session.child.stdin.end(); await waitFor(session, 37000); result = snapshot(session, args);
    } else if (name === 'windows_adb') {
      const argv = args.serial ? ['-s', args.serial, ...(args.args ?? [])] : (args.args ?? []);
      const session = start({ executable: 'adb.exe', args: argv, cwd: args.cwd ?? defaultCwd, timeout_ms: args.timeout_ms ?? 60000, output_limit: args.output_limit }, true); session.child.stdin.end(); await waitFor(session, (args.timeout_ms ?? 60000) + 7000); result = snapshot(session, args);
    }
    const isError = Boolean(result.error || result.timed_out || (['windows_execute', 'windows_run_program', 'windows_adb', 'windows_adb_devices', 'windows_screenshot', 'windows_desktop_action'].includes(name) && result.exit_code !== 0));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, ...(isError ? { isError: true } : {}) };
  }

  return {
    definitions: windowsToolDefinitions,
    owns: name => validators.has(name), call,
    async close() { await Promise.allSettled([...sessions.values()].filter(s => s.running).map(s => stopSession(s))); },
  };
}
