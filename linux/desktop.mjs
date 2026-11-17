import fs from 'node:fs';
import path from 'node:path';
import {STATE, privateDir, safeFile} from './platform.mjs';
import {createManager} from './manager.mjs';

if (process.platform !== 'linux') throw Error('CMCP Ubuntu entry requires Linux');
if (process.getuid() === 0) throw Error('请以普通桌面用户运行 CMCP，不要使用 sudo。');
process.umask(0o077);
privateDir(STATE);
const lock = path.join(STATE, 'manager.lock');
safeFile(lock);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
let fd;
try { fd = fs.openSync(lock, 'wx', 0o600); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 2 || alive(pid)) throw Error('CMCP 已在运行或正在启动，请从应用菜单打开现有窗口。');
  fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx', 0o600);
}
fs.writeFileSync(fd, String(process.pid));
const cleanup = () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} try { fs.closeSync(fd); } catch {} };
process.once('exit', cleanup);
let manager, closing = false;
async function stop() {
  if (closing) return; closing = true;
  process.stdin.pause();
  try { await manager?.close(); } finally { cleanup(); }
}
try {
  manager = await createManager();
  // The native host reads this private pipe once; never save this management token.
  process.stdout.write(JSON.stringify({origin: manager.origin, token: manager.token}) + '\n');
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { void stop(); });
  process.stdin.resume(); process.stdin.once('end', () => { void stop(); });
} catch {
  await stop(); process.stderr.write('CMCP Linux 启动失败，请检查安装依赖和私有状态目录。\n'); process.exitCode = 1;
}
