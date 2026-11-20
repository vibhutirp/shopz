import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeadline, parseBudget, shortDate } from '../apps/agent/src/dates.js';

const NOW = new Date('2026-11-20T12:00:00'); // a Friday

test('"by next Friday" on Fri 2026-11-20 → 2026-11-27', () => {
  assert.equal(parseDeadline('by next Friday', NOW), '2026-11-27');
  assert.equal(parseDeadline('By next Friday.', NOW), '2026-11-27');
  assert.equal(parseDeadline('Yes, under 140, by next Friday', NOW), '2026-11-27');
});

test('"in three weeks" and other relative forms', () => {
  assert.equal(parseDeadline('in three weeks', NOW), '2026-12-11');
  assert.equal(parseDeadline('in 10 days', NOW), '2026-11-30');
  assert.equal(parseDeadline('next week', NOW), '2026-11-27');
  assert.equal(parseDeadline('within a couple of weeks', NOW), '2026-12-04');
});

test('weekdays and explicit dates', () => {
  assert.equal(parseDeadline('by Friday', NOW), '2026-11-27');
  assert.equal(parseDeadline('by Saturday', NOW), '2026-11-21');
  assert.equal(parseDeadline('next Saturday', NOW), '2026-11-28', 'next <weekday> must be at least 2 days away');
  assert.equal(parseDeadline('next Sunday', NOW), '2026-11-22');
  assert.equal(parseDeadline('by Nov 27', NOW), '2026-11-27');
  assert.equal(parseDeadline('by 11/27', NOW), '2026-11-27');
  assert.equal(parseDeadline('by Jan 5', NOW), '2027-01-05');
  assert.equal(parseDeadline('no date here', NOW), null);
});

test('event dates are not need-by dates when ignoreEventDates is set', () => {
  const t = 'I need running shoes for a half marathon in three weeks.';
  assert.equal(parseDeadline(t, NOW), '2026-12-11');
  assert.equal(parseDeadline(t, NOW, { ignoreEventDates: true }), null);
  assert.equal(parseDeadline('Shoes for a race in three weeks, delivered by next Friday', NOW, { ignoreEventDates: true }), '2026-11-27');
});

test('parseBudget', () => {
  assert.equal(parseBudget('under 140'), 140);
  assert.equal(parseBudget('under $140'), 140);
  assert.equal(parseBudget('max 150'), 150);
  assert.equal(parseBudget('Yes, under 140, by next Friday'), 140);
  assert.equal(parseBudget('$99 tops'), 99);
  assert.equal(parseBudget('size 10.5 wide'), null);
  assert.equal(parseBudget('within 10 days'), null);
  assert.equal(parseBudget('in three weeks'), null);
});

test('shortDate chip label', () => {
  assert.equal(shortDate('2026-11-27'), 'Fri 11/27');
});
