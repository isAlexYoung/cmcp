"""Stage one release from the Windows and Mac builds of one commit, or from one side only."""
import argparse
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def inspect_package(file, version, commit, platform):
    linux = platform == 'linux-x64'
    prefix = 'CMCP/' if linux else 'CMCP.app/' if platform.startswith('macos-') else 'CMCP-' + version + '-windows-x64/'
    manifest_name = prefix + ('distribution-manifest.json' if linux else 'Contents/Resources/distribution-manifest.json' if platform.startswith('macos-') else 'app/distribution-manifest.json')
    with zipfile.ZipFile(file) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or sum(i.file_size for i in archive.infolist()) > 1024**3:
            raise ValueError('Duplicate entries or oversized package')
        for name in names:
            if not name.startswith(prefix) or '\\' in name or ':' in name or any(p in ('.', '..') for p in name.split('/')):
                raise ValueError('Unsafe package path')
        manifest = json.loads(archive.read(manifest_name))
        if (manifest.get('version'), manifest.get('sourceCommit'), manifest.get('platform')) != (version, commit, platform):
            raise ValueError('Package version, platform or source mismatch: ' + file.name)
        if manifest.get('schema') != 1:
            raise ValueError('Unknown package manifest schema')
        actual = {n for n in names if not n.endswith('/')}
        expected = {manifest_name}
        for entry in manifest['files']:
            name = prefix + entry['path']
            if name in expected or name not in actual:
                raise ValueError('Invalid manifest inventory')
            expected.add(name)
            if entry.get('codeSignature') is True:
                # The Mac build verifies the sealed native executable after signing.
                if not platform.startswith('macos-') or entry['path'] != 'Contents/MacOS/CMCP' or 'sha256' in entry:
                    raise ValueError('Invalid signed executable entry')
            elif sha256(archive.read(name)) != entry.get('sha256'):
                raise ValueError('Package file hash mismatch: ' + name)
        if platform.startswith('macos-'):
            expected.add(prefix + 'Contents/_CodeSignature/CodeResources')
        if actual != expected:
            raise ValueError('Unexpected package files')
        required = ('runtime/node', 'linux/desktop.py', 'linux/desktop.mjs', 'linux/launcher.py', 'linux/update_runtime.py', 'linux/apply_update.py') if linux else ('Contents/Info.plist', 'Contents/MacOS/CMCP', 'Contents/Resources/runtime/node', 'Contents/Resources/macos/desktop.mjs') if platform.startswith('macos-') else ('CMCP.exe', 'app/runtime/node.exe', 'app/server.mjs', 'app/build-info.json')
        if any(prefix + name not in actual for name in required):
            raise ValueError('Required application files are missing')
        forbidden = {'.env', 'targets.json', 'cloudpc-targets.json', 'cloudcli-logins.json', 'target-controls.json', 'browser-entries.json', 'session.json', 'manager-instance.json'}
        if any(PurePosixPath(n).name in forbidden for n in actual):
            raise ValueError('Personal state in package')


def inspect_deb(file, version, commit):
    fields = subprocess.check_output(['dpkg-deb', '--field', str(file), 'Package', 'Version', 'Architecture'], text=True)
    if dict(line.split(': ', 1) for line in fields.strip().splitlines()) != {'Package': 'cmcp', 'Version': version, 'Architecture': 'amd64'}:
        raise ValueError('Wrong Debian package identity')
    control = subprocess.check_output(['dpkg-deb', '--ctrl-tarfile', str(file)])
    with tarfile.open(fileobj=io.BytesIO(control)) as archive:
        if {entry.name.removeprefix('./') for entry in archive if entry.isfile()} != {'control'}:
            raise ValueError('Unexpected installer scripts')
    data = subprocess.check_output(['dpkg-deb', '--fsys-tarfile', str(file)])
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        entries = archive.getmembers()
        if any(not (entry.isfile() or entry.isdir()) or entry.uid != 0 or entry.gid != 0 or entry.mode & 0o022 for entry in entries):
            raise ValueError('Unsafe Debian file ownership or type')
        files = {}
        for entry in entries:
            if entry.isfile():
                name = entry.name.removeprefix('./')
                if name in files or name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')):
                    raise ValueError('Unsafe Debian path')
                files[name] = archive.extractfile(entry).read()
        manifest_name = 'opt/cmcp/distribution-manifest.json'
        manifest = json.loads(files[manifest_name])
        if (manifest.get('schema'), manifest.get('version'), manifest.get('sourceCommit'), manifest.get('platform'), manifest.get('development')) != (1, version, commit, 'linux-x64', False):
            raise ValueError('Wrong Debian manifest')
        expected = {manifest_name, 'usr/bin/cmcp', 'usr/share/applications/cmcp.desktop', 'usr/share/icons/hicolor/scalable/apps/cmcp.svg'}
        for entry in manifest['files']:
            name = 'opt/cmcp/' + entry['path']
            if name in expected or name not in files or sha256(files[name]) != entry['sha256']:
                raise ValueError('Debian payload checksum mismatch')
            expected.add(name)
        if set(files) != expected:
            raise ValueError('Unexpected Debian files')


