#!/usr/bin/env python3
"""
FBWeb – FreeBASIC Web-IDE
Backend: Dateiverwaltung (lokale und sshfs-Laufwerke), Kompilieren mit fbc,
Ausführen in einer Sandbox mit Pseudo-Terminal (Konsole). Grafik kommt über
den eigenen gfxlib2-Treiber "FBWeb" (Socket, siehe fbsrc/) direkt ins Browser-Canvas.
"""
import asyncio
import base64
import codecs
import fcntl
import json
import logging
import os
import pwd
import re
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import termios
import time
import zlib
from contextlib import asynccontextmanager
from pathlib import Path

import yaml
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
log = logging.getLogger("fbweb")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------
DEFAULTS = {
    "server": {"host": "0.0.0.0", "port": 8090, "user": "fb", "password": ""},
    "drives": [{"name": "lokal", "type": "local", "path": "/srv/fbweb/work"}],
    "run": {
        "user": "fbrun",
        "sandbox": True,
        "network": False,
        "timeout": 0,
        "max_memory_mb": 1024,
        "fbc": "/usr/local/bin/fbc",
        "fbc_options": [],
        "build_dir": "/var/tmp/fbweb",
    },
    "graphics": {"fps": 30, "compression": 1},
}


def _merge(a, b):
    out = dict(a)
    for k, v in (b or {}).items():
        out[k] = _merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


def load_config():
    path = os.environ.get("FBWEB_CONFIG")
    cands = [Path(path)] if path else [Path("/etc/fbweb/config.yaml"), BASE / "config.yaml"]
    for p in cands:
        if p.is_file():
            log.info("Konfiguration: %s", p)
            return _merge(DEFAULTS, yaml.safe_load(p.read_text()) or {})
    log.warning("Keine Konfigurationsdatei gefunden, verwende Standardwerte")
    return DEFAULTS


CFG = load_config()
RUN = CFG["run"]
GFX = CFG["graphics"]
RUN_PW = pwd.getpwnam(RUN["user"])
BUILD = Path(RUN["build_dir"])
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

# --------------------------------------------------------------------------
# Laufwerke
# --------------------------------------------------------------------------
class Drive:
    def __init__(self, d):
        self.name = d["name"]
        if not NAME_RE.match(self.name):
            raise ValueError(f"Ungültiger Laufwerksname: {self.name!r}")
        self.type = d.get("type", "local")
        self.cfg = d
        self.error = ""
        if self.type == "sshfs":
            self.root = Path(d.get("mountpoint") or f"/srv/fbweb/mnt/{self.name}")
        else:
            self.root = Path(d["path"])

    @property
    def enabled(self):
        return self.cfg.get("enabled", True)

    def is_mounted(self):
        if self.type != "sshfs":
            return True
        return subprocess.run(["mountpoint", "-q", str(self.root)]).returncode == 0

    @property
    def available(self):
        return self.enabled and self.root.is_dir() and self.is_mounted()

    def prepare(self):
        if not self.enabled:
            return
        if self.type == "local":
            self.root.mkdir(parents=True, exist_ok=True)
            os.chown(self.root, RUN_PW.pw_uid, RUN_PW.pw_gid)
        elif self.type == "sshfs":
            self.mount()

    def mount(self):
        self.error = ""
        if self.is_mounted():
            return True
        self.root.mkdir(parents=True, exist_ok=True)
        c = self.cfg
        opts = ["allow_other", "reconnect", "ServerAliveInterval=15", "ServerAliveCountMax=3",
                "StrictHostKeyChecking=accept-new", "BatchMode=yes"]
        if c.get("identity_file"):
            opts.append(f"IdentityFile={c['identity_file']}")
        opts += c.get("options", [])
        cmd = ["sshfs", c["remote"], str(self.root), "-p", str(c.get("port", 22)), "-o", ",".join(opts)]
        log.info("Mounte %s: %s", self.name, " ".join(cmd))
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            self.error = "Zeitüberschreitung beim Verbinden"
            return False
        if r.returncode != 0:
            self.error = (r.stderr or r.stdout).strip() or f"sshfs Fehler {r.returncode}"
            log.error("sshfs %s: %s", self.name, self.error)
            return False
        return True

    def unmount(self):
        if self.type == "sshfs" and self.is_mounted():
            subprocess.run(["fusermount3", "-u", str(self.root)], capture_output=True)

    def info(self):
        return {"name": self.name, "type": self.type, "enabled": self.enabled,
                "available": self.available, "error": self.error,
                "remote": self.cfg.get("remote", "") if self.type == "sshfs" else str(self.root)}

    def inside(self):
        """Pfad dieses Laufwerks aus Sicht des laufenden Programms."""
        return f"/mnt/{self.name}" if RUN["sandbox"] else str(self.root)


