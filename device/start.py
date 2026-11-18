"""Start one authenticated development relay and its temporary HTTPS tunnel."""

import argparse
import json
import os
from pathlib import Path
import queue
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error


def ensure_key(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.stat().st_mode & 0o077:
        raise ValueError("Relay state directory must have mode 700")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w") as output:
            output.write(secrets.token_hex(32))
    from relay import load_token
    return load_token(path)


def register(profile, url, token, repos, activate=False):
    prefix = "REVIEWER_LAPTOP_RELAY" if profile == "laptop" else "REVIEWER_ANDROID_RELAY"
    for repo in repos:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or any(v in (".", "..") for v in repo.split("/")):
            raise ValueError("Invalid repository")
    for repo in repos:
        for name, value in ((prefix + "_URL", url), (prefix + "_KEY", token)):
            subprocess.run(["gh", "secret", "set", name, "--repo", repo], input=value, text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if activate:
            subprocess.run(["gh", "variable", "set", "REVIEWER_EGRESS_PROFILE", "--body", profile, "--repo", repo], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def stop(child):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("laptop", "android"), required=True)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--repo", action="append", default=[])
    parser.add_argument("--register", action="store_true", help="Update explicitly selected repositories using authenticated gh")
    parser.add_argument("--activate", action="store_true", help="Explicitly make this profile the selected repositories' default")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Use an unprivileged port between 1024 and 65535")
    if args.activate and not args.register:
        parser.error("--activate requires --register")
    if args.register and not args.repo:
        parser.error("--register requires at least one --repo")
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    key_path = state_root / "opencode-reviewer" / args.profile / "relay.key"
    token = ensure_key(key_path)
    server = None
    tunnel = None
    interrupted = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: interrupted.set())
    signal.signal(signal.SIGINT, lambda *_: interrupted.set())
    try:
        keep = ("PATH", "HOME", "PREFIX", "TMPDIR", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG")
        env = {name: os.environ[name] for name in keep if name in os.environ}
        env["REVIEWER_RELAY_TOKEN_FILE"] = str(key_path)
        server = subprocess.Popen([sys.executable, str(Path(__file__).with_name("relay.py")), "--port", str(args.port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ready = False
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not interrupted.is_set():
            if server.poll() is not None:
                raise RuntimeError("Relay did not start")
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{args.port}/health", headers={"x-reviewer-relay-key": token})
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=1) as response:
                    ready = response.status == 200
                if ready:
                    break
            except (OSError, urllib.error.URLError):
                interrupted.wait(0.2)
        if not ready:
            raise RuntimeError("Relay readiness deadline exceeded")
        tunnel = subprocess.Popen(["cloudflared", "tunnel", "--config", "/dev/null", "--no-autoupdate", "--protocol", "http2", "--metrics", "127.0.0.1:0", "--url", f"http://127.0.0.1:{args.port}"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        lines = queue.Queue(maxsize=100)

        def receive():
            for line in tunnel.stderr:
                try:
                    lines.put(line[:4096], timeout=1)
                except queue.Full:
                    continue

        threading.Thread(target=receive, daemon=True).start()
        url = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not interrupted.is_set():
            if tunnel.poll() is not None:
                raise RuntimeError("Tunnel did not start")
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com\b", line)
            if match:
                url = match.group(0) + "/"
                break
        if not url:
            raise RuntimeError("Tunnel URL deadline exceeded")
        if args.register:
            register(args.profile, url, token, args.repo, args.activate)
        print(json.dumps({"profile": args.profile, "url": url, "keyFile": str(key_path), "registered": bool(args.register), "activeDefault": bool(args.activate)}), flush=True)
        while not interrupted.wait(1):
            if server.poll() is not None or tunnel.poll() is not None:
                raise RuntimeError("Relay or tunnel stopped. No other connection was selected")
    finally:
        stop(tunnel)
        stop(server)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print("Device relay startup or registration failed. Check dependencies, private state permissions, and gh access. No credentials were printed.", file=sys.stderr)
        sys.exit(1)
