"""SSH questions stay on stdin; a user's answer goes only to the askpass pipe."""
import json
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

request = json.loads(sys.stdin.buffer.read(16385))
dialog = Gtk.MessageDialog(message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.OK_CANCEL, text="CMCP · SSH")
dialog.format_secondary_text(str(request.get("message", ""))[:8192])
entry = Gtk.Entry()
entry.set_visibility(False)
if sys.argv[1] == "ask":
    dialog.get_content_area().pack_end(entry, False, False, 8)
    entry.set_activates_default(True)
dialog.set_default_response(Gtk.ResponseType.OK)
dialog.show_all()
accepted = dialog.run() == Gtk.ResponseType.OK
print(json.dumps({"cancelled": not accepted, "value": entry.get_text() if sys.argv[1] == "ask" else "yes"}))
dialog.destroy()
