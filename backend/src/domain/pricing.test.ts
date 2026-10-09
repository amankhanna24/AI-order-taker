import assert from 'node:assert/strict';
import test from 'node:test';
import { priceLine, priceOrder } from './pricing';
import { formatMoney } from './money';

const aed = (n: number) => n * 100;

test('Smash & Go: add-ons are price deltas on the burger, total is derived (no tax configured)', () => {
  // 2 × Grilled Chicken Burger (28) + Extra Cheese (+4) + Fried Egg (+6), 1 × Fries Large (10 + 5)
  const lines = [
    { quantity: 2, unitBasePrice: aed(28), taxCategory: 'STANDARD', modifiers: [{ price: aed(4), quantity: 1 }, { price: aed(6), quantity: 1 }] },
    { quantity: 1, unitBasePrice: aed(10), taxCategory: 'STANDARD', modifiers: [{ price: aed(5), quantity: 1 }] },
  ];
  const p = priceOrder(lines, {});
  assert.equal(p.subtotal, aed(91));
  assert.equal(p.tax, 0);
  assert.equal(p.total, aed(91));
  assert.equal(formatMoney(p.total), 'AED 91');
});

test('combo is cheaper than the à-la-carte parts: Classic Combo 42 vs 28 + 10 + 8', () => {
  const alaCarte = priceOrder(
    [
      { quantity: 1, unitBasePrice: aed(28), taxCategory: 'S', modifiers: [] },
      { quantity: 1, unitBasePrice: aed(10), taxCategory: 'S', modifiers: [] },
      { quantity: 1, unitBasePrice: aed(6), taxCategory: 'S', modifiers: [{ price: aed(2), quantity: 1 }] },
    ],
    {},
  );
  const combo = priceOrder([{ quantity: 1, unitBasePrice: aed(42), taxCategory: 'S', modifiers: [] }], {});
  assert.equal(alaCarte.total, aed(46));
  assert.equal(combo.total, aed(42));
  assert.equal(alaCarte.total - combo.total, aed(4));
});

test('line pricing multiplies unit total by quantity', () => {
  const l = priceLine({ quantity: 2, unitBasePrice: aed(30), taxCategory: 'STANDARD', modifiers: [{ price: aed(4), quantity: 1 }, { price: 0, quantity: 1 }] });
  assert.deepEqual(l, { modifierTotal: aed(4), unitTotal: aed(34), lineTotal: aed(68) });
});

test('modifier quantity counts toward the unit total', () => {
  const l = priceLine({ quantity: 1, unitBasePrice: aed(38), taxCategory: 'S', modifiers: [{ price: aed(10), quantity: 2 }] });
  assert.equal(l.unitTotal, aed(58));
});

test('money formatting shows fils only when present', () => {
  assert.equal(formatMoney(2800), 'AED 28');
  assert.equal(formatMoney(2850), 'AED 28.50');
  assert.equal(formatMoney(5), 'AED 0.05');
  assert.equal(formatMoney(0), 'AED 0');
});

test('tax (when configured) is exclusive and rounds half-up to the fil', () => {
  const p = priceOrder([{ quantity: 1, unitBasePrice: 2650, taxCategory: 'S', modifiers: [] }], { S: 500 });
  assert.equal(p.tax, 133); // 132.5 -> 133
  assert.equal(p.total, 2783);
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
