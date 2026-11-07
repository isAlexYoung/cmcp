"""Install the CLI-only connector and run its private SSH relay (no PTY/TCP)."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time


def private_directory(directory):
    if directory.is_symlink():
        raise ValueError('Unsafe connector directory')
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Unsafe connector directory')


def write_source(file, content):
    if file.is_symlink():
        raise ValueError('Unsafe connector file')
    if file.exists():
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('Unsafe connector file')
        if file.read_text(encoding='utf-8') == content:
            return
    temporary = file.with_name(file.name + '.new-' + os.urandom(8).hex())
    try:
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
        os.replace(str(temporary), str(file))
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, str(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if sys.version_info < (3, 9):
        raise ValueError('Python 3.9 or newer is required')
    # Initial payload is sent before any protocol packet, avoiding stdin read-ahead.
    raw = sys.stdin.buffer.readline(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024 or not raw.endswith(b'\n'):
        raise ValueError('Invalid SSH bootstrap payload')
    data = json.loads(raw)
    name = data['name']
    if not isinstance(name, str) or not name.startswith('cmcp-ssh-') or len(name) != 25 or any(c not in '0123456789abcdef' for c in name[9:]):
        raise ValueError('Invalid SSH connector name')
    if os.environ.get('CLAUDE_CONFIG_DIR'):
        raise ValueError('Custom CLAUDE_CONFIG_DIR requires an explicit connector configuration')
    home = Path.home()
    config = home / '.claude.json'
    if os.environ.get('CMCP_SHARED_SESSION') == '1':
        # Root handed over to the WebDesktop terminal user (ssh-mcp.mjs). The shared folder there
        # belongs to the web connector and must keep its group access, so this connector gets a
        # private home of its own and only adds its entry to the terminal's Claude config.
        home = home / '.cmcp-ssh'
        private_directory(home)
        os.environ['HOME'] = str(home)
    directory = home
    for part in ('.local', 'share', 'cloudpc-link', name):
        directory = directory / part
        private_directory(directory)
    relay_directory = directory / 'relay'
    private_directory(relay_directory)
    # SSH and web bridges have distinct sockets, caches and MCP entries.
    os.environ.pop('CLOUDPC_CC_SHARED', None)
    os.environ['CLOUDPC_LINK_SOCKET'] = str(relay_directory / 'link.sock')
    for file, key in (('cloudpc-relay.py', 'relay'), ('source-connector.py', 'connector')):
        content = data[key]
        if not isinstance(content, str) or len(content.encode('utf-8')) > 512 * 1024:
            raise ValueError('Invalid connector source')
        write_source(directory / file, content)
    connector = load('ssh_connector', directory / 'source-connector.py')
    catalog = data['catalog']
    if not isinstance(catalog, dict) or not isinstance(catalog.get('tools'), list):
        raise ValueError('Invalid local tool catalog')
    # Reuse the existing backups, concurrent-config checks and rollback behavior.
    # Configure Claude Code only; never modify Claude Desktop's configuration.
    for attempt in range(5):
        try:
            with contextlib.redirect_stdout(sys.stderr):
                connector.apply_install(directory, [config], catalog, name)
            break
        except connector.ConfigRace:
            if attempt == 4:
                raise
            time.sleep(0.2)
    relay = load('ssh_relay', directory / 'cloudpc-relay.py')
    relay.Relay(relay_directory).run()


if __name__ == '__main__':
    main()
