#!/usr/bin/env python3
"""Cloud computer side of the Mac MCP kit.

Claude starts `connector.py serve` over stdio. initialize and tools/list are answered
locally from a cache, so the MCP stays connected while the Mac is offline;
tool calls go through the WebDesktop link socket to the PC.

Python 3.9+, standard library only. Run as the same user who runs Claude.
"""
import argparse
import base64
import concurrent.futures
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
import threading
import time
import uuid

VERSION = "4.23.0"
MAX_MESSAGE = 8 * 1024 * 1024
MAX_RESPONSE = 40 * 1024 * 1024
LINK_DIR = Path.home() / ".local" / "share" / "cloudpc-link"
LINK_SOCKET = Path(os.environ.get("CLOUDPC_LINK_SOCKET") or LINK_DIR / "link.sock")
PROTOCOLS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
OFFLINE_TEXT = ("本地电脑未连接或已主动停止，本次请求尚未送达。请在 CMCP 中检查连接状态后重试。"
                " (The request was not delivered. Check the connection in CMCP.)")
UNCERTAIN_TEXT = ("操作已发送，但执行结果未确认；它可能仍在执行或已经完成。为避免重复执行，程序没有重发。"
                  "请先检查实际状态，再决定下一步。"
                  " (Outcome unknown. The operation may have completed; it was not replayed.)")
DEFAULT_INSTRUCTIONS = ("These tools operate on the user's physical Mac. Use absolute Mac paths such as "
                        "/Users/name/project. Bash and terminals built into this cloud computer run on Linux; use the "
                        "mac_* MCP tools for Mac work.")

TRANSFER_TOOLS = [{"name": name, "description": description,
    "inputSchema": {"type": "object", "properties": {
        "mac_path": {"type": "string"}, "cloud_path": {"type": "string"},
        "overwrite": {"type": "boolean", "default": False}},
        "required": ["mac_path", "cloud_path"], "additionalProperties": False}}
    for name, description in (
        ("mac_download_to_cloud", "Copy any binary file from Mac to an absolute path on this cloud computer (Linux). Streams 1 MiB chunks internally; returns size and SHA-256 without putting file bytes in chat."),
        ("mac_upload_from_cloud", "Copy any binary file from an absolute path on this cloud computer (Linux) to Mac. Supports MP4, audio, images, PDF, Office and archives. Validates SHA-256 before publishing."))]
TRANSFER_NAMES = {tool["name"] for tool in TRANSFER_TOOLS}

