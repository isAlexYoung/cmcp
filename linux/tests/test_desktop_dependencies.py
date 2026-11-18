import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

path = Path(__file__).resolve().parents[1] / "desktop_dependencies.py"
spec = importlib.util.spec_from_file_location("desktop_dependencies", path)
dependencies = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"gi": Mock()}):
    spec.loader.exec_module(dependencies)


class DesktopDependencyTests(unittest.TestCase):
    def setUp(self):
        which = patch.object(dependencies.shutil, "which")
        apt = patch.object(dependencies.subprocess, "run")
        version = patch.object(dependencies.gi, "require_version")
        self.which = which.start()
        self.apt = apt.start()
        self.version = version.start()
        for mock in (which, apt, version):
            self.addCleanup(mock.stop)
        self.available = {dependencies.PKEXEC, dependencies.APT_GET, "xdotool"}
        self.which.side_effect = lambda name: name if name in self.available else None

    def test_skips_install_when_dependencies_are_present(self):
        self.assertEqual(dependencies.install_desktop_dependencies(), {"missing": [], "canInstall": True})
        self.apt.assert_not_called()

    def test_skips_install_when_policykit_is_unavailable(self):
        self.available.difference_update({dependencies.PKEXEC, "xdotool"})
        self.assertEqual(dependencies.install_desktop_dependencies(), {"missing": ["xdotool"], "canInstall": False})
        self.apt.assert_not_called()

    def test_installs_only_missing_package_and_rechecks_it(self):
        self.available.remove("xdotool")

        def install(*args, **kwargs):
            self.available.add("xdotool")
            return subprocess.CompletedProcess(args[0], 0)

        self.apt.side_effect = install
        self.assertEqual(dependencies.install_desktop_dependencies(),
                         {"missing": [], "canInstall": True, "cancelled": False})
        self.apt.assert_called_once_with(
            [dependencies.PKEXEC, "--disable-internal-agent", dependencies.APT_GET, "--assume-yes",
             "install", "--", "xdotool"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

    def test_cancellation_keeps_missing_dependencies_visible(self):
        self.available.remove("xdotool")
        self.version.side_effect = ValueError("Typelib missing")
        self.apt.return_value = subprocess.CompletedProcess([], 126)
        self.assertEqual(dependencies.install_desktop_dependencies(),
                         {"missing": ["xdotool", "gir1.2-dbusmenu-glib-0.4"], "canInstall": True, "cancelled": True})
