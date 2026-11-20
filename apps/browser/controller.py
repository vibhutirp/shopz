#!/usr/bin/env python3
"""Shopz browser controller: one Chromium for the whole session, driven over HTTP.

Implements docs/CONTRACTS.md section 2 against the product pages described in section 1.

  BROWSER_MODE=playwright  headed Chromium via Playwright (default)
  BROWSER_MODE=headless    headless Chromium via Playwright (tests)
  BROWSER_MODE=nova        the Nova Act SDK owns the headed browser; navigation goes through its
                           Playwright page handle, checkout steps go through act()

The server is a plain, single-threaded http.server.HTTPServer on purpose: the sync APIs of
Playwright and Nova Act are bound to the thread that started them, so every browser call has to
run on the main thread. Requests are handled one at a time (HTTP/1.0, no keep-alive), which also
keeps browser commands strictly ordered.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import selectors
import signal
import socket
import socketserver
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urldefrag, urlencode, urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

log = logging.getLogger("shopz.controller")

MODES = ("nova", "playwright", "headless")
WINDOW_X, WINDOW_Y, WINDOW_W, WINDOW_H = 0, 0, 1180, 1050
ACTION_TIMEOUT_MS = 10_000
SCROLL_OFFSET_PX = 80
SCROLL_SETTLE_MS = 350
MAX_QTY = 99
MAX_BODY_BYTES = 1_000_000

SECTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
SKU_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?$")  # same rule as the merchants' JSON sections API
MONEY_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ORDER_MARKER = "[data-order-id]"
QTY_SELECTOR = '[data-testid="qty"], select[name="qty"], input[name="qty"]'
# (step, act() prompt, button that must be on screen, element that proves the step worked)
CHECKOUT_STEPS = (
    ("add_to_cart", "Click the Add to cart button", '[data-testid="add-to-cart"]', '[data-testid="checkout"]'),
    ("checkout", "Click Checkout", '[data-testid="checkout"]', '[data-testid="continue"]'),
    ("continue", "Click Continue", '[data-testid="continue"]', '[data-testid="place-order"]'),
    ("place_order", "Click Place order", '[data-testid="place-order"]', ORDER_MARKER),
)
# Labels for reading totals from visible text when the confirmation page has no data attribute.
TOTAL_LABELS = {
    "subtotal": r"(?<![a-z])sub-?total",
    "tax": r"(?<![a-z])(?:sales\s+)?tax(?:es)?",
    "shipping": r"(?<![a-z])shipping",
    "total": r"(?<![a-z-])(?:order\s+)?total",
}

HIGHLIGHT_CSS = """
.shopz-hl {
  outline: 3px solid rgba(245, 158, 11, 0);
  outline-offset: 6px;
  transition: outline-color 200ms ease, box-shadow 200ms ease;
}
.shopz-hl-round { border-radius: 12px; }
.shopz-hl.shopz-hl-on {
  outline-color: #f59e0b;
  box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.10), 0 0 22px 6px rgba(245, 158, 11, 0.30);
  animation: shopz-hl-glow 1.8s ease-in-out 200ms infinite;
}
@keyframes shopz-hl-glow {
  0%, 100% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.10), 0 0 22px 6px rgba(245, 158, 11, 0.30); }
  50% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.18), 0 0 34px 10px rgba(245, 158, 11, 0.45); }
}
@media (prefers-reduced-motion: reduce) { .shopz-hl.shopz-hl-on { animation: none; } }
"""

SCROLL_JS = r"""
({ name, offset }) => {
  const el = document.querySelector('[data-section="' + CSS.escape(name) + '"]');
  if (!el) return false;
  el.style.scrollMarginTop = offset + 'px';
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}
"""

HIGHLIGHT_JS = r"""
({ name, css }) => {
  const el = name === null ? null : document.querySelector('[data-section="' + CSS.escape(name) + '"]');
  if (name !== null && !el) return false;
  if (!document.getElementById('shopz-highlight-style')) {
    const style = document.createElement('style');
    style.id = 'shopz-highlight-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  for (const old of document.querySelectorAll('.shopz-hl-on')) old.classList.remove('shopz-hl-on');
  if (!el) return true;
  el.classList.add('shopz-hl');
  if (!parseFloat(getComputedStyle(el).borderTopLeftRadius)) el.classList.add('shopz-hl-round');
  void el.offsetWidth; // commit the transparent frame first so the 200 ms transition runs
  el.classList.add('shopz-hl-on');
  return true;
}
"""

SNAPSHOT_JS = r"""
(name) => {
  const collect = (el) => {
    const attrs = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('data-') && a.name !== 'data-section') attrs[a.name] = a.value;
    }
    return { name: el.getAttribute('data-section'), text: (el.innerText || '').replace(/\s+/g, ' ').trim(), attrs };
  };
  if (name === null) return Array.from(document.querySelectorAll('[data-section]')).map(collect);
  const el = document.querySelector('[data-section="' + CSS.escape(name) + '"]');
  return el ? [collect(el)] : [];
}
"""

PRODUCT_STATE_JS = r"""
() => {
  const el = document.querySelector('[data-section="price"][data-sku]') || document.querySelector('[data-sku]');
  return el ? { sku: el.getAttribute('data-sku'), in_stock: el.getAttribute('data-in-stock') } : null;
}
"""

CONFIRMATION_JS = r"""
() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const pick = (attr) => {
    const el = document.querySelector('[' + attr + ']');
    return el ? { value: el.getAttribute(attr), text: clean(el.innerText || el.textContent) } : null;
  };
  return {
    order_id: pick('data-order-id'), subtotal: pick('data-subtotal'), tax: pick('data-tax'),
    shipping: pick('data-shipping'), total: pick('data-total'), currency: pick('data-currency'),
    eta: pick('data-eta'), lines: document.body ? document.body.innerText.trim() : '',
    body: clean(document.body ? document.body.innerText : ''),
  };
}
"""


class ApiError(Exception):
    """An error with an HTTP status; extra keyword arguments are added to the JSON body."""

    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


# ---------------------------------------------------------------------------------------------
# Small helpers


def env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)))
    except ValueError:
        log.warning("%s is not a number - using %s", name, default)
        return default


def load_env(path: Path) -> None:
    """Minimal .env reader (KEY=VALUE lines). Never overrides variables that are already set."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value and key not in os.environ:
            os.environ[key] = value


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ms_since(t0: float) -> int:
    return int(round((time.monotonic() - t0) * 1000))


