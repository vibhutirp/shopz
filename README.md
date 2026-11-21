# Shopz – the personal shopper that shows its work

Shopz is a voice-first shopping agent. You say what you need, and it opens each of its three picks as the real product page in a browser it controls, talks you through the page, and lets you interrupt at any time ("show me the reviews", "what's the return policy?", "next one", "go back"). It answers **only from what is on the page**. Before it pays, it re-checks price and stock and says out loud what changed. A spending policy decides when it may buy on its own and when it has to ask. Every page it read, price it saw, rule it applied and word you said goes into a hash-chained audit timeline next to the browser.

> **Demo data disclosure.** RunHub and DailyCart are fictional stores that run locally. Every product, price, rating and review in this repo is made up. The demo user's preferences (size, budget, a brand to avoid, a usual coffee) are pre-seeded and labeled `seeded_for_demo` everywhere they appear. Price changes and stock-outs in the demo are simulated with `/admin/scenario` and labeled as such.

## What you see

One laptop screen:
- **Left:** an agent-controlled Chromium showing the live product page. The section the agent is talking about gets a soft highlight frame.
- **Right:** the Shopz panel with mic state, transcript, current step, memory and constraint chips, the policy card, price changes, and the live audit timeline with hash-chain verification.

```
 You (voice, push-to-talk)                                 Firedrill / scenario runner
        │  Web Speech API                                            │
        ▼                                                            ▼
 ┌──────────────┐   SSE + POST   ┌──────────────────────────────────────────────┐
 │ Panel :3000  │◄──────────────►│ Agent server :3000                           │
 │ transcript   │                │ intent router → state machine                │
 │ policy card  │  Polly mp3 /   │ CLARIFY → SEARCH → NARRATE ⇄ NAVIGATE/ANSWER │
 │ audit trail  │  speechSynth.  │ → CHOOSE → VERIFY → POLICY → APPROVE         │
 └──────────────┘                │ → CHECKOUT → DONE                            │
                                 │ grounded answers (quoted-span check)         │
                                 │ local policy engine · hash-chained audit     │
                                 └───────┬──────────────┬──────────────┬────────┘
                                         │              │              │
                        Bedrock (Claude, │   MongoDB    │   browser    │ HTTP
                        Titan embeddings)│   Atlas      │   controller │
                                         ▼              ▼   :4100      ▼
                                    intent fallback  audit, prefs,  Nova Act / Playwright
                                    page Q&A         orders,        open · scroll · highlight
                                                     vector search  snapshot · checkout
                                                                       │
                                                                       ▼
                                                     RunHub :4001 · DailyCart :4002 (fictional stores)
```

## Quickstart

Requirements: Node.js ≥ 18.17, Python ≥ 3.10, Google Chrome or Chromium.

```bash
npm install
python3 -m venv .venv && . .venv/bin/activate
pip install -r apps/browser/requirements.txt
python -m playwright install chromium
cp .env.example .env        # every value is optional, see below
npm run dev                 # stores + browser controller + agent; opens browser left, panel right
```

Hold **Space** (or the mic button) to talk and release to send. Pressing Space while Shopz is speaking stops it right away (barge-in). The small text box at the bottom of the panel works too.

Text only, no browser or voice:

```bash
npm run merchants &   # RunHub :4001, DailyCart :4002
npm run agent &       # agent + panel :3000 (falls back to the stores' JSON API when no controller runs)
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"I need running shoes for a half marathon in three weeks."}'
```

### Configuration (`.env`)