DRIVES = {d["name"]: Drive(d) for d in CFG["drives"]}


def resolve(vpath: str, must_exist=False):
    """'laufwerk/unter/datei.bas' -> (Drive, absoluter Pfad, relativer Pfad)"""
    vpath = (vpath or "").strip("/")
    name, _, rel = vpath.partition("/")
    drv = DRIVES.get(name)
    if not drv:
        raise HTTPException(404, f"Unbekanntes Laufwerk: {name}")
    if not drv.available:
        raise HTTPException(503, f"Laufwerk {name} ist nicht verfügbar {drv.error}")
    root = os.path.realpath(drv.root)
    full = os.path.realpath(os.path.join(root, rel))
    if os.path.commonpath([root, full]) != root:
        raise HTTPException(400, "Pfad außerhalb des Laufwerks")
    if must_exist and not os.path.exists(full):
        raise HTTPException(404, "Datei nicht gefunden")
    return drv, full, "" if full == root else os.path.relpath(full, root)


def give_to_runner(drv, path):
    if drv.type == "local":
        try:
            os.chown(path, RUN_PW.pw_uid, RUN_PW.pw_gid)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Grafik: Daten vom gfxlib2-Treiber "FBWeb" empfangen und an Browser verteilen
# --------------------------------------------------------------------------
# Treiber -> Server: 12 Byte Kopf (u8 typ, u8 flag, u16 a, u16 b, u16 c, u32 len) + Daten
G_MODE, G_ROWS, G_TITLE, G_CLOSE, G_CURSOR = 1, 2, 3, 4, 5
# Server -> Treiber: 12 Byte (u8 typ, u8 a, u8 b, u8 0, i16 x, i16 y, i32 key)
IN_KEYDOWN, IN_KEYUP, IN_MOVE, IN_BUTTON, IN_WHEEL, IN_FOCUS, IN_CLOSE, IN_REDRAW = range(1, 9)
HDR = struct.Struct("<BBHHHI")
INP = struct.Struct("<BBBBhhi")


