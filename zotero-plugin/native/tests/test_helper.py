#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import unittest


HELPER = Path(os.environ.get("HELPER", Path(__file__).parents[1] / "build" / "zoterochat-helper"))
TOKEN = "native-helper-test-token-0123456789"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def recv_exact(sock: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise EOFError("socket closed")
        data.extend(chunk)
    return bytes(data)


class WebSocket:
    def __init__(self, port: int, token: str):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=3)
        self.sock.settimeout(5)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET /ws?token={token} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: keep-alive, Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
        self.sock.sendall(request)
        response = bytearray()
        while b"\r\n\r\n" not in response:
            response.extend(self.sock.recv(4096))
        expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        )
        self.assert_handshake(bytes(response), expected)

    @staticmethod
    def assert_handshake(response: bytes, expected: bytes) -> None:
        if not response.startswith(b"HTTP/1.1 101 "):
            raise AssertionError(response)
        if b"Sec-WebSocket-Accept: " + expected + b"\r\n" not in response:
            raise AssertionError("bad Sec-WebSocket-Accept")

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
        cls.port = free_port()
        cls.token_dir = tempfile.TemporaryDirectory()
        token_path = Path(cls.token_dir.name) / "helper-token"
        token_path.write_text(TOKEN + "\n", encoding="utf-8")
        token_path.chmod(0o600)
        cls.daemon = subprocess.Popen(
            [str(HELPER), "--port", str(cls.port), "--token-file", str(token_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if cls.daemon.poll() is not None:
                raise RuntimeError(cls.daemon.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.03)
        else:
            raise RuntimeError("daemon did not become ready")
        if token_path.exists():
            raise RuntimeError("daemon did not consume its token file")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.daemon.terminate()
        try:
            cls.daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.daemon.kill()
            cls.daemon.wait(timeout=3)
        cls.daemon.stderr.close()
        cls.token_dir.cleanup()

    def http(self, path: str, extra_headers: str = "") -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as sock:
            request = (
                f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
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
        response = self.http("/health", f"Authorization: Bearer {TOKEN}\r\n")
        self.assertTrue(response.startswith(b"HTTP/1.1 200 "))
        self.assertIn(b'"ok":true', response)

    def test_websocket_pty_io_resize_exit_and_multiple_sessions(self) -> None:
        ws = WebSocket(self.port, TOKEN)
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
        ws = WebSocket(self.port, TOKEN)
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

    def test_large_nonblocking_input_is_queued_without_truncation(self) -> None:
        ws = WebSocket(self.port, TOKEN)
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
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / "token"
            token_path.write_text(TOKEN, encoding="utf-8")
            token_path.chmod(0o644)
            result = subprocess.run(
                [str(HELPER), "--port", str(free_port()), "--token-file", str(token_path)],
                capture_output=True,
                text=True,
                timeout=3,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("private regular file", result.stderr)
            self.assertTrue(token_path.exists())


class McpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.context = root / "context"
        self.library = root / "library"
        self.outside = root / "outside"
        self.context.mkdir()
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
            "activePaper": {
                "title": "Alpha Paper",
                "pdfPath": str(self.library / "Papers" / "Alpha Paper.pdf"),
            },
            "currentPage": {"page": 4},
            "currentSelection": {"page": 4, "length": len(selection)},
        }
        (self.context / "context.json").write_text(json.dumps(value), encoding="utf-8")
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
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_initialize_tools_and_read_only_context(self) -> None:
        responses = self.call(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
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
            ]
        )
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "zotkit-reader")
        self.assertIn("active Zotero PDF Reader", responses[0]["result"]["instructions"])
        names = {tool["name"] for tool in responses[1]["result"]["tools"]}
        self.assertEqual(
            names,
            {
                "get_active_paper",
                "get_current_page",
                "get_current_selection",
                "list_library_files",
                "search_library_files",
            },
        )
        self.assertEqual(responses[2]["result"]["structuredContent"]["activePaper"]["title"], "Alpha Paper")
        self.assertEqual(responses[3]["result"]["structuredContent"]["text"], "page four")
        self.assertEqual(responses[4]["result"]["structuredContent"]["text"], "selection one")

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
        (self.context / "context.json").write_text(json.dumps(context), encoding="utf-8")
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
        (self.context / "context.json").write_text(json.dumps(context), encoding="utf-8")

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
        return [json.loads(line) for line in result.stdout.splitlines()]

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
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
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
