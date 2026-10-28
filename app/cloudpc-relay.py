#!/usr/bin/env python3
"""Authenticated WebDesktop terminal -> Windows MCP relay for older desktops.

No listener on TCP and no external dependencies. The terminal's existing login
checks protect its lifetime; only the current Linux user can use link.sock.
"""
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import socketserver
import stat
import sys
import termios
import threading
import time
import tty
import uuid

PREFIX = b"CPCMCP1:"
MAX_REQUEST = 8 * 1024 * 1024
MAX_RESPONSE = 40 * 1024 * 1024
LINK_DIR = Path.home() / ".local" / "share" / "cloudpc-link"
CC_SHARED = os.environ.get('CLOUDPC_CC_SHARED') == '1'


def directory_mode(directory):
    if not CC_SHARED:
        os.chmod(directory,0o700)
        return
    import pwd
    if Path(directory)!=Path('/home/wdguest/.local/share/cloudpc-link') or os.geteuid()!=pwd.getpwnam('wdterm').pw_uid or os.getegid()!=pwd.getpwnam('wdguest').pw_gid:
        raise RuntimeError('Restricted CC relay identity required')
    current=Path(directory)
    while str(current).startswith('/home/wdguest'):
        meta=current.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in (os.geteuid(),pwd.getpwnam('wdguest').pw_uid) or meta.st_gid!=os.getegid() or meta.st_mode&0o5007 or meta.st_mode&0o070!=0o070:
            raise RuntimeError('Unsafe CC relay directory')
        current=current.parent


