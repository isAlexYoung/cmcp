"""Offline real GTK update/restart/ack integration, in an isolated empty account state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, '/opt/cmcp/linux')
import update_runtime as u


def drive(prepared_file):
    prepared = json.loads(Path(prepared_file).read_text())
    spec = importlib.util.spec_from_file_location('desktop', '/opt/cmcp/linux/desktop.py')
    desktop = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(desktop)
    from gi.repository import GLib
    app = desktop.Desktop()
    original_api, original_action, original_reply = app.api, app.action, app.reply
    app.api = lambda route, *args, **kwargs: {'directory': prepared} if route in ('update/download', 'update/prepared') else original_api(route, *args, **kwargs)
    confirmation = False
    app.action = lambda action, payload: confirmation if action == 'confirm' else original_action(action, payload)
    def post(ident, action):
        app.web.run_javascript('window.webkit.messageHandlers.cmcp.postMessage(' + json.dumps({'id': ident, 'action': action, 'payload': {}}) + ')', None, None, None)
    def reply(ident, value=None, error=None):
        nonlocal confirmation
        if ident in (-108, -109, -110):
            if error:
                raise AssertionError(error)
            if ident == -108:
                assert value['prepared']
                post(-109, 'install-update')  # Cancel first: window must stay usable.
            elif ident == -109:
                assert value['prepared'] and not app.exiting
                confirmation = True
                post(-110, 'install-update')
            else:
                assert value['version'] == prepared['version']
                print('WebKit download/cancel/install bridge accepted', flush=True)
        else:
            original_reply(ident, value, error)
    app.reply = reply
    sent = False
    pending = False
    def inspected(web, task):
        nonlocal sent, pending
        pending = False
        if web.run_javascript_finish(task).get_js_value().to_boolean() and not sent:
            sent = True
            post(-108, 'update')
    def tick():
        nonlocal pending
        if sent:
            return False
        if app.identity and getattr(app, 'web', None) and not pending:
            pending = True
            app.web.run_javascript("document.querySelector('.cards') !== null", None, inspected)
        return True
    GLib.timeout_add(300, tick)
    app.run(['cmcp-update-test'])
    assert app.exiting and app.backend.poll() is not None


def main(package):
    with tempfile.TemporaryDirectory(prefix='cmcp GTK update ') as temporary:
        state = u.private(Path(temporary))
        folder = u.private(state / ('update-' + str(uuid.uuid4())))
        with zipfile.ZipFile(package) as original:
            manifest = json.loads(original.read('CMCP/distribution-manifest.json'))
            parts = list(u.version(manifest['version']))
            parts[2] += 1
            next_version = '.'.join(map(str, parts))
            settings = json.loads(original.read('CMCP/linux/package.json'))
            settings['version'] = next_version
            settings_bytes = json.dumps(settings).encode()
            manifest['version'] = next_version
            next(entry for entry in manifest['files'] if entry['path'] == 'linux/package.json')['sha256'] = hashlib.sha256(settings_bytes).hexdigest()
            archive = folder / f'CMCP-{next_version}-linux-x64.zip'
            with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as output:
                for entry in original.infolist():
                    data = json.dumps(manifest).encode() if entry.filename == 'CMCP/distribution-manifest.json' else settings_bytes if entry.filename == 'CMCP/linux/package.json' else original.read(entry)
                    output.writestr(entry, data)
        archive.chmod(0o600)
        prepared = {'folder': str(folder), 'zip': str(archive), 'version': next_version, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
        prepared_file = state / 'fixture.json'
        u.atomic(prepared_file, prepared)
        preference_file = state / 'application-preferences.json'
        u.atomic(preference_file, {'schema': 1, 'language': 'zh-CN', 'theme': 'dark', 'autoStart': False, 'closeAction': 'exit', 'shortcutPrompt': False})
        original_preferences = preference_file.read_bytes()
        environment = dict(os.environ, CMCP_STATE_DIR=str(state), PYTHONDONTWRITEBYTECODE='1')
        worker = subprocess.Popen(['/usr/bin/python3', '-B', __file__, '--drive', str(prepared_file)], env=environment)
        new_pid = None
        try:
            worker.wait(timeout=100)
            assert worker.returncode == 0, 'Original GTK host failed'
            result_file = state / 'updates/result.json'
            deadline = time.monotonic() + 65
            while not result_file.is_file() and time.monotonic() < deadline:
                time.sleep(0.1)
            result = json.loads(result_file.read_text())
            assert result['ok'], result
            new_pid = result['pid']
            assert result['version'] == next_version
            os.kill(new_pid, 0)
            root = u.active_root('/opt/cmcp', state)
            assert root != Path('/opt/cmcp')
            assert u.validate(root)['version'] == next_version
            assert preference_file.read_bytes() == original_preferences, 'User configuration changed'
            assert not list(state.glob('update-request-*')), 'Update request was not cleaned'
            print('Real GTK update: confirmed install, old host exit, new window/backend health acknowledgement, launcher selection and configuration preservation passed')
        finally:
            if worker.poll() is None:
                worker.terminate()
                worker.wait(timeout=30)
            if new_pid:
                os.kill(new_pid, signal.SIGTERM)
                deadline = time.monotonic() + 30
                while (state / 'manager.lock').exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                assert not (state / 'manager.lock').exists(), 'Updated backend survived window close'


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--drive':
        drive(sys.argv[2])
    else:
        main(sys.argv[1])
