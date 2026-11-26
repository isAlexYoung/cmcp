import importlib.util
import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
POLICY = {
    "key": "device-key",
    "name": "cmcp-pc-0123456789abcdef",
    "ssh": "cmcp-ssh-0123456789abcdef",
    "web": "windows-pc-files",
    "primary": "url",
    "dual": True,
}


class ManagedConnectorTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.private = self.home / ".local/share/cloudpc-link" / POLICY["name"]
        self.config = self.home / ".claude.json"

    def load(self, platform, primary="url", dual=True):
        policy = dict(POLICY, primary=primary, dual=dual)
        if platform == "macos":
            policy["web"] = "mac-pc-files"
        helper = (ROOT / "app/managed-connector.py").read_text(encoding="utf-8")
        source = (ROOT / platform / "cloudpc-connector.py").read_text(encoding="utf-8")
        file = self.home / (platform + ".py")
        file.write_text(source.replace("# CMCP_MANAGED_CONNECTOR", "MANAGED_POLICY = " + repr(policy) + "\n" + helper), encoding="utf-8")
        spec = importlib.util.spec_from_file_location("managed_fixture", file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, policy

    def test_both_installers_converge_and_preserve_unrelated_mcp(self):
        for platform in ("app", "macos"):
            with self.subTest(platform=platform):
                module, policy = self.load(platform)
                aliases = {
                    alias: {"command": "python3", "args": ["-u", str(self.private.parent / alias / "connector.py"), "serve", "--name", alias]}
                    for alias in (policy["ssh"], policy["web"])
                }
                other = {"command": "custom-tool", "args": ["custom"]}
                self.config.write_text(json.dumps({"mcpServers": {**aliases, "other": other}}), encoding="utf-8")
                for alias in (policy["web"], policy["ssh"]):
                    module.apply_install(self.private.parent / alias, [self.config], {"tools": []}, alias)
                config = json.loads(self.config.read_text(encoding="utf-8"))["mcpServers"]
                self.assertEqual(set(config), {"other", policy["name"]})
                self.assertEqual(config["other"], other)
                self.assertEqual(config[policy["name"]]["args"][1], str(self.private / "connector.py"))
                self.assertEqual(json.loads((self.private / "connection-policy.json").read_text()), policy)

    def test_route_fallback_and_never_replays_an_unconfirmed_request(self):
        module, policy = self.load("app")
        module.apply_install(self.private.parent / policy["web"], [self.config], {"tools": []}, policy["web"])
        calls = []
        outcomes = {policy["web"]: module.Offline, policy["ssh"]: None}

        class Route:
            def __init__(self, path):
                self.route = path.parent.parent.name

            def status(self):
                return {"connected": True, "pc": {"machine": policy["key"]}}

            def request(self, message, wait):
                calls.append(self.route)
                error = outcomes[self.route]
                if error:
                    raise error()
                return message

        with patch.object(module, "Link", Route):
            link = module.ManagedLink(self.private)
            message = {"id": 1, "method": "tools/call"}
            self.assertEqual(link.request(message, 0), message)
            self.assertEqual(calls, [policy["web"], policy["ssh"]])
            calls.clear()
            outcomes[policy["web"]] = module.OutcomeUnknown
            with self.assertRaises(module.OutcomeUnknown):
                link.request(message, 0)
            self.assertEqual(calls, [policy["web"]])
            calls.clear()
            (self.private / "connection-policy.json").write_text(json.dumps(dict(policy, primary="ssh", dual=False)), encoding="utf-8")
            self.assertEqual(link.request(message, 0), message)
            self.assertEqual(calls, [policy["ssh"]])

    @unittest.skipUnless(os.name == "posix", "Unix relay sockets")
    def test_switches_between_live_unix_sockets_using_one_stdio_connector(self):
        module, policy = self.load("app")
        module.apply_install(self.private.parent / policy["web"], [self.config], {"tools": []}, policy["web"])

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                line = self.rfile.readline()
                if not line:
                    return
                request = json.loads(line)
                response = {"ok": True, "connected": True, "pc": {"machine": policy["key"]}}
                if request["op"] == "call":
                    response["msg"] = {"jsonrpc": "2.0", "id": request["msg"]["id"], "result": self.server.route}
                self.wfile.write((json.dumps(response) + "\n").encode())

        servers = []
        try:
            for route in ("url", "ssh"):
                name = policy["web"] if route == "url" else policy["ssh"]
                sock = self.private.parent / name / "relay" / "link.sock"
                sock.parent.mkdir(parents=True)
                server = socketserver.UnixStreamServer(str(sock), Handler)
                server.route = route
                threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
                servers.append(server)
            link = module.ManagedLink(self.private)
            msg = {"id": 1, "method": "tools/call"}
            self.assertEqual(link.request(msg, 0)["result"], "url")
            first = servers.pop(0)
            first.shutdown()
            first.server_close()
            self.assertEqual(link.request(msg, 0)["result"], "ssh")
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
