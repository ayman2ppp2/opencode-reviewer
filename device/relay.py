"""Loopback-only free inference relay, portable to Python 3.10+ and Termux.

Run with REVIEWER_RELAY_TOKEN_FILE pointing to an owner-only mode-0600 file
containing a randomly generated token from secrets.token_hex(32).
No token command-line argument is accepted. Catalog plus inference share a
90-second upstream deadline. A daemon worker bounds the caller's wait, including
DNS. Python cannot cancel OS DNS resolution or guarantee real-time scheduling;
a timed-out worker may survive, but blocks new network work until it finishes.
Responses are buffered JSON, never SSE over the tunnel. Restarting this process
resets its 100-request local budget.
"""

import base64
import argparse
import hmac
import http.client
import json
import math
import os
import queue
import re
import socket
import stat
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlsplit


MODEL = "deepseek-v4.1-flash-free"
CATALOG_URL = "https://opencode.ai/inference/v1/models"
CREDENTIAL_MARKERS = ("apikey", "authorization", "cookie", "credential")
MAX_DEPTH = 32
INFERENCE_URL = "https://opencode.ai/inference/openai/v1/chat/completions"
MAX_REQUEST = 1_500_000
MAX_CATALOG = 2_000_000
MAX_RESPONSE = 1_000_000
MAX_REQUESTS = 100
UPSTREAM_TIMEOUT = 90
MAX_THREADS = 4
_NETWORK_SLOT = threading.BoundedSemaphore(1)


@dataclass(frozen=True)
class Config:
    token_file: str | None = None
    port: int = 8787


@dataclass(frozen=True)
class UpstreamResponse:
    status: int
    content_type: str
    body: bytes


