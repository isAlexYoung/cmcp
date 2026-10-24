"""Standard library tests; Linux additionally exercises real Unix sockets."""
import importlib.util
import json
import os
from pathlib import Path
import socket
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
C = load('connector', 'cloudpc-connector.py')
if os.name == 'nt':
    with patch.dict(sys.modules, {n: types.ModuleType(n) for n in ('fcntl', 'termios', 'tty')}):
        R = load('relay', 'cloudpc-relay.py')
else:
    R = load('relay', 'cloudpc-relay.py')
MSG = {'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {'name': 'simulated_write'}}
RESULT = {'jsonrpc': '2.0', 'id': 7, 'result': {'done': True}}
DONE = {'ok': True, 'msg': RESULT, 'recovery': {'protocol': 1, 'state': 'done'}}

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.link = C.Link(Path(self.directory.name) / 'link.sock', recovery_wait=0.03, poll=0.001)

    def scripted(self, responses):
        calls = []
        def exchange(request, timeout):
            calls.append(request)
            value = responses.pop(0)
            if isinstance(value, Exception): raise value
            return value
        self.link._exchange = exchange
        return calls

    def test_missing_socket_waits_then_delivers_once(self):
        calls = self.scripted([C.NotSent(), C.NotSent(), DONE])
        self.assertEqual(self.link.request(MSG), RESULT)
        self.assertEqual(len({c['request_id'] for c in calls}), 1)
        self.assertEqual([c['op'] for c in calls], ['call'] * 3)

    def test_proven_not_sent_waits_and_retries(self):
        calls = self.scripted([{'ok': False, 'code': 'offline', 'delivery': 'not_sent'}, DONE])
        self.assertEqual(self.link.request(MSG), RESULT)
        self.assertEqual([c['op'] for c in calls], ['call', 'call'])

    def test_partial_send_only_queries(self):
        calls = self.scripted([C.OutcomeUnknown(), DONE])
        self.assertEqual(self.link.request(MSG), RESULT)
        self.assertEqual([c['op'] for c in calls], ['call', 'result'])
        self.assertNotIn('msg', calls[1])

    def test_disconnected_queries_until_running_completes(self):
        calls = self.scripted([{'ok': False, 'code': 'disconnected'}, C.NotSent(),
            {'ok': True, 'recovery': {'protocol': 1, 'state': 'running'}}, DONE])
        self.assertEqual(self.link.request(MSG), RESULT)
        self.assertEqual([c['op'] for c in calls], ['call', 'result', 'result', 'result'])

    def test_legacy_offline_is_uncertain_and_never_replayed(self):
        calls = self.scripted([{'ok': False, 'code': 'offline'}])
        with self.assertRaises(C.OutcomeUnknown): self.link.request(MSG)
        self.assertEqual(len(calls), 1)

    def test_legacy_success_stays_compatible(self):
        self.scripted([{'ok': True, 'msg': RESULT}])
        self.assertEqual(self.link.request(MSG), RESULT)

    def test_legacy_query_unsupported_reports_uncertainty(self):
        calls = self.scripted([C.OutcomeUnknown(), {'ok': False, 'code': 'error', 'error': 'unknown op'}])
        with self.assertRaises(C.OutcomeUnknown): self.link.request(MSG)
        self.assertEqual(len(calls), 2)

    def test_missing_expired_and_oversized_results_never_execute_again(self):
        for state in ('missing', 'unavailable', 'conflict', 'invalid'):
            calls = self.scripted([C.OutcomeUnknown(), {'ok': True, 'recovery': {'protocol': 1, 'state': state}}])
            with self.assertRaises(C.OutcomeUnknown): self.link.request(MSG)
            self.assertEqual([c['op'] for c in calls], ['call', 'result'])

    def test_gap_timeout_before_send_is_offline(self):
        self.link._exchange = lambda *args: (_ for _ in ()).throw(C.NotSent())
        started = time.monotonic()
        with self.assertRaises(C.Offline): self.link.request(MSG)
        self.assertLess(time.monotonic() - started, 0.3)

    def test_gap_timeout_after_send_is_uncertain(self):
        calls = []
        def exchange(request, timeout):
            calls.append(request['op'])
            if len(calls) == 1: raise C.OutcomeUnknown()
            raise C.NotSent()
        self.link._exchange = exchange
        with self.assertRaises(C.OutcomeUnknown): self.link.request(MSG)
        self.assertEqual(calls.count('call'), 1)

    def test_manual_stop_returns_without_waiting_or_sending(self):
        marker = Path(self.directory.name) / 'manual-stop.json'
        marker.write_text('{"schema":1,"stopped":true}', encoding='utf-8')
        self.link._exchange = lambda *args: self.fail('must not send')
        with self.assertRaises(C.Offline): self.link.request(MSG)

    def test_relay_delivery_states_and_legacy_client(self):
        relay = R.Relay(self.directory.name)
        relay.stop.set()
        self.assertEqual(relay.exchange({'op': 'call', 'msg': MSG})['delivery'], 'not_sent')
        relay.stop.clear()
        relay.emit = lambda packet: relay.stop.set()
        self.assertEqual(relay.exchange({'op': 'call', 'msg': MSG})['code'], 'disconnected')
        relay.stop.clear()
        relay.emit = lambda packet: relay.message({'t': 'res', 'id': packet['id'], 'msg': RESULT})
        self.assertEqual(relay.exchange({'op': 'call', 'msg': MSG})['msg'], RESULT)

    def test_new_relay_queries_do_not_become_legacy_calls(self):
        relay = R.Relay(self.directory.name)
        relay.emit = lambda *args: self.fail('no execute packet')
        reply = relay.exchange({'op': 'result', 'request_id': 'a' * 32})
        self.assertEqual(reply['code'], 'unsupported')

    def test_relay_stop_persists_a_marker(self):
        relay = R.Relay(self.directory.name); relay.pc = {'machine': 'test'}
        relay.message({'t': 'stop'})
        self.assertTrue(self.link.manually_stopped())

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX') and os.name != 'nt', 'requires real Linux Unix socket')
    def test_real_unix_socket_recovers_after_absent_socket(self):
        relay = R.Relay(self.directory.name)
        relay.emit = lambda packet: relay.message({'t': 'res', 'id': packet['id'], 'msg': RESULT}) if packet.get('t') == 'req' else None
        self.link.recovery_wait = 2
        started = threading.Event()
        def start():
            time.sleep(0.05)
            relay.start({'machine': 'test', 'recovery': {'protocol': 1}})
            started.set()
        worker = threading.Thread(target=start); worker.start()
        try:
            self.assertEqual(self.link.request(MSG), RESULT)
        finally:
            worker.join(); relay.close()
        self.assertTrue(started.is_set())

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX') and os.name != 'nt', 'requires real Linux Unix socket')
    def test_real_unix_query_follows_relay_replacement_without_reexecution(self):
        first = R.Relay(self.directory.name); second = R.Relay(self.directory.name)
        emitted = []; calls = []; ready = threading.Event()
        def first_emit(packet):
            if packet.get('t') == 'req':
                calls.append(packet); first.stop.set(); ready.set()
        first.emit = first_emit
        first.start({'machine': 'test', 'recovery': {'protocol': 1}})
        def replacement():
            ready.wait(3); first.close()
            def second_emit(packet):
                if packet.get('t') == 'req':
                    emitted.append(packet)
                    second.message({'t': 'res', 'id': packet['id'], 'msg': RESULT,
                                    'recovery': {'protocol': 1, 'state': 'done'}})
            second.emit = second_emit
            second.start({'machine': 'test', 'recovery': {'protocol': 1}})
        worker = threading.Thread(target=replacement); worker.start(); self.link.recovery_wait = 3
        try:
            self.assertEqual(self.link.request(MSG), RESULT)
            self.assertEqual(len(calls), 1)
            self.assertTrue(emitted)
            self.assertTrue(all(p['recovery']['action'] == 'query' for p in emitted))
            self.assertEqual(calls[0]['recovery']['requestId'], emitted[-1]['recovery']['requestId'])
        finally:
            worker.join(4); second.close(); first.close()

if __name__ == '__main__':
    unittest.main(verbosity=2)
