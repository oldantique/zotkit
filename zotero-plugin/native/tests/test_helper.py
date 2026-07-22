#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest


HELPER = Path(os.environ.get("HELPER", Path(__file__).parents[1] / "build" / "zoterochat-helper"))
TOKEN = "native-helper-test-token-0123456789"


def recv_exact(sock: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise EOFError("socket closed")
        data.extend(chunk)
    return bytes(data)


class WebSocket:
    def __init__(self, socket_path: str, token: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(3)
        try:
            self.sock.connect(socket_path)
        except BaseException:
            self.sock.close()
            raise
        self.sock.settimeout(5)
        key = base64.b64encode(os.urandom(16)).decode()
        client_proof = base64.b64encode(
            hmac.new(token.encode(), ("client:" + key).encode(), hashlib.sha1).digest()
        ).decode()
        request = (
            "GET /ws HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Upgrade: websocket\r\n"
            "Connection: keep-alive, Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"X-Zotkit-Client-Proof: {client_proof}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
        self.sock.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response:
            response.extend(self.sock.recv(4096))
        expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        )
        server_proof = base64.b64encode(
            hmac.new(token.encode(), ("server:" + key).encode(), hashlib.sha1).digest()
        )
        self.assert_handshake(bytes(response), expected, server_proof)

    @staticmethod
    def assert_handshake(response: bytes, expected: bytes, server_proof: bytes) -> None:
        if not response.startswith(b"HTTP/1.1 101 "):
            raise AssertionError(response)
        if b"Sec-WebSocket-Accept: " + expected + b"\r\n" not in response:
            raise AssertionError("bad Sec-WebSocket-Accept")
        if b"X-Zotkit-Server-Proof: " + server_proof + b"\r\n" not in response:
            raise AssertionError("bad X-Zotkit-Server-Proof")

    def send_frame(self, opcode: int, payload: bytes, *, fin: bool = True) -> None:
        mask = os.urandom(4)
        first = (0x80 if fin else 0) | opcode
        length = len(payload)
        if length <= 125:
            header = bytes((first, 0x80 | length))
        elif length <= 65535:
            header = bytes((first, 0x80 | 126)) + struct.pack("!H", length)
        else:
            header = bytes((first, 0x80 | 127)) + struct.pack("!Q", length)
        masked = bytes(value ^ mask[index & 3] for index, value in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_json(self, value: dict) -> None:
        self.send_frame(1, json.dumps(value, separators=(",", ":")).encode())

    def recv_frame(self) -> tuple[int, bytes]:
        first, second = recv_exact(self.sock, 2)
        self.assert_server_frame(first, second)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", recv_exact(self.sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", recv_exact(self.sock, 8))[0]
        return first & 0x0F, recv_exact(self.sock, length)

    @staticmethod
    def assert_server_frame(first: int, second: int) -> None:
        if not first & 0x80:
            raise AssertionError("fragmented server frame")
        if second & 0x80:
            raise AssertionError("server frame must not be masked")

    def recv_json(self) -> dict:
        opcode, payload = self.recv_frame()
        if opcode != 1:
            raise AssertionError(f"expected text frame, got opcode {opcode}")
        return json.loads(payload)

    def close(self) -> None:
        try:
            self.send_frame(8, struct.pack("!H", 1000))
        finally:
            self.sock.close()


class DaemonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.token_dir = tempfile.TemporaryDirectory(dir="/tmp")
        Path(cls.token_dir.name).chmod(0o700)
        cls.socket_path = str(Path(cls.token_dir.name) / "bridge.sock")
        token_path = Path(cls.token_dir.name) / "helper-token"
        token_path.write_text(TOKEN + "\n", encoding="utf-8")
        token_path.chmod(0o600)
        cls.daemon = subprocess.Popen(
            [
                str(HELPER),
                "--socket",
                cls.socket_path,
                "--token-file",
                str(token_path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if cls.daemon.poll() is not None:
                raise RuntimeError(cls.daemon.stderr.read())
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.settimeout(0.1)
                    probe.connect(cls.socket_path)
                    break
            except OSError:
                time.sleep(0.03)
        else:
            raise RuntimeError("daemon did not become ready")
        if token_path.exists():
            raise RuntimeError("daemon did not consume its token file")
        socket_mode = Path(cls.socket_path).stat().st_mode & 0o777
        if socket_mode != 0o600:
            raise RuntimeError(f"daemon socket mode is {socket_mode:o}, expected 600")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.daemon.terminate()
        try:
            cls.daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.daemon.kill()
            cls.daemon.wait(timeout=3)
        cls.daemon.stderr.close()
        if Path(cls.socket_path).exists():
            raise RuntimeError("daemon did not remove its Unix socket")
        cls.token_dir.cleanup()

    def http(self, path: str, extra_headers: str = "") -> bytes:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(3)
            sock.connect(self.socket_path)
            request = (
                f"GET {path} HTTP/1.1\r\nHost: localhost\r\n"
                f"{extra_headers}Connection: close\r\n\r\n"
            ).encode()
            sock.sendall(request)
            response = bytearray()
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    return bytes(response)
                response.extend(chunk)

    def test_health_requires_token(self) -> None:
        self.assertTrue(self.http("/health").startswith(b"HTTP/1.1 401 "))
        self.assertTrue(
            self.http(f"/health?token={TOKEN}").startswith(b"HTTP/1.1 401 ")
        )
        self.assertTrue(
            self.http("/health", f"X-ZoteroChat-Token: {TOKEN}\r\n").startswith(
                b"HTTP/1.1 401 "
            )
        )
        response = self.http("/health", f"Authorization: Bearer {TOKEN}\r\n")
        self.assertTrue(response.startswith(b"HTTP/1.1 200 "))
        self.assertIn(b'"ok":true', response)

    def test_websocket_requires_mutual_hmac_proof(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET /ws HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Authorization: Bearer {TOKEN}\r\n\r\n"
        ).encode()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(3)
            sock.connect(self.socket_path)
            sock.sendall(request)
            response = sock.recv(4096)
        self.assertTrue(response.startswith(b"HTTP/1.1 401 "))
        self.assertNotIn(TOKEN.encode(), response)

    def test_idle_http_handshake_is_closed_on_deadline(self) -> None:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(4)
            sock.connect(self.socket_path)
            started = time.monotonic()
            self.assertEqual(sock.recv(1), b"")
            elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 1.5)
        self.assertLess(elapsed, 3.0)

    def test_idle_handshakes_release_all_client_slots(self) -> None:
        slow_clients: list[socket.socket] = []
        try:
            for _ in range(16):
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.settimeout(4)
                sock.connect(self.socket_path)
                slow_clients.append(sock)

            # Give the daemon time to accept the full backlog, then cross the
            # absolute handshake deadline. A new authenticated client must not
            # be rejected because stale HTTP clients retained every slot.
            time.sleep(2.5)
            ws = WebSocket(self.socket_path, TOKEN)
            try:
                ws.send_json({"type": "ping"})
                self.assertEqual(ws.recv_json(), {"type": "pong"})
            finally:
                ws.close()
        finally:
            for sock in slow_clients:
                sock.close()

    def test_websocket_pty_io_resize_exit_and_multiple_sessions(self) -> None:
        ws = WebSocket(self.socket_path, TOKEN)
        self.addCleanup(ws.close)

        ws.send_frame(9, b"probe")
        self.assertEqual(ws.recv_frame(), (10, b"probe"))
        ws.send_json({"type": "ping"})
        self.assertEqual(ws.recv_json(), {"type": "pong"})
        ws.send_frame(1, b'{"type":', fin=False)
        ws.send_frame(0, b'"ping"}')
        self.assertEqual(ws.recv_json(), {"type": "pong"})

        with tempfile.TemporaryDirectory() as cwd:
            ws.send_json(
                {
                    "type": "spawn",
                    "sessionId": "interactive",
                    "argv": [
                        "/bin/sh",
                        "-c",
                        "printf 'START:%s\\n' \"$ZC_TEST\"; IFS= read -r line; stty size; printf 'GOT:%s\\n' \"$line\"; exit 7",
                    ],
                    "cwd": cwd,
                    "env": {"ZC_TEST": "yes"},
                    "rows": 20,
                    "cols": 90,
                }
            )
            ws.send_json(
                {
                    "type": "spawn",
                    "sessionId": "sleeper",
                    "argv": ["/bin/sh", "-c", "sleep 30"],
                    "cwd": cwd,
                }
            )

            spawned: set[str] = set()
            output = bytearray()
            exit_event = None
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and spawned != {"interactive", "sleeper"}:
                message = ws.recv_json()
                if message["type"] == "spawned":
                    spawned.add(message["sessionId"])
                elif message["type"] == "output" and message["sessionId"] == "interactive":
                    output.extend(base64.b64decode(message["data"]))
            self.assertEqual(spawned, {"interactive", "sleeper"})

            ws.send_json({"type": "resize", "sessionId": "interactive", "rows": 31, "cols": 101})
            ws.send_json(
                {
                    "type": "input",
                    "sessionId": "interactive",
                    "encoding": "base64",
                    "data": base64.b64encode(b"hello world\n").decode(),
                }
            )
            ws.send_json({"type": "close", "sessionId": "sleeper"})

            sleeper_exit = None
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and (exit_event is None or sleeper_exit is None):
                message = ws.recv_json()
                if message["type"] == "output" and message["sessionId"] == "interactive":
                    output.extend(base64.b64decode(message["data"]))
                elif message["type"] == "exit" and message["sessionId"] == "interactive":
                    exit_event = message
                elif message["type"] == "exit" and message["sessionId"] == "sleeper":
                    sleeper_exit = message

            decoded = bytes(output).replace(b"\r", b"")
            self.assertIn(b"START:yes\n", decoded)
            self.assertIn(b"31 101\n", decoded)
            self.assertIn(b"GOT:hello world\n", decoded)
            self.assertEqual(exit_event["exitCode"], 7)
            self.assertIsNone(exit_event["signal"])
            self.assertIsNotNone(sleeper_exit)

    def test_websocket_pipe_io_for_jsonl_services(self) -> None:
        ws = WebSocket(self.socket_path, TOKEN)
        self.addCleanup(ws.close)
        with tempfile.TemporaryDirectory() as cwd:
            ws.send_json(
                {
                    "type": "spawnPipe",
                    "sessionId": "jsonl",
                    "argv": [
                        "/bin/sh",
                        "-c",
                        "IFS= read -r line; printf '{\"wrapped\":%s}\\n' \"$line\"",
                    ],
                    "cwd": cwd,
                }
            )
            self.assertEqual(ws.recv_json()["type"], "spawned")
            ws.send_json(
                {
                    "type": "input",
                    "sessionId": "jsonl",
                    "encoding": "base64",
                    "data": base64.b64encode(b'{"ok":true}\n').decode(),
                }
            )
            output = bytearray()
            exit_event = None
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and exit_event is None:
                message = ws.recv_json()
                if message["type"] == "output":
                    output.extend(base64.b64decode(message["data"]))
                elif message["type"] == "exit":
                    exit_event = message
            self.assertEqual(bytes(output), b'{"wrapped":{"ok":true}}\n')
            self.assertEqual(exit_event["exitCode"], 0)

    def test_spawn_error_is_scoped_and_does_not_cancel_another_spawn(self) -> None:
        ws = WebSocket(self.socket_path, TOKEN)
        self.addCleanup(ws.close)
        with tempfile.TemporaryDirectory() as cwd:
            ws.send_json(
                {
                    "type": "spawnPipe",
                    "sessionId": "bad-spawn",
                    "argv": ["/bin/true"],
                    "cwd": os.path.join(cwd, "missing"),
                }
            )
            ws.send_json(
                {
                    "type": "spawnPipe",
                    "sessionId": "good-spawn",
                    "argv": ["/bin/sh", "-c", "printf 'ok\\n'"],
                    "cwd": cwd,
                }
            )

            bad_error = None
            good_spawned = False
            good_exit = None
            output = bytearray()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and (
                bad_error is None or not good_spawned or good_exit is None
            ):
                message = ws.recv_json()
                if message.get("type") == "error" and message.get("sessionId") == "bad-spawn":
                    bad_error = message
                elif message.get("type") == "spawned" and message.get("sessionId") == "good-spawn":
                    good_spawned = True
                elif message.get("type") == "output" and message.get("sessionId") == "good-spawn":
                    output.extend(base64.b64decode(message["data"]))
                elif message.get("type") == "exit" and message.get("sessionId") == "good-spawn":
                    good_exit = message

            self.assertIsNotNone(bad_error)
            self.assertIn("cwd", bad_error["message"])
            self.assertTrue(good_spawned)
            self.assertIsNotNone(good_exit)
            self.assertEqual(good_exit["exitCode"], 0)
            self.assertEqual(bytes(output), b"ok\n")

    def test_spawned_child_does_not_inherit_helper_descriptors(self) -> None:
        ws = WebSocket(self.socket_path, TOKEN)
        self.addCleanup(ws.close)
        with tempfile.TemporaryDirectory() as cwd:
            ws.send_json(
                {
                    "type": "spawn",
                    "sessionId": "fd-sleeper",
                    "argv": ["/bin/sh", "-c", "sleep 30"],
                    "cwd": cwd,
                }
            )
            while True:
                message = ws.recv_json()
                if (
                    message.get("type") == "spawned"
                    and message.get("sessionId") == "fd-sleeper"
                ):
                    break

            # Keeping the exception-safe probe in argv avoids creating a script file
            # that could add its own descriptor and contaminate the observation.
            audit = (
                "import json,os\n"
                "leaked=[]\n"
                "for fd in range(3,256):\n"
                " try: os.fstat(fd)\n"
                " except OSError: continue\n"
                " leaked.append(fd)\n"
                "print(json.dumps(leaked,separators=(',',':')))\n"
            )

            def inherited_fds(kind: str, session_id: str) -> list[int]:
                ws.send_json(
                    {
                        "type": kind,
                        "sessionId": session_id,
                        "argv": [sys.executable, "-c", audit],
                        "cwd": cwd,
                    }
                )
                output = bytearray()
                exit_event = None
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and exit_event is None:
                    message = ws.recv_json()
                    if (
                        message.get("type") == "output"
                        and message.get("sessionId") == session_id
                    ):
                        output.extend(base64.b64decode(message["data"]))
                    elif (
                        message.get("type") == "exit"
                        and message.get("sessionId") == session_id
                    ):
                        exit_event = message
                self.assertIsNotNone(exit_event)
                self.assertEqual(exit_event["exitCode"], 0)
                return json.loads(bytes(output))

            for kind, session_id in (
                ("spawnPipe", "fd-audit-pipe"),
                ("spawn", "fd-audit-pty"),
            ):
                self.assertEqual(
                    inherited_fds(kind, session_id),
                    [],
                    f"{kind} agents must inherit only stdin, stdout, and stderr",
                )
            ws.send_json({"type": "close", "sessionId": "fd-sleeper"})

    def test_close_escalates_for_a_child_ignoring_hup_and_term(self) -> None:
        ws = WebSocket(self.socket_path, TOKEN)
        self.addCleanup(ws.close)
        with tempfile.TemporaryDirectory() as cwd:
            ws.send_json(
                {
                    "type": "spawnPipe",
                    "sessionId": "stubborn-close",
                    "argv": [
                        "/bin/sh",
                        "-c",
                        "trap '' HUP TERM; printf 'READY\\n'; while :; do :; done",
                    ],
                    "cwd": cwd,
                }
            )
            pid = None
            output = bytearray()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and (pid is None or b"READY\n" not in output):
                message = ws.recv_json()
                if message.get("type") == "spawned":
                    pid = message["pid"]
                elif message.get("type") == "output":
                    output.extend(base64.b64decode(message["data"]))
            self.assertIsNotNone(pid)
            self.assertIn(b"READY\n", output)

            ws.send_json({"type": "close", "sessionId": "stubborn-close"})
            closing = False
            exit_event = None
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and exit_event is None:
                message = ws.recv_json()
                if message.get("type") == "closing":
                    closing = True
                elif message.get("type") == "exit":
                    exit_event = message
            self.assertTrue(closing)
            self.assertIsNotNone(exit_event)
            self.assertEqual(exit_event["signal"], 9)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_large_nonblocking_input_is_queued_without_truncation(self) -> None:
        ws = WebSocket(self.socket_path, TOKEN)
        self.addCleanup(ws.close)
        with tempfile.TemporaryDirectory() as cwd:
            total = 240_000
            ws.send_json(
                {
                    "type": "spawnPipe",
                    "sessionId": "large-input",
                    "argv": [
                        "/bin/sh",
                        "-c",
                        "sleep 0.4; dd bs=1 count=240000 2>/dev/null | wc -c",
                    ],
                    "cwd": cwd,
                }
            )
            self.assertEqual(ws.recv_json()["type"], "spawned")
            for _ in range(4):
                ws.send_json(
                    {
                        "type": "input",
                        "sessionId": "large-input",
                        "encoding": "base64",
                        "data": base64.b64encode(b"x" * 60_000).decode(),
                    }
                )

            output = bytearray()
            exit_event = None
            errors: list[str] = []
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and exit_event is None:
                message = ws.recv_json()
                if message["type"] == "output":
                    output.extend(base64.b64decode(message["data"]))
                elif message["type"] == "error":
                    errors.append(message["message"])
                elif message["type"] == "exit":
                    exit_event = message

            self.assertEqual(errors, [])
            self.assertIsNotNone(exit_event)
            self.assertEqual(exit_event["exitCode"], 0)
            self.assertEqual(int(bytes(output).strip()), total)


class TokenFileTests(unittest.TestCase):
    def test_rejects_group_or_world_readable_token_file(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            token_path = Path(directory) / "token"
            socket_path = Path(directory) / "bridge.sock"
            token_path.write_text(TOKEN, encoding="utf-8")
            token_path.chmod(0o644)
            result = subprocess.run(
                [
                    str(HELPER),
                    "--socket",
                    str(socket_path),
                    "--token-file",
                    str(token_path),
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("private regular file", result.stderr)
            self.assertTrue(token_path.exists())


class GracefulShutdownTests(unittest.TestCase):
    def test_authenticated_shutdown_reaps_a_stubborn_child(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            root.chmod(0o700)
            socket_path = str(root / "bridge.sock")
            token_path = root / "token"
            token_path.write_text(TOKEN, encoding="utf-8")
            token_path.chmod(0o600)
            daemon = subprocess.Popen(
                [
                    str(HELPER),
                    "--socket",
                    socket_path,
                    "--token-file",
                    str(token_path),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            ws = None
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    try:
                        ws = WebSocket(socket_path, TOKEN)
                        break
                    except OSError:
                        if daemon.poll() is not None:
                            self.fail(daemon.stderr.read())
                        time.sleep(0.03)
                self.assertIsNotNone(ws)
                ws.send_json(
                    {
                        "type": "spawnPipe",
                        "sessionId": "stubborn-shutdown",
                        "argv": [
                            "/bin/sh",
                            "-c",
                            "trap '' HUP TERM; printf 'READY\\n'; while :; do :; done",
                        ],
                        "cwd": directory,
                    }
                )
                pid = None
                output = bytearray()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and (
                    pid is None or b"READY\n" not in output
                ):
                    message = ws.recv_json()
                    if message.get("type") == "spawned":
                        pid = message["pid"]
                    elif message.get("type") == "output":
                        output.extend(base64.b64decode(message["data"]))
                self.assertIsNotNone(pid)
                self.assertIn(b"READY\n", output)

                ws.send_json({"type": "shutdown"})
                self.assertEqual(ws.recv_json(), {"type": "shutdownAck"})
                self.assertEqual(daemon.wait(timeout=3), 0)
                self.assertFalse(Path(socket_path).exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if ws is not None:
                    try:
                        ws.sock.close()
                    except OSError:
                        pass
                if daemon.poll() is None:
                    daemon.kill()
                    daemon.wait(timeout=3)
                daemon.stderr.close()


class UnixSocketSecurityTests(unittest.TestCase):
    def test_rejects_socket_directory_accessible_to_other_users(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            root.chmod(0o755)
            token_path = root / "token"
            token_path.write_text(TOKEN, encoding="utf-8")
            token_path.chmod(0o600)
            result = subprocess.run(
                [
                    str(HELPER),
                    "--socket",
                    str(root / "bridge.sock"),
                    "--token-file",
                    str(token_path),
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cannot bind private socket", result.stderr)

    def test_refuses_to_replace_an_existing_socket_path(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            root.chmod(0o700)
            socket_path = root / "bridge.sock"
            socket_path.write_text("do not replace", encoding="utf-8")
            token_path = root / "token"
            token_path.write_text(TOKEN, encoding="utf-8")
            token_path.chmod(0o600)
            result = subprocess.run(
                [
                    str(HELPER),
                    "--socket",
                    str(socket_path),
                    "--token-file",
                    str(token_path),
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(socket_path.read_text(encoding="utf-8"), "do not replace")


class McpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.context = root / "context"
        self.library = root / "library"
        self.outside = root / "outside"
        self.context.mkdir()
        self.pdf_text = self.context / "current-pdf-text.txt"
        self.pdf_text.write_text(
            "first page introduction\fsecond page discusses intermediate-state "
            "scattering and dark paths\fthird page conclusion",
            encoding="utf-8",
        )
        (self.library / "Papers").mkdir(parents=True)
        self.outside.mkdir()
        (self.library / "Papers" / "Alpha Paper.pdf").write_bytes(b"pdf")
        (self.library / "Papers" / "Beta.PDF").write_bytes(b"PDF")
        (self.library / "Papers" / "notes.txt").write_text("notes", encoding="utf-8")
        (self.library / ".hidden.pdf").write_bytes(b"hidden")
        (self.library / ".secret").mkdir()
        (self.library / ".secret" / "Hidden Paper.pdf").write_bytes(b"hidden")
        (self.library / "__MACOSX").mkdir()
        (self.library / "__MACOSX" / "Metadata.pdf").write_bytes(b"hidden")
        (self.outside / "secret.pdf").write_bytes(b"secret")
        os.symlink(self.outside, self.library / "escape-link")
        self.write_context("selection one")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_context(self, selection: str) -> None:
        value = {
            "libraryRoot": str(self.library),
            "attachment": {"key": "ATTACH01"},
            "activePaper": {
                "title": "Alpha Paper",
                "pdfPath": str(self.library / "Papers" / "Alpha Paper.pdf"),
            },
            "currentPage": {"page": 4},
            "currentSelection": {"page": 4, "length": len(selection)},
            "pdfText": {
                "schemaVersion": 1,
                "path": str(self.pdf_text),
                "source": "pdf-worker",
                "characters": self.pdf_text.stat().st_size,
                "totalPages": 3,
                "truncated": False,
            },
        }
        (self.context / "context.json").write_text(
            json.dumps(value, indent=2), encoding="utf-8"
        )
        (self.context / "current-page.md").write_text("page four", encoding="utf-8")
        (self.context / "current-selection.md").write_text(selection, encoding="utf-8")

    def call(self, requests: list[dict]) -> list[dict]:
        payload = "".join(json.dumps(request, separators=(",", ":")) + "\n" for request in requests)
        result = subprocess.run(
            [str(HELPER), "--mcp-stdio", "--context", str(self.context)],
            input=payload,
            text=True,
            capture_output=True,
            timeout=5,
            check=True,
        )
        lines = result.stdout.splitlines()
        expected_responses = sum("id" in request for request in requests)
        self.assertEqual(
            len(lines),
            expected_responses,
            "each JSON-RPC response must occupy exactly one physical stdout line",
        )
        return [json.loads(line) for line in lines]

    def test_initialize_tools_and_read_only_context(self) -> None:
        responses = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "zotkit-test", "version": "1.0"},
                    },
                },
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "get_active_paper", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "get_current_page", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "get_current_selection", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 6,
                    "method": "tools/call",
                    "params": {"name": "get_reader_context", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "tools/call",
                    "params": {
                        "name": "search_current_pdf",
                        "arguments": {"query": "scattering"},
                    },
                },
                {
                    "jsonrpc": "2.0",
                    "id": 8,
                    "method": "tools/call",
                    "params": {
                        "name": "read_pdf_pages",
                        "arguments": {"start_page": 2, "end_page": 3},
                    },
                },
            ]
        )
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "zotkit-reader")
        self.assertEqual(responses[0]["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("active Zotero PDF Reader", responses[0]["result"]["instructions"])
        names = {tool["name"] for tool in responses[1]["result"]["tools"]}
        self.assertEqual(
            names,
            {
                "get_reader_context",
                "get_active_paper",
                "get_current_page",
                "get_current_selection",
                "search_current_pdf",
                "read_pdf_pages",
                "list_library_files",
                "search_library_files",
            },
        )
        for tool in responses[1]["result"]["tools"]:
            self.assertEqual(
                tool["annotations"],
                {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "idempotentHint": True,
                    "openWorldHint": False,
                },
            )
        self.assertEqual(responses[2]["result"]["structuredContent"]["activePaper"]["title"], "Alpha Paper")
        self.assertEqual(responses[3]["result"]["structuredContent"]["text"], "page four")
        self.assertEqual(responses[4]["result"]["structuredContent"]["text"], "selection one")
        combined = responses[5]["result"]["structuredContent"]
        self.assertEqual(combined["activePaper"]["title"], "Alpha Paper")
        self.assertEqual(combined["currentPageText"], "page four")
        self.assertEqual(combined["currentSelectionText"], "selection one")
        searched = responses[6]["result"]["structuredContent"]
        self.assertEqual(searched["matches"][0]["pageNumber"], 2)
        self.assertIn("scattering", searched["matches"][0]["snippet"])
        pages = responses[7]["result"]["structuredContent"]
        self.assertEqual([page["pageNumber"] for page in pages["pages"]], [2, 3])
        self.assertIn("dark paths", pages["pages"][0]["text"])

    def test_library_boundary_listing_and_search(self) -> None:
        responses = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "list_library_files", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "search_library_files", "arguments": {"query": "alpha"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "list_library_files", "arguments": {"path": "../outside"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "list_library_files", "arguments": {"path": "escape-link"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "list_library_files", "arguments": {"path": ".secret"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 6,
                    "method": "tools/call",
                    "params": {"name": "list_library_files", "arguments": {"path": "__MACOSX"}},
                },
            ]
        )
        listed = {entry["path"] for entry in responses[0]["result"]["structuredContent"]["files"]}
        self.assertEqual(listed, {"Papers/Alpha Paper.pdf", "Papers/Beta.PDF"})
        searched = responses[1]["result"]["structuredContent"]["files"]
        self.assertEqual([entry["path"] for entry in searched], ["Papers/Alpha Paper.pdf"])
        self.assertTrue(responses[2]["result"]["isError"])
        self.assertTrue(responses[3]["result"]["isError"])
        self.assertTrue(responses[4]["result"]["isError"])
        self.assertTrue(responses[5]["result"]["isError"])
        self.assertNotIn("secret.pdf", json.dumps(responses))
        self.assertNotIn("Hidden Paper.pdf", json.dumps(responses))
        self.assertNotIn("Metadata.pdf", json.dumps(responses))

    def test_reads_zotero_index_in_place_only_for_the_active_attachment_key(self) -> None:
        index_directory = self.context.parent / "ATTACH01"
        index_directory.mkdir()
        index_path = index_directory / ".zotero-ft-cache"
        index_path.write_text(
            "indexed first page\findexed second page with Rydberg scattering",
            encoding="utf-8",
        )
        context_path = self.context / "context.json"
        context = json.loads(context_path.read_text(encoding="utf-8"))
        context["pdfText"] = {
            "schemaVersion": 1,
            "path": str(index_path),
            "source": "indexed-fulltext",
            "totalPages": 2,
            "truncated": False,
        }
        context_path.write_text(json.dumps(context, indent=2), encoding="utf-8")

        response = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "search_current_pdf",
                        "arguments": {"query": "Rydberg"},
                    },
                }
            ]
        )[0]
        self.assertFalse(response["result"]["isError"])
        self.assertEqual(
            response["result"]["structuredContent"]["matches"][0]["pageNumber"],
            2,
        )

        context["attachment"]["key"] = "DIFFERENT"
        context_path.write_text(json.dumps(context, indent=2), encoding="utf-8")
        rejected = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "read_pdf_pages",
                        "arguments": {"start_page": 1, "end_page": 1},
                    },
                }
            ]
        )[0]
        self.assertTrue(rejected["result"]["isError"])
        self.assertIn(
            "does not match the active attachment",
            rejected["result"]["content"][0]["text"],
        )

    def test_pdf_page_response_is_bounded_after_nested_json_escaping(self) -> None:
        self.pdf_text.write_text(
            ("\x01\"\\\n" * 100_000) + "tail",
            encoding="utf-8",
        )
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "read_pdf_pages",
                "arguments": {"start_page": 1, "end_page": 1},
            },
        }
        result = subprocess.run(
            [str(HELPER), "--mcp-stdio", "--context", str(self.context)],
            input=json.dumps(request, separators=(",", ":")) + "\n",
            text=True,
            capture_output=True,
            timeout=5,
            check=True,
        )
        encoded = result.stdout.encode("utf-8")
        self.assertLessEqual(
            len(encoded),
            512 * 1024,
            "the complete JSON-RPC line must stay bounded after both JSON encodings",
        )
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        response = json.loads(lines[0])["result"]
        self.assertFalse(response["isError"])
        structured = response["structuredContent"]
        self.assertTrue(structured["pages"][0]["truncated"])
        self.assertLessEqual(
            structured["output"]["escapedBytes"],
            structured["output"]["escapedByteLimit"],
        )

    def test_pdf_search_scans_many_form_feed_pages_in_one_pass(self) -> None:
        page_count = 50_000
        self.pdf_text.write_text(
            "\f".join(["short page"] * (page_count - 1) + ["last-page needle"]),
            encoding="utf-8",
        )
        context_path = self.context / "context.json"
        context = json.loads(context_path.read_text(encoding="utf-8"))
        context["pdfText"]["totalPages"] = page_count
        context_path.write_text(json.dumps(context, indent=2), encoding="utf-8")

        response = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "search_current_pdf",
                        "arguments": {"query": "last-page needle"},
                    },
                }
            ]
        )[0]["result"]["structuredContent"]

        self.assertEqual(response["pagesSearched"], page_count)
        self.assertEqual(response["matches"][0]["pageNumber"], page_count)

    def test_pdf_search_handles_eight_mibibyte_kmp_near_match_under_timeout(self) -> None:
        prefix_size = 8 * 1024 * 1024
        self.pdf_text.write_bytes((b"a" * prefix_size) + b"b")
        query = ("A" * 511) + "B"
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "search_current_pdf",
                "arguments": {"query": query, "limit": 1},
            },
        }
        result = subprocess.run(
            [str(HELPER), "--mcp-stdio", "--context", str(self.context)],
            input=json.dumps(request, separators=(",", ":")) + "\n",
            text=True,
            capture_output=True,
            timeout=3,
            check=True,
        )
        response = json.loads(result.stdout)["result"]["structuredContent"]
        self.assertEqual(response["matches"][0]["pageNumber"], 1)
        self.assertEqual(response["matches"][0]["matchStart"], prefix_size - 511)
        self.assertEqual(response["matches"][0]["matchLength"], 512)

    def test_pdf_search_folds_ascii_only_and_keeps_utf8_bytes_exact(self) -> None:
        self.pdf_text.write_text("ASCII Mixed Case; Ä only", encoding="utf-8")
        responses = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "search_current_pdf",
                        "arguments": {"query": "ascii mixed case"},
                    },
                },
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "search_current_pdf",
                        "arguments": {"query": "Ä"},
                    },
                },
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "search_current_pdf",
                        "arguments": {"query": "ä"},
                    },
                },
            ]
        )
        self.assertEqual(len(responses[0]["result"]["structuredContent"]["matches"]), 1)
        self.assertEqual(len(responses[1]["result"]["structuredContent"]["matches"]), 1)
        self.assertEqual(responses[2]["result"]["structuredContent"]["matches"], [])

    def test_context_is_reloaded_for_each_tool_call(self) -> None:
        process = subprocess.Popen(
            [str(HELPER), "--mcp-stdio", "--context", str(self.context)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "get_current_selection", "arguments": {}},
        }
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        first = json.loads(process.stdout.readline())
        self.assertEqual(first["result"]["structuredContent"]["text"], "selection one")

        self.write_context("selection two")
        request["id"] = 2
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        second = json.loads(process.stdout.readline())
        self.assertEqual(second["result"]["structuredContent"]["text"], "selection two")
        process.stdin.close()
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertEqual(
            process.stdout.read(),
            "",
            "continuous calls must not leave fragmented response lines behind",
        )
        process.stdout.close()
        process.stderr.close()

    def test_zoterochat_workspace_schema_works_without_library_root(self) -> None:
        context = {
            "schemaVersion": 1,
            "attachment": {"key": "ATTACH", "title": "Workspace Paper"},
            "parent": {"key": "PARENT", "title": "Parent Paper"},
            "pdfPath": "/read-only/example.pdf",
            "page": {"pageIndex": 2, "pageNumber": 3},
            "selection": {"text": "workspace selection", "pageNumber": 3},
        }
        (self.context / "context.json").write_text(
            json.dumps(context, indent=2), encoding="utf-8"
        )
        responses = self.call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "get_active_paper", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "get_current_page", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "list_library_files", "arguments": {}},
                },
            ]
        )
        active = responses[0]["result"]["structuredContent"]["activePaper"]
        self.assertEqual(active["attachment"]["key"], "ATTACH")
        self.assertEqual(active["parent"]["title"], "Parent Paper")
        self.assertEqual(active["pdfPath"], "/read-only/example.pdf")
        page = responses[1]["result"]["structuredContent"]["currentPage"]
        self.assertEqual(page["pageNumber"], 3)
        self.assertTrue(responses[2]["result"]["isError"])