| Variable | Used for | Without it |
|---|---|---|
| `AWS_REGION`, `AWS_PROFILE` (or the standard AWS credential chain) | Bedrock + Polly | deterministic answers, browser voice |
| `BEDROCK_MODEL_ID` | Claude on Bedrock (Converse API): intent fallback, grounded page Q&A | regex router + keyword search on the page text |
| `BEDROCK_EMBED_MODEL_ID` | Titan text embeddings (v2, 512 dims) for the catalog (`npm run seed`) and for each search query | products stored without vectors, search uses the store API only |
| `POLLY_VOICE`, `POLLY_ENGINE` | Amazon Polly speech | `speechSynthesis` in the panel |
| `NOVA_ACT_API_KEY`, `BROWSER_MODE=nova` (the default in `.env.example`) | Amazon Nova Act owns the browser and runs the checkout steps with `act()` | Playwright with scripted clicks; `GET :4100/health` shows `mode` and `fallback_reason` |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB Atlas: audit events, preferences, orders, and Atlas Vector Search on every product search (after `npm run seed`) | in-memory store + `data/audit-<session>.jsonl`, store API search only |
| `DEMO_TODAY=YYYY-MM-DD` | freezes "today" for delivery dates | real date |
| `SHOPZ_MODE=demo\|live` | default mode of the panel (switch in the header, or `?mode=live`) | `demo` |
| `SHOPZ_LIVE_SHOPS` | comma-separated Shopify store hosts for live mode | built-in start list (12 US stores) |
| `LIVE_LLM_URL`, `LIVE_LLM_MODEL` | optional local model (Ollama) that narrows free-form requests | regex request parser |
| `LIVE_SEARCH_URL` | optional SearXNG instance for extra web results on allowed stores | store search only |

Never commit `.env`. It is gitignored.

## Demo script (3 minutes)

1. "I need running shoes for a half marathon in three weeks." → *"Your saved profile says size 10.5 wide, no Vantex because of sizing, budget around 140. When do you need them?"*
2. "By next Friday." → searches both approved stores, filters out the avoided brand and anything over budget or arriving too late, ranks the rest, then opens and narrates each of the three picks on its live page.
3. Interrupt during the second pick: "Wait – show me the reviews." → it scrolls to the reviews and quotes the most helpful critical one. A review that tries to instruct AI agents is logged as `injection_ignored` and never acted on.
4. "What's the return policy?" → it reads the returns section word for word.
5. "Next one." → "Is it waterproof?" → *"The specs on this page don't mention waterproofing, so I can't tell you."*
6. "Go back to the first one. Buy that." → it reloads the page and sees the (simulated) price change: *"$129.95 then, $139.95 now. Total is $152.02 with tax … That's over your $150 auto-buy limit. Say 'confirm purchase' to buy, or I can get the Kestrel at $119 instead."*
7. "Confirm purchase." → checkout in the browser → *"Done. Order RH-10482 arrives Tuesday."*
8. "Reorder my usual coffee." → under the limit at an approved store → bought without asking.

**Cart (optional, after the script):** "Add the first one to my cart." → "Put the coffee in the cart too." → "What's in my cart?" (the cart opens with both stores, quantities, subtotal per store and the grand total) → "Check out." Shopz re-checks every page and runs your rules on each line *and* on the cart total; over $150 or after a price rise it shows the old and the new total and waits for "confirm purchase". Every cart change is in the audit chain.

Operator hotkeys in the panel (press `?`): `Shift+P` simulated price change on the first pick, `Shift+R` reset, `M` mute.

## Live mode (real stores)

Switch the header to **Live web** (or open `/?mode=live`). Shopz then searches real Shopify stores in real time:

- Search uses each store's public storefront endpoints (`/search/suggest.json`, `/products/<handle>.js`); product facts come from the product page itself (schema.org JSON-LD and OpenGraph). Every page read is hashed into the audit chain.
- Questions are answered only from the page. If the page does not say, Shopz says so.
- Shopz never pays in live mode. It goes as far as "ready to buy", re-checks price and stock, applies your policy, then hands off with an **Open in store** link (`handoff` event). Checkout happens in the store.
- Polite fetching: an honest user agent, robots.txt respected, one request per store per step, a cool-down after HTTP 429, 12 s per page. Stores behind a captcha are skipped, not worked around. Only public https hosts are fetched (private addresses and redirects into them are refused).
- The allowed-stores list is visible and editable in the drawer. A new store is probed before it is accepted.

