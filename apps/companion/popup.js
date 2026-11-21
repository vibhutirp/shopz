// Shopz Companion popup: pair with a Shopz panel (address + code), show what Shopz did in the Shopz tab.
const $ = (id) => document.getElementById(id);

function render(s) {
  if (!s) return;
  const on = s.status === 'paired' || s.status === 'connecting';
  $('pairBox').hidden = on;
  $('onBox').hidden = !on;
  $('statusText').textContent = s.status === 'paired' ? `Connected to ${s.server ? new URL(s.server).host : 'Shopz'}` : 'Connecting…';
  $('sub').textContent = s.status === 'paired' ? 'Shopz can use this browser' : 'Let Shopz use this browser';
  $('turn').hidden = !s.turn;
  $('turn').textContent = s.turn ? s.turn.message : '';
  $('log').replaceChildren(...(s.log || []).map((l) => { const li = document.createElement('li'); li.textContent = l.line; return li; }));
  $('err').hidden = !s.error;
  $('err').textContent = s.error || '';
  if (s.server && !$('server').value) $('server').value = s.server;
  $('connect').disabled = false;
  $('connect').textContent = 'Connect';
}

async function guessServer() {
  // If the active tab is a Shopz panel, use its address.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/.test(tab.url || '')) return;
    const origin = new URL(tab.url).origin;
    const r = await fetch(origin + '/api/health', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.companion && !$('server').value) $('server').value = origin;
  } catch { /* not a Shopz panel */ }
}

$('connect').addEventListener('click', async () => {
  const server = $('server').value.trim();
  const code = $('code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  $('err').hidden = true;
  try { new URL(server); } catch { $('err').textContent = 'Enter the address of your Shopz panel.'; $('err').hidden = false; return; }
  if (code.length < 6) { $('err').textContent = 'Enter the 6-character code shown in the Shopz panel.'; $('err').hidden = false; return; }
  $('connect').disabled = true;
  $('connect').textContent = 'Connecting…';
  await chrome.runtime.sendMessage({ type: 'connect', server, code });
});
$('disconnect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'disconnect' }));
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect').click(); });
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'state') render(m.state); });
chrome.runtime.sendMessage({ type: 'get_state' }).then(render);
guessServer();
