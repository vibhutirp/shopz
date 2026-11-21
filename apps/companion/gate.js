// Shopz Companion – the hand-off rules, shared by the extension (content script) and the server tests.
// Plain script: in the browser it sets globalThis.ShopzGate, in Node it is loaded with vm (tests/companion.test.js).
// The rules are deliberately conservative: when in doubt, the human takes over.
(function (root) {
  'use strict';

  const CAPTCHA_FRAME = /(recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|perimeterx|px-cdn|captcha-delivery|geo\.captcha|datadome|awswaf|amazon.*captcha)/i;
  const CAPTCHA_TEXT = /(verify (that )?you are (a )?human|are you a robot|i'?m not a robot|press (&|and) hold|complete the security check|checking your browser|unusual traffic|bot (check|protection)|enter the characters you see|type the characters)/i;
  const LOGIN_URL = /(\/(account\/)?log-?in\b|\/sign-?in\b|\/signin\b|\/authentication\b|\/auth\/|\/session\/new|accounts?\.[a-z0-9-]+\.[a-z]+\/|\/ap\/signin|\/customer\/account\/login)/i;
  const LOGIN_TEXT = /\b(sign in|log in|login|anmelden|einloggen)\b/i;
  const OTP_TEXT = /(verification code|one-?time (pass)?code|enter the code|we sent (you )?a code|two-?factor|2fa|authenticator app|security code sent)/i;
  const PAYMENT_URL = /(\/checkouts?\/|\/checkout\/(payment|place|review)|\/payment\b|\/pay\b|\/cart\/checkout|pay\.shopify|\/billing\b)/i;
  const PAYMENT_FRAME = /(checkout\.shopifycs\.com|js\.stripe\.com|stripe\.network|braintree|adyen|paypal\.com|pay\.google\.com|applepay|klarna|affirm|afterpay|checkout\.com|cybersource|card-fields|deposit\.shopifycs)/i;
  // Buttons the agent never clicks: paying or placing an order is always the human's tap.
  const PAY_BUTTON = /(\bpay\b|pay now|place (your )?order|complete (order|purchase|payment)|submit (order|payment)|confirm (order|purchase|payment)|buy (it )?now|purchase now|checkout with|express checkout|order now|jetzt (kaufen|bezahlen)|zahlungspflichtig)/i;
  // Fields the agent never types into.
  const SENSITIVE_AC = /^(current-password|new-password|one-time-code|cc-|webauthn)/i;
  const SENSITIVE_NAME = /(pass(word|wd)?|pwd|otp|one.?time|2fa|totp|card.?(number|num|no)|cc.?(num|number|exp|csc|cvc|cvv)|\bcvc\b|\bcvv\b|\bcsc\b|security.?code|iban|routing|account.?number|ssn|social.?security)/i;

  /**
   * features: { url, title, text, password_visible, email_input, otp_input, card_input, payment_frame, captcha_frame,
   *             captcha_element, pay_button }  (all optional; produced by readFeatures() in the page)
   * → { kind: 'captcha' | '2fa' | 'login' | 'payment' | null, reason }
   */
  function classify(f) {
    const x = f || {};
    const url = String(x.url || '');
    const text = String(x.text || '').slice(0, 6000);
    const title = String(x.title || '');
    if (x.captcha_element || (x.captcha_frame && CAPTCHA_FRAME.test(String(x.captcha_frame))) || CAPTCHA_TEXT.test(title) || (CAPTCHA_TEXT.test(text) && text.length < 2500)) {
      return { kind: 'captcha', reason: x.captcha_element ? `captcha element ${x.captcha_element}` : x.captcha_frame ? 'captcha frame' : 'bot check text' };
    }
    if (x.otp_input || (OTP_TEXT.test(text) && text.length < 3000 && /\b(code|digits?)\b/i.test(text))) {
      return { kind: '2fa', reason: x.otp_input ? 'one-time code field' : 'verification code text' };
    }
    if (x.password_visible) return { kind: 'login', reason: 'password field' };
    if (x.email_input && (LOGIN_URL.test(url) || LOGIN_TEXT.test(title))) return { kind: 'login', reason: 'sign-in form' };
    if (x.card_input) return { kind: 'payment', reason: 'card field' };
    if (x.payment_frame && PAYMENT_FRAME.test(String(x.payment_frame))) return { kind: 'payment', reason: 'payment frame' };
    if (PAYMENT_URL.test(url) && (x.pay_button || /\b(payment|card|billing)\b/i.test(text.slice(0, 3000)))) return { kind: 'payment', reason: 'checkout payment step' };
    return { kind: null, reason: null };
  }

  /** An element the agent wants to click: { text, value, aria, type, in_payment_form } → reason string when refused, else null. */
  function refuseClick(el) {
    const e = el || {};
    const label = [e.text, e.value, e.aria, e.title].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (PAY_BUTTON.test(label)) return `"${label.slice(0, 60)}" pays or places an order – that is the human's tap`;
    if (e.in_payment_form && String(e.type || '').toLowerCase() === 'submit') return 'submit button of a payment form';
    return null;
  }

  /** A field the agent wants to fill: { type, name, id, autocomplete, label } → reason string when refused, else null. */
  function refuseFill(field) {
    const f = field || {};
    const type = String(f.type || '').toLowerCase();
    if (type === 'password') return 'password field';
    if (SENSITIVE_AC.test(String(f.autocomplete || ''))) return `${f.autocomplete} field`;
    const ident = [f.name, f.id, f.label, f.placeholder].filter(Boolean).join(' ');
    if (SENSITIVE_NAME.test(ident)) return `sensitive field (${ident.slice(0, 40)})`;
    return null;
  }

  /** Navigation targets: only http(s); never browser-internal pages, files, or another extension. */
  function refuseUrl(url, { allowLocal = false } = {}) {
    let u;
    try { u = new URL(String(url)); } catch { return 'not a valid address'; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${u.protocol} pages are off limits`;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const local = h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h) || /^(fc|fd|fe8)/.test(h) || h.endsWith('.local') || h.endsWith('.internal');
    if (local && !allowLocal) return 'addresses on your local network are off limits';
    if (u.protocol === 'http:' && !local) return 'only https pages';
    if (u.username || u.password) return 'addresses with credentials are off limits';
    return null;
  }

  const MESSAGES = {
    captcha: 'Your turn: please solve the check in the Shopz tab. Shopz never solves captchas.',
    login: 'Your turn: please sign in in the Shopz tab. Shopz never types your password.',
    '2fa': 'Your turn: please enter the verification code in the Shopz tab.',
    payment: 'Your turn: review the order and pay in the Shopz tab. Shopz never clicks pay.',
  };

  const api = { classify, refuseClick, refuseFill, refuseUrl, MESSAGES, PAY_BUTTON, version: 1 };
  root.ShopzGate = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
