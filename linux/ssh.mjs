import fs from 'node:fs';
import path from 'node:path';
import {commandScript, sshProblem, answerPrompt as baseAnswerPrompt, sessionsFolder} from '../macos/ssh.mjs';
import {KIT, privateDir, atomicWrite, executable, launch, runFile} from './platform.mjs';
import {listProcesses} from './browsers.mjs';
export {sshProblem};
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

export function detectTerminals(find = executable) {
  return [['gnome-terminal', 'GNOME Terminal'], ['x-terminal-emulator', 'System terminal'], ['xterm', 'XTerm']].map(([id, label]) => ({id, label, path: find(id)})).filter(item => item.path);
}
function askpassFile(directory) {
  const file = path.join(privateDir(path.join(directory, 'ssh-run')), 'askpass');
  atomicWrite(file, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(path.join(KIT, 'ssh-askpass.mjs')) + ' "$1"\n', 0o700);
  return file;
}
export function webTunnelEnvironment(login, directory) {
  return {...process.env, CMCP_STATE_DIR: directory, CMCP_SSH_ASKPASS: login.id, SSH_ASKPASS: askpassFile(directory), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0'};
}
export async function openTerminal(login, directory, chosen, {found = detectTerminals(), run = launch, closeTerminal = false} = {}) {
  if (sshProblem(login)) throw Error(sshProblem(login));
  const terminal = found.find(item => item.id === chosen) || found[0];
  if (!terminal) throw Error('没有找到终端，请安装 gnome-terminal。');
  const {randomUUID} = await import('node:crypto');
  const folder = privateDir(path.join(directory, 'ssh-run')), file = path.join(folder, randomUUID() + '.sh');
  const text = commandScript(login, {askpass: askpassFile(directory), state: directory, mcp: {node: process.execPath, script: path.join(KIT, '../app/ssh-terminal.mjs'), owner: process.pid}, sessions: closeTerminal ? privateDir(sessionsFolder(directory, login.id)) : undefined});
  atomicWrite(file, text.replace('exec "${SHELL:-/bin/zsh}" -l', 'exec "${SHELL:-/bin/bash}" -l'), 0o700);
  const args = terminal.id === 'gnome-terminal' ? ['--wait', '--', '/bin/sh', file] : ['-e', '/bin/sh', file];
  try { await run(terminal.path, args); } catch (error) { try { fs.unlinkSync(file); } catch {} throw error; }
  return terminal.id;
}
export async function closeSessions(directory, id, {list = listProcesses, kill = (pid, signal) => process.kill(pid, signal)} = {}) {
  const folder = sessionsFolder(directory, id); let names;
  try { names = fs.readdirSync(folder).filter(name => /^\d+\.pid$/.test(name)); } catch { return 0; }
  const processes = await list(); let count = 0;
  for (const name of names) {
    const shell = processes.find(item => item.pid === Number(name.slice(0, -4)) && item.argv?.some(arg => path.dirname(arg) === path.join(directory, 'ssh-run')));
    try { fs.unlinkSync(path.join(folder, name)); } catch {}
    if (!shell) continue;
    for (const child of processes.filter(item => item.ppid === shell.pid && path.basename(item.argv?.[0] || '') === 'ssh')) {
      const current = (await list()).find(item => item.pid === child.pid && item.started === child.started);
      if (current) { try { kill(child.pid, 'SIGTERM'); count++; } catch {} }
    }
  }
  return count;
}
async function dialog(message, kind, _language, run = runFile) {
  // zenity reads the prompt from a file descriptor, not from the command line.
  try {
    const output = await run('/usr/bin/python3', [path.join(KIT, 'prompt.py'), kind], {input: JSON.stringify({message}), timeout: 600000});
    const result = JSON.parse(output); return result.cancelled ? null : result.value;
  } catch { return null; }
}
export const answerPrompt = options => baseAnswerPrompt({...options, ask: options.ask || dialog});
