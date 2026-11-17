"""Unprivileged Linux updates: verified inventory, atomic activation and health rollback."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import time
import uuid
import zipfile

VERSION = re.compile(r'(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\Z')
APP = re.compile(r'app-[a-f0-9-]{36}\Z')
REQUIRED = {'runtime/node', 'linux/desktop.py', 'linux/desktop.mjs', 'linux/launcher.py', 'linux/package.json', 'linux/update_runtime.py', 'linux/apply_update.py'}
FORBIDDEN = {'.env', 'targets.json', 'session.json', 'manager-instance.json', 'cloudcli-logins.json', 'cloudpc-targets.json'}


def version(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ValueError('Invalid stable version')
    return tuple(map(int, value.split('.')))


def private(directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Private user-owned directory required')
    return directory


def safe_file(file):
    info = Path(file).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Private user-owned file required')


def atomic(file, value):
    file = Path(file)
    if file.is_symlink():
        raise ValueError('Symlink metadata')
    temporary = file.with_name('.' + file.name + '-' + str(uuid.uuid4()))
    with temporary.open('x', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        output.write(json.dumps(value))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, file)


def inventory(manifest, expected_version=None):
    if manifest.get('schema') != 1 or manifest.get('platform') != 'linux-x64' or not re.fullmatch('[a-f0-9]{40}', manifest.get('sourceCommit', '')):
        raise ValueError('Invalid Linux manifest')
    version(manifest.get('version'))
    if expected_version is not None and manifest['version'] != expected_version:
        raise ValueError('Wrong application version')
    files = manifest.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 20000:
        raise ValueError('Invalid inventory size')
    expected = {}
    for entry in files:
        name = entry.get('path')
        if not isinstance(name, str) or not name or name.startswith('/') or '\\' in name or ':' in name or any(ord(c) < 32 or ord(c) == 127 for c in name) or any(part in ('', '.', '..') for part in name.split('/')) or PurePosixPath(name).name in FORBIDDEN:
            raise ValueError('Unsafe manifest path')
        if name in expected or name == 'distribution-manifest.json' or not re.fullmatch('[a-f0-9]{64}', entry.get('sha256', '')):
            raise ValueError('Duplicate or invalid manifest file')
        expected[name] = entry['sha256']
    if not REQUIRED <= expected.keys():
        raise ValueError('Incomplete application')
    return expected


def validate(root, expected_version=None):
    root = Path(root)
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError('Application directory required')
    manifest_file = root / 'distribution-manifest.json'
    if not stat.S_ISREG(manifest_file.lstat().st_mode) or manifest_file.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Invalid manifest file')
    manifest = json.loads(manifest_file.read_text())
    expected = inventory(manifest, expected_version)
    actual = set()
    for file in root.rglob('*'):
        info = file.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Special file in application')
        name = file.relative_to(root).as_posix()
        if name == 'distribution-manifest.json':
            continue
        actual.add(name)
        if name not in expected or hashlib.sha256(file.read_bytes()).hexdigest() != expected[name]:
            raise ValueError('Modified or extra application file')
    if actual != expected.keys():
        raise ValueError('Missing application file')
    if json.loads((root / 'linux/package.json').read_text())['version'] != manifest['version']:
        raise ValueError('Package version mismatch')
    with (root / 'runtime/node').open('rb') as node:
        if node.read(4) != b'\x7fELF':
            raise ValueError('Linux runtime required')
    if not os.access(root / 'runtime/node', os.X_OK):
        raise ValueError('Runtime is not executable')
    return manifest


def unpack(archive_file, destination, expected_version, digest):
    safe_file(archive_file)
    if not re.fullmatch('[a-f0-9]{64}', digest) or hashlib.sha256(Path(archive_file).read_bytes()).hexdigest() != digest:
        raise ValueError('Update package changed')
    with zipfile.ZipFile(archive_file) as archive:
        members = archive.infolist()
        names = [entry.filename for entry in members]
        if len(names) != len(set(names)) or len(names) > 20001 or sum(entry.file_size for entry in members) > 1024 ** 3:
            raise ValueError('Duplicate or oversized archive')
        for entry in members:
            name = entry.filename
            mode = entry.external_attr >> 16
            if not name.startswith('CMCP/') or not name[5:] or name.endswith('/') or '\\' in name or ':' in name or any(p in ('', '.', '..') for p in name.split('/')) or any(ord(c) < 32 or ord(c) == 127 for c in name) or entry.flag_bits & 1 or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('Unsafe archive member')
        if archive.getinfo('CMCP/distribution-manifest.json').file_size > 8 * 1024 * 1024:
            raise ValueError('Oversized manifest')
        manifest = json.loads(archive.read('CMCP/distribution-manifest.json'))
        expected = inventory(manifest, expected_version)
        if set(names) != {'CMCP/' + name for name in expected} | {'CMCP/distribution-manifest.json'}:
            raise ValueError('Archive inventory mismatch')
        destination = Path(destination)
        destination.mkdir(mode=0o700)
        for entry in members:
            name = entry.filename[5:]
            data = archive.read(entry)
            if name != 'distribution-manifest.json' and hashlib.sha256(data).hexdigest() != expected[name]:
                raise ValueError('Archive resource checksum mismatch')
            file = destination / name
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with file.open('xb') as output:
                output.write(data)
            file.chmod(0o700 if name == 'runtime/node' else 0o600)
    validate(destination, expected_version)


def state_directory():
    return Path(os.environ.get('CMCP_STATE_DIR') or Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state') / 'cmcp')


def active_root(base, state):
    """Broken or obsolete overlays never prevent the system installation starting."""
    base, state = Path(base), Path(state)
    try:
        private(state)
        updates = private(state / 'updates')
        pointer_file = updates / 'active.json'
        safe_file(pointer_file)
        pointer = json.loads(pointer_file.read_text())
        if not APP.fullmatch(pointer['directory']):
            raise ValueError('Invalid application path')
        root = updates / 'apps' / pointer['directory']
        private(root.parent)
        private(root)
        manifest = validate(root, pointer['version'])
        base_version = json.loads((base / 'linux/package.json').read_text())['version']
        if version(manifest['version']) > version(base_version):
            return root
    except (ValueError, OSError, KeyError, TypeError):
        pass
    return base


def process_stamp(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def read_request(file, base=Path('/opt/cmcp')):
    file = Path(file)
    safe_file(file)
    request = json.loads(file.read_text())
    state = private(Path(request['state']))
    if file.parent != state or not re.fullmatch(r'update-request-[a-f0-9-]{36}\.json', file.name) or not re.fullmatch('[a-f0-9-]{36}', request['nonce']):
        raise ValueError('Invalid update request')
    folder, archive = Path(request['folder']), Path(request['zip'])
    if folder.parent != state or not re.fullmatch('update-[a-f0-9-]{36}', folder.name) or archive.parent != folder or archive.name != f"CMCP-{request['version']}-linux-x64.zip":
        raise ValueError('Invalid staging paths')
    private(folder)
    safe_file(archive)
    old = Path(request['installRoot'])
    updates = private(state / 'updates')
    if old != Path(base) and (old.parent != updates / 'apps' or not APP.fullmatch(old.name)):
        raise ValueError('Invalid previous installation')
    validate(old)
    if version(request['version']) <= version(json.loads((old / 'linux/package.json').read_text())['version']):
        raise ValueError('Update must be newer')
    for name in ('managerPid', 'appPid'):
        if type(request[name]) is not int or request[name] < 2 or not isinstance(request[name + 'Stamp'], str):
            raise ValueError('Invalid process identity')
    return request


def acknowledge(file, root):
    request = read_request(file)
    safe_file(str(file) + '.ready')
    pointer = json.loads(Path(str(file) + '.ready').read_text())
    if not APP.fullmatch(pointer['directory']) or pointer['nonce'] != request['nonce'] or Path(root) != Path(request['state']) / 'updates/apps' / pointer['directory'] or pointer['version'] != request['version']:
        raise ValueError('Acknowledgement belongs to another installation')
    atomic(str(file) + '.ack', request['nonce'])


def apply(file, base=Path('/opt/cmcp'), launch=None, healthy=None, wait_seconds=40):
    request = read_request(file, base)
    state = Path(request['state'])
    updates = private(state / 'updates')
    apps = private(updates / 'apps')
    active = updates / 'active.json'
    previous = active.read_bytes() if active.is_file() and not active.is_symlink() else None
    candidate = apps / ('app-' + str(uuid.uuid4()))
    activated, child = False, None
    try:
        unpack(request['zip'], candidate, request['version'], request['sha256'])
        atomic(str(file) + '.ready', {'nonce': request['nonce'], 'directory': candidate.name, 'version': request['version']})
        deadline = time.monotonic() + wait_seconds
        while any(process_stamp(request[key]) == request[key + 'Stamp'] for key in ('managerPid', 'appPid')):
            if time.monotonic() > deadline:
                raise TimeoutError('Previous application did not exit')
            time.sleep(0.1)
        activated = True
        def start(root, update_file=None):
            environment = dict(os.environ, CMCP_STATE_DIR=str(state), PYTHONDONTWRITEBYTECODE='1')
            return subprocess.Popen(['/usr/bin/python3', '-B', str(root / 'linux/desktop.py'), *(['--updated', str(update_file)] if update_file else [])], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        launch = launch or start
        child = launch(candidate, file)
        def check():
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                try:
                    safe_file(str(file) + '.ack')
                    if json.loads(Path(str(file) + '.ack').read_text()) == request['nonce']:
                        return True
                except (OSError, ValueError):
                    pass
                if child.poll() is not None:
                    return False
                time.sleep(0.1)
            return False
        if not (healthy or check)():
            raise RuntimeError('New application did not become healthy')
        # Keep the old launch target until the new window is healthy. Power loss
        # during preparation/startup therefore still starts the previous version.
        atomic(active, {'directory': candidate.name, 'version': request['version']})
        atomic(updates / 'result.json', {'ok': True, 'version': request['version'], 'pid': getattr(child, 'pid', None)})
        # Delete only a verified former overlay, never the system installation.
        if previous:
            try:
                old = json.loads(previous)
                old_root = apps / old['directory']
                if APP.fullmatch(old['directory']) and old_root != candidate:
                    validate(old_root, old['version'])
                    shutil.rmtree(old_root)
            except (ValueError, OSError, KeyError):
                pass
        return candidate
    except Exception:
        if activated:
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            if previous is not None:
                atomic(active, json.loads(previous))
            else:
                active.unlink(missing_ok=True)
            launch(Path(request['installRoot']), None)
        atomic(updates / 'result.json', {'ok': False, 'version': request['version'], 'message': '更新未完成，已保留或恢复原版本。'})
        if candidate.exists():
            shutil.rmtree(candidate)
        raise
    finally:
        for suffix in ('.ready', '.ack'):
            Path(str(file) + suffix).unlink(missing_ok=True)
        Path(file).unlink(missing_ok=True)
        folder, archive = Path(request['folder']), Path(request['zip'])
        if folder.is_dir() and not folder.is_symlink() and set(folder.iterdir()) == {archive} and archive.is_file() and not archive.is_symlink():
            archive.unlink()
            folder.rmdir()