class GfxHub:
    def __init__(self):
        self.clients = set()
        self.sock = None
        self.rbuf = bytearray()
        self.w = self.h = 0
        self.fb = bytearray()
        self.title = ""
        self.cursor = True
        self.dirty = None          # (y0, y1) noch nicht gesendeter Bereich
        self.wake = None
        self.task = None

    # ---- Verbindung zum laufenden Programm --------------------------------
    def attach(self, sock):
        self.detach()
        self.reset()
        self.sock = sock
        sock.setblocking(False)
        asyncio.get_running_loop().add_reader(sock.fileno(), self._on_read)

    def detach(self):
        if self.sock is not None:
            try:
                asyncio.get_running_loop().remove_reader(self.sock.fileno())
            except Exception:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
        if self.w:
            self._close_window()

    def reset(self):
        self.rbuf = bytearray()
        if self.w:
            self._close_window()

    def _close_window(self):
        self.w = self.h = 0
        self.fb = bytearray()
        self.dirty = None
        self.broadcast_json({"t": "close"})

    def _on_read(self):
        try:
            data = self.sock.recv(4 << 20)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b""
        if not data:
            asyncio.get_running_loop().remove_reader(self.sock.fileno())
            return
        self.rbuf += data
        mv = memoryview(self.rbuf)
        pos, n = 0, len(self.rbuf)
        while n - pos >= 12:
            t, _f, a, b, c, ln = HDR.unpack_from(mv, pos)
            if n - pos - 12 < ln:
                break
            self._handle(t, a, b, c, mv[pos + 12:pos + 12 + ln])
            pos += 12 + ln
        mv.release()
        if pos:
            del self.rbuf[:pos]

    def _handle(self, t, a, b, c, payload):
        if t == G_MODE:
            self.w, self.h = a, b
            self.fb = bytearray(a * b * 4)
            self.dirty = None
            self.cursor = True
            self.broadcast_json({"t": "mode", "w": a, "h": b, "title": self.title})
        elif t == G_ROWS and self.w:
            y0, cnt, pitch = a, b, self.w * 4
            if c != self.w or len(payload) != cnt * pitch or y0 + cnt > self.h:
                return
            self.fb[y0 * pitch:(y0 + cnt) * pitch] = payload
            y1 = y0 + cnt
            self.dirty = (min(self.dirty[0], y0), max(self.dirty[1], y1)) if self.dirty else (y0, y1)
            self._kick()
        elif t == G_TITLE:
            self.title = bytes(payload).decode("utf-8", "replace")
            self.broadcast_json({"t": "title", "title": self.title})
        elif t == G_CLOSE:
            self._close_window()
        elif t == G_CURSOR:
            self.cursor = bool(a)
            self.broadcast_json({"t": "cursor", "on": self.cursor})

    # ---- Verteilung an Browser --------------------------------------------
    def _kick(self):
        if self.wake is None:
            self.wake = asyncio.Event()
            self.task = asyncio.get_running_loop().create_task(self._sender())
        self.wake.set()

    def _frame(self, y0, y1):
        pitch = self.w * 4
        data = zlib.compress(bytes(self.fb[y0 * pitch:y1 * pitch]), int(GFX.get("compression", 1)))
        return struct.pack("<HHH", y0, y1 - y0, self.w) + data

    async def _sender(self):
        interval = 1.0 / max(1, int(GFX.get("fps", 30)))
        while True:
            await self.wake.wait()
            self.wake.clear()
            t0 = time.monotonic()
            if self.dirty and self.clients and self.w:
                y0, y1 = self.dirty
                self.dirty = None
                msg = await asyncio.to_thread(self._frame, y0, y1)
                await asyncio.gather(*(self._send(ws, msg) for ws in list(self.clients)))
            elif not self.clients:
                self.dirty = None
            rest = interval - (time.monotonic() - t0)
            if rest > 0:
                await asyncio.sleep(rest)

    async def _send(self, ws, data):
        try:
            if isinstance(data, (bytes, bytearray)):
                await asyncio.wait_for(ws.send_bytes(data), 5)
            else:
                await asyncio.wait_for(ws.send_text(data), 5)
        except Exception:
            self.clients.discard(ws)

    def broadcast_json(self, obj):
        if not self.clients:
            return
        txt = json.dumps(obj)
        loop = asyncio.get_running_loop()
        for ws in list(self.clients):
            loop.create_task(self._send(ws, txt))

    async def add_client(self, ws):
        self.clients.add(ws)
        if self.w:
            await self._send(ws, json.dumps({"t": "mode", "w": self.w, "h": self.h, "title": self.title}))
            await self._send(ws, json.dumps({"t": "cursor", "on": self.cursor}))
            await self._send(ws, await asyncio.to_thread(self._frame, 0, self.h))

    # ---- Eingaben vom Browser an das Programm -------------------------------
    def input(self, m):
        if self.sock is None or not self.w:
            return
        t = m.get("t")
        try:
            if t == "key":
                pkt = INP.pack(IN_KEYDOWN if m.get("down") else IN_KEYUP, int(m.get("sc", 0)) & 0x7F,
                               1 if m.get("rep") else 0, 0, 0, 0, int(m.get("key", 0)))
            elif t == "move":
                pkt = INP.pack(IN_MOVE, 0, 0, 0, int(m["x"]), int(m["y"]), 0)
            elif t == "btn":
                pkt = INP.pack(IN_BUTTON, int(m["b"]) & 0x1F, 1 if m.get("down") else 0, 0, 0, 0, 0)
            elif t == "wheel":
                pkt = INP.pack(IN_WHEEL, 0, 0, 0, int(m.get("dz", 0)), int(m.get("dw", 0)), 0)
            elif t == "focus":
                pkt = INP.pack(IN_FOCUS, 1 if m.get("on") else 0, 0, 0, 0, 0, 0)
            elif t == "close":
                pkt = INP.pack(IN_CLOSE, 0, 0, 0, 0, 0, 0)
            else:
                return
            self.sock.send(pkt)
        except (BlockingIOError, OSError, KeyError, ValueError, struct.error):
            pass


