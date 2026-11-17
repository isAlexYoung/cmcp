import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update_runtime as u


class Child:
    pid = 12345
    running = True
    def poll(self):
        return None if self.running else 0
    def terminate(self):
        self.running = False
    def wait(self, timeout=None):
        return 0


@unittest.skipUnless(os.name == 'posix', 'Real POSIX ownership and modes required')
class Updates(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / 'system'
        self.state = u.private(self.root / 'state')
        self.bundle(self.base, '1.0.0')
        (self.state / 'targets.json').write_text('KEEP-CONFIG')

    def bundle(self, root, version):
        root.mkdir(mode=0o700, parents=True)
        files = []
        for name in sorted(u.REQUIRED):
            file = root / name
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            data = json.dumps({'version': version}).encode() if name == 'linux/package.json' else b'\x7fELFfixture' if name == 'runtime/node' else b'fixture'
            file.write_bytes(data)
            file.chmod(0o700 if name == 'runtime/node' else 0o600)
            files.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest()})
        u.atomic(root / 'distribution-manifest.json', {'schema': 1, 'version': version, 'platform': 'linux-x64', 'sourceCommit': 'a' * 40, 'development': False, 'files': files})

    def request(self, version='2.0.0', old=None):
        folder = u.private(self.state / ('update-' + str(uuid.uuid4())))
        payload = self.root / ('payload-' + str(uuid.uuid4()))
        self.bundle(payload, version)
        archive = folder / f'CMCP-{version}-linux-x64.zip'
        with zipfile.ZipFile(archive, 'x') as output:
            for file in payload.rglob('*'):
                if file.is_file():
                    output.write(file, 'CMCP/' + file.relative_to(payload).as_posix())
        archive.chmod(0o600)
        file = self.state / ('update-request-' + str(uuid.uuid4()) + '.json')
        request = {'state': str(self.state), 'folder': str(folder), 'zip': str(archive), 'version': version, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'installRoot': str(old or self.base), 'nonce': str(uuid.uuid4()), 'appPid': 2147483646, 'appPidStamp': 'missing', 'managerPid': 2147483645, 'managerPidStamp': 'missing'}
        u.atomic(file, request)
        return file, request

    def test_success_activates_verified_newer_overlay_and_preserves_user_data(self):
        file, _ = self.request()
        calls = []
        root = u.apply(file, self.base, launch=lambda root, request: calls.append(root) or Child(), healthy=lambda: True)
        self.assertEqual(u.active_root(self.base, self.state), root)
        self.assertEqual(calls, [root])
        self.assertEqual((self.state / 'targets.json').read_text(), 'KEEP-CONFIG')
        self.assertEqual(u.validate(self.base)['version'], '1.0.0')
        self.assertFalse(Path(str(file) + '.ready').exists())

    def test_unhealthy_launch_restores_pointer_and_reopens_the_old_application(self):
        first, _ = self.request()
        old = u.apply(first, self.base, launch=lambda *_: Child(), healthy=lambda: True)
        file, _ = self.request('3.0.0', old)
        calls = []
        with self.assertRaises(RuntimeError):
            u.apply(file, self.base, launch=lambda root, request: calls.append((root, request)) or Child(), healthy=lambda: False)
        self.assertEqual(u.active_root(self.base, self.state), old)
        self.assertEqual(calls[-1], (old, None))
        self.assertEqual(len(list((self.state / 'updates/apps').iterdir())), 1)
        self.assertEqual((self.state / 'targets.json').read_text(), 'KEEP-CONFIG')

    def test_modified_download_is_rejected_before_activation(self):
        file, request = self.request()
        Path(request['zip']).write_bytes(b'CORRUPT')
        with self.assertRaises(ValueError):
            u.apply(file, self.base, launch=lambda *_: self.fail('Must not launch'))
        self.assertEqual(u.active_root(self.base, self.state), self.base)

    def test_traversal_and_unlisted_resources_are_rejected(self):
        for name in ('CMCP/../outside', 'CMCP/extra-file'):
            file, request = self.request()
            archive = Path(request['zip'])
            with zipfile.ZipFile(archive, 'a') as output:
                output.writestr(name, b'bad')
            request['sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
            u.atomic(file, request)
            with self.assertRaises(ValueError):
                u.apply(file, self.base, launch=lambda *_: self.fail('Must not launch'))
            self.assertFalse((self.root / 'outside').exists())

    def test_modified_overlay_or_newer_system_installation_uses_system_version(self):
        file, _ = self.request()
        root = u.apply(file, self.base, launch=lambda *_: Child(), healthy=lambda: True)
        (root / 'linux/desktop.py').write_text('tampered')
        self.assertEqual(u.active_root(self.base, self.state), self.base)

    def test_symlink_inventory_and_same_version_are_rejected(self):
        file, request = self.request('1.0.0')
        with self.assertRaises(ValueError):
            u.read_request(file, self.base)
        destination = self.base / 'linux/desktop.py'
        destination.unlink()
        destination.symlink_to(self.state / 'targets.json')
        with self.assertRaises(ValueError):
            u.validate(self.base)

    def test_live_old_process_prevents_switch(self):
        file, request = self.request()
        request.update(appPid=os.getpid(), appPidStamp=u.process_stamp(os.getpid()))
        u.atomic(file, request)
        with self.assertRaises(TimeoutError):
            u.apply(file, self.base, launch=lambda *_: self.fail('Must not launch'), wait_seconds=0.01)
        self.assertFalse((self.state / 'updates/active.json').exists())


if __name__ == '__main__':
    unittest.main()
