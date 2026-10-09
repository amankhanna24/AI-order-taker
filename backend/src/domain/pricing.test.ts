import assert from 'node:assert/strict';
import test from 'node:test';
import { priceLine, priceOrder } from './pricing';
import { formatMoney } from './money';

test('spec §32 example: ₹488 subtotal, 5% tax ₹24.40, total ₹512.40', () => {
  const lines = [
    { quantity: 1, unitBasePrice: 18900, taxCategory: 'STANDARD', modifiers: [{ price: 4500, quantity: 1 }, { price: 2000, quantity: 1 }] },
    { quantity: 1, unitBasePrice: 18900, taxCategory: 'STANDARD', modifiers: [{ price: 4500, quantity: 1 }] },
  ];
  const p = priceOrder(lines, { STANDARD: 500 });
  assert.equal(p.subtotal, 48800);
  assert.equal(p.tax, 2440);
  assert.equal(p.total, 51240);
  assert.equal(formatMoney(p.total), '₹512.40');
});

test('line pricing multiplies unit total by quantity (§26)', () => {
  const l = priceLine({ quantity: 2, unitBasePrice: 18900, taxCategory: 'STANDARD', modifiers: [{ price: 4500, quantity: 1 }, { price: 2000, quantity: 1 }] });
  assert.deepEqual(l, { modifierTotal: 6500, unitTotal: 25400, lineTotal: 50800 });
});

test('tax rounds half-up to the paisa', () => {
  const p = priceOrder([{ quantity: 1, unitBasePrice: 9900, taxCategory: 'S', modifiers: [] }], { S: 500 });
  assert.equal(p.tax, 495);
  const q = priceOrder([{ quantity: 1, unitBasePrice: 12900, taxCategory: 'S', modifiers: [] }], { S: 500 });
  assert.equal(q.tax, 645); // 644.5 -> 645
});

test('discount reduces taxable amount and never exceeds subtotal', () => {
  const lines = [{ quantity: 1, unitBasePrice: 10000, taxCategory: 'S', modifiers: [] }];
  const p = priceOrder(lines, { S: 500 }, [{ id: 'd', name: 'Big', type: 'FIXED_AMOUNT', value: 99999, minimumSubtotal: 0 }]);
  assert.equal(p.discount, 10000);
  assert.equal(p.total, 0);
  const p2 = priceOrder(lines, { S: 500 }, [{ id: 'd', name: '10%', type: 'PERCENTAGE', value: 1000, minimumSubtotal: 0 }]);
  assert.equal(p2.taxableAmount, 9000);
  assert.equal(p2.tax, 450);
});

test('empty order prices to zero', () => {
  assert.equal(priceOrder([], { S: 500 }).total, 0);
});
