"""Check and install CMCP's optional desktop runtime from Ubuntu's APT sources."""
import shutil
import subprocess

import gi

PKEXEC = "/usr/bin/pkexec"
APT_GET = "/usr/bin/apt-get"


def desktop_dependency_status():
    missing = []
    if shutil.which("xdotool") is None:
        missing.append("xdotool")
    try:
        gi.require_version("Dbusmenu", "0.4")
    except ValueError:
        missing.append("gir1.2-dbusmenu-glib-0.4")
    return {"missing": missing, "canInstall": bool(shutil.which(PKEXEC) and shutil.which(APT_GET))}


def install_desktop_dependencies():
    status = desktop_dependency_status()
    if not status["missing"] or not status["canInstall"]:
        return status
    # Compute the package names locally. Package names, flags and commands never come from the UI.
    command = [PKEXEC, "--disable-internal-agent", APT_GET, "--assume-yes", "install", "--", *status["missing"]]
    try:
        process = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, check=False)
        cancelled = process.returncode == 126
    except OSError:
        cancelled = False
    return {**desktop_dependency_status(), "cancelled": cancelled}
