import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {privateDir, safeFile, atomicWrite, readConfig, normalizeUrl, runFile} from '../macos/platform.mjs';
import {proxySettings, proxyAddress} from '../macos/ui/network-settings.js';

export {privateDir, safeFile, atomicWrite, readConfig, normalizeUrl, runFile};
export const KIT = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version;
export const STATE = process.env.CMCP_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'cmcp');

/** All stored values are encoded before crossing secret-tool's line-oriented CLI. */
export async function keychain(op, id, password, runner = runFile) {
  if (!['get', 'set', 'delete'].includes(op) || !/^[a-f0-9-]{36}$/.test(id)) throw Error('无效的密钥环操作');
  const attributes = ['application', 'cmcp', 'credential', id];
  try {
    if (op === 'set') {
      if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 * 1024) throw Error('Invalid secret');
      await runner('secret-tool', ['store', '--label=CMCP', ...attributes], {input: 'cmcp-v1:' + Buffer.from(password).toString('base64'), timeout: 90000});
    } else if (op === 'get') {
      const value = (await runner('secret-tool', ['lookup', ...attributes], {timeout: 90000})).replace(/\r?\n$/, '');
      if (!/^cmcp-v1:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('Credential unavailable');
      return Buffer.from(value.slice(8), 'base64').toString('utf8');
    } else {
      try { await runner('secret-tool', ['clear', ...attributes], {timeout: 90000}); }
      catch (error) { if (error.code !== 1) throw error; }
    }
  } catch {
    throw Error('无法访问 CMCP 密码：请安装 libsecret-tools 并解锁登录密钥环。不会回退到明文保存。');
  }
}

export function executable(name, env = process.env) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(name)) return null;
  return (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  }) || null;
}

/** Resolve once spawn succeeds; GUI launchers can stay alive for the window lifetime. */
export function launch(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {stdio: 'ignore', detached: true, ...options});
    child.once('error', () => reject(Error('无法启动 ' + path.basename(file))));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function proxyFor(_url, {preferences = {}, env = process.env, runner = runFile} = {}) {
  const settings = proxySettings(preferences);
  if (settings.proxyMode === 'direct') return '';
  if (settings.proxyMode === 'manual') return proxyAddress(settings);
  const supplied = env.CLAUDE_MCP_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (supplied !== undefined) {
    if (!supplied) return '';
    const url = new URL(supplied);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw Error('仅支持 HTTP/HTTPS CONNECT 代理');
    return url.href;
  }
  const setting = async (schema, key) => String(await runner('gsettings', ['get', schema, key])).trim();
  const mode = await setting('org.gnome.system.proxy', 'mode');
  if (mode === "'none'") return '';
  if (mode !== "'manual'") throw Error('系统使用 PAC 或未知代理模式；请在 CMCP 设置中填写手动 HTTP 代理。');
  for (const scheme of ['https', 'http']) {
    const raw = await setting('org.gnome.system.proxy.' + scheme, 'host');
    if (!/^'[A-Za-z0-9.:-]*'$/.test(raw)) throw Error('系统代理地址无效');
    const host = raw.slice(1, -1), port = Number(await setting('org.gnome.system.proxy.' + scheme, 'port'));
    if (!host) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('系统代理端口无效');
    return `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
  }
  throw Error('系统手动代理没有可用的 HTTP 地址；请检查 CMCP 代理设置。');
}