# Compact mode: third-party tools and Blender behind three tools, for clients that load every tool
# description up front (Claude Desktop, Claude Code behind a gateway without tool search).
META_TOOLS = [
    {"name": "cmcp_list_tools", "description": "List the local tools installed on the user's computer (third-party MCP servers and Blender), one line each. Filter with query.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "maxLength": 200}}, "additionalProperties": False}},
    {"name": "cmcp_describe_tool", "description": "Show what one local tool from cmcp_list_tools does and its input schema.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "maxLength": 128}}, "required": ["name"], "additionalProperties": False}},
    {"name": "cmcp_call_tool", "description": "Run one local tool from cmcp_list_tools with its arguments.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "maxLength": 128}, "arguments": {"type": "object"}}, "required": ["name"], "additionalProperties": False}},
]
META_NAMES = {tool["name"] for tool in META_TOOLS}


def compactable(tool):
    name = tool.get("name", "")
    return "__" in name or name.startswith("blender_")


def wants_compact(exposure, client, environ, custom_count):
    """Whether to put compactable tools behind META_TOOLS for this client (heuristic, see spec)."""
    if exposure in ("compact", "full"):
        return exposure == "compact"
    if not custom_count:
        return False
    name = str(client.get("name", "")).lower()
    if name != "claude-code":
        return True
    search = environ.get("ENABLE_TOOL_SEARCH", "").lower()
    if search == "false" or environ.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"):
        return custom_count > 30
    version = tuple(int(x) for x in re.findall(r"\d+", str(client.get("version", "")))[:3]) or (0,)
    if environ.get("ANTHROPIC_BASE_URL") and not search and version < (2, 1, 304):
        return custom_count > 30
    return False
# Built-in tools that must be present, by the group that can switch them off on the PC.
REQUIRED_TOOLS = {"read_text_file": "files", "write_file": "files", "list_allowed_directories": "files",
                  "mac_execute": "commands", "mac_run_program": "commands", "mac_start_process": "processes",
                  "mac_stop_process": "processes", "mac_toolchain_info": "toolchains", "mac_adb": "toolchains",
                  "mac_screenshot": "desktop", "mac_binary_info": "files", "mac_binary_begin": "files",
                  "mac_binary_write": "files", "mac_binary_finish": "files"}


class Offline(Exception):
    pass


class NotSent(Offline):
    """Proven failure before sendall; safe to wait and try delivery."""


class OutcomeUnknown(RuntimeError):
    pass


def read_json(file):
    value = json.loads(Path(file).read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object in " + str(file))
    return value


def safe_parents(directory):
    directory = Path(directory).absolute()
    for item in (directory, *directory.parents):
        if item.is_symlink():
            raise ValueError("Refusing a symlink directory: " + str(item))


CC_SHARED = os.environ.get("CLOUDPC_CC_SHARED") == "1"


def shared_directory(directory, create=False, allow_home=False):
    """CC user-data grant: terminal and GUI may share Claude/MCP data only."""
    import pwd
    import stat
    home = Path("/home/wdguest")
    directory = Path(directory)
    allowed = (home / ".config/Claude", home / ".local/share/cloudpc-link")
    if not (allow_home and directory == home) and not any(directory == root or root in directory.parents for root in allowed):
        raise ValueError("Outside shared Claude/MCP data")
    identities = [pwd.getpwnam(n) for n in ("wdguest", "wdterm", "wdgui")]
    group = identities[0].pw_gid
    if os.geteuid() not in {u.pw_uid for u in identities[1:]} or os.getegid() != group:
        raise ValueError("Restricted CC connector identity required")
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in directory.relative_to(home).parts:
            if create:
                try:
                    os.mkdir(name, 0o2770, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            meta = os.fstat(fd)
            if meta.st_uid not in {u.pw_uid for u in identities} or meta.st_gid != group or meta.st_mode & 0o5007 or meta.st_mode & 0o070 != 0o070:
                raise ValueError("Unsafe shared Claude/MCP directory")
            if meta.st_uid == os.geteuid() and not meta.st_mode & 0o2000:
                os.fchmod(fd, stat.S_IMODE(meta.st_mode) | 0o2000)
        return fd
    except BaseException:
        os.close(fd)
        raise


def shared_write(file, data):
    # Descriptor-relative operations cannot follow a substituted parent symlink.
    import stat
    import pwd
    # Claude CLI keeps its configuration directly in the home directory.
    directory = shared_directory(file.parent, create=True, allow_home=file.name.startswith(".claude.json"))
    temporary = ".mcp-tmp-" + uuid.uuid4().hex
    try:
        try:
            meta = os.stat(file.name, dir_fd=directory, follow_symlinks=False)
            owners = {pwd.getpwnam(n).pw_uid for n in ("wdguest", "wdterm", "wdgui")}
            if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_gid != os.getegid() or meta.st_uid not in owners:
                raise ValueError("Unsafe shared Claude/MCP file")
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), 0o660)
            os.fsync(stream.fileno())
        os.replace(temporary, file.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


def atomic_write(file, data, mode=0o600):
    file = Path(file)
    if CC_SHARED:
        return shared_write(file, data)
    safe_parents(file.parent)
    if file.is_symlink():
        raise ValueError("Refusing to replace a symlink: " + str(file))
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".mcp-tmp-", dir=str(file.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, file)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def encoded_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


class Link:
    """One request per connection to the WebDesktop link socket (same Linux user only)."""

    def __init__(self, path=LINK_SOCKET, recovery_wait=30, poll=0.5):
        self.path = str(path)
        self.recovery_wait = recovery_wait
        self.poll = poll
        # Set by the server: shows a tool's question (elicitation) to Claude and returns the answer.
        self.on_ask = None

    def manually_stopped(self):
        try:
            marker = Path(self.path).parent / 'manual-stop.json'
            if marker.stat().st_size > 1024:
                return False
            data = json.loads(marker.read_text(encoding='utf-8'))
            return data.get('schema') == 1 and data.get('stopped') is True
        except (OSError, ValueError, AttributeError):
            return False

    def _exchange(self, request, timeout):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            try:
                sock.connect(self.path)
            except (FileNotFoundError, ConnectionRefusedError):
                raise NotSent("云电脑的连接服务未运行") from None
            try:
                sock.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
                buffer = b""
                raw = b""
                while not raw:
                    data = sock.recv(1048576)
                    if not data:
                        break
                    buffer += data
                    if len(buffer) > MAX_RESPONSE:
                        raise OutcomeUnknown(UNCERTAIN_TEXT)
                    while b"\n" in buffer and not raw:
                        line, buffer = buffer.split(b"\n", 1)
                        # A tool may ask the user something before the call ends; the reply
                        # follows on this socket once the answer has been sent back.
                        if line.startswith(b'{"ask"') and self.on_ask:
                            self._answer_ask(line, timeout)
                        else:
                            raw = line
            except OSError:
                raise OutcomeUnknown(UNCERTAIN_TEXT) from None
        finally:
            sock.close()
        if not raw:
            raise OutcomeUnknown(UNCERTAIN_TEXT)
        try:
            result = json.loads(raw.decode("utf-8"))
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeError):
            raise OutcomeUnknown(UNCERTAIN_TEXT) from None

    def _answer_ask(self, line, timeout):
        try:
            ask = json.loads(line.decode("utf-8"))["ask"]
            ask_id = ask["id"]
        except (ValueError, KeyError, TypeError, UnicodeError):
            return
        try:
            answer = self.on_ask(ask.get("msg") or {})
        except Exception as error:
            answer = {"error": str(error)}
        request = {"id": 1, "op": "answer", "ask": ask_id}
        request.update(answer if isinstance(answer, dict) else {"error": "No answer"})
        with contextlib.suppress(Offline, OutcomeUnknown, OSError):
            self._exchange(request, 10)

    def status(self):
        try:
            return self._exchange({"id": 1, "op": "status"}, 5)
        except (Offline, OutcomeUnknown, OSError):
            return {"ok": True, "connected": False, "pc": None}

    def request(self, message, wait=30):
        data = json.dumps(message, ensure_ascii=False).encode("utf-8")
        if len(data) > MAX_MESSAGE:
            raise ValueError("MCP request exceeds the 8 MiB limit")
        request_id = uuid.uuid4().hex
        budget = max(0, min(wait, self.recovery_wait))
        gap_deadline = time.monotonic() + budget
        overall_deadline = time.monotonic() + 200 + budget
        querying = False
        while True:
            if self.manually_stopped():
                if querying:
                    raise OutcomeUnknown(UNCERTAIN_TEXT)
                raise Offline(OFFLINE_TEXT)
            request = {'id': 1, 'op': 'result' if querying else 'call', 'request_id': request_id}
            if not querying:
                request.update(msg=message, wait=int(wait * 1000))
                if self.on_ask:
                    request['asks'] = True
            try:
                timeout = min(5, max(0.1, gap_deadline - time.monotonic())) if querying else min(200, max(1, overall_deadline - time.monotonic()))
                reply = self._exchange(request, timeout)
            except NotSent:
                if time.monotonic() >= gap_deadline:
                    if querying:
                        raise OutcomeUnknown(UNCERTAIN_TEXT)
                    raise Offline(OFFLINE_TEXT)
                time.sleep(min(self.poll, max(0, gap_deadline - time.monotonic())))
                continue
            except OutcomeUnknown:
                # The send may have succeeded: query only, never submit again.
                if not querying:
                    gap_deadline = min(overall_deadline, time.monotonic() + budget)
                querying = True
                if time.monotonic() >= gap_deadline:
                    raise OutcomeUnknown(UNCERTAIN_TEXT)
                time.sleep(min(self.poll, max(0, gap_deadline - time.monotonic())))
                continue
            recovery = reply.get('recovery') or {}
            phase = recovery.get('state') if recovery.get('protocol') == 1 else None
            if phase in ('missing', 'unavailable', 'conflict', 'invalid'):
                raise OutcomeUnknown(UNCERTAIN_TEXT)
            if phase == 'running':
                querying = True
                if time.monotonic() >= overall_deadline:
                    raise OutcomeUnknown(UNCERTAIN_TEXT)
                gap_deadline = min(overall_deadline, time.monotonic() + budget)
                time.sleep(self.poll)
                continue
            if (reply.get('code') == 'offline' and reply.get('delivery') == 'not_sent') or phase == 'not_sent':
                if time.monotonic() >= gap_deadline:
                    if querying:
                        raise OutcomeUnknown(UNCERTAIN_TEXT)
                    raise Offline(OFFLINE_TEXT)
                time.sleep(min(self.poll, max(0, gap_deadline - time.monotonic())))
                continue
            if not reply.get('ok'):
                if reply.get('code') in ('disconnected', 'timeout'):
                    if not querying:
                        gap_deadline = min(overall_deadline, time.monotonic() + budget)
                    querying = True
                    if time.monotonic() >= gap_deadline:
                        raise OutcomeUnknown(UNCERTAIN_TEXT)
                    time.sleep(min(self.poll, max(0, gap_deadline - time.monotonic())))
                    continue
                if reply.get('code') in ('offline', 'unsupported') or querying:
                    # Legacy offline does not prove whether execution started.
                    raise OutcomeUnknown(UNCERTAIN_TEXT)
                raise RuntimeError(reply.get('error') or '本地电脑返回了错误')
            if querying and phase != 'done':
                raise OutcomeUnknown(UNCERTAIN_TEXT)
            break
        result = reply.get("msg")
        if "id" not in message:
            return None
        if not isinstance(result, dict) or result.get("jsonrpc") != "2.0" or result.get("id") != message["id"]:
            raise ValueError("The Windows PC returned an invalid JSON-RPC response")
        return result

    def call_tool(self, tool, arguments):
        reply = self.request({"jsonrpc": "2.0", "id": uuid.uuid4().hex,
            "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
        if "error" in reply:
            raise RuntimeError(str(reply["error"]))
        result = reply["result"]
        if result.get("isError"):
            raise RuntimeError(result["content"][0]["text"])
        return result.get("structuredContent") or json.loads(result["content"][0]["text"])

    def fetch_catalog(self, wait=20):
        """initialize + tools/list on the PC; returns {instructions, tools}."""
        first = self.request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "cloudpc-connector", "version": VERSION}}}, wait)
        if "error" in first:
            raise ValueError("MCP initialization failed on the Mac")
        second = self.request({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, wait)
        tools = second.get("result", {}).get("tools", [])
        for tool in tools:
            for field in ("inputSchema", "outputSchema"):
                schema = tool.get(field)
                if schema is None:
                    continue
                dialect = schema.get("$schema", "https://json-schema.org/draft/2020-12/schema")
                if dialect.rstrip("#") != "https://json-schema.org/draft/2020-12/schema":
                    raise ValueError("Incompatible tool schema for %s.%s: %s" % (tool["name"], field, dialect))
        names = {tool["name"] for tool in tools}
        meta = (second.get("result", {}).get("_meta") or {}).get("cmcp/catalog")
        required = set(REQUIRED_TOOLS)
        if isinstance(meta, dict) and meta.get("schema") == 1 and isinstance(meta.get("groups"), list):
            # A PC with switchable tool groups: only the groups switched on must be complete.
            required = {name for name, group in REQUIRED_TOOLS.items() if group in meta["groups"]}
        if not required.issubset(names):
            raise ValueError("The Mac runs an old tool version; missing: " + ", ".join(sorted(required - names)))
        catalog = {"instructions": first.get("result", {}).get("instructions") or DEFAULT_INSTRUCTIONS, "tools": tools}
        if isinstance(meta, dict) and isinstance(meta.get("revision"), str):
            catalog["revision"] = meta["revision"][:128]
        if isinstance(meta, dict) and meta.get("exposure") in ("auto", "full", "compact"):
            catalog["exposure"] = meta["exposure"]
        # Resources and prompts of the PC's local tools, when there are any.
        for kind in ("resources", "prompts"):
            if isinstance(meta, dict) and isinstance(meta.get(kind), int) and meta[kind] > 0:
                listed = self.request({"jsonrpc": "2.0", "id": 3, "method": kind + "/list", "params": {}}, wait)
                items = listed.get("result", {}).get(kind)
                if isinstance(items, list):
                    catalog[kind] = items
        return catalog


def transfer_file(link, name, args):
    if name not in TRANSFER_NAMES or not isinstance(args, dict) or set(args) - {"mac_path", "cloud_path", "overwrite"}:
        raise ValueError("Invalid transfer arguments")
    if not all(isinstance(args.get(k), str) and args[k] and "\0" not in args[k] for k in ("mac_path", "cloud_path")):
        raise ValueError("Both paths must be nonempty strings")
    if "overwrite" in args and not isinstance(args["overwrite"], bool):
        raise ValueError("overwrite must be a boolean")
    local = Path(args["cloud_path"])
    if not local.is_absolute():
        raise ValueError("cloud_path must be absolute")
    if local.is_symlink():
        raise ValueError("cloud_path cannot be a symlink")
    overwrite = args.get("overwrite", False)
    call = link.call_tool
    if name == "mac_download_to_cloud":
        if local.exists() and not overwrite:
            raise ValueError("Destination exists; set overwrite=true")
        info = call("mac_binary_info", {"path": args["mac_path"]})
        fd, temporary = tempfile.mkstemp(prefix=".mcp-download-", dir=str(local.parent))
        try:
            digest = hashlib.sha256()
            offset = 0
            with os.fdopen(fd, "wb") as stream:
                while offset < info["size"]:
                    chunk = call("mac_binary_read", {"path": args["mac_path"], "offset": offset})
                    data = base64.b64decode(chunk["data"], validate=True)
                    if not data or len(data) != chunk["bytes"]:
                        raise ValueError("Incomplete download")
                    stream.write(data)
                    digest.update(data)
                    offset += len(data)
            if offset != info["size"] or digest.hexdigest() != info["sha256"]:
                raise ValueError("Download SHA-256 mismatch")
            if overwrite:
                os.replace(temporary, local)
            else:
                os.link(temporary, local)
                os.unlink(temporary)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)
    else:
        if not local.is_file():
            raise ValueError("cloud_path must be a regular file")
        digest = hashlib.sha256()
        with local.open("rb") as stream:
            for data in iter(lambda: stream.read(1048576), b""):
                digest.update(data)
        info = {"size": local.stat().st_size, "sha256": digest.hexdigest()}
        upload = call("mac_binary_begin", {"path": args["mac_path"], **info, "overwrite": overwrite})
        try:
            offset = 0
            with local.open("rb") as stream:
                for data in iter(lambda: stream.read(1048576), b""):
                    call("mac_binary_write", {"upload_id": upload["upload_id"], "offset": offset,
                        "data": base64.b64encode(data).decode("ascii")})
                    offset += len(data)
            call("mac_binary_finish", {"upload_id": upload["upload_id"]})
        except Exception:
            with contextlib.suppress(Exception):
                call("mac_binary_finish", {"upload_id": upload["upload_id"], "cancel": True})
            raise
    return {"mac_path": args["mac_path"], "cloud_path": str(local), **info}


def report_client(client_name):
    """Tell the relay this Claude client is running. A failure here never affects requests."""
    kind = "cli" if "code" in str(client_name).lower() else "desktop"
    file = LINK_SOCKET.parent / "clients" / (kind + "-" + uuid.uuid4().hex)

    def beat():
        while True:
            with contextlib.suppress(Exception):
                if file.exists():
                    os.utime(file)
                else:
                    atomic_write(file, b"{}\n")
            time.sleep(10)

    threading.Thread(target=beat, daemon=True).start()


def run_server(private):
    link = Link()
    cache_file = private / "tools-cache.json"
    try:
        catalog = read_json(cache_file)
    except (OSError, ValueError):
        catalog = {"instructions": DEFAULT_INSTRUCTIONS, "tools": []}
    state = {"catalog": catalog, "initialized": False, "refreshing": False, "again": False, "can_ask": False, "can_sample": False}
    questions = {}
    questions_lock = threading.Lock()

    def ask_client(msg):
        # A local tool's question (MCP elicitation) shown by Claude; only when Claude said it can.
        method = msg.get("method")
        if method not in ("elicitation/create", "sampling/createMessage") or not isinstance(msg.get("params"), dict):
            return {"error": "Only questions (elicitation) and sampling can be passed on"}
        if method == "sampling/createMessage" and not state["can_sample"]:
            return {"error": "This Claude client does not take sampling requests"}
        if method == "elicitation/create" and not state["can_ask"]:
            return {"result": {"action": "decline"}}
        ask_id = "cmcp-ask-" + uuid.uuid4().hex
        waiting = {"event": threading.Event(), "reply": None}
        with questions_lock:
            questions[ask_id] = waiting
        try:
            output({"jsonrpc": "2.0", "id": ask_id, "method": method, "params": msg["params"]})
            if not waiting["event"].wait(600):
                return {"result": {"action": "cancel"}} if method == "elicitation/create" else {"error": "No answer within 10 minutes"}
            reply = waiting["reply"]
            if isinstance(reply.get("result"), dict):
                return {"result": reply["result"]}
            return {"error": str((reply.get("error") or {}).get("message") or "Claude could not show the question")}
        finally:
            with questions_lock:
                questions.pop(ask_id, None)

    link.on_ask = ask_client
    output_lock = threading.Lock()
    state_lock = threading.Lock()
    slots = threading.BoundedSemaphore(8)

    def output(value):
        if value is not None:
            with output_lock:
                sys.stdout.write(json.dumps(value, ensure_ascii=True) + "\n")
                sys.stdout.flush()

    def all_tools():
        tools = state["catalog"]["tools"]
        # File transfers run on the PC's binary tools, which go away with the files group.
        if any(tool.get("name") == "mac_binary_info" for tool in tools):
            return tools + TRANSFER_TOOLS
        return tools

    def compact():
        hidden = [tool for tool in state["catalog"]["tools"] if compactable(tool)]
        return wants_compact(state["catalog"].get("exposure", "auto"), state.get("client") or {}, os.environ, len(hidden))

    def tool_list():
        tools = all_tools()
        if not compact():
            return tools
        return [tool for tool in tools if not compactable(tool)] + META_TOOLS

    def meta_call(name, arguments, mid):
        hidden = [tool for tool in state["catalog"]["tools"] if compactable(tool)]
        if name == "cmcp_list_tools":
            query = str(arguments.get("query") or "").lower()
            rows = [tool["name"] + " - " + str(tool.get("description", "")).split(". ")[0][:160] for tool in hidden
                    if not query or query in (tool["name"] + " " + str(tool.get("description", ""))).lower()]
            text = "\n".join(rows[:100]) + ("\n(%d more; use query)" % (len(rows) - 100) if len(rows) > 100 else "")
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text or "No local tools match."}]}}
        target = next((tool for tool in hidden if tool["name"] == arguments.get("name")), None)
        if target is None:
            close = sorted(hidden, key=lambda tool: -len(set(tool["name"]) & set(str(arguments.get("name")))))[:3]
            hint = ("Unknown local tool. Similar: " + ", ".join(tool["name"] for tool in close)) if close else "Unknown local tool."
            return {"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": hint}]}}
        if name == "cmcp_describe_tool":
            text = json.dumps({"name": target["name"], "description": target.get("description", ""), "inputSchema": target.get("inputSchema", {})}, ensure_ascii=False)
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}}
        inner = arguments.get("arguments") or {}
        if not isinstance(inner, dict):
            return {"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": "arguments must be an object"}]}}
        return link.request({"jsonrpc": "2.0", "id": mid, "method": "tools/call", "params": {"name": target["name"], "arguments": inner}})

    def refresh():
        # Keep the cached list current; tell Claude when the PC's tools changed. A change
        # announced while a refresh runs makes it run once more.
        with state_lock:
            if state["refreshing"]:
                state["again"] = True
                return
            state["refreshing"] = True
        try:
            while True:
                state["again"] = False
                try:
                    fresh = link.fetch_catalog(wait=0)
                    if fresh != state["catalog"]:
                        # What Claude sees may change with the list or with the exposure setting.
                        before = tool_list()
                        old = state["catalog"]
                        state["catalog"] = fresh
                        changed = tool_list() != before
                        for kind in ("resources", "prompts"):
                            if fresh.get(kind, []) != old.get(kind, []) and state["initialized"]:
                                output({"jsonrpc": "2.0", "method": "notifications/" + kind + "/list_changed"})
                        atomic_write(cache_file, encoded_json(fresh))
                        if changed and state["initialized"]:
                            output({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
                except Exception:
                    pass
                if not state["again"]:
                    break
        finally:
            state["refreshing"] = False

    def watch():
        # The relay announces each change of the PC's tool catalog. An older relay does not
        # know this request; the list then refreshes only when Claude connects or lists tools.
        pause = 1
        while True:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.settimeout(60)
                sock.connect(str(LINK_SOCKET))
                sock.sendall((json.dumps({"id": 1, "op": "watch", "since": state["catalog"].get("revision")}) + "\n").encode())
                stream = sock.makefile("rb")
                first = json.loads(stream.readline(4096) or b"null")
                if not isinstance(first, dict) or (not first.get("ok") and first.get("code") != "busy"):
                    # The legacy WebDesktop link has no watch: CMCP writes the revision into a file
                    # next to its socket instead, and a local check of that file replaces the event.
                    return watch_file()
                if first.get("ok"):
                    pause = 1
                    while True:
                        raw = stream.readline(4096)
                        if not raw:
                            break
                        event = json.loads(raw)
                        if isinstance(event, dict) and event.get("event") == "catalog" and event.get("revision") != state["catalog"].get("revision"):
                            threading.Thread(target=refresh, daemon=True).start()
            except (OSError, ValueError):
                pass
            finally:
                sock.close()
            time.sleep(pause)
            pause = min(pause * 2, 30)

    def watch_file():
        marker = LINK_SOCKET.parent / "catalog-revision"
        seen = None
        while True:
            try:
                stamp = marker.stat()
                current = (stamp.st_mtime_ns, stamp.st_size)
                if seen is not None and current != seen:
                    revision = marker.read_text(encoding="utf-8").strip()[:128]
                    if revision and revision != state["catalog"].get("revision"):
                        threading.Thread(target=refresh, daemon=True).start()
                seen = current
            except (OSError, ValueError):
                seen = seen or (0, 0)
            time.sleep(2)

    def process(message):
        method = message["method"]
        mid = message.get("id")
        if method == "initialize":
            capabilities = message.get("params", {}).get("capabilities") or {}
            client = message.get("params", {}).get("clientInfo")
            state["client"] = client if isinstance(client, dict) else {}
            state["can_ask"] = isinstance(capabilities, dict) and isinstance(capabilities.get("elicitation"), dict)
            state["can_sample"] = isinstance(capabilities, dict) and isinstance(capabilities.get("sampling"), dict)
            asked = str(message.get("params", {}).get("protocolVersion", ""))
            output({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": asked if asked in PROTOCOLS else "2025-03-26",
                "capabilities": {"tools": {"listChanged": True}, "resources": {"listChanged": True}, "prompts": {"listChanged": True}},
                "serverInfo": {"name": "mac-pc-files", "version": VERSION},
                "instructions": state["catalog"].get("instructions") or DEFAULT_INSTRUCTIONS}})
            threading.Thread(target=refresh, daemon=True).start()
            if not state.get("watching"):
                state["watching"] = True
                threading.Thread(target=watch, daemon=True).start()
            if not state.get("reported"):
                state["reported"] = True
                with contextlib.suppress(Exception):
                    report_client(message.get("params", {}).get("clientInfo", {}).get("name", ""))
            return
        if method == "notifications/initialized":
            state["initialized"] = True
            return
        if method.startswith("notifications/"):
            return
        if method == "ping":
            output({"jsonrpc": "2.0", "id": mid, "result": {}})
            return
        if method == "tools/list":
            output({"jsonrpc": "2.0", "id": mid, "result": {"tools": tool_list()}})
            threading.Thread(target=refresh, daemon=True).start()
            return
        if method in ("resources/list", "prompts/list"):
            kind = method.split("/")[0]
            output({"jsonrpc": "2.0", "id": mid, "result": {kind: state["catalog"].get(kind, [])}})
            return
        if method == "resources/templates/list":
            output({"jsonrpc": "2.0", "id": mid, "result": {"resourceTemplates": []}})
            return
        if method in ("resources/read", "prompts/get"):
            try:
                output(link.request(message))
            except Offline:
                output({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": OFFLINE_TEXT}})
            except Exception as error:
                output({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": str(error)}})
            return
        if method != "tools/call":
            output({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found: " + method}})
            return
        name = message.get("params", {}).get("name")
        try:
            if name in META_NAMES and compact():
                output(meta_call(name, message.get("params", {}).get("arguments") or {}, mid))
            elif name in TRANSFER_NAMES:
                result = transfer_file(link, name, message["params"].get("arguments", {}))
                output({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": result}})
            else:
                output(link.request(message))
        except Offline:
            output({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": OFFLINE_TEXT}]}})
        except Exception as error:
            output({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": str(error)}]}})

    def scheduled(message):
        try:
            process(message)
        except Exception as error:
            if "id" in message:
                output({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(error)}})
        finally:
            slots.release()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        while True:
            raw = sys.stdin.buffer.readline(MAX_MESSAGE + 2)
            if not raw:
                break
            if len(raw) > MAX_MESSAGE:
                raise ValueError("MCP input line exceeds the 8 MiB limit")
            if not raw.strip():
                continue
            try:
                message = json.loads(raw)
            except (ValueError, UnicodeError):
                output({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON"}})
                continue
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
                if isinstance(message, dict) and ("result" in message or "error" in message):
                    # Claude's answer to a tool's question; anything else is ignored.
                    with questions_lock:
                        waiting = questions.get(message.get("id"))
                    if waiting:
                        waiting["reply"] = message
                        waiting["event"].set()
                    continue
                output({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid JSON-RPC request"}})
                continue
            if message["method"] in ("initialize", "ping") or message["method"].startswith("notifications/"):
                process(message)
            else:
                slots.acquire()
                executor.submit(scheduled, message)


def paths_for(args):
    home = Path(args.home).expanduser().resolve() if args.home else Path.home()
    private = home / ".local" / "share" / "cloudpc-link" / args.name
    desktop_default = (home / "Library/Application Support/Claude/claude_desktop_config.json"
                       if sys.platform == "darwin" else home / ".config/Claude/claude_desktop_config.json")
    targets = []
    if args.client in ("both", "desktop"):
        targets.append(Path(args.desktop_config).expanduser().resolve() if args.desktop_config else desktop_default)
    if args.client in ("both", "code"):
        if os.environ.get("CLAUDE_CONFIG_DIR") and not args.code_config and not args.home:
            raise ValueError("CLAUDE_CONFIG_DIR is set; pass --code-config with the actual .claude.json path")
        targets.append(Path(args.code_config).expanduser().resolve() if args.code_config else home / ".claude.json")
    return private, targets


def wait_connected(link, seconds):
    deadline = time.time() + seconds
    while True:
        status = link.status()
        if status.get("connected"):
            return status
        if time.time() >= deadline:
            raise ValueError("本地电脑没有连上云电脑（等待 %d 秒）" % seconds)
        time.sleep(1)


class ConfigRace(Exception):
    pass


def install(args):
    private, targets = paths_for(args)
    link = Link()
    print("Checking the Mac link...", flush=True)
    wait_connected(link, args.wait)
    catalog = link.fetch_catalog()
    print("Connected: %d Mac tools" % (len(catalog["tools"]) + len(TRANSFER_TOOLS)), flush=True)
    # A running Claude Code rewrites ~/.claude.json from time to time; retry when it changes under us.
    for attempt in range(5):
        try:
            changed, updated = apply_install(private, targets, catalog, args.name)
            break
        except ConfigRace as race:
            if attempt == 4:
                raise ValueError("Claude 的配置文件一直在被修改，请稍后重试（%s）" % race) from None
            time.sleep(1)
    print("Installed MCP: " + args.name + " " + VERSION)
    for target in targets:
        print("Config: " + str(target))
    # The Mac start window reads these lines to decide whether Claude must be restarted.
    print("Config changed: %d" % changed)
    print("Connector updated: " + ("yes" if updated else "no"), flush=True)


def apply_install(private, targets, catalog, name):
    """Write the connector and point every Claude config at it. Returns (configs changed, connector updated)."""
    # Parse every target before changing any configuration.
    documents = {}
    originals = {}
    for target in targets:
        if target.is_symlink():
            raise ValueError("Config is a symlink; pass its real file path explicitly: " + str(target))
        originals[target] = target.read_bytes() if target.exists() else None
        document = read_json(target) if target.exists() else {}
        if not isinstance(document.get("mcpServers", {}), dict):
            raise ValueError("mcpServers must be an object in " + str(target))
        documents[target] = document

    safe_parents(private)
    if CC_SHARED:
        desktop = Path("/home/wdguest/.config/Claude/claude_desktop_config.json")
        if targets not in ([desktop], [desktop, Path("/home/wdguest/.claude.json")]):
            raise ValueError("CC shared install requires the fixed Claude configs")
        fd = shared_directory(private, create=True)
        os.close(fd)
    else:
        private.mkdir(parents=True, exist_ok=True)
        os.chmod(private.parent, 0o700)
        os.chmod(private, 0o700)
    lock_dir = private / ".install-lock"
    try:
        lock_dir.mkdir()
    except FileExistsError:
        raise ValueError("An installer is already running; if it crashed, remove the empty lock directory: " + str(lock_dir)) from None
    try:
        connector = private / "connector.py"
        code = Path(__file__).read_bytes()
        updated = (connector.read_bytes() if connector.exists() else None) != code
        entry = {"command": str(Path(sys.executable).resolve()),
                 "args": ["-u", str(connector), "serve", "--name", name, "--home", str(private.parents[3])]}
        if os.environ.get("CLOUDPC_LINK_SOCKET"):
            entry["env"] = {"CLOUDPC_LINK_SOCKET": str(LINK_SOCKET)}
        if CC_SHARED:
            entry["env"] = {"CLOUDPC_CC_SHARED": "1", "CLOUDPC_LINK_SOCKET": str(LINK_SOCKET)}
        manifest_file = private / "manifest.json"
        previous_manifest = read_json(manifest_file) if manifest_file.exists() else {}
        known_targets = sorted(set(previous_manifest.get("targets", []) + [str(p) for p in targets]))
        writes = {connector: code,
                  private / "tools-cache.json": encoded_json(catalog),
                  private / "server-entry.json": encoded_json(entry),
                  manifest_file: encoded_json({"version": VERSION, "name": name, "targets": known_targets})}
        changed = 0
        for target, document in documents.items():
            current = target.read_bytes() if target.exists() else None
            if current != originals[target]:
                raise ConfigRace(str(target))
            if document.get("mcpServers", {}).get(name) == entry:
                continue
            if originals[target] is not None:
                stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
                backup = target.with_name(target.name + ".mcp-backup-" + stamp)
                atomic_write(backup, originals[target])
                print("Backup: " + str(backup))
            document.setdefault("mcpServers", {})[name] = entry
            writes[target] = encoded_json(document)
            changed += 1
        rollback = []
        try:
            for target, data in writes.items():
                if target in originals and (target.read_bytes() if target.exists() else None) != originals[target]:
                    raise ConfigRace(str(target))
                before = target.read_bytes() if target.exists() else None
                if before == data:
                    continue
                rollback.append((target, before))
                atomic_write(target, data)
        except Exception:
            for target, before in reversed(rollback):
                if before is None:
                    with contextlib.suppress(FileNotFoundError):
                        target.unlink()
                else:
                    atomic_write(target, before)
            raise
        # Mac edition preserves another kit's legacy files.
        return changed, updated
    finally:
        with contextlib.suppress(OSError):
            lock_dir.rmdir()


def remove_legacy(private, name):
    # Files of the earlier version (they held the old connection key).
    legacy_root = private.parent.parent / "claude-pc-mcp"
    legacy = legacy_root / name
    for filename in ("connection.json", "proxy.py", "server-entry.json", "manifest.json"):
        with contextlib.suppress(FileNotFoundError):
            (legacy / filename).unlink()
    for compiled in (legacy / "__pycache__").glob("proxy.*.pyc"):
        with contextlib.suppress(OSError):
            compiled.unlink()
    for directory in (legacy / "__pycache__", legacy, legacy_root):
        with contextlib.suppress(OSError):
            directory.rmdir()


def uninstall(args):
    private, _ = paths_for(args)
    manifest_file = private / "manifest.json"
    if not manifest_file.exists():
        print("Nothing to remove for " + args.name)
        return
    manifest = read_json(manifest_file)
    expected = read_json(private / "server-entry.json")
    for filename in manifest["targets"]:
        target = Path(filename)
        if not target.exists():
            continue
        if target.is_symlink():
            raise ValueError("Refusing to replace a symlink: " + str(target))
        document = read_json(target)
        servers = document.get("mcpServers", {})
        if servers.get(args.name) == expected:
            del servers[args.name]
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
            atomic_write(target.with_name(target.name + ".mcp-uninstall-backup-" + stamp), target.read_bytes())
            atomic_write(target, encoded_json(document))
    for filename in ("connector.py", "tools-cache.json", "server-entry.json", "manifest.json"):
        with contextlib.suppress(FileNotFoundError):
            (private / filename).unlink()
    with contextlib.suppress(OSError):
        private.rmdir()
    # Other kit files are preserved.
    print("Removed " + args.name + ".")


def main():
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9 or newer is required")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="install", choices=("install", "check", "uninstall", "serve", "status"))
    parser.add_argument("--client", choices=("both", "desktop", "code"), default="both")
    parser.add_argument("--name", default="mac-pc-files")
    parser.add_argument("--wait", type=int, default=30, help="Seconds to wait for the PC link during install/check")
    parser.add_argument("--desktop-config")
    parser.add_argument("--code-config")
    parser.add_argument("--home", help="Alternate user home (also useful for isolated tests)")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", args.name):
        raise ValueError("MCP name must contain 1-64 letters, numbers, underscores, or hyphens")
    if args.action == "serve":
        run_server(paths_for(args)[0])
    elif args.action == "uninstall":
        uninstall(args)
    elif args.action == "status":
        print(json.dumps(Link().status(), ensure_ascii=False))
    elif args.action == "check":
        link = Link()
        wait_connected(link, args.wait)
        print("Connected: %d Mac tools" % (len(link.fetch_catalog()["tools"]) + len(TRANSFER_TOOLS)))
    else:
        install(args)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print("ERROR: " + str(error), file=sys.stderr)
        sys.exit(1)
