import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNamed } from './text';

const items = [
  { id: '1', name: 'Grilled Chicken Burger', aliases: ['grilled burger'] },
  { id: '2', name: 'Crispy Chicken Burger', aliases: ['crispy burger'] },
  { id: '3', name: 'Veggie Burger', aliases: ['veg burger', 'vegetarian burger'] },
  { id: '4', name: 'Double Chicken Smash', aliases: ['double smash', 'smash burger'] },
  { id: '5', name: 'Spicy Zinger Burger', aliases: ['zinger', 'zinger burger'] },
  { id: '6', name: 'Fries' },
  { id: '7', name: 'Loaded Cheese Fries', aliases: ['cheese fries'] },
  { id: '8', name: 'Onion Rings' },
  { id: '9', name: 'Mozzarella Sticks', aliases: ['mozzarella', 'mozz sticks'] },
];

test('alias resolves to one product', () => {
  assert.equal(resolveNamed('zinger', items).kind, 'ONE');
  assert.equal(resolveNamed('veg burger', items).kind, 'ONE');
});
test('"burger" and "chicken burger" are ambiguous and never auto-selected', () => {
  const r = resolveNamed('burger', items);
  assert.equal(r.kind, 'MANY');
  const c = resolveNamed('chicken burger', items);
  assert.equal(c.kind, 'MANY');
  if (c.kind === 'MANY') assert.deepEqual(c.matches.map((m) => m.id).sort(), ['1', '2']);
});
test('plain "fries" is the Fries product, "cheese fries" the loaded one', () => {
  const plain = resolveNamed('fries', items);
  assert.equal(plain.kind, 'ONE');
  if (plain.kind === 'ONE') assert.equal(plain.match.id, '6');
  const loaded = resolveNamed('cheese fries', items);
  assert.equal(loaded.kind, 'ONE');
  if (loaded.kind === 'ONE') assert.equal(loaded.match.id, '7');
});
test('plural, partial and typo forms', () => {
  assert.equal(resolveNamed('onion ring', items).kind, 'ONE');
  assert.equal(resolveNamed('mozarella sticks', items).kind, 'ONE');
  assert.equal(resolveNamed('grilled chicken burgers', items).kind, 'ONE');
  const smash = resolveNamed('smashes', items);
  assert.equal(smash.kind, 'ONE');
  if (smash.kind === 'ONE') assert.equal(smash.match.id, '4');
});
test('things not on the menu resolve to nothing', () => {
  assert.equal(resolveNamed('pizza', items).kind, 'NONE');
  assert.equal(resolveNamed('cheesecake', items).kind, 'NONE');
  assert.equal(resolveNamed('   ', items).kind, 'NONE');
});
