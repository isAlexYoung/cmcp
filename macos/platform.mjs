import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '4.5.0';
export const KIT = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeMcpMac');
const bundleMarker=KIT.lastIndexOf('.app'+path.sep+'Contents'+path.sep);
const portableRoot=bundleMarker>=0?path.dirname(KIT.slice(0,bundleMarker+4)):path.dirname(KIT);
const requestedState = process.env.CMCP_STATE_DIR || path.join(portableRoot,'user');
// Foundation may abbreviate /private/var back to the system-owned /var alias.
// Normalize only that known macOS alias; retain rejection of user symlinks.
export const STATE = process.platform==='darwin' && requestedState.startsWith('/var/') && fs.realpathSync('/var')==='/private/var' ? '/private'+requestedState : requestedState;
export const LABEL = 'com.claude-mcp.mac';
export function privateDir(dir) {
  // Check parents, including dangling symlinks, before trusting private state.
  let p = dir;
  while (p !== path.dirname(p)) {
    try { const parent = fs.lstatSync(p); if (parent.isSymbolicLink()) throw new Error('目录路径不能包含符号链接：' + p); }
    catch(e){if(e.code!=='ENOENT')throw e;}
    p = path.dirname(p);
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('不安全的目录：' + dir);
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}
export function safeFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid())) throw new Error('不安全的文件：' + file);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export function atomicWrite(file, text, mode = 0o600) {
  privateDir(path.dirname(file)); safeFile(file);
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    safeFile(file); fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
export function readConfig(state = STATE) {
  privateDir(state);
  const file = path.join(state, 'targets.json'); safeFile(file);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { targets: [], roots: [os.homedir()] }; throw e; }
  if (!Array.isArray(config.targets) || config.targets.length > 100 || !Array.isArray(config.roots) || !config.roots.length) throw new Error('连接配置格式错误');
  const seen = new Set();
  for (const t of config.targets) {
    if (!t || !/^[a-f0-9-]{36}$/.test(t.id) || seen.has(t.id) || normalizeUrl(t.url) !== t.url) throw new Error('连接配置无效');
    seen.add(t.id);
  }
  for (const root of config.roots) if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('文件根目录必须是绝对路径');
  return config;
}
export function normalizeUrl(input) {
  const u = new URL(String(input).trim());
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('请使用完整的 HTTPS 云电脑首页地址，不能包含密码、路径或查询参数');
  return u.origin;
}
export function runFile(file, args = [], { input, timeout = 30000, maxBuffer = 2 * 1024 * 1024, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, maxBuffer, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) { const error = new Error(`${path.basename(file)} 执行失败（${err.code ?? 'timeout'}）`); error.code = err.code; reject(error); }
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function keychain(op, id, password, runner = runFile) {
  if (!['get','set','delete'].includes(op) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的钥匙串操作');
  const raw = await runner('/usr/bin/osascript', ['-l','JavaScript',path.join(KIT,'keychain.jxa')], {
    input: JSON.stringify({ op, id, ...(op === 'set' ? { password } : {}) }), timeout: 90000,
  });
  const result = JSON.parse(raw);
  if (!result.ok) throw new Error(`钥匙串操作失败（${result.status}）。请解锁登录钥匙串或重新添加连接。`);
  return op === 'get' ? Buffer.from(result.data, 'base64').toString('utf8') : undefined;
}
export async function prompt(title, message, hidden = false) {
  const result = JSON.parse(await runFile('/usr/bin/osascript', ['-l','JavaScript',path.join(KIT,'ui.jxa')], {
    input: JSON.stringify({ title, message, hidden }), timeout: 600000,
  }));
  return result.cancelled ? null : result.value;
}
export function parseScutil(text) {
  const values = Object.fromEntries([...text.matchAll(/^\s*(\w+)\s*:\s*(.*?)\s*$/gm)].map(m => [m[1],m[2]]));
  for (const kind of ['HTTPS','HTTP']) {
    if (values[kind + 'Enable'] !== '1') continue;
    const host = values[kind + 'Proxy']; const port = Number(values[kind + 'Port']);
    if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('系统代理地址无效');
    // macOS HTTPSProxy means HTTP CONNECT for HTTPS destinations, not TLS to the proxy.
    return `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
  }
  if (values.ProxyAutoConfigEnable === '1' || values.SOCKSEnable === '1' || values.ProxyAutoDiscoveryEnable === '1') throw new Error('请为本程序配置 HTTPS_PROXY 的 HTTP CONNECT 代理；暂不支持 PAC/WPAD/SOCKS');
  return '';
}
export async function proxyFor() {
  const value = process.env.CLAUDE_MCP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (value !== undefined) {
    if (!value) return '';
    const u = new URL(value);
    if (!['http:','https:'].includes(u.protocol) || u.pathname !== '/' || u.search || u.hash) throw new Error('仅支持 HTTP/HTTPS CONNECT 代理');
    return u.href;
  }
  return parseScutil(await runFile('/usr/sbin/scutil', ['--proxy']));
}
