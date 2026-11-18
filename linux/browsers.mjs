import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pageFolder} from '../macos/browsers.mjs';
import {executable, launch, privateDir} from './platform.mjs';
export {pageFolder};

const JAMMY_GNOME = (() => {
  if (!process.env.XDG_CURRENT_DESKTOP?.split(':').includes('GNOME')) return false;
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf8');
    return /^ID=(?:ubuntu|"ubuntu")$/m.test(release) && /^VERSION_ID=(?:22\.04|"22\.04")$/m.test(release);
  } catch { return false; }
})();
const useDirectKeyring = (browser, jammyGnome) => jammyGnome && !browser.snap && ['chrome', 'edge'].includes(browser.id);

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
export function openArguments(browser, url, folder, directKeyring = false) {
  if (!folder) return ['--new-window', url];
  return browser.id === 'firefox' ? ['--no-remote', '--profile', folder, '--new-window', url]
    : [...(directKeyring ? ['--disable-features=DbusSecretPortal'] : []),
      '--user-data-dir=' + folder, '--no-first-run', '--no-default-browser-check', '--new-window', url];
}
export async function openPage(preferences, directory, id, url, {found = detectBrowsers(), run = launch, jammyGnome = JAMMY_GNOME} = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('Invalid browser URL');
  const browser = found.find(item => item.id === preferences.browser);
  if (!browser) { await run('xdg-open', [url]); return true; }
  const directKeyring = useDirectKeyring(browser, jammyGnome);
  // A fresh profile prevents reusing cookies or credentials encrypted by the
  // Portal. It also keeps an existing daily browser process from taking over.
  const folder = directKeyring || preferences.closeWeb === true
    ? privateDir(profileFolder(directory, id, browser) + (directKeyring ? '-direct-keyring' : ''))
    : null;
  await run(browser.path, openArguments(browser, url, folder, directKeyring));
  return true;
}
/** Read the process arguments and birth marker used when closing a window. */
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

function chromiumLockPid(folder) {
  try {
    const lock = fs.readlinkSync(path.join(folder, 'SingletonLock'));
    const prefix = os.hostname() + '-';
    if (!lock.startsWith(prefix)) return null;
    const pid = Number(lock.slice(prefix.length));
    return Number.isSafeInteger(pid) && pid > 1 && lock === prefix + pid ? pid : null;
  } catch { return null; }
}

export async function closePages(preferences, directory, id, {list = listProcesses, found = detectBrowsers(), kill = (pid, signal) => process.kill(pid, signal), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), jammyGnome = JAMMY_GNOME} = {}) {
  if (preferences.closeWeb !== true || !['chrome', 'edge', 'firefox'].includes(preferences.browser)) return 0;
  const browser = found.find(item => item.id === preferences.browser) || {id: preferences.browser};
  const profile = profileFolder(directory, id, browser);
  const folders = useDirectKeyring(browser, jammyGnome) ? [profile, profile + '-direct-keyring'] : [profile];
  // Recent Chromium builds replace argv with a single process title. Require
  // both the profile's lock PID and CMCP's complete launch flags in that case.
  const profiles = folders.map(folder => ({
    folder,
    argument: '--user-data-dir=' + folder,
    lockPid: browser.id === 'firefox' ? null : chromiumLockPid(folder),
    launchFlags: ' ' + openArguments(browser, '', folder).slice(0, -1).join(' ') + ' ',
  }));
  const owns = ({pid, argv}) => pid !== process.pid && argv && profiles.some(({folder, argument, lockPid, launchFlags}) =>
    argv.some((arg, i) => arg === argument || (['-profile', '--profile'].includes(arg) && argv[i + 1] === folder)) ||
    (pid === lockPid && argv.length === 1 && argv[0].includes(launchFlags)));
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
