"""The VPS side of "初始化／修复 CloudCLI 连接" against fixture systems, then the real one it runs on."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'cloudcli-setup.py'
spec = importlib.util.spec_from_file_location('cloudcli_setup', SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
ME = pwd.getpwuid(os.geteuid())


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def test_only_ubuntu_and_debian_are_supported(self):
        cases = {'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n': True, 'ID=debian\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n': True,
                 'ID=linuxmint\nID_LIKE="ubuntu debian"\n': False, 'ID="centos"\nPRETTY_NAME="CentOS Stream 9"\n': False, '': False}
        for text, supported in cases.items():
            self.write('etc/os-release', text)
            self.assertEqual(setup.os_release(str(self.root))['supported'], supported, text)
        self.assertEqual(setup.os_release(str(self.root))['id'], '')

    def test_systemd_units_report_account_and_port(self):
        units = self.root / 'units'
        self.write('units/cloudcli.service', '[Service]\nUser=ubuntu\nEnvironment="PORT=3005" NODE_ENV=production\nExecStart=/usr/bin/node /usr/lib/node_modules/@siteboon/claude-code-ui/server/index.js\n')
        self.write('units/other.service', '[Service]\nExecStart=/usr/bin/nginx\n')
        self.write('units/claudeui.service', '[Service]\nExecStart=/usr/bin/cloudcli --port 3009\n')
        found = {item['unit']: item for item in setup.systemd_instances([str(units)]) if item['scope'] == 'system'}
        self.assertEqual(set(found), {'cloudcli', 'claudeui'})
        self.assertEqual((found['cloudcli']['user'], found['cloudcli']['port']), ('ubuntu', 3005))
        self.assertEqual((found['claudeui']['user'], found['claudeui']['port']), ('root', 3009))

    def proc(self, pid, args, uid, environ=''):
        base = self.root / 'proc' / str(pid)
        base.mkdir(parents=True)
        (base / 'cmdline').write_bytes('\0'.join(args).encode() + b'\0')
        (base / 'status').write_text('Name:\tnode\nUid:\t%d\t%d\t%d\t%d\n' % (uid, uid, uid, uid))
        (base / 'environ').write_bytes(environ.encode())
        (base / 'fd').mkdir()

    def test_processes_skip_claude_sessions_launchers_and_this_check(self):
        self.proc(100, ['node', '/home/u/.npm/_npx/x/node_modules/@siteboon/claude-code-ui/server/index.js'], ME.pw_uid, 'PORT=3002\0PATH=/usr/bin\0')
        self.proc(101, ['node', '/home/u/.npm/_npx/x/node_modules/@siteboon/claude-code-ui/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'], ME.pw_uid)
        self.proc(102, ['npm', 'exec', '@siteboon/claude-code-ui'], ME.pw_uid)
        self.proc(103, ['python3', '-c', 'claude-code-ui'], ME.pw_uid)
        found = setup.process_instances(str(self.root / 'proc'), me=-1)
        self.assertEqual([(item['pid'], item['port'], item['user']) for item in found], [(100, 3002, ME.pw_name)])
        merged = setup.merge_instances([{'source': 'systemd', 'unit': 'cloudcli', 'user': ME.pw_name, 'port': None}], found + found)
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0]['unit'], merged[0]['port'], merged[0]['running']), ('cloudcli', 3002, True))
        idle = setup.merge_instances([{'source': 'systemd', 'unit': 'cloudcli', 'user': 'root', 'port': None}], [])
        self.assertEqual((idle[0]['port'], idle[0]['portKnown'], idle[0]['running']), (3001, False, False))

    def test_mcp_entry_must_point_at_an_existing_connector(self):
        home = self.root / 'home'
        user = {'user': 'u', 'uid': ME.pw_uid, 'home': str(home)}
        name = 'cmcp-ssh-0123456789abcdef'
        self.assertEqual(setup.mcp_state(user, name)['present'], False)
        connector = self.write('home/.local/share/cloudpc-link/%s/connector.py' % name, '')
        self.write('home/.claude.json', json.dumps({'mcpServers': {name: {'command': '/usr/bin/python3', 'args': ['-u', str(connector), 'serve']}}}))
        self.assertEqual(setup.mcp_state(user, name)['present'], True)
        connector.unlink()
        self.assertEqual(setup.mcp_state(user, name)['present'], False)
        self.write('home/.claude.json', '{broken')
        self.assertEqual(setup.mcp_state(user, name).get('invalid'), True)

    def test_search_path_prefers_the_node_that_runs_cloudcli(self):
        home = self.root / 'home'
        (home / '.nvm/versions/node/v22.1.0/bin').mkdir(parents=True)
        path = setup.search_path({'home': str(home)}, {'node': '/opt/node/bin/node', 'path': '/srv/bin:relative'}).split(':')
        self.assertEqual(path[:2], ['/opt/node/bin', '/srv/bin'])
        self.assertNotIn('relative', path)
        self.assertIn(str(home / '.nvm/versions/node/v22.1.0/bin'), path)
        self.assertEqual(path[-1], '/bin')

    def test_sudo_install_passes_the_password_on_stdin_only(self):
        if os.geteuid() == 0:
            self.skipTest('root installs without sudo')
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        npm = bin_dir / 'npm'
        npm.write_text('#!/bin/sh\nexit 0\n')
        npm.chmod(0o755)
        seen = []

        def run(command, **options):
            seen.append((command, options))
            return subprocess.CompletedProcess(command, 1, '', 'sudo: 1 incorrect password attempt')
        original = setup.search_path
        setup.search_path = lambda user, instance: str(bin_dir)
        try:
            result = setup.install({'account': ME.pw_name, 'mode': 'root', 'password': 'SUDO-FIXTURE'}, run)
        finally:
            setup.search_path = original
        self.assertEqual(result, {'ok': False, 'code': 'SUDO'})
        command, options = seen[0]
        self.assertEqual(command[:6], ['sudo', '-S', '-k', '-p', '', '--'])
        self.assertNotIn('SUDO-FIXTURE', ' '.join(command))
        self.assertNotIn('SUDO-FIXTURE', json.dumps(options.get('env') or {}))
        self.assertEqual(options['input'], 'SUDO-FIXTURE\n')


class RealSystem(unittest.TestCase):
    def test_inspect_runs_read_only_on_this_system(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)], input=json.dumps({'action': 'inspect', 'connector': 'cmcp-ssh-0123456789abcdef'}) + '\n',
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report['ok'])
        self.assertEqual(report['me']['user'], ME.pw_name)
        self.assertIn(report['privilege'], ('root', 'sudo-nopass', 'sudo-password', 'none'))

    def test_bad_requests_are_refused(self):
        for line in ('{"action":"inspect","connector":"x"}', '{"action":"install","connector":"cmcp-ssh-0123456789abcdef","account":"a;b","mode":"user"}', 'nope'):
            result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)], input=line + '\n', capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0, line)


if __name__ == '__main__':
    unittest.main()
