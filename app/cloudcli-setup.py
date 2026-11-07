"""Read-only checks and the one install step for a CloudCLI installed without WebDesktop.

CMCP runs this over the device's saved SSH login (app/cloudcli-setup.mjs). It reads one JSON
line from stdin and prints one JSON line. It never changes CloudCLI, its service, nginx, Caddy
or firewalls. The only change it can make is installing the Claude CLI, and only when asked.
A sudo password arrives on stdin, goes to sudo's stdin and is never written anywhere.
"""
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys

PATTERN = re.compile(r'claude-code-ui|claudecodeui|@siteboon|(?:^|/)cloudcli(?:\s|$|\.js)', re.IGNORECASE)
UNIT_DIRS = ('/etc/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system')
DEFAULT_PORT = 3001
SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
PACKAGE = '@anthropic-ai/claude-code'
NAME = re.compile(r'^cmcp-ssh-[0-9a-f]{16}$')
ACCOUNT = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')


def read_text(path, limit=1024 * 1024):
    try:
        with open(path, 'rb') as handle:
            return handle.read(limit).decode('utf-8', 'replace')
    except OSError:
        return None


def os_release(root='/'):
    values = {}
    text = read_text(os.path.join(root, 'etc/os-release')) or read_text(os.path.join(root, 'usr/lib/os-release')) or ''
    for line in text.splitlines():
        match = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
        if match:
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                value = value[1:-1]
            values[match.group(1)] = value
    family = {values.get('ID', '').lower()} | set(values.get('ID_LIKE', '').lower().split())
    return {'id': values.get('ID', ''), 'version': values.get('VERSION_ID', ''), 'pretty': values.get('PRETTY_NAME', values.get('ID', ''))[:120],
            'supported': values.get('ID', '').lower() in ('ubuntu', 'debian')}


def account(uid=None, name=None):
    try:
        entry = pwd.getpwuid(uid) if name is None else pwd.getpwnam(name)
        return {'uid': entry.pw_uid, 'user': entry.pw_name, 'home': entry.pw_dir}
    except (KeyError, OverflowError):
        return None


