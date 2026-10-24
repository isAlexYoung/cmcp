import hashlib
import json
import runpy
import tempfile
import unittest
import zipfile
from pathlib import Path

inspect_package = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'tools/prepare-release.py'))['inspect_package']
COMMIT = 'a' * 40


class UnifiedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / 'package.zip'

    def package(self, platform='macos-arm64', change=None):
        mac = platform.startswith('macos-')
        prefix = 'CMCP.app/' if mac else 'CMCP-4.1.1-windows-x64/'
        names = ['Contents/Info.plist', 'Contents/MacOS/CMCP', 'Contents/Resources/runtime/node', 'Contents/Resources/macos/desktop.mjs'] if mac else ['Claude-MCP.exe', 'app/runtime/node.exe', 'app/server.mjs', 'app/build-info.json']
        payload = {prefix + name: b'content' for name in names}
        files = [{'path': name, 'sha256': hashlib.sha256(b'content').hexdigest()} for name in names]
        manifest = {'schema': 1, 'version': '4.1.1', 'sourceCommit': COMMIT, 'platform': platform, 'files': files}
        if mac:
            payload[prefix + 'Contents/_CodeSignature/CodeResources'] = b'signed by the Mac builder'
            files[1] = {'path': names[1], 'codeSignature': True}
        if change:
            change(payload, manifest, prefix)
        name = prefix + ('Contents/Resources/distribution-manifest.json' if mac else 'app/distribution-manifest.json')
        payload[name] = json.dumps(manifest).encode()
        with zipfile.ZipFile(self.file, 'w') as archive:
            for name, data in payload.items():
                archive.writestr(name, data)

    def test_all_three_platforms_accept_the_common_source(self):
        for platform in ('windows-x64', 'macos-arm64', 'macos-x64'):
            with self.subTest(platform=platform):
                self.package(platform)
                inspect_package(self.file, '4.1.1', COMMIT, platform)

    def test_another_source_or_platform_is_rejected(self):
        self.package()
        for commit, platform in [('b' * 40, 'macos-arm64'), (COMMIT, 'macos-x64')]:
            with self.assertRaises(ValueError):
                inspect_package(self.file, '4.1.1', commit, platform)

    def test_modified_and_extra_files_are_rejected(self):
        for change in [lambda p, m, base: p.update({base + 'Contents/Info.plist': b'tampered'}), lambda p, m, base: p.update({base + 'user-file': b'private'})]:
            self.package(change=change)
            with self.assertRaises(ValueError):
                inspect_package(self.file, '4.1.1', COMMIT, 'macos-arm64')

    def test_signature_marker_cannot_skip_resource_hashes(self):
        self.package(change=lambda p, m, base: m['files'][0].update(codeSignature=True))
        with self.assertRaises(ValueError):
            inspect_package(self.file, '4.1.1', COMMIT, 'macos-arm64')


if __name__ == '__main__':
    unittest.main()
