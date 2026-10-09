import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';

type Ing = { name: string; removable: boolean };
const ing = (name: string, removable = true): Ing => ({ name, removable });
const rs = (n: number) => n * 100;

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
      name: 'Green Spoon Kitchen',
      description: 'Fresh vegetarian food, made to order.',
      phone: '+911100000000',
      taxRules: { create: [{ category: 'STANDARD', name: 'GST 5%', rateBps: 500 }] },
      discounts: { create: [{ name: 'Welcome 10% (inactive example)', type: 'PERCENTAGE', value: 1000, minimumSubtotal: rs(500), active: false }] },
      locations: {
        create: [{ name: 'Green Spoon — Delhi', address: '12 Connaught Place', city: 'Delhi', state: 'Delhi', postalCode: '110001', phone: '+911100000000' }],
      },
    },
  });

  // ----- Modifier groups (restaurant-level, attached to compatible products only: §17)
  const group = async (
    name: string,
    min: number,
    max: number,
    selectionType: 'SINGLE' | 'MULTIPLE',
    mods: { name: string; price: number; aliases?: string[]; default?: boolean }[],
  ) => {
    const g = await prisma.modifierGroup.create({
      data: {
        restaurantId: restaurant.id,
        name,
        minimumSelections: min,
        maximumSelections: max,
        selectionType,
        modifiers: { create: mods.map((m, i) => ({ name: m.name, priceDelta: m.price, aliases: m.aliases ?? [], displayOrder: i })) },
      },
      include: { modifiers: true },
    });
    const def = mods.find((m) => m.default);
    if (def) await prisma.modifierGroup.update({ where: { id: g.id }, data: { defaultModifierId: g.modifiers.find((m) => m.name === def.name)!.id } });
    return g;
  };

  const burgerSize = await group('Burger Size', 0, 1, 'SINGLE', [
    { name: 'Regular', price: 0, default: true },
    { name: 'Medium', price: rs(15) },
    { name: 'Large', price: rs(30), aliases: ['large size', 'big'] },
  ]);
  const cheese = await group('Cheese', 0, 1, 'SINGLE', [
    { name: 'No Cheese', price: 0, aliases: ['without cheese', 'no cheese'] },
    { name: 'Cheddar', price: rs(30), aliases: ['cheddar cheese'] },
    { name: 'Mozzarella', price: rs(30), aliases: ['mozzarella cheese', 'mozarella'] },
  ]);
  const burgerToppings = await group('Burger Toppings', 0, 5, 'MULTIPLE', [
    { name: 'Jalapeno', price: rs(20), aliases: ['jalapenos', 'jalapeño'] },
    { name: 'Mushroom', price: rs(25), aliases: ['mushrooms'] },
    { name: 'Extra Paneer', price: rs(45) },
  ]);
  const spice = await group('Spice Level', 0, 1, 'SINGLE', [
    { name: 'Mild', price: 0 },
    { name: 'Spicy', price: 0, aliases: ['extra spicy', 'hot'] },
  ]);
  const sauce = await group('Sauce', 0, 1, 'SINGLE', [
    { name: 'House Sauce', price: 0, default: true, aliases: ['sauce'] },
    { name: 'Mayo', price: 0, aliases: ['mayonnaise'] },
    { name: 'Peri Peri Sauce', price: 0 },
  ]);
  const pizzaSize = await group('Pizza Size', 1, 1, 'SINGLE', [
    { name: 'Regular Pizza', price: 0, aliases: ['regular', 'small'] },
    { name: 'Medium Pizza', price: rs(100), aliases: ['medium'] },
    { name: 'Large Pizza', price: rs(200), aliases: ['large'] },
  ]);
  const crust = await group('Crust', 0, 1, 'SINGLE', [
    { name: 'Classic Crust', price: 0, default: true, aliases: ['classic', 'regular crust'] },
    { name: 'Thin Crust', price: 0, aliases: ['thin'] },
    { name: 'Cheese Burst', price: rs(60), aliases: ['cheese burst crust'] },
  ]);
  const pizzaToppings = await group('Pizza Toppings', 0, 5, 'MULTIPLE', [
    { name: 'Onion', price: rs(20), aliases: ['onions'] },
    { name: 'Pizza Jalapeno', price: rs(20), aliases: ['jalapeno', 'jalapenos'] },
    { name: 'Pizza Mushroom', price: rs(30), aliases: ['mushroom', 'mushrooms'] },
    { name: 'Extra Cheese', price: rs(50), aliases: ['cheese topping', 'extra cheese topping', 'extra cheese pizza topping', 'cheese stopping'] },
  ]);

  const menu = await prisma.menu.create({
    data: { restaurantId: restaurant.id, name: 'Main Menu', description: 'All-day menu', status: 'ACTIVE' },
  });

  type P = {
    name: string;
    price: number;
    desc: string;
    aliases?: string[];
    ingredients: Ing[];
    allergens: ('MILK' | 'EGG' | 'PEANUTS' | 'TREE_NUTS' | 'SOY' | 'GLUTEN' | 'SESAME' | 'MUSTARD')[];
    verified?: boolean;
    vegan?: boolean;
    glutenFree?: boolean;
    available?: boolean;
    groups?: string[];
  };
  const burgerGroups = [burgerSize.id, cheese.id, burgerToppings.id, spice.id, sauce.id];
  const pizzaGroups = [pizzaSize.id, crust.id, pizzaToppings.id];

  const category = async (name: string, displayOrder: number, products: P[], groups: string[]) => {
    const c = await prisma.category.create({ data: { menuId: menu.id, name, displayOrder } });
    for (const [i, p] of products.entries()) {
      const prod = await prisma.product.create({
        data: {
          categoryId: c.id,
          name: p.name,
          description: p.desc,
          basePrice: rs(p.price),
          aliases: p.aliases ?? [],
          ingredients: p.ingredients,
          allergens: p.allergens,
          allergenInfoVerified: p.verified ?? true,
          vegan: p.vegan ?? false,
          glutenFree: p.glutenFree ?? false,
          available: p.available ?? true,
          displayOrder: i,
        },
      });
      const gs = p.groups ?? groups;
      for (const [gi, gid] of gs.entries()) await prisma.productModifierGroup.create({ data: { productId: prod.id, modifierGroupId: gid, displayOrder: gi } });
    }
    return c;
  };

  await category('Burgers', 1, [
    {
      name: 'Classic Veg Burger', price: 149, desc: 'Crisp vegetable patty with fresh lettuce, tomato and our house sauce.',
      aliases: ['veg burger', 'vegetable burger', 'classic burger', 'veggie burger'],
      ingredients: [ing('Vegetable patty', false), ing('Lettuce'), ing('Tomato'), ing('Onion'), ing('House sauce', false), ing('Bun', false)],
      allergens: ['GLUTEN', 'SOY'],
    },
    {
      name: 'Paneer Tikka Burger', price: 189, desc: 'Tandoori paneer tikka patty with mint mayo, onions and lettuce.',
      aliases: ['paneer burger', 'paneer tikka burger', 'tikka burger'],
      ingredients: [ing('Paneer tikka patty', false), ing('Lettuce'), ing('Onion'), ing('Mint mayo'), ing('Bun', false)],
      allergens: ['MILK', 'GLUTEN'],
    },
    {
      name: 'Spicy Aloo Burger', price: 129, desc: 'Spiced potato patty with tangy chutney.',
      aliases: ['aloo burger', 'aloo tikki burger'],
      ingredients: [ing('Potato patty', false), ing('Lettuce'), ing('Onion'), ing('Tomato'), ing('Chutney'), ing('Bun', false)],
      allergens: ['GLUTEN'],
    },
  ], burgerGroups);

  await category('Pizza', 2, [
    { name: 'Margherita Pizza', price: 299, desc: 'Tomato, mozzarella and basil.', aliases: ['margherita', 'margarita pizza'], ingredients: [ing('Pizza base', false), ing('Tomato sauce', false), ing('Mozzarella', false), ing('Basil')], allergens: ['MILK', 'GLUTEN'] },
    { name: 'Farmhouse Pizza', price: 349, desc: 'Capsicum, onion, mushroom and sweetcorn.', aliases: ['farmhouse'], ingredients: [ing('Pizza base', false), ing('Mozzarella', false), ing('Capsicum'), ing('Onion'), ing('Mushroom'), ing('Sweetcorn')], allergens: ['MILK', 'GLUTEN'] },
    { name: 'Paneer Makhani Pizza', price: 399, desc: 'Paneer in rich makhani sauce.', aliases: ['paneer pizza', 'makhani pizza'], ingredients: [ing('Pizza base', false), ing('Mozzarella', false), ing('Paneer', false), ing('Makhani sauce', false), ing('Onion')], allergens: ['MILK', 'GLUTEN', 'TREE_NUTS'] },
  ], pizzaGroups);

  await category('Sides', 3, [
    { name: 'French Fries', price: 99, desc: 'Classic salted fries.', aliases: ['plain fries'], ingredients: [ing('Potato', false), ing('Salt')], allergens: [], vegan: true, glutenFree: true },
    { name: 'Peri Peri Fries', price: 119, desc: 'Fries tossed in peri peri seasoning.', ingredients: [ing('Potato', false), ing('Peri peri seasoning')], allergens: [], vegan: true, glutenFree: true },
    { name: 'Cheese Garlic Bread', price: 169, desc: 'Toasted garlic bread with melted cheese.', aliases: ['garlic bread'], ingredients: [ing('Bread', false), ing('Garlic butter', false), ing('Cheese', false)], allergens: ['MILK', 'GLUTEN'] },
  ], []);

  await category('Drinks', 4, [
    { name: 'Coke', price: 59, desc: 'Chilled Coca-Cola.', aliases: ['coca cola', 'cola'], ingredients: [], allergens: [], vegan: true, glutenFree: true },
    { name: 'Fresh Lime Soda', price: 89, desc: 'Fresh lime with soda, sweet or salted.', aliases: ['lime soda', 'nimbu soda'], ingredients: [ing('Lime', false), ing('Soda', false)], allergens: [], vegan: true, glutenFree: true },
    { name: 'Mango Shake', price: 139, desc: 'Thick mango milkshake.', aliases: ['mango milkshake'], ingredients: [ing('Mango', false), ing('Milk', false)], allergens: ['MILK'], glutenFree: true },
  ], []);

  await category('Desserts', 5, [
    // Deliberately unverified allergen data to exercise the escalation path (§11).
    { name: 'Chocolate Brownie', price: 129, desc: 'Warm fudgy brownie.', aliases: ['brownie'], ingredients: [ing('Chocolate', false)], allergens: [], verified: false },
    { name: 'Vanilla Ice Cream', price: 99, desc: 'Two scoops of vanilla.', aliases: ['ice cream', 'vanilla'], ingredients: [], allergens: ['MILK'], glutenFree: true },
    // Deliberately sold out to exercise the out-of-stock path (§64).
    { name: 'Classic Cheesecake', price: 179, desc: 'Baked New York style cheesecake.', aliases: ['cheesecake'], ingredients: [], allergens: ['MILK', 'GLUTEN', 'EGG'], available: false },
  ], []);

  // ----- Combo (§52)
  const byName = async (name: string) => (await prisma.product.findFirstOrThrow({ where: { name, category: { menuId: menu.id } } })).id;
  const combo = await prisma.combo.create({
    data: {
      restaurantId: restaurant.id, menuId: menu.id, name: 'Veg Burger Combo', basePrice: rs(249),
      description: 'A burger, a side and a drink.', aliases: ['burger combo', 'veg combo', 'combo'],
    },
  });
  const comp = async (name: string, order: number, options: [string, number][]) => {
    const c = await prisma.comboComponent.create({ data: { comboId: combo.id, name, displayOrder: order } });
    for (const [pn, up] of options) await prisma.comboComponentProduct.create({ data: { componentId: c.id, productId: await byName(pn), upcharge: rs(up) } });
  };
  await comp('Burger', 0, [['Classic Veg Burger', 0], ['Spicy Aloo Burger', 0], ['Paneer Tikka Burger', 40]]);
  await comp('Side', 1, [['French Fries', 0], ['Peri Peri Fries', 20]]);
  await comp('Drink', 2, [['Coke', 0], ['Fresh Lime Soda', 0]]);

  console.log(`Seeded "${restaurant.name}" (slug: ${slug}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
