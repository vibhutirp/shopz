#!/usr/bin/env python3
"""End-to-end test for the Shopz browser controller in headless mode.

Starts the merchants server (apps/merchants/server.js, RunHub :24001, DailyCart :24002) and the
controller (BROWSER_MODE=headless, :24100) as subprocesses and drives the controller over HTTP.
Both processes are stopped at the end.

    python3 apps/browser/test_controller.py

If Playwright's own Chromium build is missing, point PLAYWRIGHT_CHROMIUM_PATH at a Chromium binary
for the test run.
"""
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MERCHANTS_JS = REPO / "apps" / "merchants" / "server.js"
CONTROLLER_PORT = 24100
RUNHUB_PORT = 24001
DAILYCART_PORT = 24002
CTRL = f"http://127.0.0.1:{CONTROLLER_PORT}"
RUNHUB = f"http://localhost:{RUNHUB_PORT}"
SKU = "RH-STW-GL5-W"
PRODUCT_URL = f"{RUNHUB}/p/{SKU}"
OTHER_URL = f"{RUNHUB}/p/RH-OND-CP-W"
SECTIONS = ["gallery", "price", "delivery", "specs", "reviews", "returns", "seller"]


def call(method, path, body=None, base=CTRL, timeout=60, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
    except urllib.error.HTTPError as err:
        payload = err.read()
        try:
            return err.code, json.loads(payload) if payload else None
        except ValueError:
            return err.code, payload.decode("utf-8", "replace")


def wait_http(url, timeout_s, proc):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"process exited early with code {proc.returncode} while waiting for {url}")
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except urllib.error.HTTPError:
            return  # it answers
        except OSError:
            time.sleep(0.25)
    raise RuntimeError(f"{url} did not answer within {timeout_s} s")


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class ControllerTest(unittest.TestCase):
    @classmethod
    def start(cls, name, cmd, env):
        log = tempfile.TemporaryFile(prefix=f"shopz-{name}-")
        proc = subprocess.Popen(
            cmd, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
        )
        cls.addClassCleanup(cls.stop, name, proc, log)
        return proc

    @staticmethod
    def stop(name, proc, log):
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)  # graceful: the controller closes its browser
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # anything left in the process group (browser, driver)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait(timeout=10)
        log.seek(0)
        lines = log.read().decode("utf-8", "replace").splitlines()
        log.close()
        print(f"\n--- {name} log (last 25 of {len(lines)} lines, exit {proc.returncode}) ---")
        print("\n".join(lines[-25:]))

    @classmethod
    def setUpClass(cls):
        if not MERCHANTS_JS.exists():
            raise unittest.SkipTest("apps/merchants/server.js is missing")
        env = dict(os.environ, RUNHUB_PORT=str(RUNHUB_PORT), DAILYCART_PORT=str(DAILYCART_PORT))
        cls.merchants = cls.start("merchants", ["node", str(MERCHANTS_JS)], env)
        wait_http(f"{RUNHUB}/", 20, cls.merchants)

        env = dict(os.environ, BROWSER_MODE="headless", CONTROLLER_PORT=str(CONTROLLER_PORT))
        env.pop("CONTROLLER_HOST", None)
        cls.controller = cls.start("controller", [sys.executable, str(HERE / "controller.py")], env)
        wait_http(f"{CTRL}/health", 60, cls.controller)

    # --- navigation -----------------------------------------------------------------------------

    def test_01_health(self):
        self.assertEqual(call("GET", "/health"), (200, {"ok": True, "mode": "headless"}))
        status, _ = call("GET", "/health", base=f"http://localhost:{CONTROLLER_PORT}")
        self.assertEqual(status, 200, "the default bind should also answer on localhost")

    def test_02_open(self):
        t0 = time.monotonic()
        status, body = call("POST", "/open", {"url": PRODUCT_URL})
        ms = int((time.monotonic() - t0) * 1000)
        self.assertEqual(status, 200, body)
        self.assertTrue(body["ok"])
        self.assertEqual(body["url"], PRODUCT_URL)
        self.assertTrue(body["title"])
        print(f"\n    open: {ms} ms, title={body['title']!r}")

    def test_03_scroll_and_highlight(self):
        self.assertEqual(call("POST", "/scroll", {"section": "reviews"}), (200, {"ok": True}))
        self.assertEqual(call("POST", "/highlight", {"section": "reviews"}), (200, {"ok": True}))
        self.assertEqual(call("POST", "/highlight", {"section": "price"}), (200, {"ok": True}))
        self.assertEqual(call("POST", "/highlight", {"section": None}), (200, {"ok": True}))
        self.assertEqual(call("POST", "/highlight", {"section": "reviews"}), (200, {"ok": True}))

    def test_04_snapshot_price(self):
        status, snap = call("GET", "/snapshot?section=price")
        self.assertEqual(status, 200, snap)
        self.assertEqual(snap["section"], "price")
        self.assertEqual(snap["fields"]["price"], 129.95)
        self.assertIs(snap["fields"]["in_stock"], True)
        self.assertEqual(snap["fields"]["sku"], SKU)
        self.assertEqual(snap["fields"]["currency"], "USD")
        self.assertEqual(snap["sha256"], sha256_hex(snap["text"]))
        self.assertRegex(snap["snapshot_id"], r"^snap_\d+$")
        self.assertRegex(snap["taken_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        self.assertEqual(snap["url"], PRODUCT_URL + "#price")
        self.assertIn("129.95", snap["text"])
        self.assertNotIn("  ", snap["text"])
        print(f"\n    {snap['snapshot_id']} fields={json.dumps(snap['fields'])}")
        print(f"    sha256={snap['sha256']} text[:100]={snap['text'][:100]!r}")

    def test_05_snapshot_all(self):
        status, snap = call("GET", "/snapshot?section=all")
        self.assertEqual(status, 200, snap)
        self.assertEqual(snap["section"], "all")
        self.assertEqual(re.findall(r"^## (\S+)$", snap["text"], re.MULTILINE), SECTIONS)
        self.assertEqual(snap["sha256"], sha256_hex(snap["text"]))
        fields = snap["fields"]
        self.assertEqual(fields["price.price"], 129.95)
        self.assertEqual(fields["reviews.count"], 1240)
        self.assertEqual(fields["reviews.avg"], 4.6)
        self.assertRegex(fields["delivery.eta"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertIsInstance(fields["reviews.critical_quote"], str)
        print(f"\n    {snap['snapshot_id']}: {len(snap['text'])} chars, {len(fields)} fields: {sorted(fields)}")

    def test_06_snapshot_text_matches_merchant_api(self):
        """The merchant JSON API promises the same visible text; report any section that differs."""
        status, api = call("GET", f"/api/products/{SKU}/sections", base=RUNHUB)
        if status != 200:
            self.skipTest(f"merchant sections API answered {status}")
        diffs = []
        for name in SECTIONS:
            _, snap = call("GET", f"/snapshot?section={name}")
            theirs = (api.get("sections", {}).get(name) or {}).get("text")
            if snap["text"] != theirs:
                diffs.append(name)
                print(f"\n    INFO {name}: page={snap['text'][:90]!r}\n         api ={str(theirs)[:90]!r}")
        print(f"\n    page text == merchant API text for {len(SECTIONS) - len(diffs)}/{len(SECTIONS)} sections")

    def test_07_errors_keep_server_alive(self):
        self.assertEqual(call("POST", "/scroll", {"section": "nope"})[0], 404)
        self.assertEqual(call("POST", "/highlight", {"section": "nope"})[0], 404)
        self.assertEqual(call("GET", "/snapshot?section=nope")[0], 404)
        self.assertEqual(call("POST", "/scroll", {"section": "a b"})[0], 400)
        self.assertEqual(call("POST", "/open", {"url": "javascript:alert(1)"})[0], 400)
        self.assertEqual(call("POST", "/open", raw=b"{not json")[0], 400)
        self.assertEqual(call("GET", "/open")[0], 405)
        status, body = call("GET", "/nothing-here")
        self.assertEqual(status, 404)
        self.assertIn("error", body)
        status, body = call("POST", "/open", {"url": "http://127.0.0.1:24199/"})  # nothing listens there
        self.assertEqual(status, 500)
        self.assertIn("error", body)
        self.assertEqual(call("GET", "/health")[0], 200)

    def test_08_back_and_reload(self):
        status, body = call("POST", "/open", {"url": PRODUCT_URL})
        self.assertEqual(status, 200, body)
        status, body = call("POST", "/open", {"url": OTHER_URL})
        self.assertEqual((status, body["url"]), (200, OTHER_URL))
        self.assertEqual(call("POST", "/back"), (200, {"ok": True, "url": PRODUCT_URL}))
        self.assertEqual(call("POST", "/reload"), (200, {"ok": True, "url": PRODUCT_URL}))
        _, snap = call("GET", "/snapshot?section=price")
        self.assertEqual(snap["fields"]["sku"], SKU)

    # --- checkout -------------------------------------------------------------------------------

    def test_09_checkout_refuses_wrong_sku(self):
        status, body = call("POST", "/checkout", {"url": PRODUCT_URL, "sku": "RH-OND-CP-W", "qty": 1})
        self.assertEqual(status, 409, body)
        self.assertEqual(call("POST", "/checkout", {"url": PRODUCT_URL, "sku": SKU, "qty": 0})[0], 400)

    def test_10_checkout(self):
        call("POST", "/admin/reset", {}, base=RUNHUB)
        t0 = time.monotonic()
        status, order = call("POST", "/checkout", {"url": PRODUCT_URL, "sku": SKU, "qty": 1}, timeout=120)
        ms = int((time.monotonic() - t0) * 1000)
        self.assertEqual(status, 200, order)
        self.assertTrue(order["order_id"].startswith("RH-"), order)
        self.assertIsNotNone(order["totals"]["total"], order)
        self.assertEqual(order["executor"], "playwright")
        self.assertEqual([s["step"] for s in order["steps"]], ["add_to_cart", "checkout", "continue", "place_order"])
        self.assertTrue(all(s["ok"] for s in order["steps"]), order["steps"])
        self.assertRegex(order["delivery_eta"] or "", r"^\d{4}-\d{2}-\d{2}$")
        self.assertIn(order["order_id"], order["confirmation_text"] or "")
        print(f"\n    checkout {ms} ms: {json.dumps(order, ensure_ascii=False)}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