def short_error(exc: BaseException) -> str:
    lines = str(exc).strip().splitlines()
    return f"{type(exc).__name__}: {lines[0] if lines else ''}".strip().rstrip(":")


def field_key(attr: str) -> str:
    """data-critical-quote -> critical_quote"""
    return attr[len("data-"):].replace("-", "_")


def typed_value(raw: str):
    """'true'/'false' -> bool, '129.95' -> 129.95, '812' -> 812, anything else stays a string."""
    if raw == "true":
        return True
    if raw == "false":
        return False
    if NUMBER_RE.match(raw):
        return float(raw) if "." in raw else int(raw)
    return raw


def parse_money(text):
    if text is None:
        return None
    match = MONEY_RE.search(str(text))
    if match:
        try:
            return round(float(match.group(0).replace(",", "")), 2)
        except ValueError:
            return None
    if re.search(r"\bfree\b", str(text), re.IGNORECASE):
        return 0.0
    return None


def money_after_label(body: str, key: str):
    label = TOTAL_LABELS[key]
    match = re.search(
        label + r"\s*(?:\([^)]*\))?\s*:?\s*(?:USD\s*)?\$?\s*(-?\d[\d,]*\.\d{2})(?!\d)", body, re.IGNORECASE
    )
    if match:
        return round(float(match.group(1).replace(",", "")), 2)
    if key == "shipping" and re.search(label + r"\s*:?\s*free\b", body, re.IGNORECASE):
        return 0.0
    return None