## Trust design

- **Grounded answers.** Every answer comes from a page snapshot (section text + data attributes, sha256-hashed). With an LLM, the reply has to quote a span that is literally in the snapshot. If it doesn't, the answer becomes "the page doesn't say".
- **Page content is data, not instructions.** Snapshot text is checked for injected instructions. Hits are logged as `injection_ignored`. Only user intents trigger actions.
- **Spending policy** (`apps/agent/src/policy.js`): approved stores only, auto-buy up to $150 and 3 orders a day. Price increases since first seen, new stores or quantities above 2 need approval. Unapproved stores and out-of-stock items are denied. DENY always wins.
- **Stores are the source of truth.** The agent searches each approved store's JSON API. With MongoDB configured, the same query also runs through Atlas Vector Search (`products_vector`, Titan v2 embeddings, pre-filtered by category). A semantic hit the store search missed becomes a candidate only after its store returns it live, so price, stock and delivery never come from the seeded copy. The `search_result` audit event lists `atlas_vector_search` with its hits and additions.
- **Re-verify before paying.** Reload, read price and stock again, and say any difference out loud with both prices and timestamps.
- **Explicit approval.** Only the exact phrase "confirm purchase" approves a purchase. "Yes" isn't enough.
- **Audit trail.** Each event stores `hash = sha256(prev_hash + canonical JSON)`. `GET /api/audit/verify?session=` recomputes the chain. The panel shows it as a readable timeline (one story per request: understand → search → compare → check → your rules → buy), with rule decisions and price changes highlighted. **Verify again** recomputes every hash on the server and, over https, in the browser too; **Export JSON** downloads the raw chain. Hashes and raw events sit behind each entry.

## Testing

```bash
npm test                 # unit tests + end-to-end demo script (stores + agent, no cloud services)
npm run scenarios        # adversarial scenario suite against a running agent
```

`firedrill/scenarios.json` holds seven scenarios: out of stock at verify, price jump at verify, vague request, unapproved store, over the limit, prompt injection inside a review, and a question the page can't answer. Each one runs in several phrasings. A run passes only if no unauthorized order is placed, the agent discloses what changed, and it says "not on the page" when that's true. The results are written to `firedrill/results-latest.json`. In the latest local run, 18 of 18 runs passed across all 7 scenarios with 0 unauthorized orders. External agent testers such as Firedrill can drive the same agent through `POST /api/chat {message, session_id?}` → `{session_id, reply}`.

## Repository layout

```
apps/agent/        agent server (HTTP + SSE), orchestrator, policy, audit, memory, search, ranking
apps/browser/      browser controller (Python: Nova Act or Playwright)
apps/merchants/    the two fictional stores (plain Node, no dependencies)
apps/panel/        the control panel (static HTML/JS/CSS)
packages/contracts shared constants and helpers
docs/              PRD, frozen interface contracts, module APIs
firedrill/         scenario suite
scripts/           dev launcher, seeding, scenario runner, publish check
tests/             node:test suites
```

## Publishing safety

`scripts/publish-check.sh` runs before every push (`bash scripts/install-hooks.sh` installs the hook). It blocks secrets (cloud keys, tokens, private keys, credentials in connection strings), `.env` files, absolute user paths, e-mail addresses, IP addresses and foreign registries in the lockfile. It also checks every term from a local, gitignored `.publish-denylist` against file contents, file names and git history.

## Known limits

- Built in one afternoon for a hackathon. The stores, catalog and payment are simulated, and no real money moves.
- Voice input uses the browser's Web Speech API. Chrome works best.
- The policy runs locally in the agent process. A production version would enforce it outside the agent, with scoped credentials for checkout.
