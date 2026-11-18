import fs from 'node:fs';
import path from 'node:path';
import {KIT, runFile, safeFile} from './platform.mjs';
import {define, result, validator} from '../macos/schema.mjs';

const packages = ['lm-sensors', 'adb', 'nodejs', 'npm', 'docker.io'];
const definitions = [
  define('linux_admin_kernel_log', 'Request recent kernel warnings and errors on the local Ubuntu PC. Requires local confirmation and Ubuntu administrator authorization.', {}, []),
  define('linux_admin_install_package', 'Request installation of a supported Ubuntu package. Opens a local terminal for the user to authorize and complete installation.', {
    package: {enum: packages},
  }, ['package']),
];
const validate = validator(definitions);
const kernelLog = definitions[0].name;

function requireEnabled(stateDir) {
  const file = path.join(stateDir, 'application-preferences.json');
  try {
    safeFile(file);
    if (fs.statSync(file).size <= 32768) {
      const preferences = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (preferences.schema === 1 && preferences.linuxAdminRequests === true) return;
    }
  } catch {}
  throw Error('管理员操作已关闭。请由本机用户在 CMCP「设置 → 通用」开启。');
}

export function createLinuxAdminTools({stateDir, run = runFile}) {
  let requesting = false;
  return {definitions, async call(name, args) {
    validate(name, args);
    requireEnabled(stateDir);
    if (requesting) throw Error('已有管理员请求正在处理。');
    const reading = name === kernelLog;
    const message = reading
      ? '云端 Claude 请求读取这台 Ubuntu 电脑的内核警告和错误。确认并授权后，日志内容会返回给发起请求的连接。'
      : `云端 Claude 请求安装 Ubuntu 软件包 ${args.package}。系统可能安装依赖并更改本机软件。确认后将在本机终端继续授权和安装。`;
    requesting = true;
    try {
      const answer = JSON.parse(await run('/usr/bin/python3', ['-B', path.join(KIT, 'prompt.py'), 'admin'], {
        input: JSON.stringify({message}), timeout: 40000,
      }));
      if (answer.cancelled !== false) return result({status: 'cancelled'});
      requireEnabled(stateDir);
      if (reading) {
        const output = await run('/usr/bin/pkexec', [
          '--disable-internal-agent', '/usr/bin/dmesg', '--color=never', '--level=warn,err,crit,alert,emerg',
        ], {timeout: 55000, maxBuffer: 4 * 1024 * 1024});
        return result({status: 'completed', log: output.slice(-24000)});
      }
      await run('/usr/bin/gnome-terminal', [
        '--', '/usr/bin/sudo', '-k', '--', '/usr/bin/apt-get', '--no-remove', 'install', '--', args.package,
      ], {timeout: 10000});
      return result({status: 'local_terminal_opened', package: args.package,
        message: '请由本机用户在终端授权和确认安装。安装结果以终端为准。'});
    } finally {
      requesting = false;
    }
  }};
}
