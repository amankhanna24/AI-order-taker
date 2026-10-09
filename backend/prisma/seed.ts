import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';

/**
 * Smash & Go — the menu from assets/menu.pdf (all prices in AED, stored as fils).
 *
 *  BURGERS  Grilled Chicken 28 · Crispy Chicken 26 · Veggie 24 · Double Chicken Smash 38 · Spicy Zinger 30
 *           add-ons: Extra Cheese +4 | Extra Patty +10 | Fried Egg +6 | Avocado +5 | No onions / No pickles +0
 *  SIDES    Fries (Regular 10 / Large 15) · Loaded Cheese Fries 18 · Onion Rings 14 · Mozzarella Sticks 16 · Coleslaw 8
 *  DRINKS   Soft Drink (Coke / Sprite / Fanta — Small 6 / Medium 8 / Large 10) · Fresh Lemon Mint 14
 *           Iced Tea (peach or lemon) 12 · Milkshake (chocolate / vanilla / strawberry) 18 · Bottled Water 4
 *  COMBOS   Classic Combo 42 (Grilled Chicken Burger + Regular Fries + Medium Soft Drink)
 *           Zinger Combo 48 (Spicy Zinger Burger + Onion Rings + Medium Soft Drink)
 *
 * The PDF gives no allergen or dietary data, so none is invented: allergen info is left unverified and the
 * agent says so instead of guessing.
 */

type Ing = { name: string; removable: boolean };
const ing = (name: string): Ing => ({ name, removable: false }); // only the burger add-on options ("No onions / No pickles") are removals
const aed = (n: number) => n * 100;

