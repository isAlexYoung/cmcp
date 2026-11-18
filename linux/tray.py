"""GNOME StatusNotifierItem with the same device menu as the Windows client."""
import threading

import gi
gi.require_version("Dbusmenu", "0.4")
from gi.repository import Dbusmenu, GdkPixbuf, Gio, GLib

WATCHER = "org.kde.StatusNotifierWatcher"
ITEM = "org.kde.StatusNotifierItem"
ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/com/cmcp/Ubuntu/TrayMenu"
ITEM_INFO = Gio.DBusNodeInfo.new_for_xml(f"""
<node><interface name="{ITEM}">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <signal name="NewStatus"><arg type="s"/></signal>
</interface></node>
""")

ACTIVE = {"connected", "connecting", "configuring", "waiting-login", "recovering", "unstable"}
STATES = {
    "connected": ("已连接", "Connected"),
    "connecting": ("连接中", "Connecting"),
    "configuring": ("正在配置 Claude", "Setting up Claude"),
    "config-error": ("连接异常", "Connection error"),
    "waiting-login": ("等待网页登录", "Waiting for browser sign-in"),
    "recovering": ("正在恢复", "Recovering"),
    "unstable": ("正在恢复", "Recovering"),
    "offline": ("等待网络恢复", "Waiting for network"),
    "replaced": ("连接已被接管", "Connection replaced"),
    "password": ("需要更新密码", "Update password"),
    "locked": ("登录暂时锁定", "Sign-in locked"),
    "expired": ("访问已过期", "Access expired"),
    "stopped": ("已停止", "Stopped"),
    "stale": ("状态不可用", "Status unavailable"),
    "idle-ssh": ("SSH", "SSH"),
}
NEXT_MODE = {
    "web": ("cloudcli", "切换为 CloudCLI 登录", "Switch to CloudCLI sign-in"),
    "cloudcli": ("ssh", "切换为 SSH 登录", "Switch to SSH sign-in"),
    "ssh": ("web", "切换为网页桌面登录", "Switch to WebDesktop sign-in"),
}


def argb(pixbuf):
    """The notifier wire format is packed ARGB, regardless of GTK row padding."""
    width, height = pixbuf.get_width(), pixbuf.get_height()
    pixels = pixbuf.get_pixels()
    stride, channels = pixbuf.get_rowstride(), pixbuf.get_n_channels()
    data = bytearray()
    for y in range(height):
        for x in range(width):
            offset = y * stride + x * channels
            data.append(pixels[offset + 3] if channels == 4 else 255)
            data.extend(pixels[offset:offset + 3])
    return width, height, bytes(data)


def dot_icon(rgb):
    size = 12
    rgba = bytes(channel for y in range(size) for x in range(size)
                 for channel in (*rgb, 255 if (x - 5.5)**2 + (y - 5.5)**2 <= 17 else 0))
    pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(rgba), GdkPixbuf.Colorspace.RGB, True, 8, size, size, size * 4)
    return GLib.Variant("ay", pixbuf.save_to_bufferv("png", [], [])[1])