HUB = GfxHub()

# --------------------------------------------------------------------------
# Sandbox
# --------------------------------------------------------------------------
def sandbox_wrap(argv, cwd, gfx_fd=None):
    env = {"HOME": "/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "xterm-256color",
           "LANG": "C.UTF-8", "USER": RUN["user"], "FBWEB_CONSOLE": "1"}
    if gfx_fd is not None:
        env["FBWEB_GFX_FD"] = str(gfx_fd)
    if not RUN["sandbox"]:
        return argv, {**env, "HOME": str(BUILD)}, cwd
    c = ["bwrap", "--ro-bind", "/usr", "/usr",
         "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
         "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
         "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
         "--ro-bind-try", "/etc/localtime", "/etc/localtime",
         "--ro-bind-try", "/etc/fonts", "/etc/fonts",
         "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
         "--bind", str(BUILD), "/build",
         "--unshare-all", "--die-with-parent", "--hostname", "fbweb"]
    if RUN["network"]:
        c += ["--share-net", "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
              "--ro-bind-try", "/etc/hosts", "/etc/hosts", "--ro-bind-try", "/etc/ssl", "/etc/ssl"]
    for d in DRIVES.values():
        if d.available:
            c += ["--bind", str(d.root), d.inside()]
    c += ["--clearenv"]
    for k, v in env.items():
        c += ["--setenv", k, v]
    c += ["--chdir", cwd, "--"] + argv
    return c, None, None


def _limits():
    import resource
    mb = int(RUN.get("max_memory_mb") or 0)
    if mb > 0:
        resource.setrlimit(resource.RLIMIT_AS, (mb * 1024 * 1024, mb * 1024 * 1024))


# --------------------------------------------------------------------------
# Kompilieren und Ausführen
# --------------------------------------------------------------------------
MSG_RE = re.compile(r"^(?P<file>.*?)\((?P<line>\d+)\)\s*(?P<kind>error|warning)\s*(?P<code>\d*)\s*:?\s*(?P<text>.*)$", re.I)


def parse_fbc(output):
    msgs = []
    for ln in output.splitlines():
        m = MSG_RE.match(ln.strip())
        if m:
            msgs.append({"file": os.path.basename(m["file"]), "line": int(m["line"]),
                         "kind": m["kind"].lower(), "code": m["code"], "text": m["text"]})
    return msgs


