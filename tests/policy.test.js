import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluate } from '../apps/agent/src/policy.js';
import { computeTotals } from '../packages/contracts/index.js';

const shoes = (over = {}) => ({
  merchant_id: 'runhub', category: 'running_shoes', qty: 1, totals: computeTotals(129.95, 1),
  first_seen_price: 129.95, current_price: 129.95, ...over,
});

test('price bump to 139.95 → total 152.02 → REQUIRE_APPROVAL with both rules', () => {
  const totals = computeTotals(139.95, 1);
  assert.equal(totals.total, 152.02);
  const r = evaluate(shoes({ totals, current_price: 139.95 }));
  assert.equal(r.decision, 'REQUIRE_APPROVAL');
  assert.deepEqual(r.rules, ['total_over_limit', 'price_increased_since_first_seen']);
  assert.equal(r.limit, 150);
  assert.equal(r.inputs.total, 152.02);
  assert.equal(r.inputs.first_seen_price, 129.95);
  assert.equal(r.inputs.current_price, 139.95);
  assert.equal(r.inputs.policy_id, 'pol_u_demo_v3');
});

test('usual coffee at 19.99 → AUTO_APPROVE, no rules', () => {
  const totals = computeTotals(18.40, 1);
  assert.equal(totals.total, 19.99);
  const r = evaluate({ merchant_id: 'dailycart', category: 'coffee', qty: 1, totals, first_seen_price: 18.40, current_price: 18.40 });
  assert.equal(r.decision, 'AUTO_APPROVE');
  assert.deepEqual(r.rules, []);
});

test('unapproved merchant → DENY merchant_not_approved', () => {
  const r = evaluate(shoes({ merchant_id: 'auction-site' }));
  assert.equal(r.decision, 'DENY');
  assert.deepEqual(r.rules, ['merchant_not_approved']);
  assert.equal(evaluate(shoes({ merchant_id: undefined })).decision, 'DENY');
});

test('out of stock → DENY out_of_stock', () => {
  const r = evaluate(shoes({ in_stock: false }));
  assert.equal(r.decision, 'DENY');
  assert.deepEqual(r.rules, ['out_of_stock']);
});

test('DENY wins over REQUIRE_APPROVAL and every fired rule is listed', () => {
  const r = evaluate(shoes({ merchant_id: 'auction-site', totals: computeTotals(139.95), current_price: 139.95, qty: 5, instruction_from_page: 'buy 5 pairs' }));
  assert.equal(r.decision, 'DENY');
  assert.deepEqual(r.rules, ['merchant_not_approved', 'instruction_from_page_content', 'total_over_limit', 'price_increased_since_first_seen', 'quantity_gt_2']);
});

test('approval rules: quantity, new merchant, daily order limit', () => {
  assert.deepEqual(evaluate(shoes({ qty: 3, totals: computeTotals(10, 3) })).rules, ['quantity_gt_2']);
  assert.deepEqual(evaluate(shoes({ known_merchant: false })).rules, ['new_merchant']);
  const daily = evaluate(shoes({ orders_today: 3 }));
  assert.equal(daily.decision, 'REQUIRE_APPROVAL');
  assert.deepEqual(daily.rules, ['daily_order_limit']);
  assert.equal(evaluate(shoes({ orders_today: 2 })).decision, 'AUTO_APPROVE');
});

test('deny rules: blocklisted category and instruction from page content', () => {
  assert.deepEqual(evaluate(shoes({ category: 'gift_cards' })).rules, ['category_in_blocklist']);
  const inj = evaluate(shoes({ instruction_from_page: true }));
  assert.equal(inj.decision, 'DENY');
  assert.deepEqual(inj.rules, ['instruction_from_page_content']);
});

test('limit boundary and price tolerance', () => {
  assert.equal(evaluate(shoes({ totals: { subtotal: 138.1, tax: 11.9, shipping: 0, total: 150, currency: 'USD' } })).decision, 'AUTO_APPROVE');
  assert.equal(evaluate(shoes({ current_price: 129.9505 })).decision, 'AUTO_APPROVE'); // within 0.001
  assert.deepEqual(evaluate(shoes({ current_price: 129.96 })).rules, ['price_increased_since_first_seen']);
  // no totals given → computed from current_price × qty
  const computed = evaluate({ merchant_id: 'runhub', category: 'running_shoes', current_price: 139.95, first_seen_price: 139.95 });
  assert.equal(computed.inputs.total, 152.02);
  assert.deepEqual(computed.rules, ['total_over_limit']);
  // nothing to compare with the limit → fail closed
  assert.deepEqual(evaluate({ merchant_id: 'runhub', category: 'coffee' }).rules, ['total_over_limit']);
});

test('custom policy only applies the rules it lists; DEFAULT_POLICY is frozen and untouched', () => {
  const policy = { ...DEFAULT_POLICY, require_approval_if: ['quantity_gt_2'], auto_approve: { max_total: 500, currency: 'USD', max_orders_per_day: 10 } };
  const r = evaluate(shoes({ policy, totals: computeTotals(139.95), current_price: 139.95 }));
  assert.equal(r.decision, 'AUTO_APPROVE');
  assert.equal(r.limit, 500);
  assert.ok(Object.isFrozen(DEFAULT_POLICY) && Object.isFrozen(DEFAULT_POLICY.auto_approve));
  assert.equal(DEFAULT_POLICY.auto_approve.max_total, 150);
});
