// Shopz Companion in the panel: pair the user's own browser, show what Shopz does there, and the "Your turn" hand-off.
// Loaded before app.js; app.js merges `handlers` into its event stream and calls init() with the session and helpers.
(() => {
  'use strict';
  let api = null; // { session, mode, post, toast, h, placeInThread, hideWelcome, scrollTurns }
  let status = { connected: false };
  let pairCard = null; // { el, codeEl, statusEl, timer }
  let activity = null; // { el, list }
  let turnCard = null; // { el, turn_id }

  const ICON = {
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  };
  const KIND = { login: 'Sign in', captcha: 'Solve the check', '2fa': 'Enter the code', payment: 'Pay' };

  function el(tag, attrs, ...kids) { return api.h(tag, attrs, ...kids); }
  /** "Your turn: please sign in …" → "Please sign in …" (the card already says "Your turn"). */
  const sentence = (m) => { const t = String(m || '').replace(/^Your turn:\s*/i, ''); return t.charAt(0).toUpperCase() + t.slice(1); };
  function place(node) { api.hideWelcome(); api.placeInThread(node); api.scrollTurns(true); }

  function renderButton() {
    const b = document.getElementById('companionBtn');
    if (!b) return;
    b.classList.toggle('on', Boolean(status.connected));
    b.classList.toggle('turn', Boolean(status.your_turn));
    b.setAttribute('aria-pressed', status.connected ? 'true' : 'false');
    b.title = status.connected ? `Shopz uses your browser (${status.browser || 'Chrome'})` : 'Connect your browser: Shopz then searches and reads pages from your own Chrome';
    const lab = b.querySelector('.cmp-label');
    if (lab) lab.textContent = status.connected ? 'Your browser' : 'Connect browser';
  }

  // ---------------------------------------------------------------- pairing card
  async function openPair() {
    if (status.connected) { showConnected(); return; }
    const r = await api.post('/api/companion/pair', { session_id: api.session, mode: api.mode() });
    if (!r || !r.code) return;
    if (pairCard && pairCard.el.isConnected) pairCard.el.remove();
    const origin = location.origin;
    const codeEl = el('div', { class: 'cmp-code', 'aria-label': `Pairing code ${r.code.split('').join(' ')}` }, r.code.slice(0, 3), el('span', { class: 'cmp-gap' }), r.code.slice(3));
    const statusEl = el('div', { class: 'cmp-wait' }, el('span', { class: 'cmp-spin', 'aria-hidden': 'true' }), 'Waiting for your browser…');
    const copy = (text, what) => { navigator.clipboard?.writeText(text).then(() => api.toast(`${what} copied`, 'info', 1500), () => {}); };
    const card = el('div', { class: 'icard cmp-card', role: 'group', 'aria-label': 'Connect your browser' },
      el('div', { class: 'icard-top', html: ICON.link + '<span>Connect your browser</span>' }),
      el('p', { class: 'cmp-lead' }, 'Shopz then searches and reads stores from your own Chrome – your connection, your sign-ins. It works in one tab of its own and hands sign-in, checks and paying to you.'),
      el('ol', { class: 'cmp-steps' },
        el('li', null, 'Install ', el('b', null, 'Shopz Companion'), ' (Chrome → Extensions → Developer mode → Load unpacked → the ', el('code', null, 'apps/companion'), ' folder).'),
        el('li', null, 'Click the extension, enter this address and the code:'),
      ),
      el('div', { class: 'cmp-pair' },
        el('button', { class: 'cmp-addr', type: 'button', title: 'Copy the address', onclick: () => copy(origin, 'Address') }, origin.replace(/^https?:\/\//, '')),
        el('button', { class: 'cmp-codebtn', type: 'button', title: 'Copy the code', onclick: () => copy(r.code, 'Code') }, codeEl)),
      el('div', { class: 'cmp-foot' }, statusEl, el('span', { class: 'cmp-ttl' }, 'Code valid for 10 minutes')),
    );
    pairCard = { el: card, codeEl, statusEl };
    place(card);
  }

  function showConnected() {
    if (pairCard && pairCard.el.isConnected) {
      pairCard.statusEl.replaceChildren(el('span', { class: 'cmp-ok', html: ICON.check }), `Connected – ${status.browser || 'your browser'}`);
      pairCard.el.classList.add('done');
      pairCard.el.querySelector('.cmp-ttl')?.remove();
      if (!pairCard.el.querySelector('.cmp-off')) {
        pairCard.el.querySelector('.cmp-foot').append(el('button', { class: 'btn cmp-off', type: 'button', onclick: disconnect }, 'Disconnect'));
      }
      return;
    }
    const card = el('div', { class: 'icard cmp-card done' },
      el('div', { class: 'icard-top', html: ICON.link + '<span>Your browser</span>' }),
      el('div', { class: 'cmp-foot' }, el('div', { class: 'cmp-wait' }, el('span', { class: 'cmp-ok', html: ICON.check }), `Connected – ${status.browser || 'your browser'}`),
        el('button', { class: 'btn cmp-off', type: 'button', onclick: disconnect }, 'Disconnect')));
    pairCard = { el: card, statusEl: card.querySelector('.cmp-wait') };
    place(card);
  }

  async function disconnect() {
    await api.post('/api/companion/disconnect', { session_id: api.session });
  }

  // ---------------------------------------------------------------- activity in the user's browser
  function addActivity(d) {
    if (!activity || !activity.el.isConnected || activity.el !== activity.el.parentNode?.lastElementChild) {
      const list = el('ul', { class: 'cmp-acts' });
      activity = { el: el('div', { class: 'cmp-activity', 'aria-live': 'polite' }, el('div', { class: 'cmp-acts-head', html: ICON.link + '<span>In your browser</span>' }), list), list, rows: new Map() };
      place(activity.el);
    }
    let row = activity.rows.get(d.id);
    const cls = `cmp-act ${d.state}`;
    const txt = d.state === 'refused' ? `Refused: ${d.summary} – ${d.error || ''}` : d.state === 'failed' ? `${d.summary} – failed` : d.summary;
    if (!row) {
      row = el('li', { class: cls }, txt);
      activity.rows.set(d.id, row);
      activity.list.append(row);
      while (activity.list.children.length > 6) activity.list.firstElementChild.remove();
    } else { row.className = cls; row.textContent = txt; }
    api.scrollTurns();
  }

  // ---------------------------------------------------------------- your turn
  function showTurn(d) {
    if (turnCard && turnCard.el.isConnected) turnCard.el.remove();
    const btn = d.wait ? el('button', { class: 'btn btn-primary cmp-done', type: 'button', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Continuing…';
      await api.post('/api/companion/resume', { session_id: api.session });
    } }, "I'm done") : null;
    const card = el('div', { class: 'icard cmp-turn', role: 'alert' },
      el('div', { class: 'cmp-turn-head', html: ICON.hand + `<span>Your turn · ${KIND[d.kind] || 'In the Shopz tab'}</span>` }),
      el('p', { class: 'cmp-turn-msg' }, sentence(d.message)),
      el('div', { class: 'cmp-turn-foot' },
        el('span', { class: 'cmp-turn-hint' }, d.wait ? 'Shopz waits and carries on by itself when it sees you are through – or say “done”.' : 'Shopz stops here. The Shopz tab in your browser is ready for you.'),
        btn),
    );
    turnCard = { el: card, turn_id: d.turn_id };
    place(card);
  }
  function turnDone(d) {
    if (!turnCard || turnCard.turn_id !== d.turn_id || !turnCard.el.isConnected) return;
    const c = turnCard.el;
    c.classList.add('done');
    const foot = c.querySelector('.cmp-turn-foot');
    foot.replaceChildren(el('span', { class: 'cmp-turn-hint' }, d.ok ? (d.kind === 'payment' ? 'The store shows your order page.' : 'Thanks – Shopz carries on.') : `Hand-off ended (${String(d.resumed_by || '').replace('_', ' ')}).`));
    turnCard = null;
  }

  const handlers = {
    companion(d) {
      const was = status.connected;
      status = d || { connected: false };
      renderButton();
      if (status.connected && !was) { showConnected(); api.toast('Shopz now uses your browser', 'info', 2200); }
      if (!status.connected && was) {
        api.toast('Your browser disconnected – Shopz works from the server again', 'info', 3000);
        if (pairCard && pairCard.el.isConnected) { pairCard.statusEl.textContent = 'Disconnected'; pairCard.el.querySelector('.cmp-off')?.remove(); }
      }
    },
    'companion.action': addActivity,
    'companion.your_turn': (d) => { status.your_turn = d; renderButton(); showTurn(d); },
    'companion.turn_done': (d) => { status.your_turn = null; renderButton(); turnDone(d); },
    'companion.page': () => {},
  };

  function init(a) {
    api = a;
    const b = document.getElementById('companionBtn');
    if (b) b.addEventListener('click', openPair);
    fetch('/api/companion/status?session=' + encodeURIComponent(api.session), { cache: 'no-store' })
      .then((r) => r.json()).then((s) => { status = s || status; renderButton(); }).catch(() => {});
  }

  window.ShopzCompanion = { handlers, init, openPair };
})();
