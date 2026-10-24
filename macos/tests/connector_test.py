import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('connector', Path(__file__).resolve().parents[1] / 'cloudpc-connector.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class MemoryMac:
    def __init__(self, data=b''):
        self.data = data
        self.upload = bytearray()
        self.cancelled = False
        self.corrupt = False

    def call_tool(self, name, args):
        if name == 'mac_binary_info':
            return {'size': len(self.data), 'sha256': hashlib.sha256(self.data).hexdigest()}
        if name == 'mac_binary_read':
            data = self.data[args['offset']:args['offset'] + 1048576]
            if self.corrupt:
                data = b'!' * len(data)
            return {'data': base64.b64encode(data).decode(), 'bytes': len(data)}
        if name == 'mac_binary_begin':
            self.expected = args
            return {'upload_id': 'test'}
        if name == 'mac_binary_write':
            if args['offset'] != len(self.upload):
                raise ValueError('Bad upload offset')
            self.upload.extend(base64.b64decode(args['data'], validate=True))
        if name == 'mac_binary_finish':
            self.cancelled = args.get('cancel', False)
            if not self.cancelled:
                assert len(self.upload) == self.expected['size']
                assert hashlib.sha256(self.upload).hexdigest() == self.expected['sha256']


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def test_config_install_preserves_other_servers_and_makes_backup(self):
        target = self.root / 'claude.json'
        original = {'mcpServers': {'other': {'command': 'keep'}}, 'theme': 'dark'}
        target.write_text(json.dumps(original), encoding='utf-8')
        private = self.root / 'private'
        changed, updated = c.apply_install(private, [target], {'tools': []}, 'mac-pc-files')
        self.assertEqual(changed, 1)
        self.assertTrue(updated)
        doc = c.read_json(target)
        self.assertEqual(doc['theme'], 'dark')
        self.assertEqual(doc['mcpServers']['other'], {'command': 'keep'})
        backup = list(self.root.glob('claude.json.mcp-backup-*'))
        self.assertEqual(len(backup), 1)
        self.assertEqual(c.read_json(backup[0]), original)
        self.assertEqual(c.apply_install(private, [target], {'tools': []}, 'mac-pc-files'), (0, False))

    def test_invalid_second_config_prevents_first_config_changes(self):
        first = self.root / 'first.json'
        second = self.root / 'broken.json'
        first.write_text('{"keep":1}', encoding='utf-8')
        second.write_text('{broken', encoding='utf-8')
        with self.assertRaises(ValueError):
            c.apply_install(self.root / 'private', [first, second], {'tools': []}, 'mac-pc-files')
        self.assertEqual(first.read_text(), '{"keep":1}')

    def test_existing_install_lock_is_not_stolen_or_removed(self):
        private = self.root / 'private'
        private.mkdir()
        (private / '.install-lock').mkdir()
        with self.assertRaisesRegex(ValueError, 'installer'):
            c.apply_install(private, [self.root / 'claude.json'], {'tools': []}, 'mac-pc-files')
        self.assertTrue((private / '.install-lock').exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX symlink permissions')
    def test_config_and_directory_symlinks_are_refused(self):
        real = self.root / 'real.json'
        real.write_text('{}', encoding='utf-8')
        link = self.root / 'link.json'
        link.symlink_to(real)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            c.apply_install(self.root / 'private', [link], {'tools': []}, 'mac-pc-files')
        parent = self.root / 'alias'
        parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            c.atomic_write(parent / 'new.json', b'{}')
        self.assertFalse((self.root / 'new.json').exists())

    def test_binary_download_upload_and_no_overwrite(self):
        data = os.urandom(2 * 1048576 + 73)
        mac = MemoryMac(data)
        file = self.root / 'file.bin'
        args = {'mac_path': '/Users/test/file.bin', 'cloud_path': str(file)}
        result = c.transfer_file(mac, 'mac_download_to_cloud', args)
        self.assertEqual(file.read_bytes(), data)
        self.assertNotIn('data', result)
        with self.assertRaisesRegex(ValueError, 'exists'):
            c.transfer_file(mac, 'mac_download_to_cloud', args)
        c.transfer_file(mac, 'mac_upload_from_cloud', args)
        self.assertEqual(bytes(mac.upload), data)

    def test_corrupt_download_keeps_original_and_cleans_temporary(self):
        file = self.root / 'file.bin'
        file.write_bytes(b'original')
        mac = MemoryMac(b'correct'); mac.corrupt = True
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            c.transfer_file(mac, 'mac_download_to_cloud', {'mac_path': '/Users/a/file', 'cloud_path': str(file), 'overwrite': True})
        self.assertEqual(file.read_bytes(), b'original')
        self.assertFalse(list(self.root.glob('.mcp-download-*')))

    def test_transfer_validates_types_and_absolute_cloud_paths(self):
        for args in ({'mac_path': 1, 'cloud_path': '/tmp/x'}, {'mac_path': '/a', 'cloud_path': 'relative'},
                     {'mac_path': '/a', 'cloud_path': str(self.root / 'x'), 'overwrite': 'false'}):
            with self.assertRaises(ValueError):
                c.transfer_file(MemoryMac(), 'mac_download_to_cloud', args)


if __name__ == '__main__':
    unittest.main()
