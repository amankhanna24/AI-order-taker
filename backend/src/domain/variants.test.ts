import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVariantPhrase, type VariantProduct } from './variants';

const products: VariantProduct[] = [
  { id: 'fries', name: 'Fries', aliases: [], modifiers: [{ id: 'f-reg', groupId: 'fsize', labels: ['Regular'], required: false }, { id: 'f-large', groupId: 'fsize', labels: ['Large', 'big'], required: false }] },
  {
    id: 'soft',
    name: 'Soft Drink',
    aliases: ['soda'],
    modifiers: [
      { id: 'coke', groupId: 'flavor', labels: ['Coke', 'cola', 'coca cola'], required: true },
      { id: 'sprite', groupId: 'flavor', labels: ['Sprite'], required: true },
      { id: 's', groupId: 'dsize', labels: ['Small'], required: false },
      { id: 'm', groupId: 'dsize', labels: ['Medium'], required: false },
      { id: 'l', groupId: 'dsize', labels: ['Large'], required: false },
    ],
  },
  { id: 'tea', name: 'Iced Tea', aliases: [], modifiers: [{ id: 'peach', groupId: 'tflavor', labels: ['Peach'], required: true }, { id: 'lemon', groupId: 'tflavor', labels: ['Lemon'], required: true }] },
  { id: 'b1', name: 'Grilled Chicken Burger', aliases: [], modifiers: [{ id: 'xcheese', groupId: 'addons', labels: ['Extra Cheese'], required: false }] },
  { id: 'b2', name: 'Veggie Burger', aliases: [], modifiers: [{ id: 'xcheese', groupId: 'addons', labels: ['Extra Cheese'], required: false }] },
];

test('a flavour on its own identifies the product that owns it', () => {
  assert.deepEqual(parseVariantPhrase('a coke', products), { productId: 'soft', modifierIds: ['coke'] });
  assert.deepEqual(parseVariantPhrase('sprite', products), { productId: 'soft', modifierIds: ['sprite'] });
  assert.deepEqual(parseVariantPhrase('coca cola', products), { productId: 'soft', modifierIds: ['coke'] });
});

test('option words plus the product name resolve both', () => {
  assert.deepEqual(parseVariantPhrase('large fries', products), { productId: 'fries', modifierIds: ['f-large'] });
  assert.deepEqual(parseVariantPhrase('peach iced tea', products), { productId: 'tea', modifierIds: ['peach'] });
  assert.deepEqual(parseVariantPhrase('medium sprite', products), { productId: 'soft', modifierIds: ['sprite', 'm'] });
});

test('a bare shared option word is not enough to pick a product', () => {
  assert.equal(parseVariantPhrase('large', products), null);
  assert.equal(parseVariantPhrase('regular', products), null);
});

test('an option offered by several products is ambiguous, never guessed', () => {
  assert.equal(parseVariantPhrase('extra cheese', products), null);
});

test('unrelated words do not match', () => {
  assert.equal(parseVariantPhrase('cheesecake', products), null);
  assert.equal(parseVariantPhrase('large pizza', products), null);
  assert.equal(parseVariantPhrase('', products), null);
});
