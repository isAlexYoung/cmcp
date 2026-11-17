#!/usr/bin/python3
"""GNOME desktop host. The shared UI only receives a bridge on its own origin."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import Request, urlopen, ProxyHandler, build_opener
sys.dont_write_bytecode = True
from update_runtime import acknowledge, atomic, private, process_stamp, state_directory

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.0")
from gi.repository import Gio, GLib, Gtk, WebKit2

KIT = Path(__file__).resolve().parent


class Desktop(Gtk.Application):
    def __init__(self, update_request=None):
        super().__init__(application_id="com.cmcp.Ubuntu", flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.window = None
        self.backend = None
        self.identity = None
        self.exiting = False
        self.update_request = update_request
        self.update_busy = False
        self.prepared_version = None

    def error(self, text):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.ERROR, buttons=Gtk.ButtonsType.CLOSE, text="CMCP")
        dialog.format_secondary_text(text)
        dialog.run()
        dialog.destroy()

    def do_activate(self):
        if self.window:
            self.window.present()
            return
        if os.getuid() == 0:
            self.error("请以普通桌面用户运行 CMCP，不要使用 sudo。")
            self.quit()
            return
        node = KIT.parent / "runtime/node"
        if not node.is_file():
            self.error("缺少捆绑的 Node 运行时。请安装构建好的 .deb 包，或按 Linux 开发说明启动。")
            self.quit()
            return
        self.window = Gtk.ApplicationWindow(application=self, title="CMCP · Ubuntu")
        self.window.set_icon_name("cmcp")
        self.window.set_default_size(1080, 760)
        self.window.set_size_request(640, 480)
        self.window.connect("delete-event", self.close_window)
        self.window.add(Gtk.Label(label="正在启动 CMCP…"))
        self.window.show_all()
        self.backend = subprocess.Popen([str(node), str(KIT / "desktop.mjs")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(KIT.parent), start_new_session=True)
        threading.Thread(target=self.wait_backend, daemon=True).start()

    def wait_backend(self):
        messages = queue.Queue()
        def read():
            try:
                messages.put(self.backend.stdout.readline(4097))
            except Exception:
                messages.put(b"")
        threading.Thread(target=read, daemon=True).start()
        try:
            raw = messages.get(timeout=30)
            identity = json.loads(raw)
            parsed = urlsplit(identity["origin"])
            if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path or len(identity["token"]) != 64 or any(c not in "0123456789abcdef" for c in identity["token"]):
                raise ValueError("Invalid backend identity")
            self.identity = identity
            GLib.idle_add(self.show_workspace)
        except Exception:
            GLib.idle_add(self.start_failed)
            return
        self.backend.wait()
        if not self.exiting:
            GLib.idle_add(self.start_failed)

    def start_failed(self):
        if not self.exiting:
            self.error("CMCP 服务未能启动或意外退出。请检查是否已有服务运行，以及安装依赖和用户目录权限。")
            self.shutdown_backend()
            self.quit()
        return False

    def show_workspace(self):
        if self.exiting:
            return False
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler("cmcp")
        manager.connect("script-message-received::cmcp", self.native_message)
        self.web = WebKit2.WebView.new_with_user_content_manager(manager)
        self.web.get_settings().set_enable_developer_extras(False)
        self.web.connect("decide-policy", self.navigation)
        self.web.connect("permission-request", lambda *_: False)
        self.window.remove(self.window.get_child())
        self.window.add(self.web)
        self.web.load_uri(self.identity["origin"] + "/#" + self.identity["token"])
        self.window.show_all()
        if self.update_request:
            GLib.timeout_add(300, self.acknowledge_update)
        return False

    def acknowledge_update(self):
        if self.exiting or not self.update_request:
            return False
        def inspected(web, task):
            try:
                if web.run_javascript_finish(task).get_js_value().to_boolean():
                    acknowledge(self.update_request, KIT.parent)
                    self.update_request = None
            except Exception:
                pass
        self.web.run_javascript("document.querySelector('#app .cards') !== null", None, inspected)
        return True

    def api(self, route):
        request = Request(self.identity['origin'] + '/api/' + route, data=b'{}', headers={'Content-Type': 'application/json', 'X-CMCP-Token': self.identity['token']})
        with build_opener(ProxyHandler({})).open(request, timeout=8 * 60 + 15) as response:
            return json.loads(response.read())

    def begin_update(self, ident, action):
        if self.update_busy:
            raise ValueError('Update already running')
        if action == 'install-update' and not self.action('confirm', {'text': '更新已下载并校验。现在安装并重启 CMCP？当前连接会暂时断开；启动失败将恢复原版本。'}):
            self.reply(ident, {'prepared': True, 'version': self.prepared_version})
            return
        self.update_busy = True
        def worker():
            helper = None
            try:
                prepared = self.api('update/download' if action == 'update' else 'update/prepared')['directory']
                if action == 'install-update':
                    state = private(state_directory())
                    request_file = state / ('update-request-' + str(uuid.uuid4()) + '.json')
                    atomic(request_file, {**prepared, 'state': str(state), 'installRoot': str(KIT.parent), 'nonce': str(uuid.uuid4()), 'managerPid': self.backend.pid, 'managerPidStamp': process_stamp(self.backend.pid), 'appPid': os.getpid(), 'appPidStamp': process_stamp(os.getpid())})
                    helper = subprocess.Popen(['/usr/bin/python3', '-B', str(KIT / 'apply_update.py'), str(request_file)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                    deadline = time.monotonic() + 90
                    while True:
                        if Path(str(request_file) + '.ready').is_file():
                            break
                        if helper.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError('Update preparation failed')
                        time.sleep(0.1)
                def completed():
                    self.update_busy = False
                    self.prepared_version = prepared['version']
                    self.reply(ident, {'prepared': action == 'update', 'version': prepared['version']})
                    if action == 'install-update':
                        self.close_window()
                    return False
                GLib.idle_add(completed)
            except Exception:
                if helper and helper.poll() is None:
                    helper.terminate()
                try:
                    self.api('update/failed')
                except Exception:
                    pass
                def failed():
                    self.update_busy = False
                    self.reply(ident, error='更新未完成，原版本已保留。请检查网络、磁盘空间与安装包后重试。')
                    return False
                GLib.idle_add(failed)
        threading.Thread(target=worker, daemon=True).start()

    def navigation(self, _web, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            parsed = urlsplit(uri)
            if f"{parsed.scheme}://{parsed.netloc}" != self.identity["origin"] or parsed.path not in ("", "/"):
                decision.ignore()
                return True
        return False

    def reply(self, ident, value=None, error=None):
        if not self.exiting:
            script = "window.cmcpNativeReply(%s,%s,%s)" % (json.dumps(ident), json.dumps(value), json.dumps(error))
            self.web.run_javascript(script, None, None, None)

    def native_message(self, _manager, message):
        try:
            if not self.web.get_uri().startswith(self.identity["origin"] + "/"):
                return
            raw = message.get_js_value().to_json(0)
            if len(raw) > 65536:
                return
            data = json.loads(raw)
            ident, action, payload = data["id"], data["action"], data.get("payload", {})
            if not isinstance(ident, int) or isinstance(ident, bool) or not isinstance(payload, dict):
                return
            if action in ('update', 'install-update'):
                self.begin_update(ident, action)
                return
            value = self.action(action, payload)
            self.reply(ident, value)
        except Exception:
            self.reply(data.get("id") if isinstance(locals().get("data"), dict) else None, error="操作失败，请检查桌面环境与安装依赖。")

    def action(self, action, payload):
        if action == "open":
            uri = str(payload.get("url", ""))
            parsed = urlsplit(uri)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or any(ord(c) < 32 for c in uri):
                raise ValueError("Invalid URL")
            Gio.AppInfo.launch_default_for_uri(uri, None)
            return True
        if action == "copy":
            from gi.repository import Gdk
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(str(payload.get("text", ""))[:65536], -1)
            return True
        if action == "confirm":
            dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.OK_CANCEL, text="CMCP")
            dialog.format_secondary_text(str(payload.get("text", ""))[:8192])
            accepted = dialog.run() == Gtk.ResponseType.OK
            dialog.destroy()
            return accepted
        if action == "pickKey":
            dialog = Gtk.FileChooserDialog(title="选择 SSH 私钥", transient_for=self.window, action=Gtk.FileChooserAction.OPEN)
            dialog.add_buttons("取消", Gtk.ResponseType.CANCEL, "打开", Gtk.ResponseType.OK)
            result = dialog.get_filename() if dialog.run() == Gtk.ResponseType.OK else None
            dialog.destroy()
            return result
        if action in ("program", "logs"):
            state = Path(os.environ.get("CMCP_STATE_DIR") or str(Path(os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")) / "cmcp"))
            Gio.AppInfo.launch_default_for_uri((KIT.parent if action == "program" else state).as_uri(), None)
            return True
        if action in ("preferences", "icons"):
            return {}  # No native settings are changed; GTK follows the desktop theme.
        raise ValueError("Unsupported Linux action")

    def close_window(self, *_):
        self.window.hide()
        if not self.exiting:
            self.exiting = True
            threading.Thread(target=self.stop_and_quit, daemon=True).start()
        return True

    def stop_and_quit(self):
        try:
            if self.identity and self.backend.poll() is None:
                request = Request(self.identity["origin"] + "/api/exit", data=b"{}", headers={"Content-Type": "application/json", "X-CMCP-Token": self.identity["token"]})
                with build_opener(ProxyHandler({})).open(request, timeout=5):
                    pass
        except Exception:
            pass
        self.shutdown_backend()
        GLib.idle_add(self.quit)

    def shutdown_backend(self):
        self.exiting = True
        if self.backend and self.backend.poll() is None:
            try:
                self.backend.stdin.close()
                self.backend.wait(timeout=20)
            except Exception:
                self.backend.terminate()
                try:
                    self.backend.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.backend.kill()

    def do_shutdown(self):
        self.shutdown_backend()
        Gtk.Application.do_shutdown(self)


if __name__ == "__main__":
    import signal
    update_file = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == '--updated' else None
    app = Desktop(update_file)
    signal.signal(signal.SIGTERM, lambda *_: GLib.idle_add(app.close_window))
    sys.exit(app.run([sys.argv[0]] if update_file else sys.argv))