async function main() {
  const slug = env.DEFAULT_RESTAURANT_SLUG;
  const existing = await prisma.restaurant.findUnique({ where: { slug }, include: { _count: { select: { orders: true } } } });
  if (existing) {
    if (existing._count.orders > 0) {
      console.log(`Restaurant "${slug}" already has orders — seed skipped to protect order history.`);
      return;
    }
    await prisma.restaurant.delete({ where: { id: existing.id } });
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      slug,
      name: 'Smash & Go',
      description: 'Cloud kitchen — smash burgers, sides and drinks, ready for pickup.',
      currency: 'AED',
      timezone: 'Asia/Dubai',
      // No tax rule: the menu prices are what the customer pays, so the total is exactly the sum of the lines.
      locations: {
        create: [{ name: 'Smash & Go — Dubai', address: 'Cloud kitchen, Business Bay', city: 'Dubai', state: 'Dubai', country: 'UAE', postalCode: '00000', timezone: 'Asia/Dubai' }],
      },
    },
  });

  type Mod = { name: string; price: number; aliases?: string[]; default?: boolean };
  const group = async (name: string, min: number, max: number, selectionType: 'SINGLE' | 'MULTIPLE', mods: Mod[]) => {
    const g = await prisma.modifierGroup.create({
      data: {
        restaurantId: restaurant.id,
        name,
        minimumSelections: min,
        maximumSelections: max,
        selectionType,
        modifiers: { create: mods.map((m, i) => ({ name: m.name, priceDelta: aed(m.price), aliases: m.aliases ?? [], displayOrder: i })) },
      },
      include: { modifiers: true },
    });
    const def = mods.find((m) => m.default);
    if (def) await prisma.modifierGroup.update({ where: { id: g.id }, data: { defaultModifierId: g.modifiers.find((m) => m.name === def.name)!.id } });
    return { id: g.id, mod: (n: string) => g.modifiers.find((m) => m.name === n)!.id };
  };

  // ----- Burgers: paid add-ons and free removals
  const addOns = await group('Burger Add-ons', 0, 4, 'MULTIPLE', [
    { name: 'Extra Cheese', price: 4, aliases: ['cheese', 'more cheese', 'add cheese'] },
    { name: 'Extra Patty', price: 10, aliases: ['patty', 'extra pattie', 'another patty', 'more meat'] },
    { name: 'Fried Egg', price: 6, aliases: ['egg', 'extra egg', 'fried eggs'] },
    { name: 'Avocado', price: 5, aliases: ['avo', 'avocado slices'] },
  ]);
  const removals = await group('Burger Removals', 0, 2, 'MULTIPLE', [
    { name: 'No Onions', price: 0, aliases: ['without onions', 'without onion', 'hold the onions', 'skip the onions', 'skip onions'] },
    { name: 'No Pickles', price: 0, aliases: ['without pickles', 'without pickle', 'hold the pickles', 'skip the pickles', 'skip pickles'] },
  ]);

  // ----- Sides / drinks: variants with price deltas over the base price on the menu
  const friesSize = await group('Fries Size', 0, 1, 'SINGLE', [
    { name: 'Regular', price: 0, default: true, aliases: ['regular size', 'normal'] },
    { name: 'Large', price: 5, aliases: ['large size', 'big', 'upsize'] }, // Regular 10 / Large 15
  ]);
  const flavor = await group('Soft Drink Flavor', 1, 1, 'SINGLE', [
    { name: 'Coke', price: 0, aliases: ['coca cola', 'coca-cola', 'cola'] },
    { name: 'Sprite', price: 0, aliases: ['lemon lime'] },
    { name: 'Fanta', price: 0, aliases: ['orange', 'fanta orange'] },
  ]);
  const drinkSize = await group('Drink Size', 0, 1, 'SINGLE', [
    { name: 'Small', price: 0, default: true, aliases: ['small size'] }, // Small 6 / Medium 8 / Large 10
    { name: 'Medium', price: 2, aliases: ['medium size'] },
    { name: 'Large', price: 4, aliases: ['large size', 'big'] },
  ]);
  const teaFlavor = await group('Iced Tea Flavor', 1, 1, 'SINGLE', [
    { name: 'Peach', price: 0, aliases: ['peach flavour', 'peach flavor'] },
    { name: 'Lemon', price: 0, aliases: ['lemon flavour', 'lemon flavor'] },
  ]);
  const shakeFlavor = await group('Milkshake Flavor', 1, 1, 'SINGLE', [
    { name: 'Chocolate', price: 0, aliases: ['choc', 'chocolate flavour', 'chocolate flavor'] },
    { name: 'Vanilla', price: 0, aliases: ['vanilla flavour', 'vanilla flavor'] },
    { name: 'Strawberry', price: 0, aliases: ['strawberry flavour', 'strawberry flavor'] },
  ]);

  const menu = await prisma.menu.create({ data: { restaurantId: restaurant.id, name: 'Main Menu', description: 'Smash & Go order menu', status: 'ACTIVE' } });

  type P = { name: string; price: number; desc: string; aliases?: string[]; ingredients?: Ing[]; vegetarian?: boolean; groups?: string[] };
  const category = async (name: string, displayOrder: number, products: P[]) => {
    const c = await prisma.category.create({ data: { menuId: menu.id, name, displayOrder } });
    const ids: Record<string, string> = {};
    for (const [i, p] of products.entries()) {
      const prod = await prisma.product.create({
        data: {
          categoryId: c.id,
          name: p.name,
          description: p.desc,
          basePrice: aed(p.price),
          aliases: p.aliases ?? [],
          ingredients: p.ingredients ?? [],
          vegetarian: p.vegetarian ?? false,
          allergens: [],
          allergenInfoVerified: false, // the menu PDF has no allergen data: never guess
          displayOrder: i,
        },
      });
      ids[p.name] = prod.id;
      for (const [gi, gid] of (p.groups ?? []).entries()) await prisma.productModifierGroup.create({ data: { productId: prod.id, modifierGroupId: gid, displayOrder: gi } });
    }
    return ids;
  };

  const burgerGroups = [addOns.id, removals.id];
  const burgers = await category('Burgers', 1, [
    {
      name: 'Grilled Chicken Burger', price: 28, desc: 'Grilled chicken breast, lettuce, tomato, onion. Served with a side of house sauce.',
      aliases: ['grilled chicken', 'grilled burger'], ingredients: [ing('Grilled chicken breast'), ing('Lettuce'), ing('Tomato'), ing('Onion')], groups: burgerGroups,
    },
    {
      name: 'Crispy Chicken Burger', price: 26, desc: 'Crispy fried chicken fillet, lettuce, mayo. Served with a side of house sauce.',
      aliases: ['crispy chicken', 'crispy burger'], ingredients: [ing('Crispy fried chicken fillet'), ing('Lettuce'), ing('Mayo')], groups: burgerGroups,
    },
    {
      name: 'Veggie Burger', price: 24, desc: 'Spiced potato & pea patty, lettuce. Served with a side of house sauce.',
      aliases: ['veggie', 'veg burger', 'vegetable burger', 'vegetarian burger'], ingredients: [ing('Spiced potato & pea patty'), ing('Lettuce')], vegetarian: true, groups: burgerGroups,
    },
    {
      name: 'Double Chicken Smash', price: 38, desc: 'Two smashed chicken patties, cheese, onions. Served with a side of house sauce.',
      aliases: ['double smash', 'double chicken', 'smash burger', 'chicken smash'], ingredients: [ing('Two smashed chicken patties'), ing('Cheese'), ing('Onions')], groups: burgerGroups,
    },
    {
      name: 'Spicy Zinger Burger', price: 30, desc: 'Hot-marinated chicken, jalapeños, spicy mayo. Served with a side of house sauce.',
      aliases: ['zinger', 'zinger burger', 'spicy zinger'], ingredients: [ing('Hot-marinated chicken'), ing('Jalapeños'), ing('Spicy mayo')], groups: burgerGroups,
    },
  ]);

  const sides = await category('Sides', 2, [
    { name: 'Fries', price: 10, desc: 'Crispy golden fries. Regular 10 / Large 15.', aliases: ['french fries', 'chips'], vegetarian: true, groups: [friesSize.id] },
    { name: 'Loaded Cheese Fries', price: 18, desc: 'Cheddar sauce, jalapeños, spring onion.', aliases: ['cheese fries', 'loaded fries'], ingredients: [ing('Cheddar sauce'), ing('Jalapeños'), ing('Spring onion')], vegetarian: true },
    { name: 'Onion Rings', price: 14, desc: '6 pieces, crispy golden batter.', aliases: ['rings', 'onion ring'], vegetarian: true },
    { name: 'Mozzarella Sticks', price: 16, desc: '6 pieces, marinara dip.', aliases: ['mozzarella', 'mozz sticks', 'cheese sticks'], vegetarian: true },
    { name: 'Coleslaw', price: 8, desc: 'Creamy, fresh.', aliases: ['slaw', 'cole slaw'], vegetarian: true },
  ]);

  const drinks = await category('Drinks', 3, [
    { name: 'Soft Drink', price: 6, desc: 'Coke, Sprite or Fanta. Small 6 / Medium 8 / Large 10.', aliases: ['soda', 'fizzy drink', 'cold drink'], vegetarian: true, groups: [flavor.id, drinkSize.id] },
    { name: 'Fresh Lemon Mint', price: 14, desc: 'Freshly made lemon and mint.', aliases: ['lemon mint'], vegetarian: true },
    { name: 'Iced Tea', price: 12, desc: 'Peach or lemon.', aliases: ['ice tea'], vegetarian: true, groups: [teaFlavor.id] },
    { name: 'Milkshake', price: 18, desc: 'Chocolate, vanilla or strawberry.', aliases: ['shake', 'milk shake'], vegetarian: true, groups: [shakeFlavor.id] },
    { name: 'Bottled Water', price: 4, desc: '500ml.', aliases: ['water', 'mineral water', 'bottle of water'], vegetarian: true },
  ]);

  // ----- Combos: burger + side + medium soft drink, AED 4 cheaper than à la carte.
  // Components are fixed; the only open choice is the soft drink flavour (a required group on Soft Drink).
  type Part = { component: string; product: string; ids: Record<string, string>; presets?: string[] };
  const combo = async (name: string, price: number, desc: string, aliases: string[], parts: Part[]) => {
    const c = await prisma.combo.create({ data: { restaurantId: restaurant.id, menuId: menu.id, name, basePrice: aed(price), description: desc, aliases } });
    for (const [i, part] of parts.entries()) {
      const comp = await prisma.comboComponent.create({ data: { comboId: c.id, name: part.component, displayOrder: i } });
      const productId = part.ids[part.product];
      await prisma.comboComponentProduct.create({ data: { componentId: comp.id, productId, upcharge: 0 } });
      for (const modifierId of part.presets ?? []) await prisma.comboComponentPreset.create({ data: { componentId: comp.id, productId, modifierId } });
    }
  };
  await combo('Classic Combo', 42, 'Grilled Chicken Burger + Regular Fries + Medium Soft Drink', ['classic', 'classic meal', 'classic combo meal'], [
    { component: 'Burger', product: 'Grilled Chicken Burger', ids: burgers },
    { component: 'Side', product: 'Fries', ids: sides, presets: [friesSize.mod('Regular')] },
    { component: 'Drink', product: 'Soft Drink', ids: drinks, presets: [drinkSize.mod('Medium')] },
  ]);
  await combo('Zinger Combo', 48, 'Spicy Zinger Burger + Onion Rings + Medium Soft Drink', ['zinger meal', 'zinger combo meal'], [
    { component: 'Burger', product: 'Spicy Zinger Burger', ids: burgers },
    { component: 'Side', product: 'Onion Rings', ids: sides },
    { component: 'Drink', product: 'Soft Drink', ids: drinks, presets: [drinkSize.mod('Medium')] },
  ]);

  console.log(`Seeded "${restaurant.name}" (slug: ${slug}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
