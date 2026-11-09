"""Catalog events (cmcp-tools/1): the PC announces a new tool catalog revision, the real relay
passes it to every watching connector, and a running connector refreshes and sends Claude
notifications/tools/list_changed. Also the per-group required-tool check."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(ROOT / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C = load('connector_events', 'cloudpc-connector.py')
M = load('mac_connector_events', '../macos/cloudpc-connector.py')
if os.name == 'nt':
    with patch.dict(sys.modules, {n: types.ModuleType(n) for n in ('fcntl', 'termios', 'tty')}):
        R = load('relay_events', 'cloudpc-relay.py')
else:
    R = load('relay_events', 'cloudpc-relay.py')

FILES = ['read_text_file', 'write_file', 'list_allowed_directories']
BINARY = ['windows_binary_info', 'windows_binary_begin', 'windows_binary_write', 'windows_binary_finish']


def tool(name):
    return {'name': name, 'description': name, 'inputSchema': {'type': 'object'}}


def scripted_link(module, tools, meta):
    link = module.Link('/nonexistent/link.sock')
    replies = [{'jsonrpc': '2.0', 'id': 1, 'result': {'instructions': 'PC'}},
               {'jsonrpc': '2.0', 'id': 2, 'result': dict({'tools': [tool(n) for n in tools]}, **({'_meta': {'cmcp/catalog': meta}} if meta else {}))}]
    link.request = lambda message, wait=30: replies.pop(0)
    return link


class RequiredToolTests(unittest.TestCase):
    def test_switched_off_groups_are_not_required(self):
        catalog = scripted_link(C, FILES + BINARY, {'schema': 1, 'revision': 'r1', 'groups': ['system', 'files']}).fetch_catalog()
        self.assertEqual(catalog['revision'], 'r1')
        self.assertEqual(len(catalog['tools']), 7)

    def test_a_switched_on_group_must_be_complete(self):
        with self.assertRaisesRegex(ValueError, 'windows_execute'):
            scripted_link(C, FILES + BINARY, {'schema': 1, 'revision': 'r', 'groups': ['files', 'commands']}).fetch_catalog()

    def test_old_pc_without_groups_keeps_the_full_check(self):
        with self.assertRaisesRegex(ValueError, 'old tool version'):
            scripted_link(C, FILES + BINARY, None).fetch_catalog()

    def test_mac_connector_uses_the_same_rule(self):
        names = FILES + [n.replace('windows', 'mac') for n in BINARY]
        self.assertEqual(len(scripted_link(M, names, {'schema': 1, 'revision': 'm', 'groups': ['files']}).fetch_catalog()['tools']), 7)


class FakePc:
    """Answers the relay's requests the way CMCP's tool registry does."""

    def __init__(self, relay):
        self.relay, self.tools, self.revision, self.calls, self.groups = relay, ['freecad__make_box'], 'r1', [], ['system']

    def emit(self, packet):
        if packet.get('t') != 'req':
            return
        message = packet['msg']
        self.calls.append(message.get('method'))
        if message['method'] == 'initialize':
            result = {'instructions': 'PC tools'}
        elif message['method'] == 'tools/list':
            result = {'tools': [tool(n) for n in self.tools], '_meta': {'cmcp/catalog': {'schema': 1, 'revision': self.revision, 'groups': self.groups}}}
        else:
            result = {'content': [{'type': 'text', 'text': 'ok'}]}
        reply = {'t': 'res', 'id': packet['id'], 'msg': {'jsonrpc': '2.0', 'id': message.get('id'), 'result': result}}
        threading.Thread(target=self.relay.message, args=(reply,), daemon=True).start()


@unittest.skipIf(os.name == 'nt', 'Unix sockets')
class RelayWatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.relay = R.Relay(Path(self.directory.name) / 'relay')
        self.pc = FakePc(self.relay)
        self.relay.emit = self.pc.emit
        self.relay.start({'machine': 'pc', 'name': 'PC', 'version': 'test'})
        self.addCleanup(self.relay.close)

    def watch(self, since=None):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(str(self.relay.path))
        self.addCleanup(sock.close)
        sock.sendall((json.dumps({'id': 1, 'op': 'watch', 'since': since}) + '\n').encode())
        stream = sock.makefile('rb')
        return sock, stream

    def test_each_new_revision_reaches_every_watcher_once(self):
        _, first = self.watch()
        _, second = self.watch()
        for stream in (first, second):
            self.assertEqual(json.loads(stream.readline())['event'], 'watching')
        self.relay.message({'t': 'catalog', 'revision': 'r2'})
        for stream in (first, second):
            self.assertEqual(json.loads(stream.readline()), {'event': 'catalog', 'revision': 'r2'})
        self.relay.message({'t': 'catalog', 'revision': 'r2'})
        self.relay.message({'t': 'catalog', 'revision': 'r3'})
        self.assertEqual(json.loads(first.readline()), {'event': 'catalog', 'revision': 'r3'})

    def test_a_watcher_that_already_has_the_revision_waits(self):
        self.relay.message({'t': 'catalog', 'revision': 'r5'})
        sock, stream = self.watch('r5')
        self.assertEqual(json.loads(stream.readline())['event'], 'watching')
        sock.settimeout(1)
        with self.assertRaises(socket.timeout):
            stream.readline()

    def test_a_late_watcher_gets_the_current_revision_and_watchers_are_bounded(self):
        self.relay.message({'t': 'catalog', 'revision': 'r7'})
        streams = [self.watch()[1] for _ in range(8)]
        for stream in streams:
            self.assertEqual(json.loads(stream.readline())['event'], 'watching')
            self.assertEqual(json.loads(stream.readline())['revision'], 'r7')
        _, busy = self.watch()
        self.assertEqual(json.loads(busy.readline()), {'ok': False, 'code': 'busy'})

    def test_closing_the_relay_ends_watchers_and_requests_still_work(self):
        reply = self.relay.exchange({'id': 1, 'op': 'call', 'msg': {'jsonrpc': '2.0', 'id': 9, 'method': 'tools/list'}})
        self.assertTrue(reply['ok'])
        _, stream = self.watch()
        stream.readline()
        self.relay.close()
        self.assertEqual(stream.readline(), b'')

    def test_invalid_revisions_are_ignored(self):
        self.relay.message({'t': 'catalog', 'revision': 'x' * 200})
        self.relay.message({'t': 'catalog', 'revision': 5})
        self.assertIsNone(self.relay.catalog)


@unittest.skipIf(os.name == 'nt', 'Unix sockets')
class ConnectorRefreshTests(unittest.TestCase):
    """A real connector process (`serve`) behind the real relay, as Claude Code starts it."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.relay = R.Relay(base / 'relay')
        self.pc = FakePc(self.relay)
        self.relay.emit = self.pc.emit
        self.relay.start({'machine': 'pc', 'name': 'PC', 'version': 'test'})
        self.addCleanup(self.relay.close)
        env = dict(os.environ, CLOUDPC_LINK_SOCKET=str(self.relay.path), HOME=str(base))
        self.process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'cloudpc-connector.py'), 'serve', '--name', 'events-test', '--home', str(base)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.addCleanup(self.stop)
        self.lines = []
        self.ready = threading.Condition()
        threading.Thread(target=self.read, daemon=True).start()

    def stop(self):
        self.process.stdin.close()
        try:
            self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()

    def read(self):
        for raw in self.process.stdout:
            with self.ready:
                self.lines.append(json.loads(raw))
                self.ready.notify_all()

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        self.process.stdin.flush()

    def wait_for(self, check, seconds=10):
        deadline = time.time() + seconds
        with self.ready:
            while True:
                found = [line for line in self.lines if check(line)]
                if found:
                    return found
                if time.time() >= deadline:
                    self.fail('timed out; lines: %r' % self.lines)
                self.ready.wait(0.2)

    def notifications(self):
        return [line for line in self.lines if line.get('method') == 'notifications/tools/list_changed']

    def tools(self, request_id):
        self.send({'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/list'})
        return [t['name'] for t in self.wait_for(lambda line: line.get('id') == request_id)[0]['result']['tools']]

    def test_an_announced_revision_refreshes_the_list_and_notifies_claude(self):
        self.send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'clientInfo': {'name': 'claude-code'}}})
        capabilities = self.wait_for(lambda line: line.get('id') == 1)[0]['result']['capabilities']
        self.assertEqual(capabilities, {'tools': {'listChanged': True}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        deadline = time.time() + 10
        while self.relay.watchers < 1 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.relay.watchers, 1, 'the connector watches the relay')
        self.wait_for(lambda line: line.get('method') == 'notifications/tools/list_changed')
        names = self.tools(2)
        self.assertEqual(names, ['freecad__make_box'], 'files group off: no transfer tools either')
        before = len(self.notifications())
        self.pc.tools = FILES + BINARY + ['freecad__make_box']
        self.pc.groups = ['system', 'files']
        self.pc.revision = 'r2'
        self.relay.message({'t': 'catalog', 'revision': 'r2'})
        self.wait_for(lambda line: len(self.notifications()) > before)
        names = self.tools(3)
        self.assertIn('read_text_file', names)
        self.assertIn('windows_download_to_cloud', names)
        time.sleep(0.5)  # every tools/list also refreshes once in the background; let it finish
        calls = list(self.pc.calls)
        self.relay.message({'t': 'catalog', 'revision': 'r2'})
        time.sleep(0.5)
        self.assertEqual(self.pc.calls, calls, 'a repeated revision causes no refresh')


if __name__ == '__main__':
    unittest.main()