class Session:
    """Ein laufendes Programm, gebunden an eine WebSocket-Verbindung."""

    current = None

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.proc = None
        self.master = None
        self.buf = bytearray()
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.flush_scheduled = False
        self.reader_paused = False
        self.tasks = []
        self.started = 0
        self.gfx_sock = None
        self.send_lock = asyncio.Lock()

    async def send(self, obj):
        try:
            async with self.send_lock:
                await self.ws.send_text(json.dumps(obj))
        except Exception:
            pass

    # ---- Ablauf ---------------------------------------------------------
    async def run(self, msg):
        if Session.current and Session.current is not self:
            await Session.current.stop("Neues Programm gestartet")
        await self.stop()
        Session.current = self
        code = msg.get("code", "")
        vpath = msg.get("path")
        BUILD.mkdir(parents=True, exist_ok=True)
        os.chown(BUILD, RUN_PW.pw_uid, RUN_PW.pw_gid)
        # Programmdatei heißt wie die .bas-Datei (FreeBASIC nutzt den Namen als
        # Standard-Fenstertitel); jeder Lauf bekommt einen frischen Ordner.
        stem = re.sub(r"[^\w.-]", "_", Path(vpath).stem) if vpath else "unbenannt"
        for old in BUILD.glob("run_*"):
            shutil.rmtree(old, ignore_errors=True)
        run_dir = f"run_{secrets.token_hex(4)}"
        (BUILD / run_dir).mkdir()
        os.chown(BUILD / run_dir, RUN_PW.pw_uid, RUN_PW.pw_gid)
        exe_name = f"{run_dir}/{stem or 'programm'}"

        if vpath:
            drv, full, rel = resolve(vpath)
            Path(full).parent.mkdir(parents=True, exist_ok=True)
            Path(full).write_text(code, encoding="utf-8")
            give_to_runner(drv, full)
            inside_root = drv.inside()
            src_inside = os.path.join(inside_root, rel)
            cwd_inside = os.path.dirname(src_inside)
        else:
            tmp = BUILD / "unbenannt.bas"
            tmp.write_text(code, encoding="utf-8")
            os.chown(tmp, RUN_PW.pw_uid, RUN_PW.pw_gid)
            src_inside = "/build/unbenannt.bas" if RUN["sandbox"] else str(tmp)
            first = next((d for d in DRIVES.values() if d.available), None)
            cwd_inside = first.inside() if first else ("/build" if RUN["sandbox"] else str(BUILD))
        exe_inside = ("/build/" if RUN["sandbox"] else str(BUILD) + "/") + exe_name

        # --- Kompilieren
        await self.send({"t": "status", "s": "compiling"})
        argv = [RUN["fbc"], *RUN.get("fbc_options", []), "-x", exe_inside, src_inside]
        cmd, env, cwd = sandbox_wrap(argv, os.path.dirname(src_inside))
        t0 = time.time()

        def compile_():
            try:
                r = subprocess.run(cmd, env=env, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   user=RUN_PW.pw_uid, group=RUN_PW.pw_gid, extra_groups=[], timeout=120)
                return r.returncode, r.stdout
            except subprocess.TimeoutExpired:
                return -1, b"Zeitueberschreitung beim Kompilieren"

        rc, out = await asyncio.to_thread(compile_)
        out = out.decode("utf-8", "replace")
        ok = rc == 0 and (BUILD / exe_name).exists()
        await self.send({"t": "compile", "ok": ok, "log": out.strip(), "msgs": parse_fbc(out),
                         "time": round(time.time() - t0, 2)})
        if not ok:
            await self.send({"t": "status", "s": "idle"})
            return

        # --- Ausführen
        gfx_parent, gfx_child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        gfx_child.set_inheritable(True)
        cmd, env, cwd = sandbox_wrap([exe_inside], cwd_inside, gfx_fd=gfx_child.fileno())
        master, slave = os.openpty()
        self._set_winsize(slave, msg.get("rows", 24), msg.get("cols", 80))
        attrs = termios.tcgetattr(slave)
        self.master = master

        def pre():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            _limits()

        try:
            self.proc = subprocess.Popen(
                cmd, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd,
                start_new_session=True, preexec_fn=pre, close_fds=True, pass_fds=(gfx_child.fileno(),),
                user=RUN_PW.pw_uid, group=RUN_PW.pw_gid, extra_groups=[])
        except Exception as e:
            gfx_child.close()
            gfx_parent.close()
            os.close(slave)
            os.close(master)
            self.master = None
            await self.send({"t": "error", "msg": f"Start fehlgeschlagen: {e}"})
            await self.send({"t": "status", "s": "idle"})
            return
        os.close(slave)
        gfx_child.close()
        self.gfx_sock = gfx_parent
        HUB.attach(gfx_parent)
        os.set_blocking(master, False)
        self.started = time.time()
        loop = asyncio.get_running_loop()
        loop.add_reader(master, self._on_read)
        await self.send({"t": "status", "s": "running"})
        self.tasks = [asyncio.create_task(self._watch_exit())]

    def _set_winsize(self, fd, rows, cols):
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
        except Exception:
            pass

    def resize(self, rows, cols):
        if self.master is not None:
            self._set_winsize(self.master, rows, cols)

    def write(self, data: str):
        if self.master is not None:
            try:
                os.write(self.master, data.encode("utf-8"))
            except OSError:
                pass

    # ---- Ausgabe des Programms ------------------------------------------
    def _on_read(self):
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            asyncio.get_running_loop().remove_reader(self.master)
            self.reader_paused = True
            return
        self.buf += data
        if len(self.buf) > 256 * 1024 and not self.reader_paused:
            asyncio.get_running_loop().remove_reader(self.master)
            self.reader_paused = True
        if not self.flush_scheduled:
            self.flush_scheduled = True
            asyncio.get_running_loop().call_later(0.015, lambda: asyncio.ensure_future(self._flush()))

    async def _flush(self):
        self.flush_scheduled = False
        if self.buf:
            data, self.buf = bytes(self.buf), bytearray()
            await self.send({"t": "out", "d": self.decoder.decode(data)})
        if self.reader_paused and self.master is not None and self.proc and self.proc.poll() is None:
            self.reader_paused = False
            asyncio.get_running_loop().add_reader(self.master, self._on_read)

    async def _watch_exit(self):
        timeout = float(RUN.get("timeout") or 0)
        while self.proc and self.proc.poll() is None:
            if timeout and time.time() - self.started > timeout:
                await self.send({"t": "error", "msg": f"Zeitlimit von {timeout:g} s erreicht – Programm beendet"})
                self._kill()
            await asyncio.sleep(0.1)
        if not self.proc:
            return
        rc = self.proc.returncode
        # Restausgabe einsammeln
        await asyncio.sleep(0.05)
        if self.master is not None:
            try:
                while True:
                    d = os.read(self.master, 65536)
                    if not d:
                        break
                    self.buf += d
            except OSError:
                pass
        await self._flush()
        await self._cleanup()
        self.proc = None
        self.tasks = []
        if rc is not None and rc < 0:
            try:
                sig = signal.Signals(-rc).name
            except ValueError:
                sig = str(-rc)
            await self.send({"t": "exit", "code": rc, "signal": sig, "time": round(time.time() - self.started, 2)})
        else:
            await self.send({"t": "exit", "code": rc, "time": round(time.time() - self.started, 2)})
        await self.send({"t": "status", "s": "idle"})

    def _kill(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    async def _cleanup(self):
        if self.master is not None:
            try:
                asyncio.get_running_loop().remove_reader(self.master)
            except Exception:
                pass
            try:
                os.close(self.master)
            except OSError:
                pass
            self.master = None
        if self.gfx_sock is not None:
            if HUB.sock is self.gfx_sock:
                HUB.detach()
            else:
                self.gfx_sock.close()
            self.gfx_sock = None

    def _running(self):
        if self.proc is None:
            return False
        if isinstance(self.proc, subprocess.Popen):
            return self.proc.poll() is None
        return self.proc.returncode is None

    async def stop(self, reason=None):
        running = self._running()
        if running:
            if isinstance(self.proc, subprocess.Popen):
                try:
                    os.killpg(self.proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                for _ in range(10):
                    if self.proc.poll() is not None:
                        break
                    await asyncio.sleep(0.05)
                self._kill()
            else:
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass
        for t in self.tasks:
            if t is not asyncio.current_task():
                t.cancel()
        self.tasks = []
        await self._cleanup()
        self.proc = None
        if running:
            if reason:
                await self.send({"t": "error", "msg": reason})
            await self.send({"t": "exit", "code": None, "stopped": True})
            await self.send({"t": "status", "s": "idle"})


# --------------------------------------------------------------------------
# Web-App
# --------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app):
    for d in DRIVES.values():
        try:
            await asyncio.to_thread(d.prepare)
        except Exception as e:
            d.error = str(e)
            log.error("Laufwerk %s: %s", d.name, e)
    BUILD.mkdir(parents=True, exist_ok=True)
    os.chown(BUILD, RUN_PW.pw_uid, RUN_PW.pw_gid)
    # Beispiele beim ersten Start ins erste lokale Laufwerk kopieren
    local = next((d for d in DRIVES.values() if d.type == "local" and d.available), None)
    ex = BASE / "beispiele"
    if local and ex.is_dir() and not (local.root / "beispiele").exists():
        shutil.copytree(ex, local.root / "beispiele")
        for root, dirs, files in os.walk(local.root / "beispiele"):
            for f in dirs + files + ["."]:
                os.chown(os.path.join(root, f), RUN_PW.pw_uid, RUN_PW.pw_gid)
    log.info("FBWeb bereit auf http://%s:%s", CFG["server"]["host"], CFG["server"]["port"])
    yield
    if Session.current:
        await Session.current.stop()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


def _auth_ok(header: str | None):
    pw = CFG["server"].get("password")
    if not pw:
        return True
    if not header or not header.lower().startswith("basic "):
        return False
    try:
        u, _, p = base64.b64decode(header[6:]).decode().partition(":")
    except Exception:
        return False
    return secrets.compare_digest(u, CFG["server"]["user"]) and secrets.compare_digest(p, pw)


@app.middleware("http")
async def auth_mw(request: Request, call_next):
    if not _auth_ok(request.headers.get("authorization")):
        return Response("Anmeldung erforderlich", 401, {"WWW-Authenticate": 'Basic realm="FBWeb"'})
    return await call_next(request)


@app.get("/")
async def index():
    return FileResponse(BASE / "static" / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/status")
async def status():
    r = subprocess.run([RUN["fbc"], "--version"], capture_output=True, text=True)
    return {"fbc": (r.stdout.splitlines() or ["?"])[0], "drives": [d.info() for d in DRIVES.values()],
            "sandbox": RUN["sandbox"], "network": RUN["network"]}


@app.post("/api/drives/{name}/mount")
async def drive_mount(name: str):
    d = DRIVES.get(name)
    if not d:
        raise HTTPException(404)
    ok = await asyncio.to_thread(d.mount)
    return {"ok": ok, **d.info()}


@app.post("/api/drives/{name}/unmount")
async def drive_unmount(name: str):
    d = DRIVES.get(name)
    if not d:
        raise HTTPException(404)
    await asyncio.to_thread(d.unmount)
    return d.info()


@app.get("/api/list")
async def list_dir(path: str):
    drv, full, rel = resolve(path, must_exist=True)
    if not os.path.isdir(full):
        raise HTTPException(400, "Kein Verzeichnis")
    items = []
    try:
        with os.scandir(full) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    st = e.stat()
                    items.append({"name": e.name, "dir": e.is_dir(), "size": st.st_size, "mtime": int(st.st_mtime)})
                except OSError:
                    pass
    except OSError as e:
        raise HTTPException(500, str(e))
    items.sort(key=lambda i: (not i["dir"], i["name"].lower()))
    return {"path": path.strip("/"), "items": items}


@app.get("/api/file")
async def read_file(path: str):
    drv, full, rel = resolve(path, must_exist=True)
    if os.path.isdir(full):
        raise HTTPException(400, "Ist ein Verzeichnis")
    if os.path.getsize(full) > 5 * 1024 * 1024:
        raise HTTPException(413, "Datei zu groß für den Editor (> 5 MB)")
    raw = Path(full).read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", "replace")
    return {"path": path.strip("/"), "content": text}


@app.get("/api/download")
async def download(path: str):
    drv, full, rel = resolve(path, must_exist=True)
    return FileResponse(full, filename=os.path.basename(full))


@app.put("/api/file")
async def write_file(data: dict = Body(...)):
    drv, full, rel = resolve(data.get("path", ""))
    if os.path.isdir(full):
        raise HTTPException(400, "Ist ein Verzeichnis")
    if data.get("create") and os.path.exists(full):
        raise HTTPException(409, "Datei existiert bereits")
    Path(full).parent.mkdir(parents=True, exist_ok=True)
    Path(full).write_text(data.get("content", ""), encoding="utf-8")
    give_to_runner(drv, full)
    return {"ok": True}


@app.post("/api/upload")
async def upload(request: Request, path: str):
    drv, full, rel = resolve(path)
    body = await request.body()
    Path(full).write_bytes(body)
    give_to_runner(drv, full)
    return {"ok": True}


@app.post("/api/mkdir")
async def mkdir(data: dict = Body(...)):
    drv, full, rel = resolve(data.get("path", ""))
    os.makedirs(full, exist_ok=True)
    give_to_runner(drv, full)
    return {"ok": True}


@app.post("/api/rename")
async def rename(data: dict = Body(...)):
    d1, src, r1 = resolve(data.get("from", ""), must_exist=True)
    d2, dst, r2 = resolve(data.get("to", ""))
    if src == os.path.realpath(d1.root):
        raise HTTPException(400, "Laufwerk kann nicht umbenannt werden")
    if os.path.exists(dst):
        raise HTTPException(409, "Ziel existiert bereits")
    shutil.move(src, dst)
    return {"ok": True}


@app.post("/api/delete")
async def delete(data: dict = Body(...)):
    drv, full, rel = resolve(data.get("path", ""), must_exist=True)
    if full == os.path.realpath(drv.root):
        raise HTTPException(400, "Laufwerk kann nicht gelöscht werden")
    if os.path.isdir(full):
        shutil.rmtree(full)
    else:
        os.unlink(full)
    return {"ok": True}


@app.websocket("/ws/run")
async def ws_run(ws: WebSocket):
    if not _auth_ok(ws.headers.get("authorization")):
        await ws.close(code=4401)
        return
    await ws.accept()
    s = Session(ws)
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            t = msg.get("t")
            if t == "run":
                try:
                    await s.run(msg)
                except HTTPException as e:
                    await s.send({"t": "error", "msg": e.detail})
                    await s.send({"t": "status", "s": "idle"})
                except Exception as e:
                    log.exception("run")
                    await s.send({"t": "error", "msg": f"Interner Fehler: {e}"})
                    await s.send({"t": "status", "s": "idle"})
            elif t == "in":
                s.write(msg.get("d", ""))
            elif t == "resize":
                s.resize(msg.get("rows", 24), msg.get("cols", 80))
            elif t == "stop":
                await s.stop()
            elif t == "ping":
                await s.send({"t": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if Session.current is s:
            await s.stop()
            Session.current = None


@app.websocket("/ws/gfx")
async def ws_gfx(ws: WebSocket):
    """Grafikkanal: Bilddaten (binär, zlib) zum Browser, Tastatur/Maus (JSON) zurück."""
    if not _auth_ok(ws.headers.get("authorization")):
        await ws.close(code=4401)
        return
    await ws.accept()
    await HUB.add_client(ws)
    try:
        while True:
            m = json.loads(await ws.receive_text())
            if m.get("t") == "redraw":
                if HUB.w:
                    await HUB._send(ws, await asyncio.to_thread(HUB._frame, 0, HUB.h))
            else:
                HUB.input(m)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        HUB.clients.discard(ws)


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=CFG["server"]["host"], port=int(CFG["server"]["port"]), log_level="info",
                ws_max_size=16 * 1024 * 1024, ws_per_message_deflate=False)
