// Read-only protocol detection for the Windows setup UI. Never handles passwords.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requiresSharedSession} from './desktop-auth.mjs';
import {agentFor} from './link-client.mjs';
let agent;
try {
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('invalid address');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'get-proxy.ps1');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout} = await promisify(execFile)(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Url',url.origin],{windowsHide:true,timeout:30000});
  agent = agentFor(url.origin, stdout.trim());
  process.stdout.write(await requiresSharedSession(url.origin,agent) ? 'shared-browser' : 'legacy');
} catch {
  process.stderr.write('无法安全识别云电脑登录协议，请检查地址和网络后重试。');
  process.exitCode = 1;
} finally { agent?.destroy(); }