def is_navigation_race(exc: BaseException) -> bool:
    """A late navigation (e.g. Chromium's error page after a failed load) cut into this call."""
    text = str(exc)
    return "interrupted by another navigation" in text or "Execution context was destroyed" in text


def settle(page) -> None:
    try:
        page.wait_for_load_state("domcontentloaded", timeout=ACTION_TIMEOUT_MS)
    except PlaywrightError:
        pass


def goto(page, url: str):
    """page.goto that survives racing navigations; returns the response (None if another one won)."""
    target = urldefrag(url)[0]
    for attempt in range(3):
        try:
            return page.goto(url, wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
        except PlaywrightError as exc:
            if attempt == 2 or not is_navigation_race(exc):
                raise
            log.warning("navigation raced with another one (%s) - retrying", short_error(exc))
            settle(page)
            if urldefrag(page.url)[0] == target:
                return None  # the other navigation already went where we wanted


def evaluate(page, script: str, arg=None):
    """page.evaluate that retries once if a navigation destroyed the page context mid-call."""
    try:
        return page.evaluate(script, arg)
    except PlaywrightError as exc:
        if not is_navigation_race(exc):
            raise
        log.warning("page navigated during a read (%s) - retrying once", short_error(exc))
        settle(page)
        return page.evaluate(script, arg)


def require_http_url(url) -> str:
    if not isinstance(url, str) or not url.strip():
        raise ApiError(400, "url is required")
    url = url.strip()
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ApiError(400, "url must be an absolute http(s) URL")
    return url


def require_section(section) -> str:
    if not isinstance(section, str) or not SECTION_RE.match(section):
        raise ApiError(400, "section must be a section name such as 'reviews'")
    return section


def require_qty(qty) -> int:
    if isinstance(qty, str) and qty.strip().isdigit():
        qty = int(qty.strip())
    if isinstance(qty, bool) or not isinstance(qty, int) or not 1 <= qty <= MAX_QTY:
        raise ApiError(400, f"qty must be a whole number from 1 to {MAX_QTY}")
    return qty


# ---------------------------------------------------------------------------------------------
# Browser


class BrowserController:
    def __init__(self, requested_mode: str):
        self.requested_mode = requested_mode
        self.mode: str | None = None
        self.fallback_reason: str | None = None
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._nova = None
        self._snapshots = 0
        self._act_timeout_s = env_int("NOVA_ACT_STEP_TIMEOUT_S", 60)
        self._act_max_steps = env_int("NOVA_ACT_MAX_STEPS", 5)

    # --- lifecycle ----------------------------------------------------------------------------

    def start(self) -> None:
        if self.requested_mode == "nova":
            try:
                self._start_nova()
                return
            except Exception as exc:  # missing package, no key, auth or launch failure
                self._close_nova()
                self._fall_back(exc)
                return
        self._start_playwright(headless=self.requested_mode == "headless")

    def close(self) -> None:
        self._close_nova()
        self._close_playwright()

    def _fall_back(self, exc: BaseException) -> None:
        self.fallback_reason = short_error(exc)
        log.warning("Nova Act mode is not available (%s) - falling back to Playwright", self.fallback_reason)
        self._start_playwright(headless=False)

    def _start_nova(self) -> None:
        # Nova Act SDK facts, read from the nova-act 4.0.234 wheel source:
        # - NovaAct(starting_page, *, headless=False, screen_width=1600, screen_height=900,
        #   ignore_screen_dims_check=False, nova_act_api_key=None (falls back to env NOVA_ACT_API_KEY),
        #   user_data_dir=None (fresh temp profile), clone_user_data_dir=True, chrome_channel=None
        #   (env NOVA_ACT_CHROME_CHANNEL, default "chrome", retried as "chromium" if that fails),
        #   tty=True (terminal key listener thread), go_to_url_timeout=None (60 s), ...).
        # - The constructor checks auth: an API key, or AWS credentials (those also need a Workflow);
        #   neither -> AuthError. start()/stop() work without a context manager; start() raises StartFailed.
        # - .page is the Playwright sync Page it actuates on (last page of its persistent context).
        # - act(prompt, *, timeout=None (int seconds; None = no limit), max_steps=None (30)) returns an
        #   ActResult (.metadata.num_steps_executed, ...) and raises ActError subclasses (ActAgentFailed,
        #   ActExceededMaxStepsError, ActTimeoutError, ...), AuthError or ValidationFailed.
        # - Chromium flags beyond --window-size come only from env NOVA_ACT_BROWSER_ARGS (read in the
        #   constructor); the window uses no_viewport. The recommended viewport is 1600x813 +/-20 %, so
        #   1180x1050 needs ignore_screen_dims_check=True. start() runs a Playwright browser install
        #   unless NOVA_ACT_SKIP_PLAYWRIGHT_INSTALL is set.
        try:
            from nova_act import NovaAct
        except ImportError as exc:
            raise RuntimeError("the nova-act package is not installed") from exc
        if not os.environ.get("NOVA_ACT_API_KEY", "").strip():
            raise RuntimeError("NOVA_ACT_API_KEY is not set")
        flags = os.environ.get("NOVA_ACT_BROWSER_ARGS", "")
        if "--window-position" not in flags:
            os.environ["NOVA_ACT_BROWSER_ARGS"] = f"{flags} --window-position={WINDOW_X},{WINDOW_Y}".strip()
        os.environ.setdefault("NOVA_ACT_SKIP_PLAYWRIGHT_INSTALL", "1")
        nova = NovaAct(
            starting_page="about:blank",
            headless=False,
            screen_width=WINDOW_W,
            screen_height=WINDOW_H,
            ignore_screen_dims_check=True,
            chrome_channel=env("NOVA_ACT_CHROME_CHANNEL", "chromium"),
            tty=False,
        )
        nova.start()
        self._nova = nova
        self.mode = "nova"
        log.info("Nova Act browser started")

    def _close_nova(self) -> None:
        if self._nova is not None:
            try:
                self._nova.stop()
            except Exception as exc:
                log.warning("Nova Act stop failed (%s)", short_error(exc))
        self._nova = None

    def _start_playwright(self, headless: bool) -> None:
        if not headless and sys.platform.startswith("linux") and not (
            os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        ):
            log.warning("no display found - running Chromium headless")
            headless = True
        self._pw = sync_playwright().start()
        launch = {"headless": headless}
        executable = env("PLAYWRIGHT_CHROMIUM_PATH", "")
        if executable:
            launch["executable_path"] = executable
        if not headless:
            launch["args"] = [f"--window-position={WINDOW_X},{WINDOW_Y}", f"--window-size={WINDOW_W},{WINDOW_H}"]
        self._browser = self._pw.chromium.launch(**launch)
        if headless:
            self._context = self._browser.new_context(viewport={"width": WINDOW_W, "height": WINDOW_H})
        else:
            self._context = self._browser.new_context(no_viewport=True)  # viewport follows the window
        self._context.set_default_timeout(ACTION_TIMEOUT_MS)
        self._context.set_default_navigation_timeout(ACTION_TIMEOUT_MS)
        self._page = self._context.new_page()
        self.mode = "headless" if headless else "playwright"
        log.info("Chromium started (%s)", self.mode)

    def _close_playwright(self) -> None:
        for obj, method in ((self._context, "close"), (self._browser, "close"), (self._pw, "stop")):
            if obj is not None:
                try:
                    getattr(obj, method)()
                except Exception:
                    pass
        self._pw = self._browser = self._context = self._page = None

    def _ensure_page(self):
        """The live page; relaunches the browser if someone closed it."""
        if self.mode == "nova":
            try:
                page = self._nova.page
                if not page.is_closed():
                    return page
            except Exception as exc:
                log.warning("Nova Act page is gone (%s)", short_error(exc))
            self._close_nova()
            try:
                self._start_nova()
                return self._nova.page
            except Exception as exc:
                self._close_nova()
                self._fall_back(exc)
                return self._page
        if self._browser is None or not self._browser.is_connected():
            log.warning("browser is gone - relaunching")
            self._close_playwright()
            self._start_playwright(headless=self.mode == "headless")
        elif self._page is None or self._page.is_closed():
            try:
                self._page = self._context.new_page()
            except PlaywrightError:
                self._close_playwright()
                self._start_playwright(headless=self.mode == "headless")
        return self._page

    # --- commands -----------------------------------------------------------------------------

    def health(self) -> dict:
        result = {"ok": True, "mode": self.mode}
        if self.mode != self.requested_mode:
            result["requested_mode"] = self.requested_mode
            if self.fallback_reason:
                result["fallback_reason"] = self.fallback_reason
        return result

    def open(self, url) -> dict:
        url = require_http_url(url)
        page = self._ensure_page()
        response = goto(page, url)
        status = response.status if response is not None else None
        return {"ok": status is None or status < 400, "url": page.url, "title": page.title(), "status": status}

    def scroll(self, section) -> dict:
        name = require_section(section)
        page = self._ensure_page()
        if not evaluate(page, SCROLL_JS, {"name": name, "offset": SCROLL_OFFSET_PX}):
            raise ApiError(404, f"section not found on this page: {name}")
        page.wait_for_timeout(SCROLL_SETTLE_MS)
        return {"ok": True}

    def highlight(self, section) -> dict:
        name = None if section in (None, "") else require_section(section)
        page = self._ensure_page()
        if not evaluate(page, HIGHLIGHT_JS, {"name": name, "css": HIGHLIGHT_CSS}):
            raise ApiError(404, f"section not found on this page: {name}")
        return {"ok": True}

    def back(self) -> dict:
        page = self._ensure_page()
        before = page.url
        response = page.go_back(wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
        moved = response is not None or page.url != before
        result = {"ok": moved, "url": page.url}
        if not moved:
            result["note"] = "no previous page"
        return result

    def reload(self) -> dict:
        page = self._ensure_page()
        try:
            response = page.reload(wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
        except PlaywrightError as exc:
            if not is_navigation_race(exc):
                raise
            settle(page)
            response = page.reload(wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
        return {"ok": response is None or response.status < 400, "url": page.url}

    def snapshot(self, section, session_id=None) -> dict:
        name = section or "all"
        if name != "all":
            require_section(name)
        page = self._ensure_page()
        parts = evaluate(page, SNAPSHOT_JS, None if name == "all" else name)
        if name != "all" and not parts:
            raise ApiError(404, f"section not found on this page: {name}")
        page_url = urldefrag(page.url)[0]
        if name == "all":
            text = "\n\n".join(f"## {p['name']}\n{p['text']}" for p in parts)
            fields = {f"{p['name']}.{field_key(k)}": typed_value(v) for p in parts for k, v in p["attrs"].items()}
            url = page_url
        else:
            text = parts[0]["text"]
            fields = {field_key(k): typed_value(v) for k, v in parts[0]["attrs"].items()}
            url = f"{page_url}#{name}"
        self._snapshots += 1
        snap = {"snapshot_id": f"snap_{self._snapshots:04d}"}
        if session_id:
            snap["session_id"] = session_id
        snap.update(url=url, section=name, taken_at=utc_now_iso(), text=text, fields=fields, sha256=sha256_hex(text))
        return snap

    def checkout(self, url, sku, qty) -> dict:
        if not isinstance(sku, str) or not SKU_RE.match(sku):
            raise ApiError(400, "sku is required")
        qty = require_qty(qty)
        page = self._ensure_page()
        if url:
            url = require_http_url(url)
            if urldefrag(page.url)[0] != urldefrag(url)[0]:
                goto(page, url)
        elif "/p/" not in urlparse(page.url).path:
            raise ApiError(400, "url is required (the browser is not on a product page)")
        state = evaluate(page, PRODUCT_STATE_JS) or {}
        if state.get("sku") and state["sku"] != sku:
            raise ApiError(409, f"the open page sells {state['sku']}, not {sku}")
        if (state.get("in_stock") or "").strip().lower() == "false":
            raise ApiError(409, f"{sku} is out of stock on the page")
        self._set_qty(page, qty)

        steps: list[dict] = []
        use_act = self.mode == "nova"
        act_steps = 0
        pause_ms = env_int("CHECKOUT_STEP_PAUSE_MS", 0 if self.mode == "headless" else 400)
        for name, prompt, button, marker in CHECKOUT_STEPS:
            done = False
            if use_act:
                entry = self._act_step(name, prompt, button, marker)
                steps.append(entry)
                done = entry["ok"]
                if done:
                    act_steps += 1
                else:
                    use_act = False  # finish the remaining steps with scripted clicks on the same page
            if not done:
                entry = self._scripted_step(name, button, marker)
                steps.append(entry)
                if not entry["ok"]:
                    raise ApiError(
                        500,
                        f"checkout step {name} failed: {entry.get('error')}",
                        executor="nova_act" if act_steps else "playwright",
                        steps=steps,
                    )
                if pause_ms:
                    self._ensure_page().wait_for_timeout(pause_ms)
            if name == "add_to_cart":
                self._fix_cart(sku, qty)

        result = self._read_confirmation(self._ensure_page())
        result["executor"] = "nova_act" if act_steps else "playwright"
        result["steps"] = steps
        return result

    # --- checkout internals -------------------------------------------------------------------

    def _wait_for(self, selector: str, timeout_ms: int) -> bool:
        state = "attached" if selector == ORDER_MARKER else "visible"
        try:
            self._ensure_page().wait_for_selector(selector, state=state, timeout=timeout_ms)
            return True
        except PlaywrightError:
            return False

    def _act_step(self, name: str, prompt: str, button: str, marker: str) -> dict:
        t0 = time.monotonic()
        entry = {"step": name, "ok": False, "ms": 0, "executor": "nova_act"}
        try:
            self._ensure_page().wait_for_selector(button, state="visible", timeout=ACTION_TIMEOUT_MS)
            self._nova.act(prompt, timeout=self._act_timeout_s, max_steps=self._act_max_steps)
            entry["ok"] = self._wait_for(marker, ACTION_TIMEOUT_MS)
            if not entry["ok"]:
                entry["error"] = "act() returned but the page did not move on"
        except Exception as exc:  # ActError subclasses, AuthError, Playwright timeouts
            entry["error"] = short_error(exc)
            entry["ok"] = self._wait_for(marker, 2_000)  # act() may have clicked before it failed
            if entry["ok"]:
                entry["note"] = entry.pop("error")
        entry["ms"] = ms_since(t0)
        if not entry["ok"]:
            log.warning("act() step %s failed (%s) - continuing with scripted clicks", name, entry.get("error"))
        return entry

    def _scripted_step(self, name: str, button: str, marker: str) -> dict:
        t0 = time.monotonic()
        entry = {"step": name, "ok": False, "ms": 0, "executor": "playwright"}
        try:
            self._ensure_page().locator(button).first.click(timeout=ACTION_TIMEOUT_MS)
            entry["ok"] = self._wait_for(marker, ACTION_TIMEOUT_MS)
            if not entry["ok"]:
                entry["error"] = f"{marker} did not appear"
        except PlaywrightError as exc:
            entry["error"] = short_error(exc)
        entry["ms"] = ms_since(t0)
        return entry

    def _set_qty(self, page, qty: int) -> None:
        try:
            field = page.locator(QTY_SELECTOR).first
            if field.count() == 0 or field.input_value(timeout=ACTION_TIMEOUT_MS) == str(qty):
                return
            if field.evaluate("el => el.tagName") == "SELECT":
                field.select_option(str(qty), timeout=ACTION_TIMEOUT_MS)
            else:
                field.fill(str(qty), timeout=ACTION_TIMEOUT_MS)
        except PlaywrightError as exc:
            log.warning("could not set the quantity field (%s)", short_error(exc))

    def _fix_cart(self, sku: str, qty: int) -> None:
        """If the cart URL names another sku or quantity, reopen the cart with the requested ones."""
        page = self._ensure_page()
        parts = urlparse(page.url)
        query = parse_qs(parts.query)
        want = {"sku": sku, "qty": str(qty)}
        if all(query.get(key, [want[key]])[-1] == want[key] for key in want):
            return
        log.warning("cart URL %s does not match sku=%s qty=%s - reopening the cart", page.url, sku, qty)
        goto(page, f"{parts.scheme}://{parts.netloc}{parts.path}?{urlencode(want)}")
        page.wait_for_selector(CHECKOUT_STEPS[1][2], state="visible", timeout=ACTION_TIMEOUT_MS)

    def _read_confirmation(self, page) -> dict:
        found = evaluate(page, CONFIRMATION_JS)
        body = found["body"]
        # "Order <id> confirmed" on one rendered line (innerText keeps block boundaries as newlines)
        line = re.search(r"Order[^\S\n]+(\S+)[^\S\n]+confirmed[^\n.!?]*[.!?]?", found["lines"])
        order = found["order_id"]
        order_id = (order["value"] or "").strip() if order else ""
        if not order_id:
            order_id = line.group(1) if line else (order["text"] if order else "")
        if not order_id:
            raise ApiError(500, "no order id on the confirmation page")

        # Only what the page shows: data attributes first, then labelled visible text, else null.
        totals = {}
        for key in ("subtotal", "tax", "shipping", "total"):
            item = found[key]
            value = None
            if item is not None:
                value = parse_money(item["value"]) if (item["value"] or "").strip() else parse_money(item["text"])
            totals[key] = value if value is not None else money_after_label(body, key)
        currency = found["currency"]
        if currency and (currency["value"] or currency["text"]).strip():
            totals["currency"] = (currency["value"] or currency["text"]).strip()
        elif re.search(r"\bUSD\b", body):
            totals["currency"] = "USD"
        elif found["total"] and "$" in ((found["total"]["value"] or "") + found["total"]["text"]) or "$" in body:
            totals["currency"] = "USD"
        else:
            totals["currency"] = None

        eta = found["eta"]
        delivery_eta = None
        if eta:
            value = (eta["value"] or "").strip()
            delivery_eta = value if DATE_RE.match(value) else (value or eta["text"] or None)
        if line:
            confirmation_text = " ".join(line.group(0).split())
        else:
            confirmation_text = (order["text"] if order else None) or None
        return {
            "order_id": order_id,
            "totals": totals,
            "delivery_eta": delivery_eta,
            "confirmation_text": confirmation_text,
            "url": page.url,
        }


# ---------------------------------------------------------------------------------------------
# HTTP


ROUTES = {
    ("GET", "/health"): lambda c, body, query: c.health(),
    ("POST", "/open"): lambda c, body, query: c.open(body.get("url")),
    ("POST", "/scroll"): lambda c, body, query: c.scroll(body.get("section")),
    ("POST", "/highlight"): lambda c, body, query: c.highlight(body.get("section")),
    ("POST", "/back"): lambda c, body, query: c.back(),
    ("POST", "/reload"): lambda c, body, query: c.reload(),
    ("GET", "/snapshot"): lambda c, body, query: c.snapshot(
        query.get("section"), query.get("session_id") or query.get("session")
    ),
    ("POST", "/checkout"): lambda c, body, query: c.checkout(
        body.get("url"), body.get("sku"), 1 if body.get("qty") is None else body.get("qty")
    ),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "ShopzController/1.0"
    timeout = 30  # seconds a client may take to send its request
    controller: BrowserController | None = None

    def do_OPTIONS(self):  # noqa: N802 (http.server naming)
        self._send(204, None)

    def do_GET(self):  # noqa: N802
        self._dispatch("GET")

    def do_POST(self):  # noqa: N802
        self._dispatch("POST")

    def log_message(self, format, *args):  # noqa: A002 - silence the default access log
        log.debug(format, *args)

    def _dispatch(self, method: str) -> None:
        t0 = time.monotonic()
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        try:
            route = ROUTES.get((method, path))
            if route is None:
                if any(p == path for _, p in ROUTES):
                    raise ApiError(405, f"{method} is not allowed on {path}")
                raise ApiError(404, f"unknown endpoint {method} {path}")
            body = self._read_json() if method == "POST" else {}
            query = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
            status, payload = 200, route(self.controller, body, query)
        except ApiError as exc:
            status, payload = exc.status, {"error": exc.message, **exc.extra}
        except Exception as exc:  # keep the server alive whatever the browser does
            log.error("%s %s failed: %s", method, path, exc)
            status, payload = 500, {"error": short_error(exc)}
        self._send(status, payload)
        log.info("%s %s -> %s (%d ms)", method, path, status, ms_since(t0))

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "invalid Content-Length") from None
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "request body too large")
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"invalid JSON body: {exc}") from None
        if not isinstance(data, dict):
            raise ApiError(400, "JSON body must be an object")
        return data

    def _send(self, status: int, payload) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Cache-Control", "no-store")
            if payload is not None:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            log.warning("client went away before the response was sent")


class _Server(HTTPServer):
    def server_bind(self):  # skip HTTPServer's reverse DNS lookup of the bind address
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = str(self.server_address[0]), self.server_address[1]


class _ServerV6(_Server):
    address_family = socket.AF_INET6


def make_servers(host: str, port: int) -> list[HTTPServer]:
    """Bind CONTROLLER_HOST, or by default both loopback addresses ("localhost" may resolve to ::1)."""
    if host:
        return [(_ServerV6 if ":" in host else _Server)((host, port), Handler)]
    servers: list[HTTPServer] = [_Server(("127.0.0.1", port), Handler)]
    if socket.has_ipv6:
        try:
            servers.append(_ServerV6(("::1", port), Handler))
        except OSError as exc:
            log.debug("IPv6 loopback not available (%s)", exc)
    return servers


def serve(servers: list[HTTPServer]) -> None:
    with selectors.DefaultSelector() as selector:
        for server in servers:
            selector.register(server, selectors.EVENT_READ)
        while True:
            for key, _ in selector.select(timeout=1.0):
                key.fileobj.handle_request()  # one request at a time, on the main thread


def _stop_on_sigterm(signum, frame):
    raise KeyboardInterrupt


def main() -> int:
    try:
        load_env(Path(__file__).resolve().parents[2] / ".env")
    except IndexError:
        pass
    logging.basicConfig(
        level=logging.INFO, format="[controller] %(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S"
    )
    mode = env("BROWSER_MODE", "playwright").lower()
    if mode not in MODES:
        log.warning("unknown BROWSER_MODE %r - using playwright", mode)
        mode = "playwright"
    port = env_int("CONTROLLER_PORT", 4100)
    try:  # bind first: a busy port fails fast, before a browser is launched
        servers = make_servers(env("CONTROLLER_HOST", ""), port)
    except OSError as exc:
        log.error("cannot listen on port %s (%s) - is another controller running?", port, exc)
        return 1
    controller = BrowserController(mode)
    Handler.controller = controller
    signal.signal(signal.SIGTERM, _stop_on_sigterm)
    try:
        controller.start()
        log.info(
            "listening on port %s (%s), mode %s",
            port, ", ".join(str(s.server_address[0]) for s in servers), controller.mode,
        )
        serve(servers)
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        for server in servers:
            server.server_close()
        controller.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
