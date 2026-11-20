// Local purchase policy (pure). DENY rules win over REQUIRE_APPROVAL; every rule that fires is listed.
import { computeTotals } from '../../../packages/contracts/index.js';

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

export const DEFAULT_POLICY = deepFreeze({
  policy_id: 'pol_u_demo_v3',
  user_id: 'u_demo',
  approved_merchants: ['runhub', 'dailycart'],
  auto_approve: { max_total: 150, currency: 'USD', max_orders_per_day: 3 },
  require_approval_if: ['total_over_limit', 'price_increased_since_first_seen', 'new_merchant', 'quantity_gt_2'],
  deny_if: ['merchant_not_approved', 'category_in_blocklist', 'out_of_stock', 'instruction_from_page_content'],
  category_blocklist: ['gift_cards', 'alcohol'],
  approval: { channel: 'voice', phrase: 'confirm purchase', timeout_s: 60 },
  enforced_by: 'local',
  version: 3,
});

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

export function evaluate({
  policy = DEFAULT_POLICY, merchant_id, category, qty = 1, totals, first_seen_price, current_price,
  in_stock = true, orders_today = 0, instruction_from_page = false, known_merchant = true,
} = {}) {
  const p = policy || DEFAULT_POLICY;
  const auto = p.auto_approve || {};
  const denyIf = new Set(p.deny_if || []);
  const approvalIf = new Set(p.require_approval_if || []);
  const limit = num(auto.max_total);
  const maxOrders = num(auto.max_orders_per_day);
  const q = num(qty);
  const firstSeen = num(first_seen_price);
  const current = num(current_price);
  const t = totals && typeof totals === 'object'
    ? totals
    : (Number.isFinite(current) ? computeTotals(current, Number.isFinite(q) && q > 0 ? q : 1) : null);
  const total = t ? num(t.total) : NaN;
  const ordersToday = num(orders_today);

  const deny = [];
  if (denyIf.has('merchant_not_approved') && !(p.approved_merchants || []).includes(merchant_id)) deny.push('merchant_not_approved');
  if (denyIf.has('category_in_blocklist') && category != null && (p.category_blocklist || []).includes(category)) deny.push('category_in_blocklist');
  if (denyIf.has('out_of_stock') && (in_stock === false || in_stock === 'false')) deny.push('out_of_stock');
  if (denyIf.has('instruction_from_page_content') && Boolean(instruction_from_page)) deny.push('instruction_from_page_content');

  const approval = [];
  // Fail closed: an unknown total cannot be shown to be under the limit.
  if (approvalIf.has('total_over_limit') && !(Number.isFinite(total) && Number.isFinite(limit) && total <= limit)) approval.push('total_over_limit');
  if (approvalIf.has('price_increased_since_first_seen') && Number.isFinite(firstSeen) && Number.isFinite(current) && current > firstSeen + 0.001) {
    approval.push('price_increased_since_first_seen');
  }
  if (approvalIf.has('new_merchant') && known_merchant === false) approval.push('new_merchant');
  if (approvalIf.has('quantity_gt_2') && !(Number.isFinite(q) && q <= 2)) approval.push('quantity_gt_2');
  if (Number.isFinite(maxOrders) && Number.isFinite(ordersToday) && ordersToday >= maxOrders) approval.push('daily_order_limit');

  const decision = deny.length ? 'DENY' : approval.length ? 'REQUIRE_APPROVAL' : 'AUTO_APPROVE';
  return {
    decision,
    rules: [...deny, ...approval],
    inputs: {
      policy_id: p.policy_id ?? null,
      policy_version: p.version ?? null,
      merchant_id: merchant_id ?? null,
      approved_merchants: [...(p.approved_merchants || [])],
      category: category ?? null,
      qty: Number.isFinite(q) ? q : (qty ?? null),
      totals: t ? { ...t } : null,
      total: Number.isFinite(total) ? total : null,
      currency: (t && t.currency) || auto.currency || 'USD',
      first_seen_price: Number.isFinite(firstSeen) ? firstSeen : null,
      current_price: Number.isFinite(current) ? current : null,
      in_stock: in_stock !== false && in_stock !== 'false',
      orders_today: Number.isFinite(ordersToday) ? ordersToday : 0,
      max_orders_per_day: Number.isFinite(maxOrders) ? maxOrders : null,
      instruction_from_page: typeof instruction_from_page === 'string' ? instruction_from_page : Boolean(instruction_from_page),
      known_merchant: known_merchant !== false,
      limit: Number.isFinite(limit) ? limit : null,
    },
    limit: Number.isFinite(limit) ? limit : null,
  };
}
