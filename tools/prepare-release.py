"""Stage one release from Windows and both Mac builds of the same commit."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path, PurePosixPath


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def inspect_package(file, version, commit, platform):
    prefix = 'CMCP.app/' if platform.startswith('macos-') else 'CMCP-' + version + '-windows-x64/'
    manifest_name = prefix + ('Contents/Resources/distribution-manifest.json' if platform.startswith('macos-') else 'app/distribution-manifest.json')
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
        required = ('Contents/Info.plist', 'Contents/MacOS/CMCP', 'Contents/Resources/runtime/node', 'Contents/Resources/macos/desktop.mjs') if platform.startswith('macos-') else ('CMCP.exe', 'Claude-MCP.exe', 'app/runtime/node.exe', 'app/server.mjs', 'app/build-info.json')
        if any(prefix + name not in actual for name in required):
            raise ValueError('Required application files are missing')
        forbidden = {'.env', 'targets.json', 'cloudpc-targets.json', 'target-controls.json', 'browser-entries.json', 'session.json', 'manager-instance.json'}
        if any(PurePosixPath(n).name in forbidden for n in actual):
            raise ValueError('Personal state in package')


def prepare(packages, output, version, commit):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Canonical version and full source commit required')
    for name in ('app/package.json', 'macos/package.json'):
        package = json.loads(subprocess.check_output(['git', 'show', commit + ':' + name]))
        if package['version'] != version:
            raise ValueError('Source package version mismatch')
    selected = []
    for platform in ('windows-x64', 'macos-arm64', 'macos-x64'):
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
    notes = subprocess.check_output(['git', 'show', commit + ':.github/RELEASE_' + version + '.md']).decode('utf-8-sig').strip()
    if not notes:
        raise ValueError('Release notes required')
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Release staging directory must be empty')
    for file in selected:
        shutil.copyfile(file, output / file.name)
    source = output / ('CMCP-' + version + '-source.zip')
    subprocess.run(['git', 'archive', '--format=zip', '--prefix=CMCP-' + version + '-source/', '--output=' + str(source.resolve()), commit], check=True)
    for file in output.glob('*.zip'):
        Path(str(file) + '.sha256').write_bytes((sha256(file.read_bytes()) + '  ' + file.name + '\n').encode('ascii'))
    print(json.dumps({'version': version, 'commit': commit, 'assets': sorted(p.name for p in output.iterdir())}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    prepare(args.packages, args.output, args.version, args.commit)