class Relay:
    def __init__(self, directory=LINK_DIR):
        self.directory = Path(directory)
        self.path = self.directory / "link.sock"
        self.stop = threading.Event()
        self.output_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending = {}
        self.pc = None
        self.parts = []
        self.part_id = None
        self.part_size = 0
        self.server = None
        self.lock = None
        self.socket_inode = None
        self.recovery = None
        self.stop_marker = self.directory / 'manual-stop.json'

    def emit(self, message):
        data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self.output_lock:
            sys.stdout.buffer.write(PREFIX + base64.b64encode(data) + b"\n")
            sys.stdout.buffer.flush()

    def replace_existing(self, machine):
        with socket.socket(socket.AF_UNIX) as probe:
            probe.settimeout(2)
            probe.connect(str(self.path))
            probe.sendall((json.dumps({"id": 1, "op": "replace", "machine": machine}) + "\n").encode())
            reply = json.loads(probe.recv(4096))
            if not reply.get("ok"):
                raise RuntimeError("云电脑已有直连服务，请重新连接")

    def start(self, hello):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory_mode(self.directory)
        fd=os.open(self.directory/'terminal-relay.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o660 if CC_SHARED else 0o600)
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid():os.close(fd);raise RuntimeError('Unsafe relay lock')
        self.lock=os.fdopen(fd,'a+')
        os.fchmod(self.lock.fileno(),0o660 if CC_SHARED else 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.replace_existing(str(hello.get("machine", "")))
            for attempt in range(40):
                try:
                    fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("旧的兼容连接未能结束，请稍后重试")
        if self.path.exists() or self.path.is_symlink():
            if self.path.is_symlink() or not stat.S_ISSOCK(self.path.stat().st_mode):
                raise RuntimeError("云电脑的连接套接字异常")
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(2)
                try:
                    probe.connect(str(self.path))
                except (FileNotFoundError, ConnectionRefusedError):
                    self.path.unlink(missing_ok=True)
                else:
                    raise RuntimeError("云电脑已有连接服务，请重新连接")
        self.pc = {key: str(hello.get(key, ""))[:100] for key in ("machine", "name", "version")}
        self.pc["since"] = int(time.time() * 1000)
        if isinstance(hello.get('recovery'), dict) and hello['recovery'].get('protocol') == 1:
            self.recovery = hello['recovery']
        with contextlib.suppress(FileNotFoundError):
            self.stop_marker.unlink()
        relay = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                try:
                    self.connection.settimeout(65)
                    raw = self.rfile.readline(MAX_REQUEST + 2048)
                    if not raw.endswith(b"\n"):
                        raise ValueError("MCP request exceeds the 8 MiB limit")
                    request = json.loads(raw)
                    reply = relay.exchange(request)
                    self.wfile.write((json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8"))
                except (OSError, ValueError):
                    pass

        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True

        self.server = Server(str(self.path), Handler)
        os.chmod(self.path, 0o660 if CC_SHARED else 0o600)
        self.socket_inode = self.path.stat().st_ino
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
        self.emit({"t": "welcome"})

    def exchange(self, request):
        reply = {"id": request.get("id"), "ok": True}
        op = request.get("op")
        if op == "status":
            return dict(reply, connected=not self.stop.is_set(), pc=self.pc, recovery=self.recovery)
        if op == "replace":
            reason = "reconnected" if request.get("machine") == self.pc["machine"] else "replaced"
            self.emit({"t": "close", "code": 4002, "reason": reason})
            self.stop.set()
            return reply
        if op not in ("call", "result"):
            return dict(reply, ok=False, code="error", error="unknown op")
        if op == 'result' and not self.recovery:
            return dict(reply, ok=False, code='unsupported', error='结果查询不可用')
        if len(json.dumps(request.get("msg"), ensure_ascii=False).encode("utf-8")) > MAX_REQUEST:
            return dict(reply, ok=False, code="error", error="MCP request exceeds the 8 MiB limit")
        request_id = request.get('request_id')
        if request_id is not None and (not isinstance(request_id, str) or len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id)):
            return dict(reply, ok=False, code='error', error='Invalid request ID')
        if op == 'result' and not request_id:
            return dict(reply, ok=False, code='error', error='Missing request ID')
        # Each socket exchange has its own wire ID, even concurrent result queries.
        key = uuid.uuid4().hex
        event = threading.Event()
        entry = {"event": event}
        with self.pending_lock:
            if self.stop.is_set():
                return dict(reply, ok=False, code="offline", delivery="not_sent", error="本地电脑当前未连接")
            if len(self.pending) >= 64:
                return dict(reply, ok=False, code="error", error="同时进行的操作太多，请稍后重试")
            self.pending[key] = entry
        try:
            packet = {"t": "req", "id": key, "msg": request.get("msg")}
            if self.recovery and request_id:
                packet['recovery'] = {'protocol': 1, 'requestId': request_id, 'action': 'query' if op == 'result' else 'execute'}
            self.emit(packet)
            deadline = time.monotonic() + (5 if op == 'result' else 180)
            while not event.wait(0.2):
                if self.stop.is_set():
                    return dict(reply, ok=False, code="disconnected", error="执行期间连接断开，结果尚未确认")
                if time.monotonic() >= deadline:
                    return dict(reply, ok=False, code="timeout", error="本地电脑没有在规定时间内响应")
            response = entry["response"]
            if response.get("error"):
                return dict(reply, ok=False, code="error", error=str(response["error"]), recovery=response.get('recovery'))
            return dict(reply, msg=response.get("msg"), recovery=response.get('recovery'))
        finally:
            with self.pending_lock:
                self.pending.pop(key, None)

    def message(self, message):
        if message.get("t") == "hello" and self.pc is None:
            self.start(message)
        elif message.get('t') == 'stop' and self.pc is not None:
            temporary = self.directory / ('manual-stop.' + uuid.uuid4().hex + '.tmp')
            try:
                temporary.write_text(json.dumps({'schema': 1, 'stopped': True}), encoding='utf-8')
                os.chmod(temporary, 0o640 if CC_SHARED else 0o600)
                os.replace(temporary, self.stop_marker)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    temporary.unlink()
            self.stop.set()
        elif message.get("t") == "res":
            with self.pending_lock:
                entry = self.pending.get(message.get("id"))
                if entry:
                    entry["response"] = message
                    entry["event"].set()

    def packet(self, packet):
        if packet.get("t") == "ping":
            nonce=packet.get('nonce','')
            if not isinstance(nonce,str) or len(nonce)>64:raise ValueError('Invalid health probe')
            self.emit({"t": "pong",'nonce':nonce})
            return
        if packet.get("t") != "data":
            raise ValueError("Invalid terminal packet")
        key, index, data = packet.get("id"), packet.get("n"), packet.get("data")
        if not isinstance(key, str) or not isinstance(data, str) or len(data) > 65536:
            raise ValueError("Invalid terminal packet")
        if self.part_id is None:
            self.part_id = key
        if key != self.part_id or index != len(self.parts):
            raise ValueError("Out-of-order terminal packet")
        self.part_size += len(data)
        if self.part_size > (MAX_RESPONSE + 2) // 3 * 4:
            raise ValueError("MCP response exceeds the 40 MiB limit")
        self.parts.append(data)
        if packet.get("end"):
            message = json.loads(base64.b64decode("".join(self.parts), validate=True))
            self.parts, self.part_id, self.part_size = [], None, 0
            self.message(message)
        self.emit({"t": "ack", "id": key, "n": index})

    def close(self):
        self.stop.set()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.socket_inode is not None:
            with contextlib.suppress(FileNotFoundError):
                if self.path.stat().st_ino == self.socket_inode:
                    self.path.unlink()
        if self.lock:
            self.lock.close()

    def run(self):
        previous = None
        if sys.stdin.isatty():
            previous = termios.tcgetattr(sys.stdin.fileno())
            tty.setraw(sys.stdin.fileno())  # no echo, line truncation or XON/XOFF
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, lambda *_: self.stop.set())
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory_mode(self.directory)
            if not CC_SHARED:os.chmod(Path(__file__), 0o600)
            # bash leaves the cursor after its prompt/escape sequence. Start the
            # first framed packet on a fresh line, even with bracketed paste on.
            sys.stdout.buffer.write(b"\n")
            self.emit({"t": "ready"})
            buffer = b""
            last_input = time.monotonic()
            while not self.stop.is_set():
                if time.monotonic() - last_input > 65:
                    break  # detached terminal after network loss: release link.sock
                readable, _, _ = select.select([sys.stdin.buffer], [], [], 0.2)
                if not readable:
                    continue
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                last_input = time.monotonic()
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.startswith(PREFIX) or len(line) > 100000:
                        raise ValueError("Invalid terminal packet")
                    self.packet(json.loads(line[len(PREFIX):]))
                if len(buffer) > 100000:
                    raise ValueError("Terminal packet too large")
        except Exception as error:
            with contextlib.suppress(OSError):
                self.emit({"t": "error", "error": str(error)})
        finally:
            self.close()
            if previous is not None:
                with contextlib.suppress(OSError, termios.error):
                    termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, previous)


if __name__ == "__main__":
    Relay().run()
