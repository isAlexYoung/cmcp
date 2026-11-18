"""Local GTK prompts. Requests and answers stay on their standard I/O pipes."""
import json
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

request = json.loads(sys.stdin.buffer.read(16385))
admin = sys.argv[1] == "admin"
dialog = Gtk.MessageDialog(message_type=Gtk.MessageType.WARNING if admin else Gtk.MessageType.QUESTION,
                           buttons=Gtk.ButtonsType.OK_CANCEL, text="CMCP · 管理员请求" if admin else "CMCP · SSH")
dialog.format_secondary_text(str(request.get("message", ""))[:8192])
entry = Gtk.Entry()
entry.set_visibility(False)
if sys.argv[1] == "ask":
    dialog.get_content_area().pack_end(entry, False, False, 8)
    entry.set_activates_default(True)
dialog.set_default_response(Gtk.ResponseType.CANCEL if admin else Gtk.ResponseType.OK)
if admin:
    GLib.timeout_add_seconds(30, dialog.response, Gtk.ResponseType.CANCEL)
dialog.show_all()
if admin:
    dialog.present()
accepted = dialog.run() == Gtk.ResponseType.OK
print(json.dumps({"cancelled": not accepted, "value": entry.get_text() if sys.argv[1] == "ask" else "yes"}))
dialog.destroy()
