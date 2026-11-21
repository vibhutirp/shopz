// Shopz Companion – runs only in the Shopz tab (injected on demand by the background worker).
// Reads the page, shows every action on screen, and refuses anything that is the human's job.
/* global ShopzGate */
(function () {
  'use strict';
  if (window.__shopzCompanion) return;
  window.__shopzCompanion = true;

  // ---------------------------------------------------------------- overlay (shadow DOM, never blocks the page)
  let host = null;
  let shadow = null;
  function ui() {
    if (host && host.isConnected) return shadow;
    host = document.createElement('shopz-companion');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:auto 0 0 auto;pointer-events:none';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host{all:initial}
      .pill{position:fixed;right:16px;bottom:16px;display:flex;gap:8px;align-items:center;max-width:min(420px,calc(100vw - 32px));
        background:#172554;color:#fff;font:600 13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:9px 14px;border-radius:999px;
        box-shadow:0 6px 24px rgba(0,0,0,.25);opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s}
      .pill.on{opacity:1;transform:none}
      .dot{width:8px;height:8px;border-radius:50%;background:#f59e0b;flex:none}
      .turn{position:fixed;left:50%;top:14px;transform:translateX(-50%);width:min(560px,calc(100vw - 24px));box-sizing:border-box;
        background:#fffbeb;color:#422006;border:2px solid #f59e0b;border-radius:14px;padding:14px 16px;display:none;gap:12px;align-items:center;
        font:500 14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.18);pointer-events:auto}
      .turn.on{display:flex}
      .turn b{display:block;font-size:15px;margin-bottom:2px}
      .turn button{margin-left:auto;flex:none;background:#172554;color:#fff;border:0;border-radius:10px;padding:10px 14px;font:600 14px system-ui,sans-serif;cursor:pointer}
      .turn button:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
    </style><div class="pill" part="pill"><span class="dot"></span><span class="txt"></span></div>
    <div class="turn" role="alertdialog" aria-live="assertive"><div><b>Your turn</b><span class="msg"></span></div><button type="button">I'm done</button></div>`;
    shadow.querySelector('.turn button').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'turn_button' }).catch(() => {});
      shadow.querySelector('.turn button').textContent = 'Thanks…';
    });
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }
  let pillTimer = null;
  function badge(text, ms = 3500) {
    const s = ui();
    const p = s.querySelector('.pill');
    p.querySelector('.txt').textContent = `Shopz · ${text}`;
    p.classList.add('on');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => p.classList.remove('on'), ms);
  }
  function showTurn(show, message) {
    const s = ui();
    const t = s.querySelector('.turn');
    if (!show) { t.classList.remove('on'); return; }
    const m = String(message || '').replace(/^Your turn:\s*/i, '');
    s.querySelector('.msg').textContent = m.charAt(0).toUpperCase() + m.slice(1);
    if (!t.classList.contains('on')) s.querySelector('.turn button').textContent = "I'm done";
    t.classList.add('on');
  }

  const HL_CSS = '.shopz-hl{outline:3px solid rgba(245,158,11,0);outline-offset:6px;transition:outline-color .2s ease,box-shadow .2s ease}'
    + '.shopz-hl-round{border-radius:12px}.shopz-hl.shopz-hl-on{outline-color:#f59e0b;box-shadow:0 0 0 6px rgba(245,158,11,.10),0 0 22px 6px rgba(245,158,11,.30)}';
  function frame(el) {
    if (!document.getElementById('shopz-highlight-style')) {
      const style = document.createElement('style');
      style.id = 'shopz-highlight-style';
      style.textContent = HL_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    for (const old of document.querySelectorAll('.shopz-hl-on')) old.classList.remove('shopz-hl-on');
    if (!el) return;
    el.classList.add('shopz-hl');
    if (!parseFloat(getComputedStyle(el).borderTopLeftRadius)) el.classList.add('shopz-hl-round');
    void el.offsetWidth;
    el.classList.add('shopz-hl-on');
  }

  // ---------------------------------------------------------------- reading
  const visible = (el) => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');
  const anyVisible = (sel) => Array.from(document.querySelectorAll(sel)).find(visible) || null;
  const labelOf = (el) => (el ? [el.innerText || el.textContent || '', el.value || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '');

  function features() {
    const frames = Array.from(document.querySelectorAll('iframe')).filter(visible);
    const sized = (f) => { const r = f.getBoundingClientRect(); return r.width >= 150 && r.height >= 60; };
    const captchaFrame = frames.filter((f) => sized(f) && !/size=invisible/i.test(f.src || '')).map((f) => f.src || '').find((src) => /(recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha|captcha)/i.test(src)) || null;
    const captchaEl = ['#px-captcha', '.cf-turnstile', '#challenge-form', '#cf-challenge-running', '#challenge-stage', '.h-captcha', '.g-recaptcha[data-size="normal"]', 'form[action*="validateCaptcha"]', '#captcha-container']
      .find((sel) => { const el = document.querySelector(sel); if (!el || !visible(el)) return false; const r = el.getBoundingClientRect(); return r.width >= 100 && r.height >= 40; }) || null;
    const payFrame = frames.map((f) => f.src || '').filter(Boolean).join(' ').slice(0, 2000);
    const payButton = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).filter(visible).find((b) => ShopzGate.PAY_BUTTON.test(labelOf(b))) || null;
    return {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').slice(0, 6000),
      password_visible: Boolean(anyVisible('input[type=password]')),
      email_input: Boolean(anyVisible('input[type=email], input[autocomplete="email"], input[autocomplete="username"], input[name*="email" i]')),
      otp_input: Boolean(anyVisible('input[autocomplete="one-time-code"]')),
      card_input: Boolean(anyVisible('input[autocomplete^="cc-number"], input[name*="cardnumber" i], input[name="card"], input[name*="card_number" i], input[data-card-number]')),
      payment_frame: payFrame || null,
      captcha_frame: captchaFrame,
      captcha_element: captchaEl,
      pay_button: Boolean(payButton),
    };
  }
  const gateNow = () => ShopzGate.classify(features());

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function read() {
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const main = document.querySelector('main') || document.body;
    const jsonld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20).map((s) => (s.textContent || '').slice(0, 200000));
    const meta = {};
    for (const m of document.querySelectorAll('meta[property], meta[name]')) {
      const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (/^(og:|product:|description$|twitter:title)/.test(k) && !(k in meta)) meta[k] = (m.getAttribute('content') || '').slice(0, 2000);
    }
    badge('reading this page');
    return {
      url: location.href, title: document.title, text: (main ? main.innerText : '').slice(0, 20000), jsonld, meta,
      bytes: html.length, html_sha256: await sha256(html), gate: gateNow(),
    };
  }

  function snapshot({ section = null } = {}) {
    const collect = (el) => {
      const attrs = {};
      for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-') && a.name !== 'data-section') attrs[a.name] = a.value;
      return { name: el.getAttribute('data-section'), text: (el.innerText || '').replace(/\s+/g, ' ').trim(), attrs };
    };
    const parts = section === null
      ? Array.from(document.querySelectorAll('[data-section]')).map(collect)
      : [document.querySelector('[data-section="' + CSS.escape(section) + '"]')].filter(Boolean).map(collect);
    return { url: location.href, parts };
  }

  function query({ selector, limit = 5 }) {
    const items = Array.from(document.querySelectorAll(String(selector))).slice(0, Math.min(Number(limit) || 5, 20)).map((el) => {
      const attrs = {};
      for (const a of Array.from(el.attributes)) attrs[a.name] = String(a.value).slice(0, 500);
      return { text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000), attrs };
    });
    return { url: location.href, items };
  }

  // ---------------------------------------------------------------- acting (visible, refusing the human's parts)
  function find({ selector, text }) {
    if (selector) {
      const all = Array.from(document.querySelectorAll(String(selector)));
      return all.find(visible) || all[0] || null;
    }
    if (text) {
      const want = String(text).toLowerCase();
      return Array.from(document.querySelectorAll('button, a, input[type=submit], [role=button]')).filter(visible).find((b) => labelOf(b).toLowerCase().includes(want)) || null;
    }
    return null;
  }
  const inPaymentForm = (el) => {
    const form = el.closest('form');
    return Boolean(form && form.querySelector('input[type=password], input[autocomplete^="cc-"], input[name="card"], input[name*="cardnumber" i], input[name*="cvc" i], input[name*="cvv" i]'));
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function click(a) {
    const el = find(a);
    if (!el) throw new Error(`nothing to click for ${a.selector || a.text}`);
    const why = ShopzGate.refuseClick({ text: el.innerText || el.textContent, value: el.value, aria: el.getAttribute('aria-label'), title: el.getAttribute('title'), type: el.getAttribute('type') || (el.tagName === 'BUTTON' ? 'submit' : ''), in_payment_form: inPaymentForm(el) });
    if (why) throw Object.assign(new Error(why), { refused: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    frame(el);
    badge(`clicking “${labelOf(el).slice(0, 40) || a.label || 'button'}”`);
    await pause(380);
    const label = labelOf(el).slice(0, 60);
    setTimeout(() => el.click(), 20); // answer first: the click may navigate away
    return { clicked: true, label };
  }

  function setValue(el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fill(a) {
    const el = find({ selector: a.selector });
    if (!el) throw new Error(`no field ${a.selector}`);
    const lab = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || '') : (el.closest('label')?.innerText || '');
    const why = ShopzGate.refuseFill({ type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.id, autocomplete: el.getAttribute('autocomplete'), label: lab, placeholder: el.getAttribute('placeholder') });
    if (why) throw Object.assign(new Error(`Shopz does not type into a ${why}`), { refused: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    frame(el);
    badge(`filling ${a.label || el.getAttribute('name') || 'a field'}`);
    await pause(250);
    setValue(el, String(a.value ?? ''));
    return { filled: true };
  }

  /** Shopify: the product form's own "Add to cart" button (visible click), else the store's /cart/add.js. Then read /cart.js. */
  async function addToCart({ variant_id = null, qty = 1 }) {
    const forms = Array.from(document.querySelectorAll('form[action*="/cart/add"]'));
    const form = forms.find((f) => visible(f) && (!variant_id || f.querySelector('[name="id"]'))) || forms.find((f) => f.querySelector('[name="id"]')) || null;
    let method = 'cart_api';
    const before = await cartJson().catch(() => null);
    if (form) {
      const idField = form.querySelector('[name="id"]');
      if (variant_id && idField) {
        if (idField.tagName === 'SELECT' && !Array.from(idField.options).some((o) => o.value === String(variant_id))) { /* keep the theme's choice */ } else setValue(idField, String(variant_id));
      }
      const q = form.querySelector('[name="quantity"]');
      if (q && Number(qty) > 1) setValue(q, String(qty));
      const btn = Array.from(form.querySelectorAll('button[type=submit], button[name="add"], input[type=submit], button:not([type])')).filter(visible)
        .find((b) => /add to (cart|bag|basket)|add\b/i.test(labelOf(b))) || null;
      if (btn && !btn.disabled && !ShopzGate.refuseClick({ text: btn.innerText, value: btn.value, aria: btn.getAttribute('aria-label') })) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        frame(btn);
        badge('adding to your cart');
        await pause(420);
        btn.click();
        method = 'button';
        for (let i = 0; i < 12; i += 1) {
          await pause(400);
          const now = await cartJson().catch(() => null);
          if (now && before && now.item_count > before.item_count) return { method, cart: shape(now) };
          if (now && !before && now.item_count > 0) return { method, cart: shape(now) };
        }
      }
    }
    // The store's own cart endpoint, same origin, your cookies (themes without a plain form, or the click did nothing).
    const id = variant_id || form?.querySelector('[name="id"]')?.value;
    if (!id) throw new Error('no add-to-cart form on this page');
    badge('adding to your cart');
    const r = await fetch('/cart/add.js', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ items: [{ id: Number(id), quantity: Number(qty) || 1 }] }) });
    if (!r.ok) throw new Error(`the store refused the cart (HTTP ${r.status})`);
    return { method: method === 'button' ? 'button+cart_api' : 'cart_api', cart: shape(await cartJson()) };
  }
  async function cartJson() {
    const r = await fetch('/cart.js', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`cart HTTP ${r.status}`);
    return r.json();
  }
  const shape = (c) => ({
    item_count: c.item_count, total: typeof c.total_price === 'number' ? c.total_price / 100 : null, currency: c.currency || null,
    items: (c.items || []).slice(0, 20).map((x) => ({ variant_id: x.variant_id ?? x.id, handle: x.handle, title: x.product_title || x.title, qty: x.quantity, price: typeof x.final_price === 'number' ? x.final_price / 100 : typeof x.price === 'number' ? x.price / 100 : null })),
  });

  // ---------------------------------------------------------------- dispatcher
  const OPS = {
    ping: () => ({ ok: true }),
    badge: (a) => { badge(a.text || 'working'); return {}; },
    read,
    snapshot,
    query,
    exists: (a) => ({ found: Boolean(document.querySelector(String(a.selector))) }),
    scroll: (a) => {
      const el = a.section ? document.querySelector('[data-section="' + CSS.escape(a.section) + '"]') : find({ selector: a.selector });
      if (!el) throw new Error(`no ${a.section || a.selector} on this page`);
      el.style.scrollMarginTop = '80px';
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      badge(`showing ${a.section || 'this part'}`);
      return {};
    },
    highlight: (a) => {
      const el = a.section === null || a.section === undefined ? null : document.querySelector('[data-section="' + CSS.escape(a.section) + '"]');
      if (a.section && !el) throw new Error(`no ${a.section} on this page`);
      frame(el);
      return {};
    },
    click,
    fill,
    add_to_cart: addToCart,
    turn: (a) => { showTurn(Boolean(a.show), a.message); return { gate: gateNow(), url: location.href }; },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const fn = msg && OPS[msg.op];
    if (!fn) return false;
    if (msg.turn && msg.op !== 'turn') showTurn(true, msg.turn.message);
    Promise.resolve().then(() => fn(msg.args || {})).then(
      (data) => reply(msg.op === 'ping' ? { ok: true } : { ok: true, data: data || {} }),
      (err) => reply({ ok: false, error: String(err && err.message || err), refused: Boolean(err && err.refused) }),
    );
    return true;
  });
})();
