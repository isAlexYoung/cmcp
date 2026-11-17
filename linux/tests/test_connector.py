"""Run the reviewed POSIX connector's full regression suite against Linux output."""
import atexit
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
TEMPORARY = tempfile.TemporaryDirectory(prefix="cmcp-linux-connector-")
atexit.register(TEMPORARY.cleanup)
temporary = Path(TEMPORARY.name)
(temporary / "tests").mkdir()
node = os.environ.get("CMCP_NODE", "node")
source = subprocess.check_output([node, "--input-type=module", "-e", "import {connectorSource} from './linux/connector-source.mjs';process.stdout.write(connectorSource());"], cwd=ROOT)
(temporary / "cloudpc-connector.py").write_bytes(source)


def load_tests(_loader, _tests, _pattern):
    module = types.ModuleType("linux_connector_regressions")
    module.__file__ = str(temporary / "tests/connector_test.py")
    suite_source = (ROOT / "macos/tests/connector_test.py").read_text(encoding="utf-8").replace("mac-pc-files", "linux-pc-files").replace("mac_", "linux_").replace("Mac", "Linux")
    exec(compile(suite_source, module.__file__, "exec"), module.__dict__)
    return unittest.defaultTestLoader.loadTestsFromModule(module)
