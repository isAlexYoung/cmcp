import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest


RELAY = Path(__file__).resolve().parents[1] / "cloudpc-relay.py"
SPEC = importlib.util.spec_from_file_location("relay", RELAY)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

OLD_RELAY = """
import importlib.util, signal, sys, time

spec = importlib.util.spec_from_file_location("relay", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class OldRelay(module.Relay):
    def emit(self, packet):
        pass

    def exchange(self, request, interim=None):
        if request["op"] == "replace":
            time.sleep(60)  # Old terminal's blocked notification prevents the reply.
        return super().exchange(request, interim)

signal.signal(signal.SIGTERM, signal.SIG_IGN)
relay = OldRelay(sys.argv[2])
relay.start({"machine": sys.argv[3]})
print("ready", flush=True)
signal.pause()
"""


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open"), "requires Linux pidfds")
class RelayTakeoverTests(unittest.TestCase):
    def start_fixture(self, machine):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        previous = subprocess.Popen(
            [sys.executable, "-c", OLD_RELAY, str(RELAY), folder.name, machine],
            stdout=subprocess.PIPE, text=True,
        )

        def stop_fixture():
            if previous.poll() is None:
                previous.kill()
            previous.wait(timeout=5)
            previous.stdout.close()

        self.addCleanup(stop_fixture)
        self.assertEqual(previous.stdout.readline().strip(), "ready")
        replacement = MODULE.Relay(folder.name)
        replacement.emit = lambda packet: None
        self.addCleanup(replacement.close)
        return previous, replacement

    def test_a_stuck_relay_from_the_same_machine_is_replaced(self):
        previous, replacement = self.start_fixture("previous-local-machine")
        replacement.start({"machine": "current-device-key", "legacyMachine": "previous-local-machine"})
        self.assertLess(previous.wait(timeout=5), 0)
        with socket.socket(socket.AF_UNIX) as probe:
            probe.settimeout(1)
            probe.connect(str(replacement.path))
            status = replacement.relay_request(probe, "status")
        self.assertTrue(status["connected"])
        self.assertEqual(status["pc"]["machine"], "current-device-key")

    def test_a_stuck_relay_from_another_machine_is_left_running(self):
        previous, replacement = self.start_fixture("unrelated-machine")
        with self.assertRaisesRegex(RuntimeError, "旧的兼容连接未能结束"):
            replacement.start({"machine": "current-device-key", "legacyMachine": "previous-local-machine"})
        self.assertIsNone(previous.poll())
