import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNamed } from './text';

const items = [
  { id: '1', name: 'Classic Veg Burger', aliases: ['veg burger', 'veggie burger'] },
  { id: '2', name: 'Paneer Tikka Burger', aliases: ['paneer burger'] },
  { id: '3', name: 'Spicy Aloo Burger' },
  { id: '4', name: 'French Fries' },
  { id: '5', name: 'Peri Peri Fries' },
  { id: '6', name: 'Cheese Garlic Bread', aliases: ['garlic bread'] },
];

test('alias resolves to one product', () => {
  const r = resolveNamed('a veg burger'.replace('a ', ''), items);
  assert.equal(r.kind, 'ONE');
});
test('"burger" is ambiguous and never auto-selected (§9)', () => {
  const r = resolveNamed('burger', items);
  assert.equal(r.kind, 'MANY');
  if (r.kind === 'MANY') assert.equal(r.matches.length, 3);
});
test('"fries" is ambiguous between French and Peri Peri', () => {
  const r = resolveNamed('fries', items);
  assert.equal(r.kind, 'MANY');
});
test('plural, partial and alias forms', () => {
  assert.equal(resolveNamed('paneer burgers', items).kind, 'ONE');
  assert.equal(resolveNamed('garlic bread', items).kind, 'ONE');
  assert.equal(resolveNamed('pizza', items).kind, 'NONE');
  assert.equal(resolveNamed('   ', items).kind, 'NONE');
});
