import test from 'node:test';
import assert from 'node:assert/strict';
import { route, detectCategory, splitSentences, isFillerOnly } from '../apps/agent/src/intents.js';

const OPTIONS = [
  { brand: 'Stridewell', title: "Stridewell Glide 5 – Men's Wide" },
  { brand: 'Kestrel', title: 'Kestrel Tempo 2 Wide' },
  { brand: 'Ondra', title: 'Ondra Cloudpath Wide' },
];
const ctx = (state) => ({ state, optionCount: 3, options: OPTIONS });
const one = (text, state) => {
  const r = route(text, ctx(state));
  assert.equal(r.length, 1, `expected one intent for ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  return r[0];
};

test('IDLE: shopping requests and reorder', () => {
  assert.deepEqual(one('I need running shoes for a half marathon in three weeks.', 'IDLE'),
    { intent: 'request', args: { text: 'I need running shoes for a half marathon in three weeks.' } });
  assert.equal(one('Get me something nice.', 'IDLE').intent, 'request');
  assert.deepEqual(one('Reorder my usual coffee.', 'IDLE'), { intent: 'reorder', args: { category: 'coffee' } });
  assert.deepEqual(one('reorder my usual coffee', 'DONE'), { intent: 'reorder', args: { category: 'coffee' } });
  assert.equal(one('I need coffee beans', 'DONE').intent, 'request');
  assert.deepEqual(route('Reorder nothing.', ctx('AWAIT_CHOICE')), [], 'a negated reorder is not a reorder');
});

test('CLARIFY: answers stay answers even when they contain "next"', () => {
  assert.deepEqual(one('By next Friday.', 'CLARIFY'), { intent: 'answer_clarify', args: { text: 'By next Friday.' } });
  assert.equal(one('Yes, under 140, by next Friday', 'CLARIFY').intent, 'answer_clarify');
  assert.equal(one('Never mind.', 'CLARIFY').intent, 'cancel');
});

test('demo navigation utterances', () => {
  assert.deepEqual(one('Wait – show me the reviews.', 'NARRATE'), { intent: 'show_section', args: { section: 'reviews' } });
  assert.deepEqual(one('show me the reviews', 'AWAIT_CHOICE'), { intent: 'show_section', args: { section: 'reviews' } });
  assert.deepEqual(one("What's the return policy?", 'AWAIT_CHOICE'), { intent: 'show_section', args: { section: 'returns' } });
  assert.deepEqual(one('What do the reviews say?', 'AWAIT_CHOICE'), { intent: 'show_section', args: { section: 'reviews' } });
  assert.deepEqual(one('Show me the specs.', 'AWAIT_CHOICE'), { intent: 'show_section', args: { section: 'specs' } });
  assert.deepEqual(one('Next one.', 'AWAIT_CHOICE'), { intent: 'next', args: {} });
  assert.deepEqual(one('go back', 'AWAIT_CHOICE'), { intent: 'back', args: {} });
  assert.deepEqual(one('Go to the second one.', 'AWAIT_CHOICE'), { intent: 'goto_option', args: { index: 1 } });
  assert.deepEqual(one('Show me the Kestrel', 'AWAIT_CHOICE'), { intent: 'goto_option', args: { index: 1 } });
  assert.deepEqual(one('Is it waterproof?', 'AWAIT_CHOICE'), { intent: 'ask', args: { question: 'Is it waterproof?' } });
  assert.equal(one('Do the reviews mention sizing?', 'AWAIT_CHOICE').intent, 'ask');
});

test('"Go back to the first one. Buy that." → goto_option{0} + select{}', () => {
  assert.deepEqual(route('Go back to the first one. Buy that.', ctx('AWAIT_CHOICE')), [
    { intent: 'goto_option', args: { index: 0 } },
    { intent: 'select', args: {} },
  ]);
  assert.deepEqual(one('Buy the second one', 'AWAIT_CHOICE'), { intent: 'select', args: { index: 1 } });
  assert.deepEqual(one("I'll take the Ondra", 'AWAIT_CHOICE'), { intent: 'select', args: { index: 2 } });
});

test('confirm only for the exact phrase "confirm purchase"', () => {
  assert.deepEqual(one('confirm purchase', 'APPROVE'), { intent: 'confirm', args: { transcript: 'confirm purchase' } });
  assert.deepEqual(one('Confirm purchase.', 'APPROVE'), { intent: 'confirm', args: { transcript: 'Confirm purchase.' } });
  assert.equal(one('CONFIRM, purchase!', 'APPROVE').intent, 'confirm');
  for (const t of ['yes', 'Yes.', 'Buy it.', 'Sure, go ahead.', 'confirm', 'purchase', 'I confirm the purchase']) {
    const r = route(t, ctx('APPROVE'));
    assert.ok(!r.some((x) => x.intent === 'confirm'), `${t} must not confirm`);
  }
  assert.deepEqual(one('yes', 'APPROVE'), { intent: 'select', args: { affirm: true } });
  assert.deepEqual(one('buy it', 'APPROVE'), { intent: 'select', args: {} });
});

test('approval alternatives and cancel', () => {
  assert.deepEqual(one('Get the Kestrel instead.', 'APPROVE'), { intent: 'alternative', args: { hint: 'kestrel', index: 1 } });
  assert.deepEqual(one('The cheaper one.', 'APPROVE'), { intent: 'alternative', args: { hint: 'cheaper' } });
  assert.equal(one('Cancel.', 'APPROVE').intent, 'cancel');
  assert.equal(one("No, don't buy it.", 'APPROVE').intent, 'cancel');
  assert.equal(one('Is there anything cheaper?', 'AWAIT_CHOICE').intent, 'ask');
});

test('fillers, unknown text and helpers', () => {
  assert.deepEqual(route('Wait.', ctx('AWAIT_CHOICE')), []);
  assert.ok(isFillerOnly('Okay, hmm.'));
  assert.ok(!isFillerOnly('Next one.'));
  assert.deepEqual(route('blah blah', ctx('AWAIT_CHOICE')), []);
  assert.deepEqual(splitSentences('Go back to the first one. Buy that.'), ['Go back to the first one.', 'Buy that.']);
  assert.equal(detectCategory('new sneakers please'), 'running_shoes');
  assert.equal(detectCategory('espresso beans'), 'coffee');
  assert.equal(detectCategory('something nice'), null);
});
