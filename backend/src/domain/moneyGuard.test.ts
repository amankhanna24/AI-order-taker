import assert from 'node:assert/strict';
import test from 'node:test';
import { guardMoney } from './moneyGuard';

const order = { display: { total: 'AED 42', subtotal: 'AED 42' }, lines: [{ lineTotal: 4200, unitTotal: 4200 }] };

test('a made-up total is replaced with the server total', () => {
  const calls: string[] = [];
  const out = guardMoney('Got another Classic Combo with Sprite. Your total is AED 84. Anything else?', order, ['{"total":"AED 42"}'], (q) => calls.push(q));
  assert.equal(out, 'Got another Classic Combo with Sprite. Your total is AED 42. Anything else?');
  assert.deepEqual(calls, ['AED 84']);
});

test('the real total, line totals and tool-supplied prices pass through untouched', () => {
  assert.equal(guardMoney('Your total is AED 42.', order, []), 'Your total is AED 42.');
  assert.equal(guardMoney('That line comes to AED 42, so the total is AED 42.', order, []), 'That line comes to AED 42, so the total is AED 42.');
  assert.equal(guardMoney('A Large Fries is AED 15 and your total is AED 42.', order, ['{"price":"AED 15"}']), 'A Large Fries is AED 15 and your total is AED 42.');
});

test('amounts outside "total" sentences are left alone (prices come from tools anyway)', () => {
  assert.equal(guardMoney('The Zinger is AED 30. Anything else?', order, []), 'The Zinger is AED 30. Anything else?');
});

test('decimals compare numerically', () => {
  const o = { display: { total: 'AED 28.5', subtotal: 'AED 28.5' }, lines: [] };
  assert.equal(guardMoney('Your total is AED 28.50.', o, []), 'Your total is AED 28.50.');
});