def inspect_disk_image(file):
    # A Linux runner cannot mount it: the Mac job already installed and ran this image.
    with file.open('rb') as image:
        image.seek(-512, 2)
        if image.read(4) != b'koly':
            raise ValueError('Not a disk image: ' + file.name)


def planned(platforms):
    """Package platforms, extra installers and whether the source archive belongs to this publish."""
    windows = (('windows-x64',), ('windows-x64-setup.exe',))
    mac = (('macos-arm64', 'macos-x64'), ('macos-arm64.dmg', 'macos-x64.dmg'))
    linux = (('linux-x64',), ('linux-x64.deb',))
    if platforms == 'all':
        return windows[0] + mac[0] + linux[0], windows[1] + mac[1] + linux[1], True
    if platforms == 'windows':
        return windows[0], windows[1], True
    if platforms == 'macos':
        # Added later to a release that already holds the source archive.
        return mac[0], mac[1], False
    if platforms == 'linux':
        return linux[0], linux[1], True
    raise ValueError('Unknown platforms: ' + str(platforms))


def prepare(packages, output, version, commit, platforms='all'):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Canonical version and full source commit required')
    for name in ('app/package.json', 'macos/package.json', *(('linux/package.json',) if platforms in ('all', 'linux') else ())):
        package = json.loads(subprocess.check_output(['git', 'show', commit + ':' + name]))
        if package['version'] != version:
            raise ValueError('Source package version mismatch')
    selected = []
    package_platforms, installers, with_source = planned(platforms)
    for platform in package_platforms:
        name = 'CMCP-' + version + '-' + platform + '.zip'
        files = list(packages.rglob(name))
        if len(files) != 1:
            raise ValueError('Exactly one package required: ' + name)
        file = files[0]
        expected = sha256(file.read_bytes()) + '  ' + name
        if Path(str(file) + '.sha256').read_text(encoding='ascii').strip() != expected:
            raise ValueError('Package checksum mismatch')
        inspect_package(file, version, commit, platform)
        selected.append(file)
    # Built from the packages above and exercised by the Windows and Mac jobs.
    for suffix in installers:
        name = 'CMCP-' + version + '-' + suffix
        files = list(packages.rglob(name))
        if len(files) != 1:
            raise ValueError('Exactly one package required: ' + name)
        if Path(str(files[0]) + '.sha256').read_text(encoding='ascii').strip() != sha256(files[0].read_bytes()) + '  ' + name:
            raise ValueError('Package checksum mismatch')
        if name.endswith('.dmg'):
            inspect_disk_image(files[0])
        if name.endswith('.deb'):
            inspect_deb(files[0], version, commit)
        selected.append(files[0])
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Release staging directory must be empty')
    for file in selected:
        shutil.copyfile(file, output / file.name)
    if with_source:
        source = output / ('CMCP-' + version + ('-linux-source.zip' if platforms == 'linux' else '-source.zip'))
        subprocess.run(['git', 'archive', '--format=zip', '--prefix=CMCP-' + version + '-source/', '--output=' + str(source.resolve()), commit], check=True)
    for file in list(output.glob('*.zip')) + list(output.glob('*.exe')) + list(output.glob('*.dmg')) + list(output.glob('*.deb')):
        Path(str(file) + '.sha256').write_bytes((sha256(file.read_bytes()) + '  ' + file.name + '\n').encode('ascii'))
    print(json.dumps({'version': version, 'commit': commit, 'assets': sorted(p.name for p in output.iterdir())}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--platforms', default='all', choices=('all', 'windows', 'macos', 'linux'))
    args = parser.parse_args()
    prepare(args.packages, args.output, args.version, args.commit, args.platforms)
