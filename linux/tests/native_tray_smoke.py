"""Drive the real GTK host through the panel's StatusNotifier and DBusMenu APIs."""
import json
import os
from pathlib import Path
from queue import Queue
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(os.environ.get("CMCP_SMOKE_ROOT", "/opt/cmcp")) / "linux"))
import desktop
from tray import ITEM, ITEM_PATH, MENU_PATH, WATCHER
from gi.repository import Gio, GLib

BUS = "org.freedesktop.DBus"
PROPERTIES = "org.freedesktop.DBus.Properties"
MENU = "com.canonical.dbusmenu"
DEVICE = "9ae13e3d-e8d5-4d22-8f08-53d02ea10902"
INFO = Gio.DBusNodeInfo.new_for_xml(f"""
<node><interface name="{WATCHER}"><method name="RegisterStatusNotifierItem">
  <arg type="s" direction="in"/>
</method></interface></node>
""")


def wait_for(test):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        value = test()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError("Tray smoke check timed out")


def on_gtk(action):
    result = Queue()

    def execute():
        try:
            result.put((True, action()))
        except Exception as error:
            result.put((False, error))
    GLib.idle_add(execute)
    success, value = result.get(timeout=12)
    if not success:
        raise value
    return value


def main():
    panel = Gio.DBusConnection.new_for_address_sync(
        os.environ["DBUS_SESSION_BUS_ADDRESS"],
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)
    addresses = []

    def register(_connection, sender, _path, _interface, _method, parameters, invocation):
        addresses.append((sender, parameters.unpack()[0]))
        invocation.return_value(None)

    panel.register_object("/StatusNotifierWatcher", INFO.interfaces[0], register, None, None)

    def request_name():
        result = panel.call_sync(BUS, "/org/freedesktop/DBus", BUS, "RequestName",
                                 GLib.Variant("(su)", (WATCHER, 0)), None, Gio.DBusCallFlags.NONE, 5000, None)
        assert result.unpack() == (1,), "The smoke check needs its own D-Bus session"

    request_name()
    with tempfile.TemporaryDirectory(prefix="cmcp-tray-test-") as state:
        os.environ["CMCP_STATE_DIR"] = state
        config = {"roots": [state], "targets": [{"id": DEVICE, "label": "Tray device",
                  "url": "https://fixture.invalid", "authMode": "shared-browser"}]}
        file = Path(state) / "targets.json"
        file.write_text(json.dumps(config))
        file.chmod(0o600)
        app = desktop.Desktop()
        original_api = app.api
        errors, calls, opened = [], [], []
        target = {"id": DEVICE, "label": "Tray device", "state": "stopped",
                  "loginMode": "web", "enabled": False, "connectable": True}

        def api(route, payload=None, timeout=5):
            if route == "tray":
                return {"language": "en", "updating": False, "targets": [target.copy()]}
            if route == "exit":
                return original_api(route, payload, timeout)
            calls.append((route, payload))
            if route == "targets/login":
                target["loginMode"] = payload["mode"]
            if route in ("targets/start", "targets/terminal"):
                target.update(state="connected", enabled=True)
            if route in ("targets/stop", "targets/ssh-stop"):
                target.update(state="idle-ssh" if target["loginMode"] == "ssh" else "stopped", enabled=False)
            return {"url": "https://fixture.invalid", "opened": False} if route == "targets/open" else {}

        app.api = api
        app.open_from_tray = opened.append

        def call(interface, method, variant, path=MENU_PATH):
            return panel.call_sync(addresses[-1][0], path, interface, method, variant, None,
                                   Gio.DBusCallFlags.NONE, 5000, None).unpack()

        def layout():
            keys = ["label", "enabled", "visible", "type", "icon-data"]
            return call(MENU, "GetLayout", GLib.Variant("(iias)", (0, -1, keys)))[1]

        def label(row):
            return row[1].get("label", "")

        def item(name):
            for row in layout()[2]:
                for candidate in [row, *row[2]]:
                    if label(candidate) == name:
                        return candidate
            return None

        def click(name):
            def enabled():
                row = item(name)
                return row if row and row[1].get("enabled", True) else None
            ident = wait_for(enabled)[0]
            call(MENU, "Event", GLib.Variant("(isvu)", (ident, "clicked", GLib.Variant("i", 0), 0)))

        def exercise():
            try:
                wait_for(lambda: addresses and on_gtk(lambda: app.tray.available and app.close_to_tray))
                assert addresses[-1][1] == ITEM_PATH
                props = call(PROPERTIES, "GetAll", GLib.Variant("(s)", (ITEM,)), ITEM_PATH)[0]
                assert props["Menu"] == MENU_PATH and props["IconPixmap"][0][:2] == (32, 32)
                device = wait_for(lambda: item("Tray device · Stopped"))
                visible = [label(row) for row in layout()[2] if row[1].get("visible", True) and label(row)]
                assert visible == ["Open main window", "Tray device · Stopped", "Exit application"], visible
                assert [label(row) for row in device[2] if label(row)] == [
                    "Connect device", "Disconnect device", "Rename", "Switch to ClaudeWeb sign-in"]
                assert device[1]["icon-data"]

                on_gtk(app.on_window_close)
                assert on_gtk(lambda: not app.window.get_visible() and app.backend.poll() is None)
                click("Connect device")
                wait_for(lambda: opened == ["https://fixture.invalid"])
                assert not on_gtk(app.window.get_visible)
                assert [route for route, _ in calls] == ["targets/start", "targets/open"]
                wait_for(lambda: item("Tray device · Connected"))
                click("Disconnect device")
                wait_for(lambda: calls[-1][0] == "targets/stop")
                for label_text, mode in (("Switch to ClaudeWeb sign-in", "cloudcli"), ("Switch to SSH sign-in", "ssh")):
                    click(label_text)
                    wait_for(lambda: calls[-1][1].get("mode") == mode)
                click("Connect device")
                wait_for(lambda: calls[-1][0] == "targets/terminal")
                wait_for(lambda: item("Tray device · Connected"))
                click("Disconnect device")
                wait_for(lambda: calls[-1][0] == "targets/ssh-stop")
                click("Rename")
                wait_for(lambda: on_gtk(app.window.get_visible))
                renamed = Queue()

                def check_rename(web, task, _data):
                    renamed.put(web.run_javascript_finish(task).get_js_value().to_boolean())

                def editor_ready():
                    on_gtk(lambda: app.web.run_javascript(
                        "document.activeElement?.value === 'Tray device' && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 11",
                        None, check_rename, None))
                    return renamed.get(timeout=3)

                wait_for(editor_ready)

                on_gtk(app.on_window_close)
                assert not on_gtk(app.window.get_visible)
                panel.call_sync(BUS, "/org/freedesktop/DBus", BUS, "ReleaseName",
                                GLib.Variant("(s)", (WATCHER,)), None, Gio.DBusCallFlags.NONE, 5000, None)
                wait_for(lambda: on_gtk(app.window.get_visible))
                request_name()
                wait_for(lambda: len(addresses) == 2 and on_gtk(lambda: app.tray.available))
                on_gtk(app.on_window_close)
                click("Open main window")
                wait_for(lambda: on_gtk(app.window.get_visible))
                on_gtk(app.on_window_close)
                call(ITEM, "Activate", GLib.Variant("(ii)", (0, 0)), ITEM_PATH)
                wait_for(lambda: on_gtk(app.window.get_visible))
                click("Exit application")
            except Exception as error:
                errors.append(error)
                on_gtk(app.close_window)

        worker = threading.Thread(target=exercise, daemon=True)
        worker.start()
        def timed_out():
            errors.append(AssertionError("Tray smoke check did not exit"))
            app.close_window()
            return False
        deadline = GLib.timeout_add_seconds(65, timed_out)
        app.run(["cmcp-tray-smoke"])
        if not errors:
            GLib.source_remove(deadline)
        worker.join(timeout=10)
        assert not worker.is_alive()
        assert not errors, errors
        assert app.backend.poll() is not None and not (Path(state) / "manager.lock").exists()
        print("GTK tray registration, menu, device actions, hide/restore, watcher loss and full exit passed")


if __name__ == "__main__":
    main()
