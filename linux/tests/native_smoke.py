"""GTK/WebKit package smoke check, run as a normal user under Xvfb + D-Bus."""
import importlib.util
import os
from pathlib import Path
import tempfile
import time
import sys
sys.dont_write_bytecode = True
linux = Path(os.environ.get("CMCP_SMOKE_ROOT", "/opt/cmcp")) / "linux"
sys.path.insert(0, str(linux))

temporary = tempfile.TemporaryDirectory(prefix="cmcp-native-test-")
os.environ["CMCP_STATE_DIR"] = temporary.name
spec = importlib.util.spec_from_file_location("desktop", linux / "desktop.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)
from gi.repository import GLib, WebKit2

dependency_calls = []


def dependency_status():
    return {"missing": [] if dependency_calls else ["xdotool"], "canInstall": True}


def install_dependencies():
    dependency_calls.append("install")
    return dependency_status()


desktop.desktop_dependency_status = dependency_status
desktop.install_desktop_dependencies = install_dependencies
app = desktop.Desktop()
deadline = time.monotonic() + 45
errors = []
finished = False
reading = False
stage = "home"


def screenshot(name):
    global reading
    directory = os.environ.get("CMCP_SMOKE_SCREENSHOT_DIR")
    if directory:
        destination = Path(directory)
        destination.mkdir(parents=True, exist_ok=True)
        completed = []
        loop = GLib.MainLoop()
        def captured(web, task):
            try:
                web.get_snapshot_finish(task).write_to_png(str(destination / (name + ".png")))
                completed.append(True)
            except Exception as error:
                completed.append(str(error))
            loop.quit()
        reading = True
        deadline_source = GLib.timeout_add_seconds(5, lambda: (loop.quit(), False)[1])
        app.web.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, captured)
        loop.run()
        reading = False
        if completed:
            GLib.source_remove(deadline_source)
        assert completed == [True], completed or "WebKit snapshot timed out"


def inspected(web, task):
    global finished, reading, stage
    reading = False
    try:
        text = web.run_javascript_finish(task).get_js_value().to_string()
        if stage == "home":
            if "暂无设备" not in text:
                return
            assert [icon.get_width() for icon in app.window.get_icon_list()] == [32, 64, 128]
            assert desktop.Gdk.get_program_class() == desktop.APP_ID
            assert "开机自启" not in text
            assert "CMCP" in text
            screenshot("home")
            # Exercise the actual WebKit -> GTK -> JavaScript bridge without
            # changing system preferences or launching external programs.
            stage = "bridge"
            app.web.run_javascript("""
                const originalReply = window.cmcpNativeReply;
                window.cmcpNativeReply = (id, value, error) => {
                    if (id === -107) {
                        window.__cmcpNativeSmoke = !error && value && typeof value === 'object';
                        window.cmcpNativeReply = originalReply;
                    } else originalReply(id, value, error);
                };
                window.webkit.messageHandlers.cmcp.postMessage({id: -107, action: 'preferences', payload: {}});
            """, None, None, None)
        elif stage == "bridge":
            if text != "true":
                return
            stage = "settings"
            app.web.run_javascript("document.querySelector('button[aria-label=\"设置\"]').click()", None, None, None)
        elif stage == "settings":
            if "关闭时最小化到托盘" not in text:
                return
            assert "开机自启" not in text
            assert "登录 Mac 后" not in text
            screenshot("settings")
            stage = "about"
            app.web.run_javascript("document.querySelector('button[data-value=\"about\"]').click()", None, None, None)
        elif stage == "about":
            if "安装依赖" not in text:
                return
            assert "系统包管理器" in text
            assert "CMCP " in text
            assert "检查更新" in text
            assert "xdotool" in text and not dependency_calls
            screenshot("about")
            stage = "dependencies"
            app.web.run_javascript("document.querySelector('[data-focus-key=\"update:dependencies\"]').click()", None, None, None)
        elif stage == "dependencies":
            if "安装依赖" in text or "依赖已安装。" not in text:
                return
            assert dependency_calls == ["install"]
            finished = True
            assert app.close_to_tray, "Reading preferences should preserve the close-to-tray setting"
            assert app.tray is None or not app.tray.available, "Run the window-only smoke check on its own bus"
            app.on_window_close()
    except Exception as error:
        errors.append(str(error))
        app.close_window()


def tick():
    global reading
    if finished:
        return False
    if time.monotonic() > deadline:
        errors.append("GTK workspace did not become ready before deadline")
        app.close_window()
        return False
    if getattr(app, "web", None) and not reading and not app.exiting:
        reading = True
        script = "String(window.__cmcpNativeSmoke === true)" if stage == "bridge" else "document.body.innerText"
        app.web.run_javascript(script, None, inspected)
    return True


GLib.timeout_add(250, tick)
try:
    app.run(["cmcp-native-smoke"])
    assert finished and not errors, errors or "Native host exited before ready"
    assert app.backend.poll() is not None, "Backend survived window close"
    assert not (Path(temporary.name) / "manager.lock").exists(), "Backend lock survived clean exit"
    print("Installed GTK/WebKit home/settings/about, dependency install UI, native bridge and clean exit: passed")
finally:
    app.shutdown_backend()
    temporary.cleanup()
