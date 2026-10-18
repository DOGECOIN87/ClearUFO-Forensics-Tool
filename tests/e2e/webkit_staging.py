"""Staging path in WebKit with the Origin Private File System switched on.

Playwright's WebKit build has the Storage API, OPFS and mock cameras disabled, so this test starts the
WPE MiniBrowser of the Playwright install directly with those features enabled and lets
tests/e2e/webkit-harness.html drive LUCID. The harness posts its checks, the downloaded files and the
application's frame hashes here; this script verifies the files with ffmpeg.

Usage: python3 tests/e2e/webkit_staging.py [media_dir]   (dev server on http://127.0.0.1:5199/, see README)
Env: URL (app server), LUCID_TMP (scratch dir), MINIBROWSER (path to the WPE MiniBrowser)."""
import glob, http.server, json, os, shutil, subprocess, sys, tempfile, threading, time
import imageio_ffmpeg

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lucid-testmedia"
FF = imageio_ffmpeg.get_ffmpeg_exe()
TMP = tempfile.mkdtemp(prefix="lucid-wk-", dir=os.environ.get("LUCID_TMP") or None)
MB = os.environ.get("MINIBROWSER") or (sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/webkit-*/minibrowser-wpe/MiniBrowser"))) or [""])[-1]
FEATURES = "+StorageAPI,+StorageAPIEstimate,+FileSystem,+FileSystemWritableStream,+AccessHandle,+MockCaptureDevices"
PORT = 8765
state = {"done": None}

class Handler(http.server.BaseHTTPRequestHandler):
    def cors(self, code=200, ctype="text/plain"):
        self.send_response(code); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Type", ctype); self.end_headers()
    def do_GET(self):
        if self.path.startswith("/media/"):
            p = os.path.join(MEDIA, os.path.basename(self.path))
            if os.path.isfile(p): self.cors(200, "application/octet-stream"); self.wfile.write(open(p, "rb").read()); return
        self.cors(404)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/log": print("  " + body.decode(errors="replace"), flush=True)
        elif self.path.startswith("/upload?name="): open(os.path.join(TMP, os.path.basename(self.path.split("=", 1)[1])), "wb").write(body)
        elif self.path == "/done": state["done"] = json.loads(body)
        self.cors()
    def log_message(self, *a): pass

def framemd5(path):
    r = subprocess.run([FF, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-pix_fmt", "rgb24", "-"], capture_output=True, text=True)
    return [l.split(",")[-1].strip() for l in r.stdout.splitlines() if l and not l.startswith("#")], r.stderr.strip()

def main():
    if not MB: sys.exit("WPE MiniBrowser not found (install Playwright's WebKit or set MINIBROWSER)")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    page = f"{URL.rstrip('/')}/tests/e2e/webkit-harness.html?results=http://127.0.0.1:{PORT}"
    profile = os.path.join(TMP, "profile")
    proc = subprocess.Popen([MB, "--headless", f"--user-data-dir={profile}", f"--features={FEATURES}", page], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=os.path.dirname(MB))
    t0 = time.time()
    try:
        while state["done"] is None and time.time() - t0 < 240 and proc.poll() is None: time.sleep(0.25)
    finally:
        proc.kill(); proc.wait(); srv.shutdown()
    res = state["done"]
    if res is None: sys.exit(f"no result from the harness (MiniBrowser exit {proc.returncode}): {proc.stderr.read().decode(errors='replace')[-600:]}")
    print(f"engine: {res.get('ua')}\nstaging: {json.dumps(res.get('staging'))}\ncamera: {res.get('camera')}")
    checks = [(c["name"], c["ok"]) for c in res["checks"]]
    if not res.get("ok"): checks.append((f"harness ran to the end ({res.get('error', '')[:300]})", False))
    app = json.load(open(os.path.join(TMP, "app_hashes.json"))) if os.path.exists(os.path.join(TMP, "app_hashes.json")) else None
    if os.path.exists(os.path.join(TMP, "staged.avi")):
        m, warn = framemd5(os.path.join(TMP, "staged.avi"))
        ok = m == app and len(m) == 25 and not warn
        print(("PASS" if ok else "FAIL") + f" staged AVI decodes (ffmpeg) to the application's frames  [{len(m)} frames {warn[:80]}]")
        checks.append(("staged AVI identical", ok))
    if os.path.exists(os.path.join(TMP, "capture.avi")):
        m, warn = framemd5(os.path.join(TMP, "capture.avi"))
        cap = json.load(open(os.path.join(TMP, "capture_hashes.json")))
        ok = m == cap and len(m) >= 10 and not warn
        print(("PASS" if ok else "FAIL") + f" staged recording decodes (ffmpeg) to the frames the application shows  [{len(m)} frames {warn[:80]}]")
        checks.append(("staged recording identical", ok))
    passed = sum(1 for _, ok in checks if ok)
    print(f"\n{passed}/{len(checks)} checks passed")
    sys.exit(0 if passed == len(checks) else 1)

try: main()
finally: shutil.rmtree(TMP, ignore_errors=True)