def load_token(path):
    """Read a regular, current-user-owned, exact-mode-0600 token file."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Token file must be owner-only mode 0600")
        token = file.read(258).strip()
    if not re.fullmatch(rb"[a-f0-9]{64}", token) or len(set(token)) < 8:
        raise ValueError("Token must be a randomly generated 256-bit hex secret")
    return token.decode("ascii")


def network_transport(method, url, headers, body, *, max_bytes, timeout):
    """Network injection boundary. Never follows redirects or uses env proxies."""
    if url not in (CATALOG_URL, INFERENCE_URL):
        raise ValueError("Upstream denied")
    target = urlsplit(url)
    if target.scheme != "https" or target.hostname != "opencode.ai":
        raise ValueError("Upstream denied")
    if timeout <= 0:
        raise TimeoutError("Upstream deadline")
    if not _NETWORK_SLOT.acquire(blocking=False):
        raise OSError("Previous network operation still pending")
    result = queue.Queue(maxsize=1)

    def run():
        try:
            outcome = (_network_exchange(method, target, headers, body,
                                         max_bytes, timeout), None)
        except Exception as error:
            outcome = (None, error)
        finally:
            _NETWORK_SLOT.release()
        result.put(outcome)

    worker = threading.Thread(target=run, daemon=True)
    try:
        worker.start()
    except Exception:
        _NETWORK_SLOT.release()
        raise
    try:
        response, error = result.get(timeout=timeout)
    except queue.Empty:
        raise TimeoutError("Upstream deadline") from None
    if error:
        raise error
    return response


def _network_exchange(method, target, headers, body, max_bytes, timeout):
    deadline = time.monotonic() + timeout
    connection = http.client.HTTPSConnection(target.hostname, timeout=timeout)
    try:
        connection.connect()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Upstream deadline")
        upstream_socket = connection.sock
        upstream_socket.settimeout(remaining)
        connection.request(method, target.path, body=body, headers=headers)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Upstream deadline")
        upstream_socket.settimeout(remaining)
        response = connection.getresponse()
        chunks = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Upstream deadline")
            upstream_socket.settimeout(remaining)
            chunk = response.read1(min(65536, max_bytes + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > max_bytes:
                raise ValueError("Upstream body too large")
        return UpstreamResponse(
            response.status, response.getheader("Content-Type", ""), b"".join(chunks)
        )
    finally:
        connection.close()


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("Invalid JSON number")


def _json(body):
    return json.loads(body.decode("utf-8"), object_pairs_hook=_object,
                      parse_constant=_invalid_constant)


def _has_credentials(value, depth=0):
    """Reject credential-shaped keys at any nesting depth, including case variants."""
    if depth > MAX_DEPTH:
        raise ValueError("Payload nesting too deep")
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub("[^a-z0-9]", "", key.lower())
            if any(marker in normalized for marker in CREDENTIAL_MARKERS):
                return True
            if _has_credentials(child, depth + 1):
                return True
    elif isinstance(value, list):
        for child in value:
            if _has_credentials(child, depth + 1):
                return True
    return False


def _media_type(value):
    return value.split(";", 1)[0].strip().lower()


def _verify_catalog(response):
    if (response.status != 200 or len(response.body) > MAX_CATALOG
            or _media_type(response.content_type) != "application/json"):
        raise ValueError("Catalog unavailable")
    catalog = _json(response.body)
    models = [entry for entry in catalog["data"] if entry["id"] == MODEL]
    if len(models) != 1:
        raise ValueError("Free model missing or ambiguous")
    prices = models[0]["cost"]["text"]
    for direction in ("input", "output"):
        price = prices[direction]["price"]
        if type(price) not in (int, float) or not math.isfinite(price) or price != 0:
            raise ValueError("Free pricing not verified")
        cache = prices[direction].get("cache")
        if cache is not None:
            price = cache["read"]
            if type(price) not in (int, float) or price != 0:
                raise ValueError("Free cache pricing not verified")


class _RelayServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = MAX_THREADS

    def __init__(self, config, token, transport):
        self.token = token
        self.transport = transport
        self.provider_slot = threading.BoundedSemaphore(1)
        self.thread_slots = threading.BoundedSemaphore(MAX_THREADS)
        self.requests_used = 0
        super().__init__(("127.0.0.1", config.port), _Handler)

    def process_request(self, request, client_address):
        if not self.thread_slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\n"
                                b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.thread_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.thread_slots.release()

    def handle_error(self, request, client_address):
        # BaseServer prints exception details. Neither requests nor secrets belong in logs.
        pass


class _Handler(BaseHTTPRequestHandler):
    server_version = "ReviewerRelay"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        pass

    def _reply(self, status, body):
        self.close_connection = True
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def _authorized(self):
        values = self.headers.get_all("x-reviewer-relay-key", [])
        if (len(values) != 1
                or not hmac.compare_digest(values[0].encode(), self.server.token.encode())):
            self._reply(403, {"error": "Forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._authorized():
            return
        if self.path != "/health" or self.requestline.split()[1] != "/health":
            self._reply(404, {"error": "Route denied"})
            return
        self._reply(200, {"ok": True})

    def do_POST(self):
        if not self._authorized():
            return
        if self.path != "/v1/relay" or self.requestline.split()[1] != "/v1/relay":
            self._reply(404, {"error": "Route denied"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get_all("Transfer-Encoding"):
            self._reply(400, {"error": "Transfer encoding denied"})
            return
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0]):
            self._reply(400, {"error": "One content length required"})
            return
        length = int(lengths[0])
        if length > MAX_REQUEST:
            self._reply(413, {"error": "Request too large"})
            return
        if _media_type(self.headers.get("Content-Type", "")) != "application/json":
            self._reply(415, {"error": "JSON required"})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Truncated request")
            payload = _json(raw)
            if not isinstance(payload, dict) or payload.get("model") != MODEL:
                self._reply(403, {"error": "Only the pinned free model is allowed"})
                return
            if "stream" in payload and type(payload["stream"]) is not bool:
                raise ValueError("Invalid stream flag")
            if _has_credentials(payload):
                self._reply(403, {"error": "Provider credentials are not accepted"})
                return
            json.dumps(payload, allow_nan=False)
            body = raw
        except (ValueError, UnicodeError, RecursionError, socket.timeout):
            self._reply(400, {"error": "Invalid request JSON"})
            return
        if not self.server.provider_slot.acquire(blocking=False):
            self._reply(503, {"error": "Relay busy"})
            return
        if self.server.requests_used >= MAX_REQUESTS:
            self.server.provider_slot.release()
            self._reply(503, {"error": "Local request budget exhausted"})
            return
        try:
            self.server.requests_used += 1
            deadline = time.monotonic() + UPSTREAM_TIMEOUT
            catalog = self.server.transport(
                "GET", CATALOG_URL, {"Accept": "application/json"}, None,
                max_bytes=MAX_CATALOG, timeout=UPSTREAM_TIMEOUT)
            _verify_catalog(catalog)
            headers = {"Content-Type": "application/json"}
            for name, value in self.headers.items():
                name = name.lower()
                if (name == "user-agent" or
                    (name.startswith("x-opencode-") and not any(
                        word in name for word in
                        ("key", "secret", "token", "auth", "cookie", "credential")))):
                    if len(self.headers.get_all(name)) == 1:
                        headers[name] = value
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Upstream deadline")
            response = self.server.transport(
                "POST", INFERENCE_URL, headers, body,
                max_bytes=MAX_RESPONSE, timeout=remaining)
            if time.monotonic() > deadline:
                raise TimeoutError("Upstream deadline")
            if (not 200 <= response.status <= 599
                    or 300 <= response.status <= 399
                    or len(response.body) > MAX_RESPONSE
                    or _media_type(response.content_type) not in
                    ("application/json", "text/event-stream")):
                raise ValueError("Invalid upstream response")
            status, output = 200, {
                "version": 1,
                "status": response.status,
                "contentType": response.content_type,
                "bodyBase64": base64.b64encode(response.body).decode("ascii"),
            }
        except Exception:
            status, output = 503, {"error": "Free inference unavailable; no fallback"}
        finally:
            self.server.provider_slot.release()
        self._reply(status, output)


def make_server(config=Config(), transport=network_transport):
    """Create an unstarted loopback server; injected transport performs no retries.

    The transport signature is (method, url, headers, body, *, max_bytes, timeout)
    and returns UpstreamResponse. Config(port=0) supports isolated HTTP tests.
    """
    path = config.token_file or os.environ.get("REVIEWER_RELAY_TOKEN_FILE")
    if not path:
        raise ValueError("REVIEWER_RELAY_TOKEN_FILE is required")
    return _RelayServer(config, load_token(path), transport)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Use an unprivileged port between 1024 and 65535")
    try:
        server = make_server(Config(port=args.port))
    except (OSError, ValueError):
        raise SystemExit("Relay startup failed; check the owner-only token file and port")
    with server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
