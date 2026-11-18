#!/usr/bin/env python3
"""Build an Ubuntu amd64 development .deb; never collect the user's state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ICON = Path("app/assets/cmcp-icon.svg")


def copy_source(root, target, node):
    """Explicit source allowlist, shared by the real builder and package tests."""
    target.mkdir(parents=True, exist_ok=True)
    for folder in ("app", "macos", "linux"):
        source = root / folder
        for pattern in ("*.mjs", "*.py"):
            for file in source.glob(pattern):
                destination = target / folder / file.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                # Linux shell helpers require LF even from a Windows checkout.
                destination.write_bytes(file.read_bytes().replace(b"\r\n", b"\n"))
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(source / name, target / folder / name)
    for name in ("ui",):
        shutil.copytree(root / "macos" / name, target / "macos" / name)
    for name in ("mcp-tools-template", "mcp-presets"):
        shutil.copytree(root / "app" / name, target / "app" / name)
    (target / ICON).parent.mkdir()
    shutil.copy2(root / ICON, target / ICON)
    dependencies = root / "linux/node_modules"
    if not dependencies.is_dir():
        raise ValueError("Run npm --prefix linux ci --ignore-scripts first")
    shutil.copytree(dependencies, target / "node_modules", ignore=shutil.ignore_patterns(".bin"))
    runtime = target / "runtime"
    runtime.mkdir()
    shutil.copy2(node, runtime / "node")
    (runtime / "node").chmod(0o755)
    shutil.copy2(root / "app/runtime/LICENSE", runtime / "LICENSE")
    shutil.copy2(root / "macos/runtime/FILESYSTEM-LICENSE.txt", target / "FILESYSTEM-LICENSE.txt")
    shutil.copy2(root / "LICENSE", target / "LICENSE")
    shutil.copy2(root / "THIRD_PARTY_NOTICES.txt", target / "THIRD_PARTY_NOTICES.txt")
    for name in ("README.md", "WORK_GOALS.md", "DEVELOPMENT_REPORT.md", "UPDATES.md"):
        shutil.copy2(root / "linux" / name, target / "linux" / name)


def build(output, node, commit=None, release=False):
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise ValueError("Build this package on Ubuntu x86_64")
    version = json.loads((ROOT / "linux/package.json").read_text())["version"]
    if commit is None:
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('A full source commit is required')
    node_version = subprocess.check_output([str(node), "-p", "process.versions.node"], text=True).strip()
    if int(node_version.split(".")[0]) < 22:
        raise ValueError("Build with the project's Node 22+ runtime")
    if node.read_bytes()[:4] != b"\x7fELF":
        raise ValueError("The packaged runtime must be a Linux ELF executable")
    output.mkdir(parents=True, exist_ok=True)
    package = output / (f"CMCP-{version}-linux-x64.deb" if release else f"cmcp_{version}~ubuntu1_amd64.deb")
    portable = output / f"CMCP-{version}-linux-x64.zip"
    if package.exists() or portable.exists():
        raise ValueError("Output package already exists; choose a fresh directory")
    with tempfile.TemporaryDirectory(prefix="cmcp-linux-") as temporary:
        stage = Path(temporary)
        target = stage / "opt/cmcp"
        copy_source(ROOT, target, node)
        for file in target.rglob("*"):
            if file.is_symlink():
                raise ValueError("Unexpected package symlink: " + str(file.relative_to(target)))
            if file.is_file():
                file.chmod(0o755 if file == target / "runtime/node" else 0o644)
        executable = stage / "usr/bin/cmcp"
        executable.parent.mkdir(parents=True)
        executable.write_text('#!/bin/sh\nexec /usr/bin/python3 -B /opt/cmcp/linux/launcher.py "$@"\n')
        executable.chmod(0o755)
        applications = stage / "usr/share/applications"
        applications.mkdir(parents=True)
        shutil.copy2(ROOT / "linux/cmcp.desktop", applications / "cmcp.desktop")
        icon = stage / "usr/share/icons/hicolor/scalable/apps"
        icon.mkdir(parents=True)
        shutil.copy2(ROOT / ICON, icon / "cmcp.svg")
        control = stage / "DEBIAN"
        control.mkdir()
        (control / "control").write_text(f"""Package: cmcp
Version: {version if release else version + '~ubuntu1'}
Architecture: amd64
Maintainer: CMCP developers
Section: devel
Priority: optional
Depends: python3 (>= 3.10), python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.0, gir1.2-dbusmenu-glib-0.4, libsecret-tools, gnome-keyring, openssh-client, xdg-utils, xdotool
Recommends: gnome-terminal, fonts-noto-cjk
Description: CMCP Ubuntu desktop client
 Connect cloud assistants to local Linux files and developer tools.
 Ubuntu 22.04 client with verified in-app updates and X11 desktop tools.
""")
        manifest = [{"path": file.relative_to(target).as_posix(), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()} for file in sorted(target.rglob("*")) if file.is_file()]
        (target / "distribution-manifest.json").write_text(json.dumps({"schema": 1, "version": version, "platform": "linux-x64", "sourceCommit": commit, "development": not release, "files": manifest}, indent=2))
        # A private builder umask must not make root-owned installed directories
        # unreadable by the ordinary desktop account.
        for directory in [stage, *(entry for entry in stage.rglob("*") if entry.is_dir())]:
            directory.chmod(0o755)
        (target / "distribution-manifest.json").chmod(0o644)
        with zipfile.ZipFile(portable, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, strict_timestamps=False) as archive:
            for file in sorted(target.rglob('*')):
                if file.is_file():
                    archive.write(file, 'CMCP/' + file.relative_to(target).as_posix())
        subprocess.run(["dpkg-deb", "--root-owner-group", "--build", str(stage), str(package)], check=True)
    for file in (package, portable):
        checksum = hashlib.sha256(file.read_bytes()).hexdigest()
        Path(str(file) + '.sha256').write_text(checksum + "  " + file.name + "\n")
        print(json.dumps({"package": str(file), "sha256": checksum, "development": not release}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "build-results/linux")
    parser.add_argument("--node", type=Path, default=Path(shutil.which("node") or "/usr/bin/node"))
    parser.add_argument('--commit')
    parser.add_argument('--release', action='store_true')
    args = parser.parse_args()
    build(args.output.resolve(), args.node.resolve(), args.commit, args.release)
