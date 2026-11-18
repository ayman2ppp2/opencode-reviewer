import base64
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from device import relay


def catalog(price=0):
    return relay.UpstreamResponse(200, "application/json", json.dumps({
        "data": [{"id": relay.MODEL, "cost": {"text": {
            "input": {"price": price}, "output": {"price": 0}
        }}}]
    }).encode())


class FixtureTransport:
    def __init__(self):
        self.calls = []
        self.catalog = catalog()
        self.response = relay.UpstreamResponse(
            200, "text/event-stream; charset=utf-8",
            b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'
        )
        self.error = None

    def __call__(self, method, url, headers, body, *, max_bytes, timeout):
        self.calls.append((method, url, headers, body, max_bytes, timeout))
        if self.error:
            raise self.error
        return self.catalog if url == relay.CATALOG_URL else self.response


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.token_path = Path(self.temp.name) / "token"
        self.token = secrets.token_hex(32)
        self.token_path.write_text(self.token + "\n")
        self.token_path.chmod(0o600)
        self.transport = FixtureTransport()
        self.server = relay.make_server(
            relay.Config(str(self.token_path), port=0), transport=self.transport)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.port = self.server.server_address[1]
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, method="POST", path="/v1/relay", body=None, headers=None):
        if body is None:
            body = json.dumps({"model": relay.MODEL, "messages": [], "stream": True}).encode()
        request_headers = {"x-reviewer-relay-key": self.token,
                           "Content-Type": "application/json"}
        if headers:
            request_headers.update(headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def raw(self, headers, path="/v1/relay", body=b""):
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as sock:
            sock.sendall(f"POST {path} HTTP/1.1\r\nHost: localhost\r\n".encode()
                         + f"x-reviewer-relay-key: {self.token}\r\n".encode()
                         + headers + b"\r\n" + body)
            sock.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(sock)
            response.begin()
            return response.status, response.read()

    def test_loopback_health_authenticated_without_provider(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(self.request("GET", "/health"), (200, {"ok": True}))
        self.assertEqual(self.request("GET", "/health",
                                     headers={"x-reviewer-relay-key": "wrong"})[0], 403)
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request("GET", "/health")
        self.assertEqual(connection.getresponse().status, 403)
        connection.close()
        self.assertEqual(self.transport.calls, [])

    def test_paths_are_exact_and_queries_schemes_denied(self):
        for method, path in [
            ("GET", "/health?"), ("GET", "/health?check=1"),
            ("POST", "/v1/relay?"), ("POST", "/v1/relay/"),
            ("POST", "//v1/relay"), ("POST", "/v1/%72elay"),
            ("POST", "https://example.com/v1/relay"),
            ("POST", "http://localhost/v1/relay"),
            ("POST", "file:///v1/relay"), ("POST", "/health"),
        ]:
            with self.subTest(path=path):
                self.assertEqual(self.request(method, path)[0], 404)
        self.assertEqual(self.transport.calls, [])

    def test_duplicate_auth_rejected(self):
        status, _ = self.raw(
            f"x-reviewer-relay-key: {self.token}\r\nContent-Length: 0\r\n".encode())
        self.assertEqual(status, 403)
        self.assertEqual(self.transport.calls, [])

    def test_sse_envelope_can_be_reconstructed(self):
        status, envelope = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(set(envelope), {"version", "status", "contentType", "bodyBase64"})
        self.assertIs(type(envelope["version"]), int)
        self.assertEqual(envelope["version"], 1)
        self.assertEqual(envelope["status"], 200)
        self.assertEqual(envelope["contentType"], self.transport.response.content_type)
        self.assertEqual(base64.b64decode(envelope["bodyBase64"], validate=True),
                         self.transport.response.body)
        self.assertEqual([(call[0], call[1], call[4]) for call in
                          self.transport.calls], [
            ("GET", relay.CATALOG_URL, 2_000_000),
            ("POST", relay.INFERENCE_URL, 1_000_000),
        ])
        self.assertEqual(self.transport.calls[0][5], 90)
        self.assertGreater(self.transport.calls[1][5], 0)
        self.assertLessEqual(self.transport.calls[1][5], 90)

    def test_quota_is_preserved_not_retried_and_not_a_local_budget_status(self):
        self.transport.response = relay.UpstreamResponse(
            429, "application/json", b'{"error":{"message":"quota"}}')
        status, envelope = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(envelope["version"], 1)
        self.assertEqual(envelope["status"], 429)
        self.assertEqual(base64.b64decode(envelope["bodyBase64"]),
                         self.transport.response.body)
        self.assertEqual(len(self.transport.calls), 2)
        self.assertEqual(self.request("GET", "/health")[0], 200)
        self.assertEqual(len(self.transport.calls), 2)

    def test_credentials_stripped_and_headers_allowlisted(self):
        body = ('{ "model": "' + relay.MODEL + '", "messages": [] }').encode()
        self.assertEqual(self.request(body=body, headers={
            "Authorization": "Bearer paid", "Cookie": "paid",
            "Proxy-Authorization": "paid", "X-Api-Key": "paid",
            "User-Agent": "reviewer", "X-OpenCode-Session": "session",
            "X-OpenCode-SecretKey": "paid", "X-OpenCode-Api-Key": "paid",
            "X-OpenCode-Token": "paid", "X-Other": "paid",
        })[0], 200)
        post = self.transport.calls[1]
        self.assertEqual(post[2], {"Content-Type": "application/json",
                                   "user-agent": "reviewer",
                                   "x-opencode-session": "session"})
        self.assertEqual(post[3], body)
        self.assertEqual(self.transport.calls[0][2], {"Accept": "application/json"})
        self.transport.calls.clear()
        for key in ("api_key", "apiKey", "providerApiKey", "authorization",
                    "X-API-KEY", "x_api_key", "Cookie", "proxy_credentials"):
            self.assertEqual(self.request(body=json.dumps({"model": relay.MODEL, key: "paid"}).encode())[0], 403, key)
        for nested in (
            {"provider": {"apiKey": "paid"}},
            {"x": {"y": {"authorization": "paid"}}},
            {"messages": [{"role": "user", "provider": {"api_key": "paid"}}]},
            {"tools": [{"function": {"cookie": "paid"}}]},
        ):
            body = json.dumps({"model": relay.MODEL, **nested}).encode()
            self.assertEqual(self.request(body=body)[0], 403, body)
        self.assertEqual(self.transport.calls, [])

    def test_bad_json_and_paid_models_never_contact_provider(self):
        for body, expected in [
            (b'{"model":"paid"}', 403),
            (b'{"model":"' + relay.MODEL.encode() + b'","model":"paid"}', 400),
            (b'{"model":"' + relay.MODEL.encode() + b'","nested":{"a":1,"a":2}}', 400),
            (b"\xff", 400), (b"[]", 403), (b"{", 400),
            (b'{"model":"' + relay.MODEL.encode() + b'","stream":1}', 400),
            (b'{"model":"' + relay.MODEL.encode() + b'","a":NaN}', 400),
            (b'{"model":"' + relay.MODEL.encode() + b'","a":1e999}', 400),
        ]:
            with self.subTest(body=body):
                self.assertEqual(self.request(body=body)[0], expected)
        self.assertEqual(self.transport.calls, [])

    def test_request_framing_and_size_limits(self):
        for headers, expected in [
            (b"Content-Length: 0\r\nContent-Length: 0\r\n", 400),
            (b"Transfer-Encoding: chunked\r\nContent-Length: 0\r\n", 400),
            (b"Transfer-Encoding: identity\r\n", 400),
            (b"", 400),
            (b"Content-Length: -1\r\n", 400),
            (b"Content-Length: 1500001\r\n", 413),
            (b"Content-Length: 9999999999\r\n", 413),
            (b"Content-Length: 3\r\nContent-Type: application/json\r\n", 400),
            (b"Content-Length: 0\r\nContent-Type: text/plain\r\n", 415),
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.raw(headers)[0], expected)
        self.assertEqual(self.transport.calls, [])

    def test_exact_request_size_limit_is_accepted(self):
        body = json.dumps({"model": relay.MODEL, "messages": []}).encode()
        body += b" " * (relay.MAX_REQUEST - len(body))
        self.assertEqual(self.request(body=body)[0], 200)
        self.assertEqual(len(self.transport.calls), 2)

    def test_catalog_checked_each_time_and_fails_closed(self):
        self.assertEqual(self.request()[0], 200)
        for response in [
            catalog(1), catalog(False), catalog("0"),
            relay.UpstreamResponse(302, "application/json", b"{}"),
            relay.UpstreamResponse(429, "application/json", b"{}"),
            relay.UpstreamResponse(200, "text/html", b"{}"),
            relay.UpstreamResponse(200, "application/json", b"{}"),
            relay.UpstreamResponse(200, "application/json", b"x" * 2_000_001),
        ]:
            self.transport.catalog = response
            before = len(self.transport.calls)
            self.assertEqual(self.request()[0], 503)
            self.assertEqual(len(self.transport.calls), before + 1)
        self.transport.catalog = catalog()
        self.assertEqual(self.request()[0], 200)

    def test_upstream_type_size_redirect_and_offline_fail_closed(self):
        for response in [
            relay.UpstreamResponse(200, "text/html", b"not JSON"),
            relay.UpstreamResponse(302, "application/json", b"{}"),
            relay.UpstreamResponse(200, "", b"{}"),
            relay.UpstreamResponse(200, "application/json", b"x" * 1_000_001),
        ]:
            self.transport.response = response
            self.assertEqual(self.request()[0], 503)
        self.transport.error = OSError("offline")
        before = len(self.transport.calls)
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(len(self.transport.calls), before + 1)

    def test_exact_response_limit_and_local_budget(self):
        self.transport.response = relay.UpstreamResponse(
            200, "application/json", b" " * relay.MAX_RESPONSE)
        self.assertEqual(self.request()[0], 200)
        self.transport.response = relay.UpstreamResponse(200, "application/json", b"{}")
        for _ in range(relay.MAX_REQUESTS - 1):
            self.assertEqual(self.request()[0], 200)
        before = len(self.transport.calls)
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(len(self.transport.calls), before)
        self.assertEqual(self.request("GET", "/health")[0], 200)

    def test_only_one_provider_operation_at_a_time(self):
        entered, release = threading.Event(), threading.Event()
        original = self.server.transport

        def blocked(*args, **kwargs):
            entered.set()
            release.wait(3)
            return original(*args, **kwargs)

        self.server.transport = blocked
        results = []
        thread = threading.Thread(target=lambda: results.append(self.request()[0]))
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.request()[0], 503)
            self.assertEqual(self.request("GET", "/health")[0], 200)
        finally:
            release.set()
            thread.join(3)
        self.assertEqual(results, [200])
        self.assertEqual(len(self.transport.calls), 2)

    def test_http_threads_are_bounded(self):
        acquired = []
        try:
            for _ in range(relay.MAX_THREADS):
                self.assertTrue(self.server.thread_slots.acquire(blocking=False))
                acquired.append(True)
            status, _ = self.raw(b"Content-Length: 0\r\n")
            self.assertEqual(status, 503)
        finally:
            for _ in acquired:
                self.server.thread_slots.release()
        self.assertEqual(self.transport.calls, [])

    def test_catalog_and_inference_share_one_deadline(self):
        original = self.server.transport

        def expired(*args, **kwargs):
            result = original(*args, **kwargs)
            clock[0] += 91
            return result

        clock = [100.0]
        self.server.transport = expired
        with patch.object(relay.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertEqual(self.request()[0], 503)
        self.assertEqual(len(self.transport.calls), 1)

    def test_no_prompts_credentials_or_transport_errors_logged(self):
        self.transport.error = ValueError("private-provider-detail")
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            status, body = self.request(body=json.dumps({
                "model": relay.MODEL, "messages": [
                    {"role": "user", "content": "private-prompt"}
                ]
            }).encode())
        self.assertEqual(status, 503)
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn("private", json.dumps(body))


class TokenAndTransportTests(unittest.TestCase):
    def test_stalled_network_wait_is_bounded_and_cannot_start_another_worker(self):
        entered, release = threading.Event(), threading.Event()

        def stalled(*args):
            entered.set()
            release.wait(3)
            return catalog()

        with patch.object(relay, "_network_exchange", side_effect=stalled):
            try:
                started = time.monotonic()
                with self.assertRaises(TimeoutError):
                    relay.network_transport("GET", relay.CATALOG_URL, {}, None,
                                            max_bytes=relay.MAX_CATALOG, timeout=0.05)
                self.assertTrue(entered.is_set())
                self.assertLess(time.monotonic() - started, 1)
                with self.assertRaises(OSError):
                    relay.network_transport("GET", relay.CATALOG_URL, {}, None,
                                            max_bytes=relay.MAX_CATALOG, timeout=0.05)
            finally:
                release.set()
        self.assertTrue(relay._NETWORK_SLOT.acquire(timeout=2))
        relay._NETWORK_SLOT.release()

    def test_token_file_permissions_entropy_symlink_and_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            token = secrets.token_hex(32)
            path.write_text(token)
            path.chmod(0o600)
            self.assertEqual(relay.load_token(path), token)
            with patch.dict(os.environ, {"REVIEWER_RELAY_TOKEN_FILE": str(path)}):
                with relay.make_server(relay.Config(port=0), FixtureTransport()) as server:
                    self.assertEqual(server.token, token)
            for mode in (0o644, 0o400, 0o660):
                path.chmod(mode)
                with self.assertRaises(ValueError):
                    relay.load_token(path)
            path.chmod(0o600)
            with patch.object(relay.os, "getuid", return_value=os.getuid() + 1):
                with self.assertRaises(ValueError):
                    relay.load_token(path)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                relay.load_token(link)
            path.write_text("0123456789abcde" * 4 + "0123")
            self.assertEqual(relay.load_token(path), "0123456789abcde" * 4 + "0123")
            for bad in ("short", "a" * 64, "☃" * 43):
                path.write_text(bad)
                with self.assertRaises(ValueError):
                    relay.load_token(path)

    def test_transport_denies_any_non_fixed_url_before_connecting(self):
        with patch.object(http.client, "HTTPSConnection") as connect:
            for url in ("http://opencode.ai/inference/v1/models",
                        "https://evil.example/v1/chat/completions",
                        relay.CATALOG_URL + "?x=1", "file:///etc/passwd"):
                with self.assertRaises(ValueError):
                    relay.network_transport("GET", url, {}, None,
                                            max_bytes=100, timeout=90)
            connect.assert_not_called()

    def test_network_reader_is_bounded_and_never_follows_redirects(self):
        connection = Mock()
        response = connection.getresponse.return_value
        response.status = 302
        response.getheader.return_value = "application/json"
        response.read1.side_effect = [b"{}", b""]
        with patch.object(http.client, "HTTPSConnection", return_value=connection) as connect:
            result = relay.network_transport(
                "GET", relay.CATALOG_URL, {}, None, max_bytes=10, timeout=1)
        self.assertEqual(result.status, 302)
        self.assertEqual(result.body, b"{}")
        connect.assert_called_once()
        connection.request.assert_called_once_with(
            "GET", "/inference/v1/models", body=None, headers={})
        connection.close.assert_called_once()
        response.read1.side_effect = [b"x" * 11]
        with patch.object(http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaises(ValueError):
                relay.network_transport(
                    "GET", relay.CATALOG_URL, {}, None, max_bytes=10, timeout=1)

    def test_slow_dns_or_connect_cannot_send_a_late_inference(self):
        connection = Mock()
        with patch.object(http.client, "HTTPSConnection", return_value=connection):
            with patch.object(relay.time, "monotonic", side_effect=[0, 91]):
                with self.assertRaises(TimeoutError):
                    relay._network_exchange(
                        "POST", relay.urlsplit(relay.INFERENCE_URL), {}, b"{}",
                        relay.MAX_RESPONSE, 90)
        connection.request.assert_not_called()
        connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
