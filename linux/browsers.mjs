import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pageFolder} from '../macos/browsers.mjs';
import {executable, launch, privateDir} from './platform.mjs';
export {pageFolder};

function snapName(file) {
  if (/\/snap\/bin\/(firefox|chromium)$/.test(file)) return path.basename(file);
  // Ubuntu's /usr/bin/firefox and chromium-browser can be small Snap wrappers.
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const bytes = Buffer.alloc(4096), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, size).toString('utf8');
    return text.startsWith('#!') ? /\/snap\/bin\/(firefox|chromium)\b/.exec(text)?.[1] || null : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** Confined Snap browsers cannot access CMCP's hidden XDG state directory. */
export function profileFolder(directory, id, browser, home = os.homedir()) {
  return browser.snap ? pageFolder(path.join(home, 'snap', browser.snap, 'common', 'cmcp'), directory + '\0' + id, browser.id) : pageFolder(directory, id, browser.id);
}

export function detectBrowsers(find = executable) {
  return [['chrome', 'Chrome / Chromium', ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']], ['edge', 'Microsoft Edge', ['microsoft-edge', 'microsoft-edge-stable']], ['firefox', 'Firefox', ['firefox']]]
    .map(([id, label, names]) => ({id, label, path: names.map(name => find(name)).find(Boolean)})).filter(item => item.path).map(item => ({...item, snap: snapName(item.path)}));
}
export function openArguments(browser, url, folder) {
  if (!folder) return ['--new-window', url];
  return browser.id === 'firefox' ? ['--no-remote', '--profile', folder, '--new-window', url]
    : ['--user-data-dir=' + folder, '--no-first-run', '--no-default-browser-check', '--new-window', url];
}
export async function openPage(preferences, directory, id, url, {found = detectBrowsers(), run = launch} = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('Invalid browser URL');
  const browser = found.find(item => item.id === preferences.browser);
  if (!browser) { await run('xdg-open', [url]); return true; }
  const folder = preferences.closeWeb === true ? privateDir(profileFolder(directory, id, browser)) : null;
  await run(browser.path, openArguments(browser, url, folder));
  return true;
}
/** /proc gives exact argv boundaries and a birth marker; never match a path substring. */
export async function listProcesses(proc = '/proc') {
  const result = [];
  for (const name of fs.readdirSync(proc).filter(name => /^\d+$/.test(name))) {
    try {
      const base = path.join(proc, name);
      if (fs.statSync(base).uid !== process.getuid()) continue;
      const stat = fs.readFileSync(path.join(base, 'stat'), 'utf8').split(') ').at(-1).split(' ');
      const argv = fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      result.push({pid: Number(name), ppid: Number(stat[1]), started: stat[19], argv, command: argv.join(' ')});
    } catch { /* Processes may exit between directory enumeration and reads. */ }
  }
  return result;
}
export async function closePages(preferences, directory, id, {list = listProcesses, found = detectBrowsers(), kill = (pid, signal) => process.kill(pid, signal), wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  if (preferences.closeWeb !== true || !['chrome', 'edge', 'firefox'].includes(preferences.browser)) return 0;
  const folder = profileFolder(directory, id, found.find(item => item.id === preferences.browser) || {id: preferences.browser});
  const owns = item => item.pid !== process.pid && item.argv?.some((arg, i, args) => arg === '--user-data-dir=' + folder || (['-profile', '--profile'].includes(arg) && args[i + 1] === folder));
  const original = (await list()).filter(owns);
  const signal = async kind => {
    for (const item of (await list()).filter(owns)) {
      if (!original.some(old => old.pid === item.pid && old.started === item.started)) continue;
      try { kill(item.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  await signal('SIGTERM');
  for (let i = 0; i < 10 && (await list()).some(item => owns(item) && original.some(old => old.pid === item.pid && old.started === item.started)); i++) await wait(100);
  await signal('SIGKILL');
  return original.length;
}