class BundledZotkitTests(unittest.TestCase):
    """Exercise the read-only Zotkit surface shipped inside the XPI helper."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.reader_root = root / "reader-context"
        self.context = self.reader_root / "papers" / "1-ATTACH01"
        self.snapshots = self.reader_root / "library-snapshots"
        self.snapshot = self.snapshots / "1.jsonl"
        self.context.mkdir(parents=True)
        self.snapshots.mkdir(parents=True)

        records = [
            {
                "kind": "meta",
                "schemaVersion": 1,
                "generatedAt": "2026-07-22T10:00:00.000Z",
                "libraryID": 1,
                "complete": True,
                "itemCount": 3,
                "collectionCount": 2,
                "tagCount": 3,
            },
            {
                "kind": "collection",
                "value": {
                    "key": "COLL0001",
                    "name": "Research",
                    "parentKey": None,
                    "path": "Research",
                    "version": 1,
                },
            },
            {
                "kind": "collection",
                "value": {
                    "key": "COLL0002",
                    "name": "Quantum",
                    "parentKey": "COLL0001",
                    "path": "Research :: Quantum",
                    "version": 2,
                },
            },
            {"kind": "tag", "value": {"tag": "topic:quantum", "count": 1}},
            {"kind": "tag", "value": {"tag": "methods", "count": 1}},
            {"kind": "tag", "value": {"tag": "archive", "count": 1}},
            {
                "kind": "item",
                "topLevel": True,
                "value": {
                    "key": "ARTICLE1",
                    "itemType": "journalArticle",
                    "title": "Quantum Control Methods",
                    "creators": [
                        {
                            "firstName": "Ada",
                            "lastName": "Lovelace",
                            "creatorType": "author",
                        }
                    ],
                    "date": "2026",
                    "publicationTitle": "Read-Only Physics",
                    "DOI": "10.1000/quantum",
                    "url": "https://example.invalid/quantum",
                    "abstractNote": "A test record for local metadata search.",
                    "language": "en",
                    "tags": ["topic:quantum", "methods"],
                    "collections": ["Quantum"],
                    "collectionKeys": ["COLL0002"],
                    "version": 7,
                },
            },
            {
                "kind": "item",
                "topLevel": True,
                "value": {
                    "key": "BOOK0001",
                    "itemType": "book",
                    "title": "Classical Archive",
                    "creators": [],
                    "date": "2020",
                    "publicationTitle": "",
                    "DOI": "",
                    "url": "",
                    "abstractNote": "",
                    "language": "en",
                    "tags": ["archive"],
                    "collections": ["Research"],
                    "collectionKeys": ["COLL0001"],
                    "version": 3,
                },
            },
            {
                "kind": "item",
                "topLevel": False,
                "value": {
                    "key": "ATTACH01",
                    "itemType": "attachment",
                    "title": "Quantum Control Methods.pdf",
                    "creators": [],
                    "date": "",
                    "publicationTitle": "",
                    "DOI": "",
                    "url": "",
                    "abstractNote": "",
                    "language": "",
                    "tags": [],
                    "collections": [],
                    "collectionKeys": [],
                    "version": 4,
                    "parentItem": "ARTICLE1",
                    "filename": "Quantum Control Methods.pdf",
                    "contentType": "application/pdf",
                },
            },
        ]
        self.snapshot.write_text(
            "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in records),
            encoding="utf-8",
        )
        context = {
            "schemaVersion": 1,
            "attachment": {"key": "ATTACH01", "title": "Quantum Control Methods.pdf"},
            "parent": {"key": "ARTICLE1", "title": "Quantum Control Methods"},
            "pdfPath": "/read-only/Quantum Control Methods.pdf",
            # The Zotkit-only server must not require an external PDF library root.
            "libraryRoot": str(root / "intentionally-missing-library-root"),
            "zotkitLibrarySnapshot": {
                "path": str(self.snapshot),
                "libraryID": 1,
                "complete": True,
            },
        }
        (self.context / "context.json").write_text(
            json.dumps(context, indent=2), encoding="utf-8"
        )

        self.zotkit = root / "bin" / "zotkit"
        self.zotkit.parent.mkdir()
        shutil.copy2(HELPER, self.zotkit)
        self.zotkit.chmod(0o700)
        self.cli_env = os.environ.copy()
        self.cli_env.update(
            {
                "ZOTKIT_READER_CONTEXT": str(self.context),
                "ZOTKIT_SNAPSHOT": str(self.snapshot),
            }
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def mcp_call(self, requests: list[dict], *, via_cli: bool = False) -> list[dict]:
        payload = "".join(
            json.dumps(request, separators=(",", ":")) + "\n" for request in requests
        )
        command = (
            [str(self.zotkit), "mcp", "--context", str(self.context)]
            if via_cli
            else [str(HELPER), "--zotkit-mcp", "--context", str(self.context)]
        )
        result = subprocess.run(
            command,
            input=payload,
            text=True,
            capture_output=True,
            timeout=5,
            check=True,
            env=self.cli_env if via_cli else None,
        )
        lines = result.stdout.splitlines()
        expected_responses = sum("id" in request for request in requests)
        self.assertEqual(
            len(lines),
            expected_responses,
            "each JSON-RPC response must occupy exactly one physical stdout line",
        )
        return [json.loads(line) for line in lines]

    def cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.zotkit), *arguments],
            text=True,
            capture_output=True,
            timeout=5,
            env=self.cli_env,
        )

    def test_zotkit_mcp_exposes_exactly_four_read_only_tools(self) -> None:
        responses = self.mcp_call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "zotkit-test", "version": "1.0"},
                    },
                },
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "zotkit_move_item", "arguments": {}},
                },
            ]
        )
        initialized = responses[0]["result"]
        self.assertEqual(initialized["protocolVersion"], "2025-06-18")
        self.assertEqual(initialized["serverInfo"]["name"], "zotkit-library")
        self.assertIn("read-only", initialized["instructions"])

        tools = responses[1]["result"]["tools"]
        self.assertEqual(
            {tool["name"] for tool in tools},
            {
                "zotkit_find_items",
                "zotkit_get_item",
                "zotkit_list_collections",
                "zotkit_list_tags",
            },
        )
        for tool in tools:
            self.assertEqual(
                tool["annotations"],
                {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "idempotentHint": True,
                    "openWorldHint": False,
                },
            )
        self.assertEqual(len(tools), 4)
        self.assertTrue(all("read-only" in tool["description"] for tool in tools))
        self.assertTrue(responses[2]["result"]["isError"])
        self.assertIn("unknown read-only tool", responses[2]["result"]["content"][0]["text"])

    def test_zotkit_mcp_find_get_collections_and_tags(self) -> None:
        calls = [
            (
                "zotkit_find_items",
                {
                    "title": "quantum",
                    "tag": "topic:quantum",
                    "collection": "Research :: Quantum",
                },
            ),
            ("zotkit_get_item", {"key": "attach01"}),
            ("zotkit_list_collections", {}),
            ("zotkit_list_tags", {"query": "QUANT"}),
            ("zotkit_get_item", {"key": "bad-key!"}),
        ]
        responses = self.mcp_call(
            [
                {
                    "jsonrpc": "2.0",
                    "id": index,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                }
                for index, (name, arguments) in enumerate(calls, start=1)
            ]
        )
        found = responses[0]["result"]["structuredContent"]
        self.assertEqual(found["count"], 1)
        self.assertEqual(found["total"], 1)
        self.assertFalse(found["truncated"])
        self.assertEqual([item["key"] for item in found["items"]], ["ARTICLE1"])
        self.assertNotIn("ATTACH01", json.dumps(found))

        attachment = responses[1]["result"]["structuredContent"]["item"]
        self.assertEqual(attachment["key"], "ATTACH01")
        self.assertEqual(attachment["parentItem"], "ARTICLE1")

        collections = responses[2]["result"]["structuredContent"]
        self.assertEqual(collections["count"], 2)
        self.assertEqual(
            [entry["path"] for entry in collections["collections"]],
            ["Research", "Research :: Quantum"],
        )

        tags = responses[3]["result"]["structuredContent"]
        self.assertEqual(tags["count"], 1)
        self.assertEqual(tags["tags"], [{"tag": "topic:quantum", "count": 1}])

        self.assertTrue(responses[4]["result"]["isError"])
        self.assertIn(
            "key must be exactly 8 ASCII letters or digits",
            responses[4]["result"]["content"][0]["text"],
        )

    def test_basename_zotkit_cli_queries_snapshot_and_rejects_writes(self) -> None:
        help_result = self.cli("--help")
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("bundled with the Zotero XPI", help_result.stdout)
        self.assertIn("There are no create, tag, move, attach, fetch, or delete commands", help_result.stdout)

        find_result = self.cli(
            "find",
            "--title",
            "QUANTUM",
            "--tag",
            "topic:quantum",
            "--collection",
            "Research :: Quantum",
            "--json",
        )
        self.assertEqual(find_result.returncode, 0, find_result.stderr)
        self.assertEqual(json.loads(find_result.stdout)["items"][0]["key"], "ARTICLE1")

        get_result = self.cli("get", "attach01")
        self.assertEqual(get_result.returncode, 0, get_result.stderr)
        self.assertEqual(json.loads(get_result.stdout)["item"]["key"], "ATTACH01")

        collections_result = self.cli("collections", "--limit", "1")
        self.assertEqual(collections_result.returncode, 0, collections_result.stderr)
        collections = json.loads(collections_result.stdout)
        self.assertEqual(collections["count"], 1)
        self.assertEqual(collections["total"], 2)
        self.assertTrue(collections["truncated"])

        tags_result = self.cli("tags", "--query", "quant")
        self.assertEqual(tags_result.returncode, 0, tags_result.stderr)
        self.assertEqual(
            json.loads(tags_result.stdout)["tags"],
            [{"tag": "topic:quantum", "count": 1}],
        )

        bad_key = self.cli("get", "short")
        self.assertEqual(bad_key.returncode, 1)
        self.assertIn("key must be exactly 8 ASCII letters or digits", bad_key.stderr)

        write_attempt = self.cli("move", "ARTICLE1", "COLL0001")
        self.assertEqual(write_attempt.returncode, 2)
        self.assertIn("unknown read-only command 'move'", write_attempt.stderr)

    def test_zotkit_cli_mcp_and_helper_mcp_modes_are_unambiguous(self) -> None:
        responses = self.mcp_call(
            [{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}],
            via_cli=True,
        )
        self.assertEqual(len(responses[0]["result"]["tools"]), 4)

        result = subprocess.run(
            [
                str(HELPER),
                "--mcp-stdio",
                "--zotkit-mcp",
                "--context",
                str(self.context),
            ],
            text=True,
            capture_output=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("Usage:", result.stderr)

    def test_zotkit_mcp_accepts_a_bounded_long_cjk_collection_path(self) -> None:
        records = [json.loads(line) for line in self.snapshot.read_text(encoding="utf-8").splitlines()]
        long_path = "量" * 1500
        records.insert(
            3,
            {
                "kind": "collection",
                "value": {
                    "key": "COLL0003",
                    "name": "量子",
                    "parentKey": None,
                    "path": long_path,
                    "version": 1,
                },
            },
        )
        article = next(
            record["value"]
            for record in records
            if record.get("kind") == "item" and record["value"].get("key") == "ARTICLE1"
        )
        article["collections"].append("量子")
        article["collectionKeys"].append("COLL0003")
        self.snapshot.write_text(
            "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records),
            encoding="utf-8",
        )

        response = self.mcp_call(
            [{
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "zotkit_find_items",
                    "arguments": {"collection": long_path},
                },
            }]
        )[0]
        self.assertFalse(response["result"]["isError"])
        self.assertEqual(
            [item["key"] for item in response["result"]["structuredContent"]["items"]],
            ["ARTICLE1"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