class Tray:
    def __init__(self, icons, api, restore, rename, exit_app, open_url, error, unavailable, blocked):
        self.api, self.restore, self.rename = api, restore, rename
        self.open_url, self.error, self.unavailable, self.blocked = open_url, error, unavailable, blocked
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.available = self.closed = self.registering = self.refreshing = self.stale = self.updating = False
        self.owner = None
        self.language = "zh-CN"
        self.targets, self.rows, self.pending = {}, {}, set()
        self.properties = {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "cmcp"),
            "Title": GLib.Variant("s", "CMCP"),
            "Status": GLib.Variant("s", "Active"),
            "Menu": GLib.Variant("o", MENU_PATH),
            "ItemIsMenu": GLib.Variant("b", False),
            "IconName": GLib.Variant("s", ""),
            "IconPixmap": GLib.Variant("a(iiay)", [argb(icon) for icon in icons]),
        }
        self.dots = {tone: dot_icon(rgb) for tone, rgb in {
            "connected": (49, 166, 103), "ssh": (73, 139, 232), "idle": (144, 144, 144),
        }.items()}
        self.root = Dbusmenu.Menuitem.new()
        self.open_item = self.item("window-new-symbolic", restore)
        self.exit_item = self.item("application-exit-symbolic", exit_app)
        self.empty = self.item()
        self.empty.property_set_bool("enabled", False)
        for entry in (self.open_item, self.separator(), self.empty, self.separator(), self.exit_item):
            self.root.child_append(entry)
        self.update_menu()
        self.server = Dbusmenu.Server.new(MENU_PATH)
        self.server.set_root(self.root)
        self.registration = self.connection.register_object(
            ITEM_PATH, ITEM_INFO.interfaces[0], self.on_method, self.on_property, None)
        self.watch = Gio.bus_watch_name_on_connection(
            self.connection, WATCHER, Gio.BusNameWatcherFlags.NONE, self.appeared, self.vanished)
        self.timer = GLib.timeout_add_seconds(2, self.tick)

    @staticmethod
    def item(icon=None, activate=None):
        item = Dbusmenu.Menuitem.new()
        if icon:
            item.property_set("icon-name", icon)
        if activate:
            item.connect("item-activated", lambda *_: activate())
        return item

    @classmethod
    def separator(cls):
        item = cls.item()
        item.property_set("type", "separator")
        return item

    def on_method(self, _connection, _sender, _path, _iface, method, _parameters, invocation):
        invocation.return_value(None)
        if not self.closed and method in ("Activate", "SecondaryActivate"):
            self.restore()

    def on_property(self, _connection, _sender, _path, _iface, name):
        return self.properties.get(name)

    def appeared(self, _connection, _name, owner):
        self.owner = owner
        self.register()

    def vanished(self, *_):
        self.owner = None
        self.registering = False
        if self.available and not self.closed:
            self.available = False
            self.unavailable()

    def register(self):
        owner = self.owner
        if not owner or self.available or self.registering:
            return
        self.registering = True

        def finished(connection, result, *_):
            if self.closed or owner != self.owner:
                return
            self.registering = False
            try:
                connection.call_finish(result)
            except GLib.Error:
                return
            self.available = True
            self.refresh()

        self.connection.call(owner, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem",
                             GLib.Variant("(s)", (ITEM_PATH,)), None, Gio.DBusCallFlags.NONE, 3000, None, finished)

    def tick(self):
        if self.available:
            self.refresh()
        else:
            self.register()
        return True

    def tr(self, zh, en):
        return en if self.language == "en" else zh

    def make_row(self, ident):
        item = self.item()
        commands = {}
        for action, icon in (
            ("connect", "media-playback-start-symbolic"), ("stop", "media-playback-stop-symbolic"),
            ("rename", "document-edit-symbolic"), ("switch", "network-workgroup-symbolic"),
        ):
            if action == "switch":
                item.child_append(self.separator())
            commands[action] = self.item(icon, lambda action=action: self.command(ident, action))
            item.child_append(commands[action])
        return item, commands

    def allowed(self, target):
        mode, state = target["loginMode"], target["state"]
        available = not (self.stale or self.updating or self.blocked() or target["id"] in self.pending)
        return {
            "connect": available and target["connectable"] and (mode == "ssh" or state not in ACTIVE),
            "stop": available and target["enabled"],
            "rename": available,
            "switch": available,
        }

    def update_menu(self):
        self.open_item.property_set("label", self.tr("打开主界面", "Open main window"))
        self.exit_item.property_set("label", self.tr("退出程序", "Exit application"))
        self.exit_item.property_set_bool("enabled", not self.blocked())
        self.empty.property_set("label", self.tr("暂无设备", "No devices"))
        self.empty.property_set_bool("visible", not self.targets)
        for ident in set(self.rows) - self.targets.keys():
            item, _ = self.rows.pop(ident)
            self.root.child_delete(item)
        for position, (ident, target) in enumerate(self.targets.items(), 3):
            if ident not in self.rows:
                self.rows[ident] = self.make_row(ident)
                self.root.child_add_position(self.rows[ident][0], position)
            item, commands = self.rows[ident]
            if self.root.get_children()[position] != item:
                self.root.child_reorder(item, position)
            mode = target["loginMode"]
            state = "stale" if self.stale else target["state"]
            tone = "connected" if state == "connected" else "ssh" if mode == "ssh" else "idle"
            label = target["label"].replace("_", "__")
            item.property_set("label", label + " · " + self.tr(*STATES.get(state, STATES["config-error"])))
            item.property_set_variant("icon-data", self.dots[tone])
            labels = {
                "connect": ("连接设备", "Connect device"), "stop": ("断开设备", "Disconnect device"),
                "rename": ("重命名", "Rename"), "switch": NEXT_MODE[mode][1:],
            }
            enabled = self.allowed(target)
            for action, child in commands.items():
                child.property_set("label", self.tr(*labels[action]))
                child.property_set_bool("enabled", enabled[action])

    def request(self, work, completed):
        def worker():
            try:
                value = work()
            except Exception:
                value = None
            GLib.idle_add(completed, value)
        threading.Thread(target=worker, daemon=True).start()

    def refresh(self):
        if self.closed or not self.available or self.refreshing:
            return
        self.refreshing = True

        def completed(result):
            self.refreshing = False
            if self.closed:
                return
            self.stale = result is None
            if result is not None:
                self.language, self.updating = result["language"], result["updating"]
                self.targets = {target["id"]: target for target in result["targets"]}
            self.update_menu()

        self.request(lambda: self.api("tray", timeout=5), completed)

    def command(self, ident, action):
        target = self.targets.get(ident)
        if self.closed or not self.available or not target or not self.allowed(target).get(action):
            return
        if action == "rename":
            self.rename(ident)
            return
        self.pending.add(ident)
        self.update_menu()
        mode = target["loginMode"]
        body = {"id": ident, "expectedMode": mode}

        def work():
            if action == "switch":
                return self.api("targets/login", {**body, "mode": NEXT_MODE[mode][0]}, timeout=15)
            if action == "stop":
                return self.api("targets/ssh-stop" if mode == "ssh" else "targets/stop", body, timeout=20)
            if mode == "ssh":
                return self.api("targets/terminal", body, timeout=20)
            self.api("targets/start", body, timeout=15)
            return self.api("targets/open", body, timeout=15)

        def completed(result):
            if self.closed:
                return
            self.pending.discard(ident)
            try:
                if result is None:
                    self.error()
                elif action == "connect" and result.get("url") and not result.get("opened"):
                    self.open_url(result["url"])
            except (GLib.Error, ValueError):
                self.error()
            self.update_menu()
            self.refresh()

        self.request(work, completed)

    def close(self):
        if self.closed:
            return
        self.closed = True
        GLib.source_remove(self.timer)
        Gio.bus_unwatch_name(self.watch)
        self.properties["Status"] = GLib.Variant("s", "Passive")
        if not self.connection.is_closed():
            try:
                self.connection.emit_signal(None, ITEM_PATH, ITEM, "NewStatus", GLib.Variant("(s)", ("Passive",)))
            except GLib.Error:
                pass
            self.connection.unregister_object(self.registration)
        self.server = None
