# Shopz browser controller

One Chromium window for the whole session, driven over HTTP on `:4100`. The agent opens product
pages, scrolls to and highlights the section it is talking about, reads page snapshots, and runs
the checkout in the visible browser. The API is specified in `docs/CONTRACTS.md` §2.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r apps/browser/requirements.txt   # just `pip install playwright` if you skip nova mode
python -m playwright install chromium
```

## Run

```bash
python3 apps/browser/controller.py                         # headed Chromium (default)
BROWSER_MODE=nova python3 apps/browser/controller.py       # Nova Act owns the browser
BROWSER_MODE=headless python3 apps/browser/controller.py   # no window
```

The browser starts before the server accepts requests. Ctrl+C (or SIGTERM) closes it cleanly.
The repo-root `.env` is read on start; variables that are already set win.

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_MODE` | `playwright` | `nova` \| `playwright` \| `headless` |
| `CONTROLLER_PORT` | `4100` | HTTP port |
| `CONTROLLER_HOST` | both loopbacks | bind address; by default `127.0.0.1` and `::1`, so `localhost` works either way |
| `PLAYWRIGHT_CHROMIUM_PATH` | – | Chromium binary to use instead of Playwright's own build (playwright/headless modes) |
| `NOVA_ACT_API_KEY` | – | required for `nova` mode |
| `NOVA_ACT_STEP_TIMEOUT_S` | `60` | timeout of each checkout `act()` call |
| `NOVA_ACT_MAX_STEPS` | `5` | step limit of each checkout `act()` call |
| `NOVA_ACT_CHROME_CHANNEL` | `chromium` | browser channel Nova Act launches |
| `CHECKOUT_STEP_PAUSE_MS` | `400` (`0` headless) | pause after each scripted checkout click, so viewers can follow |

## Modes

- **playwright**: headed Chromium at x=0, y=0, 1180×1050; the viewport follows the window. On Linux
  without a display it runs headless and `/health` reports `headless`.
- **headless**: same, headless, viewport 1180×1050. Used by the tests.
- **nova**: the Nova Act SDK launches and owns the headed browser (same window size and position).
  Navigation, scrolling, highlights and snapshots go through its Playwright page handle, so they
  stay fast and deterministic. Checkout uses one `act()` per step ("Click the Add to cart button",
  "Click Checkout", "Click Continue", "Click Place order") and checks after each step that the page
  moved on. If an `act()` step fails, that step and the rest run as scripted Playwright clicks on
  the same page. The forms are prefilled; the test card is never given to `act()`.
  If nova mode cannot start (package missing, no `NOVA_ACT_API_KEY`, auth or launch error), the
  controller logs a warning and falls back to playwright mode. `/health` then reports
  `mode: "playwright"` plus `requested_mode` and `fallback_reason`.
  The controller sets `NOVA_ACT_SKIP_PLAYWRIGHT_INSTALL=1` (unless set), so Nova Act does not try to
  install browsers or system packages itself; run `python -m playwright install chromium` once instead.

## API (summary)

```bash
curl -s localhost:4100/health                                   # {"ok":true,"mode":"playwright"}
curl -s -XPOST localhost:4100/open -d '{"url":"http://localhost:4001/p/RH-STW-GL5-W"}'
curl -s -XPOST localhost:4100/scroll -d '{"section":"reviews"}'
curl -s -XPOST localhost:4100/highlight -d '{"section":"reviews"}'   # {"section":null} clears
curl -s 'localhost:4100/snapshot?section=price'                 # or section=all
curl -s -XPOST localhost:4100/back ; curl -s -XPOST localhost:4100/reload
curl -s -XPOST localhost:4100/checkout -d '{"url":"http://localhost:4001/p/RH-STW-GL5-W","sku":"RH-STW-GL5-W","qty":1}'
```

- **Snapshot**: `text` is the section's rendered `innerText` with whitespace collapsed; `fields` are
  the section element's `data-*` attributes in snake_case with typed values (`data-in-stock="true"`
  → `in_stock: true`, `data-price="129.95"` → `price: 129.95`). `all` joins every section in page
  order as `## <name>\n<text>` (blank line between sections) with fields keyed `<section>.<field>`.
  `sha256` is the hex SHA-256 of `text`. An optional `session_id` query parameter is echoed.
- **Checkout** returns `{order_id, totals, delivery_eta, confirmation_text, executor, steps, url}`.
  Totals come only from the confirmation page (data attributes, then labelled visible text); a value
  the page does not show is `null`, never computed. Each step entry also carries its `executor`
  and, on failure, an `error`. A failed `act()` step appears as `ok:false` followed by the scripted
  retry of the same step. Before clicking, the controller refuses (409) if the open page shows a
  different `data-sku` or `data-in-stock="false"`.
- **Errors**: `400` bad input, `404` unknown section or endpoint, `409` wrong product, `500`
  browser or timeout errors (page actions time out after 10 s). The body is always `{error}`,
  and the server keeps running. If the window was closed, the next command relaunches the browser.
- Requests are handled one at a time on the main thread, because the sync Playwright and Nova Act
  APIs are not thread-safe. A checkout blocks other calls until it finishes, so give clients a
  long timeout for `/checkout` (Nova Act steps take several seconds each).

## Test

```bash
python3 apps/browser/test_controller.py
```

Starts the merchants server (`:24001`/`:24002`) and the controller in headless mode (`:24100`), then
checks open, scroll, highlight, snapshots, back/reload, error handling and a full checkout.
Set `PLAYWRIGHT_CHROMIUM_PATH` for the test run if Playwright's own Chromium build is missing.
