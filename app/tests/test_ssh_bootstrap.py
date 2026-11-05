"""CLI-only installation regression; transport behavior has a Unix integration test."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ssh_bootstrap', str(HERE / 'ssh-bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cmcp-ssh-install-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.name = 'cmcp-ssh-' + 'a' * 16
        self.payload = {'name': self.name, 'catalog': {'instructions': 'LOCAL PC', 'tools': []},
                        'connector': (HERE / 'cloudpc-connector.py').read_text(encoding='utf-8'),
                        'relay': 'RELAY FIXTURE'}
        self.started = []

    def run_bootstrap(self):
        original = bootstrap.load
        started = self.started

        class Relay:
            def __init__(self, directory):
                self.directory = directory

            def run(self):
                started.append(self.directory)

        def load(name, file):
            if name == 'ssh_relay':
                return types.SimpleNamespace(Relay=Relay)
            return original(name, file)

        with patch.object(Path, 'home', return_value=self.home), \
                patch.object(bootstrap, 'load', side_effect=load), \
                patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO((json.dumps(self.payload) + '\n').encode()))), \
                patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': ''}), \
                patch.object(os, 'getuid', return_value=0 if os.name == 'nt' else os.getuid(), create=True), \
                patch.object(sys, 'version_info', (3, 12)):
            # Windows cannot enforce POSIX directory owner/mode checks. The Linux
            # integration runs the unmodified check against real Unix directories.
            if os.name == 'nt':
                with patch.object(bootstrap, 'private_directory', side_effect=lambda p: p.mkdir(exist_ok=True)):
                    bootstrap.main()
            else:
                bootstrap.main()

    def test_preserves_existing_cli_and_desktop_config_and_installs_separate_socket(self):
        code = self.home / '.claude.json'
        code.write_text(json.dumps({'oauthAccount': {'id': 'retained'}, 'mcpServers': {'original': {'command': 'original'}}}))
        desktop = self.home / '.config' / 'Claude' / 'claude_desktop_config.json'
        desktop.parent.mkdir(parents=True)
        desktop.write_text('DESKTOP UNCHANGED')
        self.run_bootstrap()
        installed = json.loads(code.read_text())
        self.assertEqual(installed['oauthAccount'], {'id': 'retained'})
        self.assertEqual(installed['mcpServers']['original'], {'command': 'original'})
        entry = installed['mcpServers'][self.name]
        self.assertEqual(entry['env']['CLOUDPC_LINK_SOCKET'], str(self.started[0] / 'link.sock'))
        self.assertIn('serve', entry['args'])
        self.assertNotEqual(self.started[0], self.home / '.local' / 'share' / 'cloudpc-link')
        self.assertEqual(desktop.read_text(), 'DESKTOP UNCHANGED')
        self.assertEqual(len(list(self.home.glob('.claude.json.mcp-backup-*'))), 1)
        # Reconnect is idempotent and does not keep producing config backups.
        before = code.read_bytes()
        self.run_bootstrap()
        self.assertEqual(code.read_bytes(), before)
        self.assertEqual(len(list(self.home.glob('.claude.json.mcp-backup-*'))), 1)

    def test_malformed_existing_cli_configuration_is_retained(self):
        code = self.home / '.claude.json'
        code.write_text('{"mcpServers": []}')
        with self.assertRaisesRegex(ValueError, 'mcpServers must be an object'):
            self.run_bootstrap()
        self.assertEqual(code.read_text(), '{"mcpServers": []}')
        self.assertEqual(self.started, [])

    def test_invalid_bootstrap_name_cannot_traverse_directories(self):
        self.payload['name'] = '../../outside'
        with self.assertRaisesRegex(ValueError, 'connector name'):
            self.run_bootstrap()
        self.assertFalse((self.home / '.local').exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX directory permissions require Unix')
    def test_symlink_and_writable_shared_directories_are_refused(self):
        destination = self.home / 'shared'
        destination.mkdir()
        symlink = self.home / 'alias'
        symlink.symlink_to(destination, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Unsafe connector directory'):
            bootstrap.private_directory(symlink)
        destination.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'Unsafe connector directory'):
            bootstrap.private_directory(destination)


if __name__ == '__main__':
    unittest.main()
