import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("package_linux", ROOT / "tools/package-linux.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PackageTests(unittest.TestCase):
    def test_source_offer_has_shared_dependencies_and_no_user_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            for folder in ("app", "macos", "linux"):
                base = root / folder
                base.mkdir(parents=True)
                for name in ("package.json", "package-lock.json"):
                    (base / name).write_text("{}")
                (base / "source.mjs").write_bytes(b"export const source = true;\r\n")
                (base / "private-config.json").write_text("must-not-ship")
                (base / ".env").write_text("must-not-ship")
            for folder in ("macos/ui", "app/mcp-tools-template", "app/mcp-presets", "app/runtime", "macos/runtime", "linux/node_modules/fixture"):
                (root / folder).mkdir(parents=True)
            for name in ("app/runtime/LICENSE", "macos/runtime/FILESYSTEM-LICENSE.txt", "LICENSE", "THIRD_PARTY_NOTICES.txt", "linux/README.md", "linux/WORK_GOALS.md", "linux/DEVELOPMENT_REPORT.md", "linux/UPDATES.md", "linux/node_modules/fixture/index.js"):
                (root / name).write_text("fixture")
            node = root / "linux-node"
            node.write_bytes(b"\x7fELFfixture")
            target = Path(temporary) / "stage"
            builder.copy_source(root, target, node)
            self.assertEqual((target / "runtime/node").read_bytes(), node.read_bytes())
            self.assertTrue((target / "node_modules/fixture/index.js").is_file())
            self.assertFalse(list(target.rglob(".env")))
            self.assertFalse(list(target.rglob("private-config.json")))
            self.assertNotIn(b"\r", (target / "linux/source.mjs").read_bytes())

    def test_native_sources_compile_without_importing_gtk_on_windows(self):
        for file in (ROOT / "linux").glob("*.py"):
            compile(file.read_text(encoding="utf-8"), str(file), "exec")


if __name__ == "__main__":
    unittest.main()
