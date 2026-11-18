"""Capture only the requested X11 monitor region into CMCP's private staging file."""
import json
import sys

import gi
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk


def capture(request):
    display = Gdk.Display.get_default()
    root = Gdk.get_default_root_window()
    if display is None or root is None:
        raise ValueError("The local X11 desktop is unavailable")
    monitor = request.get("monitor", 0)
    if not 0 <= monitor < display.get_n_monitors():
        raise ValueError("Invalid monitor index")
    geometry = display.get_monitor(monitor).get_geometry()
    x, y = request.get("x", 0), request.get("y", 0)
    width = request.get("width", geometry.width - x)
    height = request.get("height", geometry.height - y)
    screen_x, screen_y = geometry.x + x, geometry.y + y
    if (min(x, y, screen_x, screen_y) < 0 or width <= 0 or height <= 0
            or x + width > geometry.width or y + height > geometry.height
            or screen_x + width > root.get_width() or screen_y + height > root.get_height()):
        raise ValueError("Screenshot rectangle is outside the selected monitor")
    pixbuf = Gdk.pixbuf_get_from_window(root, screen_x, screen_y, width, height)
    if pixbuf is None:
        raise ValueError("X11 could not capture this screen region")
    pixbuf.savev(request["path"], "png", [], [])
    return {"monitor": monitor, "x": screen_x, "y": screen_y, "width": width, "height": height}


if __name__ == "__main__":
    try:
        print(json.dumps(capture(json.loads(sys.stdin.read(65536)))))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
