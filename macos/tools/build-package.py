"""Build a Mac-readable ZIP on Windows or POSIX, preserving Unix executable modes.

Run with Python 3.10+: python tools/build-package.py [output.zip]
Never put a ZIP output inside the source folder.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT.parent / (ROOT.name + "-v" + VERSION + ".zip")
if OUTPUT == ROOT or ROOT in OUTPUT.parents:
    raise ValueError("Write the output outside the source directory")

RUNTIMES = {
    "arm64": "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
    "x64": "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
}
def digest(data):
    return hashlib.sha256(data).hexdigest()

def omitted(relative):
    return any(p in ("__pycache__", ".bin", ".git", ".DS_Store") for p in relative.parts) or relative.suffix == ".pyc"

def files():
    result = []
    for p in sorted(ROOT.rglob("*")):
        relative = p.relative_to(ROOT)
        if omitted(relative):
            continue
        if p.is_symlink() or not (p.is_file() or p.is_dir()):
            raise ValueError("Refusing a symlink or special file: " + str(relative))
        if getattr(p.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("Refusing a Windows reparse point: " + str(relative))
        if p.is_file():
            result.append(p)
    return result

for arch, expected in RUNTIMES.items():
    filename = "node-v22.23.3-darwin-" + arch + ".tar.gz"
    p = ROOT / "runtime" / filename
    if digest(p.read_bytes()) != expected:
        raise ValueError("Node archive hash mismatch: " + filename)
    with tarfile.open(p, "r:gz") as tar:
        member = filename[:-7] + "/bin/node"
        header = tar.extractfile(member).read(12)
        cpu = 0x0100000C if arch == "arm64" else 0x01000007
        if header[:4] != bytes.fromhex("cffaedfe") or int.from_bytes(header[4:8], "little") != cpu:
            raise ValueError("Unexpected Mach-O architecture: " + arch)

entries = [p for p in files() if p.name != "SHA256SUMS"]
for p in entries:
    if p.parent == ROOT and p.suffix in (".mjs", ".py", ".jxa", ".sh", ".command", ".json", ".md"):
        raw = p.read_bytes()
        if raw.startswith(b"\xef\xbb\xbf") or b"\r" in raw:
            raise ValueError("Project text must be UTF-8 without BOM, with LF: " + p.name)
        raw.decode("utf-8")
    if p.parent == ROOT and (p.name in ("targets.json", "status.json", "machine-id", ".env") or p.suffix in (".log", ".pem", ".key")):
        raise ValueError("Local state or secret-like file in source folder: " + p.name)
    if p.suffix in (".node", ".exe", ".cmd", ".bat"):
        raise ValueError("Unexpected native/Windows dependency: " + str(p.relative_to(ROOT)))

manifest = {p.relative_to(ROOT).as_posix(): digest(p.read_bytes()) for p in entries}
(ROOT / "SHA256SUMS").write_text("".join(h + "  " + name + "\n" for name, h in sorted(manifest.items())), encoding="utf-8", newline="\n")
entries.append(ROOT / "SHA256SUMS")
directories = {ROOT}
for p in entries:
    directories.update(parent for parent in p.parents if parent == ROOT or ROOT in parent.parents)

def info_for(p, directory=False):
    relative = p.relative_to(ROOT).as_posix()
    name = ROOT.name + ("/" + relative if relative != "." else "") + ("/" if directory else "")
    info = zipfile.ZipInfo(name, time.localtime(p.stat().st_mtime)[:6])
    info.create_system = 3
    mode = 0o755 if directory or p.suffix in (".command", ".sh") else 0o644
    info.external_attr = ((stat.S_IFDIR if directory else stat.S_IFREG) | mode) << 16
    if directory:
        info.external_attr |= 0x10
    info.compress_type = zipfile.ZIP_STORED if directory or p.name.endswith(".tar.gz") else zipfile.ZIP_DEFLATED
    return info

temporary = OUTPUT.with_suffix(OUTPUT.suffix + ".building")
try:
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(directories):
            z.writestr(info_for(p, True), b"")
        for p in sorted(entries):
            z.writestr(info_for(p), p.read_bytes())
    with zipfile.ZipFile(temporary) as z:
        if z.testzip() is not None:
            raise ValueError("ZIP CRC failed")
        names = set()
        for item in z.infolist():
            parts = PurePosixPath(item.filename)
            if item.filename in names or parts.is_absolute() or ".." in parts.parts or "\\" in item.filename or ":" in item.filename:
                raise ValueError("Unsafe or duplicate archive path")
            names.add(item.filename)
            mode = item.external_attr >> 16
            if item.create_system != 3 or stat.S_ISLNK(mode):
                raise ValueError("Invalid Unix archive metadata")
            if item.is_dir():
                if mode & 0o777 != 0o755:
                    raise ValueError("Directory mode mismatch")
                continue
            relative = parts.relative_to(ROOT.name).as_posix()
            expected_mode = 0o755 if parts.suffix in (".command", ".sh") else 0o644
            if mode & 0o777 != expected_mode:
                raise ValueError("Executable mode mismatch")
            if z.read(item) != (ROOT / relative).read_bytes():
                raise ValueError("Archive content mismatch: " + relative)
            if relative != "SHA256SUMS" and digest(z.read(item)) != manifest[relative]:
                raise ValueError("Archive hash mismatch")
    temporary.replace(OUTPUT)
finally:
    if temporary.exists():
        temporary.unlink()
zip_hash = digest(OUTPUT.read_bytes())
OUTPUT.with_suffix(OUTPUT.suffix + ".sha256").write_text(zip_hash + "  " + OUTPUT.name + "\n", encoding="utf-8", newline="\n")
print(json.dumps({"archive": str(OUTPUT), "files": len(entries), "bytes": OUTPUT.stat().st_size,
                  "sha256": zip_hash, "checks": "CRC, file contents, SHA-256, paths, executable modes, both Mach-O runtimes passed"}, ensure_ascii=False))
