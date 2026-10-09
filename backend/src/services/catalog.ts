import { prisma } from '../config/prisma';
import { localHHmm, withinWindow, type Orderable } from '../domain/availability';
import { ApiError } from '../utils/errors';

export interface ModifierView {
  id: string;
  name: string;
  priceDelta: number;
  available: boolean;
  aliases: string[];
}
export interface GroupView {
  id: string;
  name: string;
  minimumSelections: number;
  maximumSelections: number;
  selectionType: 'SINGLE' | 'MULTIPLE';
  required: boolean; // derived: minimumSelections >= 1
  defaultModifierId: string | null;
  modifiers: ModifierView[];
}
export interface IngredientView {
  name: string;
  removable: boolean;
}
export interface ProductView {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  category: string;
  categoryId: string;
  aliases: string[];
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  ingredients: IngredientView[];
  allergens: string[];
  allergenInfoVerified: boolean;
  taxCategory: string;
  groups: GroupView[];
  orderable: Orderable;
}
export interface ComboComponentView {
  id: string;
  name: string;
  required: boolean;
  min: number;
  max: number;
  options: { productId: string; productName: string; upcharge: number }[];
}
export interface ComboView {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  aliases: string[];
  taxCategory: string;
  components: ComboComponentView[];
  orderable: Orderable;
}
export interface Catalog {
  restaurant: { id: string; name: string; currency: string; timezone: string; status: string; orderingEnabled: boolean };
  products: ProductView[];
  combos: ComboView[];
  taxRatesBps: Record<string, number>;
  discounts: { id: string; name: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: number; minimumSubtotal: number }[];
  loadedAt: Date;
}

export async function getRestaurantBySlug(slug: string) {
  const r = await prisma.restaurant.findUnique({ where: { slug } });
  if (!r) throw ApiError.notFound('Restaurant not found');
  return r;
}

export async function loadCatalog(restaurantId: string, now = new Date()): Promise<Catalog> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      taxRules: true,
      discounts: { where: { active: true } },
      menus: {
        where: { status: 'ACTIVE' },
        include: {
          categories: {
            where: { status: 'ACTIVE' },
            orderBy: { displayOrder: 'asc' },
            include: {
              products: {
                where: { status: 'ACTIVE' },
                orderBy: { displayOrder: 'asc' },
                include: {
                  modifierGroups: {
                    orderBy: { displayOrder: 'asc' },
                    include: { group: { include: { modifiers: { where: { status: 'ACTIVE' }, orderBy: { displayOrder: 'asc' } } } } },
                  },
                },
              },
            },
          },
          combos: {
            where: { status: 'ACTIVE' },
            include: { components: { orderBy: { displayOrder: 'asc' }, include: { allowedProducts: { include: { product: true } } } } },
          },
        },
      },
    },
  });
  if (!restaurant) throw ApiError.notFound('Restaurant not found');

  const restaurantOpen = restaurant.orderingEnabled && restaurant.status === 'OPEN';
  const hhmm = localHHmm(now, restaurant.timezone);
  const restaurantReason = !restaurant.orderingEnabled
    ? 'Ordering is currently disabled'
    : restaurant.status !== 'OPEN'
      ? 'The restaurant is not open right now'
      : null;

  const products: ProductView[] = [];
  const combos: ComboView[] = [];

  for (const menu of restaurant.menus) {
    if ((menu.effectiveFrom && menu.effectiveFrom > now) || (menu.effectiveUntil && menu.effectiveUntil < now)) continue;
    for (const cat of menu.categories) {
      for (const p of cat.products) {
        let orderable: Orderable = { ok: true };
        if (!restaurantOpen) orderable = { ok: false, reason: restaurantReason! };
        else if (!p.available) orderable = { ok: false, reason: 'Currently unavailable (sold out)' };
        else if (!withinWindow(hhmm, p.availableFrom, p.availableUntil))
          orderable = { ok: false, reason: `Only available ${p.availableFrom}–${p.availableUntil}` };

        products.push({
          id: p.id,
          name: p.name,
          description: p.description,
          basePrice: p.basePrice,
          category: cat.name,
          categoryId: cat.id,
          aliases: p.aliases,
          vegetarian: p.vegetarian,
          vegan: p.vegan,
          glutenFree: p.glutenFree,
          ingredients: Array.isArray(p.ingredients) ? (p.ingredients as unknown as IngredientView[]) : [],
          allergens: p.allergens,
          allergenInfoVerified: p.allergenInfoVerified,
          taxCategory: p.taxCategory,
          orderable,
          groups: p.modifierGroups
            .filter((l) => l.group.status === 'ACTIVE')
            .map((l) => ({
              id: l.group.id,
              name: l.group.name,
              minimumSelections: l.group.minimumSelections,
              maximumSelections: l.group.maximumSelections,
              selectionType: l.group.selectionType,
              required: l.group.minimumSelections >= 1,
              defaultModifierId: l.group.defaultModifierId,
              modifiers: l.group.modifiers.map((m) => ({
                id: m.id,
                name: m.name,
                priceDelta: m.priceDelta,
                available: m.available,
                aliases: m.aliases,
              })),
            })),
        });
      }
    }
    for (const c of menu.combos) {
      const components = c.components.map((comp) => ({
        id: comp.id,
        name: comp.name,
        required: comp.required,
        min: comp.minimumSelections,
        max: comp.maximumSelections,
        options: comp.allowedProducts.map((ap) => ({ productId: ap.productId, productName: ap.product.name, upcharge: ap.upcharge })),
      }));
      combos.push({
        id: c.id,
        name: c.name,
        description: c.description,
        basePrice: c.basePrice,
        aliases: c.aliases,
        taxCategory: c.taxCategory,
        components,
        orderable: !restaurantOpen
          ? { ok: false, reason: restaurantReason! }
          : c.available
            ? { ok: true }
            : { ok: false, reason: 'Currently unavailable (sold out)' },
      });
    }
  }

  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      currency: restaurant.currency,
      timezone: restaurant.timezone,
      status: restaurant.status,
      orderingEnabled: restaurant.orderingEnabled,
    },
    products,
    combos,
    taxRatesBps: Object.fromEntries(restaurant.taxRules.map((t) => [t.category, t.rateBps])),
    discounts: restaurant.discounts.map((d) => ({ id: d.id, name: d.name, type: d.type, value: d.value, minimumSubtotal: d.minimumSubtotal })),
    loadedAt: now,
  };
}
