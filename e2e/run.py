#!/usr/bin/env python3
"""Run the client in headless Chrome against a real kdoq process.

Point KDOQ_BIN (or --server) at a built `kdoq` binary. Requires OpenSSL, Bun and a Chromium
executable (--browser or KDOQ_BROWSER). A self-signed development certificate is created per run
and trusted only through `serverCertificateHashes`.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default=os.environ.get("KDOQ_BROWSER", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    parser.add_argument("--server", default=os.environ.get("KDOQ_BIN", "kdoq"))
    args = parser.parse_args()
    result = {}
    completed = threading.Event()
    with tempfile.TemporaryDirectory(prefix="kdoq-js-e2e-") as temporary:
        directory = Path(temporary)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                        "-nodes", "-keyout", str(directory / "key.pem"), "-out", str(directory / "cert.pem"),
                        "-days", "7", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
                       check=True, capture_output=True)
        der = subprocess.check_output(["openssl", "x509", "-in", str(directory / "cert.pem"), "-outform", "DER"])
        subprocess.run(["bun", "build", str(HERE / "browser.ts"), "--target=browser", "--outfile", str(directory / "scenario.js")],
                       check=True, capture_output=True)
        config = {"hash": hashlib.sha256(der).hexdigest(), "username": "Alice", "password": "secret-marker"}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/config":
                    body, kind = json.dumps(config).encode(), "application/json"
                elif self.path == "/scenario.js":
                    body, kind = (directory / "scenario.js").read_bytes(), "text/javascript"
                else:
                    body, kind = b'<!doctype html><meta charset="utf-8"><pre></pre><script type="module" src="/scenario.js"></script>', "text/html"
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                result.update(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204)
                self.end_headers()
                completed.set()

            def log_message(self, *_):
                pass

        web = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=web.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{web.server_port}"
        config["origin"] = origin
        (directory / "db").mkdir()
        settings = {
            "data": {"path": "db"}, "http": {"listen": {"http": "127.0.0.1:0", "quic": "127.0.0.1:0"},
                     "tls": {"certificate": "cert.pem", "private_key": "key.pem", "allow_self_signed": True},
                     "cors": {"origins": [origin]}}, "logging": {"format": "json"},
            "auth": {"enabled": True, "users": [{"username": config["username"], "password": config["password"]}]},
            "native": {"enabled": True},
        }
        (directory / "config.yml").write_text(json.dumps(settings))
        process = subprocess.Popen([args.server, "--config", str(directory / "config.yml")],
                                   stderr=subprocess.PIPE, text=True)
        browser = None
        try:
            events = queue.Queue()

            def collect():
                for line in process.stderr:
                    try:
                        events.put(json.loads(line))
                    except ValueError:
                        pass
                events.put(None)

            threading.Thread(target=collect, daemon=True).start()
            while True:
                event = events.get(timeout=30)
                if event is None:
                    raise RuntimeError("server exited before READY")
                fields = event.get("fields", event)
                if fields.get("event") == "server_ready":
                    match = re.search(r"127\.0\.0\.1:(\d+)", fields["native_address"])
                    config["host"], config["port"] = "127.0.0.1", int(match[1])
                    config["http"] = re.search(r"127\.0\.0\.1:\d+", fields["address"])[0]
                    break
            browser = subprocess.Popen([
                args.browser, "--headless=new", "--no-proxy-server", "--no-first-run", "--no-default-browser-check",
                f"--user-data-dir={directory / 'browser'}", origin + "/"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if not completed.wait(60):
                raise RuntimeError("the browser scenario timed out")
            print(json.dumps(result, indent=2))
            if not result.get("ok"):
                raise SystemExit(1)
        finally:
            if browser:
                browser.terminate()
                browser.wait(timeout=10)
            process.terminate()
            process.wait(timeout=10)
            web.shutdown()


if __name__ == "__main__":
    main()