def privilege(run=subprocess.run):
    if os.geteuid() == 0:
        return 'root'
    if not shutil.which('sudo'):
        return 'none'
    try:
        if run(['sudo', '-n', 'true'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0:
            return 'sudo-nopass'
    except (OSError, subprocess.TimeoutExpired):
        return 'none'
    groups = set()
    try:
        groups = {__import__('grp').getgrgid(g).gr_name for g in os.getgroups()}
    except (KeyError, ImportError):
        pass
    return 'sudo-password' if groups & {'sudo', 'admin', 'wheel'} else 'none'


def port_in(text):
    match = re.search(r'(?:--port[= ]|-p )(\d{2,5})\b', text or '')
    return int(match.group(1)) if match and 0 < int(match.group(1)) < 65536 else None


def unit_files(roots=UNIT_DIRS):
    for root in roots:
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for name in names:
            if name.endswith('.service'):
                yield os.path.join(root, name), None
    for entry in pwd.getpwall():
        folder = os.path.join(entry.pw_dir, '.config/systemd/user')
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for name in names:
            if name.endswith('.service'):
                yield os.path.join(folder, name), entry.pw_name


def systemd_instances(roots=UNIT_DIRS):
    found, seen = [], set()
    for path, owner in unit_files(roots):
        name = os.path.basename(path)
        if name in seen and owner is None:
            continue
        text = read_text(path, 65536)
        if not text:
            continue
        execs = [line.split('=', 1)[1] for line in text.splitlines() if line.strip().startswith('ExecStart=')]
        if not any(PATTERN.search(line) for line in execs):
            continue
        seen.add(name)
        user, port = owner or 'root', None
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('User=') and owner is None:
                user = line[5:].strip() or 'root'
            if line.startswith('Environment='):
                match = re.search(r'(?:^|[\s"])PORT=(\d{2,5})\b', line[12:])
                if match:
                    port = int(match.group(1))
        port = port or next((port_in(line) for line in execs if port_in(line)), None)
        found.append({'source': 'systemd', 'unit': name[:-8], 'scope': 'user' if owner else 'system', 'user': user, 'port': port})
    return found


def listening_ports(pid, proc='/proc'):
    inodes = set()
    try:
        for fd in os.listdir(os.path.join(proc, str(pid), 'fd')):
            match = re.match(r'socket:\[(\d+)\]', os.readlink(os.path.join(proc, str(pid), 'fd', fd)))
            if match:
                inodes.add(match.group(1))
    except OSError:
        return []
    ports = []
    for table in ('net/tcp', 'net/tcp6'):
        for line in (read_text(os.path.join(proc, table)) or '').splitlines()[1:]:
            parts = line.split()
            if len(parts) > 9 and parts[3] == '0A' and parts[9] in inodes:
                ports.append(int(parts[1].rsplit(':', 1)[1], 16))
    return sorted(set(ports))


def process_instances(proc='/proc', me=os.getpid()):
    found = []
    try:
        pids = [int(name) for name in os.listdir(proc) if name.isdigit()]
    except OSError:
        return found
    for pid in sorted(pids):
        if pid in (me, os.getppid()):
            continue
        raw = read_text(os.path.join(proc, str(pid), 'cmdline'), 65536)
        if not raw:
            continue
        args = [part for part in raw.split('\0') if part]
        joined = ' '.join(args)
        # Claude sessions that CloudCLI starts live inside its node_modules; npm/npx only launch it.
        if not args or not PATTERN.search(joined) or re.search(r'claude-agent-sdk|@anthropic-ai/', joined) or os.path.basename(args[0]) in ('sh', 'bash', 'grep', 'python3', 'sudo', 'runuser', 'npm', 'npx'):
            continue
        uid = None
        for line in (read_text(os.path.join(proc, str(pid), 'status')) or '').splitlines():
            if line.startswith('Uid:'):
                uid = int(line.split()[1])
        owner = account(uid) if uid is not None else None
        environ = read_text(os.path.join(proc, str(pid), 'environ'))
        values = dict(item.split('=', 1) for item in (environ or '').split('\0') if '=' in item)
        port = int(values['PORT']) if values.get('PORT', '').isdigit() else port_in(' '.join(args))
        ports = listening_ports(pid, proc)
        if not port and len(ports) == 1:
            port = ports[0]
        try:
            node = os.readlink(os.path.join(proc, str(pid), 'exe'))
        except OSError:
            node = None
        found.append({'source': 'process', 'pid': pid, 'user': owner['user'] if owner else str(uid), 'port': port,
                      'node': node if node and os.path.basename(node).startswith('node') else None, 'path': values.get('PATH')})
    return found


def merge_instances(units, processes):
    merged = []
    for process in processes:
        if any(m['running'] and m['user'] == process['user'] and m['port'] == process['port'] for m in merged):
            continue
        unit = next((u for u in units if u['user'] == process['user'] and (u['port'] in (None, process['port']))), None)
        item = dict(process, running=True)
        if unit:
            item['unit'] = unit['unit']
            item['port'] = item['port'] or unit['port']
            units = [u for u in units if u is not unit]
        merged.append(item)
    merged += [dict(unit, running=False) for unit in units]
    for item in merged:
        item['portKnown'] = bool(item.get('port'))
        item['port'] = item.get('port') or DEFAULT_PORT
    return merged


def as_user(user, me, command, environment, run=subprocess.run, timeout=30):
    """Run a command as the CloudCLI account: directly when that is us, through runuser as root."""
    env = {'HOME': user['home'], 'PATH': environment, 'LANG': 'C.UTF-8'}
    if user['user'] == me['user']:
        return run(command, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    if os.geteuid() != 0:
        raise PermissionError('not root')
    return run(['/usr/sbin/runuser', '-u', user['user'], '--', 'env', '-i'] + ['%s=%s' % item for item in env.items()] + command,
               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)


def search_path(user, instance):
    home = Path(user['home'])
    folders = []
    if instance.get('node'):
        folders.append(str(Path(instance['node']).parent))
    if instance.get('path'):
        folders += [part for part in instance['path'].split(':') if part.startswith('/')]
    folders += [str(home / '.local/bin'), str(home / '.npm-global/bin'), str(home / '.claude/local'), str(home / '.volta/bin')]
    try:
        versions = sorted((home / '.nvm/versions/node').iterdir(), reverse=True)
        folders += [str(item / 'bin') for item in versions]
    except OSError:
        pass
    folders += SYSTEM_PATH.split(':')
    unique = []
    for folder in folders:
        if folder not in unique:
            unique.append(folder)
    return ':'.join(unique)


def find(name, path):
    for folder in path.split(':'):
        candidate = os.path.join(folder, name)
        try:
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        except OSError:
            pass
    return None


def claude_state(user, me, path, run=subprocess.run):
    found = find('claude', path)
    if not found:
        return {'found': False}
    try:
        result = as_user(user, me, [found, '--version'], path, run, 30)
        version = (result.stdout or '').strip().splitlines()[0][:80] if result.returncode == 0 and result.stdout.strip() else ''
        return {'found': result.returncode == 0, 'path': found, 'version': version}
    except (OSError, subprocess.TimeoutExpired, PermissionError):
        return {'found': False, 'path': found}


def npm_state(user, me, path, run=subprocess.run):
    npm = find('npm', path)
    if not npm:
        return None
    try:
        result = as_user(user, me, [npm, 'prefix', '-g'], path, run, 30)
        prefix = result.stdout.strip() if result.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired, PermissionError):
        prefix = ''
    writable = False
    if prefix:
        try:
            info = os.stat(prefix)
            writable = info.st_uid == user['uid'] or prefix.startswith(user['home'].rstrip('/') + '/')
        except OSError:
            pass
    return {'path': npm, 'prefix': prefix, 'userWritable': writable}


def mcp_state(user, name):
    config = os.path.join(user['home'], '.claude.json')
    try:
        info = os.lstat(config)
    except FileNotFoundError:
        return {'config': config, 'readable': True, 'present': False}
    except OSError:
        return {'config': config, 'readable': False, 'present': False}
    if not stat.S_ISREG(info.st_mode):
        return {'config': config, 'readable': False, 'present': False}
    text = read_text(config, 32 * 1024 * 1024)
    if text is None:
        return {'config': config, 'readable': False, 'present': False}
    try:
        servers = json.loads(text).get('mcpServers', {})
    except (ValueError, AttributeError):
        return {'config': config, 'readable': True, 'present': False, 'invalid': True}
    entry = servers.get(name) if isinstance(servers, dict) else None
    args = entry.get('args') if isinstance(entry, dict) else None
    present = isinstance(args, list) and len(args) > 1 and isinstance(args[1], str) and os.path.isfile(args[1])
    return {'config': config, 'readable': True, 'present': present}


def webdesktop_present(root='/'):
    return any(os.path.exists(os.path.join(root, item)) for item in ('etc/systemd/system/wd-claude-session.service', 'opt/webdesktop', 'etc/systemd/system/webdesktop.service'))


def inspect(request, run=subprocess.run):
    me = account(os.geteuid())
    report = {'ok': True, 'os': os_release(), 'python': '%d.%d' % sys.version_info[:2], 'me': me, 'privilege': privilege(run), 'webdesktop': webdesktop_present()}
    if not report['os']['supported']:
        return report
    instances = merge_instances(systemd_instances(), process_instances())
    report['instances'] = instances[:8]
    wanted = request.get('port')
    chosen = next((i for i in instances if i['running'] and i['port'] == wanted), None) or next((i for i in instances if i['running']), None) or (instances[0] if instances else None)
    if not chosen:
        return report
    report['chosen'] = chosen
    user = account(name=chosen['user'])
    if not user:
        return report
    report['account'] = user
    if user['user'] != me['user'] and os.geteuid() != 0:
        return report
    path = search_path(user, chosen)
    report['claude'] = claude_state(user, me, path, run)
    report['npm'] = npm_state(user, me, path, run)
    report['mcp'] = mcp_state(user, request['connector'])
    return report


def install(request, run=subprocess.run):
    """Install the Claude CLI for the CloudCLI account with npm, as that account or as root."""
    me = account(os.geteuid())
    user = account(name=request['account'])
    if not user:
        return {'ok': False, 'code': 'ACCOUNT'}
    path = search_path(user, {'node': request.get('node'), 'path': None})
    npm = find('npm', path)
    if not npm:
        return {'ok': False, 'code': 'NPM'}
    command = [npm, 'install', '-g', PACKAGE]
    try:
        if request.get('mode') == 'user':
            result = as_user(user, me, command, path, run, 600)
        elif os.geteuid() == 0:
            result = run(command, env={'HOME': '/root', 'PATH': path, 'LANG': 'C.UTF-8'}, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
        else:
            password = request.get('password')
            # -S reads the password from stdin, -k forgets any cached ticket, -p '' prints no prompt.
            sudo = ['sudo', '-S', '-k', '-p', '', '--', 'env', 'PATH=' + path, 'HOME=/root', 'LANG=C.UTF-8'] + command
            result = run(sudo, input=(password + '\n') if isinstance(password, str) else '', capture_output=True, text=True, timeout=600)
            if result.returncode != 0 and re.search(r'incorrect password|try again|a password is required|not in the sudoers|may not run sudo', result.stderr or '', re.IGNORECASE):
                return {'ok': False, 'code': 'SUDO'}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'code': 'TIMEOUT'}
    except (OSError, PermissionError):
        return {'ok': False, 'code': 'START'}
    if result.returncode != 0:
        return {'ok': False, 'code': 'NPM_FAILED', 'detail': (result.stderr or result.stdout or '')[-600:]}
    return {'ok': True, 'claude': claude_state(user, me, path, run)}


def main():
    raw = sys.stdin.buffer.readline(65536)
    if not raw.endswith(b'\n'):
        raise ValueError('Invalid request')
    request = json.loads(raw)
    if not isinstance(request, dict) or not isinstance(request.get('connector'), str) or not NAME.match(request['connector']):
        raise ValueError('Invalid request')
    if request.get('action') == 'install':
        if not isinstance(request.get('account'), str) or not ACCOUNT.match(request['account']) or request.get('mode') not in ('user', 'root'):
            raise ValueError('Invalid request')
        result = install(request)
    else:
        result = inspect(request)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
