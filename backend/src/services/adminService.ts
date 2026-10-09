import { prisma } from '../config/prisma';
import { ApiError, CommandRejected } from '../utils/errors';
import { getOrderView, orderInclude } from './orderEngine';
import { toOrderView } from './orderView';

export async function adminMenu(restaurantId: string) {
  const r = await prisma.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    include: {
      menus: {
        where: { status: { not: 'ARCHIVED' } },
        include: {
          categories: {
            where: { status: { not: 'ARCHIVED' } },
            orderBy: { displayOrder: 'asc' },
            include: {
              products: {
                where: { status: { not: 'ARCHIVED' } },
                orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
                include: { modifierGroups: { orderBy: { displayOrder: 'asc' }, include: { group: { include: { modifiers: { where: { status: { not: 'ARCHIVED' } }, orderBy: { displayOrder: 'asc' } } } } } } },
              },
            },
          },
          combos: { where: { status: { not: 'ARCHIVED' } }, orderBy: { name: 'asc' } },
        },
      },
    },
  });
  return {
    restaurant: { id: r.id, name: r.name, status: r.status, orderingEnabled: r.orderingEnabled, currency: r.currency },
    categories: r.menus.flatMap((m) =>
      m.categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        products: c.products.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          basePrice: p.basePrice,
          available: p.available,
          vegetarian: p.vegetarian,
          vegan: p.vegan,
          glutenFree: p.glutenFree,
          allergens: p.allergens,
          allergenInfoVerified: p.allergenInfoVerified,
          aliases: p.aliases,
          availableFrom: p.availableFrom,
          availableUntil: p.availableUntil,
          modifiers: p.modifierGroups.flatMap((l) =>
            l.group.modifiers.map((m2) => ({ id: m2.id, groupId: l.group.id, name: m2.name, group: l.group.name, priceDelta: m2.priceDelta, available: m2.available })),
          ),
        })),
      })),
    ),
    combos: r.menus.flatMap((m) => m.combos.map((c) => ({ id: c.id, name: c.name, description: c.description, basePrice: c.basePrice, available: c.available }))),
  };
}

/* ---------- menu management (every lookup is scoped to the restaurant) ---------- */

const isPrismaCode = (e: unknown, code: string) => typeof e === 'object' && e !== null && (e as { code?: string }).code === code;

async function activeMenu(restaurantId: string) {
  const menu = await prisma.menu.findFirst({ where: { restaurantId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!menu) throw ApiError.unprocessable('There is no active menu to add items to');
  return menu;
}

export async function createCategory(restaurantId: string, data: { name: string; description?: string | null }) {
  const menu = await activeMenu(restaurantId);
  try {
    const last = await prisma.category.aggregate({ where: { menuId: menu.id }, _max: { displayOrder: true } });
    const c = await prisma.category.create({ data: { menuId: menu.id, name: data.name, description: data.description ?? null, displayOrder: (last._max.displayOrder ?? 0) + 1 } });
    return { id: c.id, name: c.name };
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('A category with that name already exists');
    throw e;
  }
}

export async function updateCategory(restaurantId: string, categoryId: string, data: { name?: string; description?: string | null }) {
  const c = await prisma.category.findFirst({ where: { id: categoryId, status: { not: 'ARCHIVED' }, menu: { restaurantId } } });
  if (!c) throw ApiError.notFound('Category not found');
  try {
    await prisma.category.update({ where: { id: c.id }, data });
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('A category with that name already exists');
    throw e;
  }
  return { id: c.id };
}

export async function deleteCategory(restaurantId: string, categoryId: string) {
  const c = await prisma.category.findFirst({
    where: { id: categoryId, status: { not: 'ARCHIVED' }, menu: { restaurantId } },
    include: { _count: { select: { products: { where: { status: { not: 'ARCHIVED' } } } } } },
  });
  if (!c) throw ApiError.notFound('Category not found');
  if (c._count.products > 0) throw ApiError.conflict('Move or delete the items in this category first');
  try {
    await prisma.category.delete({ where: { id: c.id } });
  } catch (e) {
    if (!isPrismaCode(e, 'P2003')) throw e;
    // Archived items from past orders still reference it: keep the rows, hide the category.
    await prisma.category.update({ where: { id: c.id }, data: { status: 'ARCHIVED' } });
  }
  return { id: c.id };
}

type ProductInput = {
  name?: string;
  description?: string | null;
  basePrice?: number;
  vegetarian?: boolean;
  vegan?: boolean;
  glutenFree?: boolean;
  allergens?: ('MILK' | 'EGG' | 'PEANUTS' | 'TREE_NUTS' | 'SOY' | 'GLUTEN' | 'SESAME' | 'MUSTARD')[];
  allergenInfoVerified?: boolean;
  aliases?: string[];
  availableFrom?: string | null;
  availableUntil?: string | null;
};

/** Cross-field rules that a per-field schema cannot express. */
function assertProductRules(p: { vegetarian: boolean; vegan: boolean; availableFrom: string | null; availableUntil: string | null }) {
  if (p.vegan && !p.vegetarian) throw ApiError.unprocessable('A vegan item must also be vegetarian');
  if ((p.availableFrom === null) !== (p.availableUntil === null)) throw ApiError.unprocessable('Set both the start and end of the availability window, or neither');
}

const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export async function createProduct(restaurantId: string, data: ProductInput & { categoryId: string; name: string; basePrice: number }) {
  const cat = await prisma.category.findFirst({ where: { id: data.categoryId, status: { not: 'ARCHIVED' }, menu: { restaurantId } } });
  if (!cat) throw ApiError.notFound('Category not found');
  const rules = { vegetarian: data.vegetarian ?? true, vegan: data.vegan ?? false, availableFrom: data.availableFrom ?? null, availableUntil: data.availableUntil ?? null };
  assertProductRules(rules);
  try {
    const last = await prisma.product.aggregate({ where: { categoryId: cat.id }, _max: { displayOrder: true } });
    const p = await prisma.product.create({
      data: {
        categoryId: cat.id,
        name: data.name,
        description: data.description ?? null,
        basePrice: data.basePrice,
        ...rules,
        glutenFree: data.glutenFree ?? false,
        allergens: data.allergens ? [...new Set(data.allergens)] : [],
        allergenInfoVerified: data.allergenInfoVerified ?? false,
        aliases: dedupe(data.aliases ?? []),
        displayOrder: (last._max.displayOrder ?? 0) + 1,
      },
    });
    return { id: p.id, name: p.name };
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('An item with that name already exists in this category');
    throw e;
  }
}

export async function updateProduct(restaurantId: string, productId: string, data: ProductInput & { categoryId?: string; available?: boolean }) {
  const p = await prisma.product.findFirst({ where: { id: productId, status: { not: 'ARCHIVED' }, category: { menu: { restaurantId } } } });
  if (!p) throw ApiError.notFound('Item not found');
  if (data.categoryId && data.categoryId !== p.categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: data.categoryId, status: { not: 'ARCHIVED' }, menu: { restaurantId } } });
    if (!cat) throw ApiError.notFound('Category not found');
  }
  assertProductRules({
    vegetarian: data.vegetarian ?? p.vegetarian,
    vegan: data.vegan ?? p.vegan,
    availableFrom: data.availableFrom !== undefined ? data.availableFrom : p.availableFrom,
    availableUntil: data.availableUntil !== undefined ? data.availableUntil : p.availableUntil,
  });
  try {
    await prisma.product.update({
      where: { id: p.id },
      data: {
        ...data,
        ...(data.allergens ? { allergens: [...new Set(data.allergens)] } : {}),
        ...(data.aliases ? { aliases: dedupe(data.aliases) } : {}),
      },
    });
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('An item with that name already exists in this category');
    throw e;
  }
  return { id: p.id };
}

export async function deleteProduct(restaurantId: string, productId: string) {
  const p = await prisma.product.findFirst({ where: { id: productId, status: { not: 'ARCHIVED' }, category: { menu: { restaurantId } } } });
  if (!p) throw ApiError.notFound('Item not found');
  try {
    await prisma.product.delete({ where: { id: p.id } });
    return { id: p.id, archived: false };
  } catch (e) {
    if (!isPrismaCode(e, 'P2003')) throw e;
    // Past orders reference it: keep the history intact and just hide it from the menu.
    await prisma.product.update({ where: { id: p.id }, data: { status: 'ARCHIVED', available: false } });
    return { id: p.id, archived: true };
  }
}

export async function createModifier(restaurantId: string, groupId: string, data: { name: string; priceDelta: number }) {
  const g = await prisma.modifierGroup.findFirst({ where: { id: groupId, restaurantId, status: { not: 'ARCHIVED' } } });
  if (!g) throw ApiError.notFound('Option group not found');
  try {
    const last = await prisma.modifier.aggregate({ where: { modifierGroupId: g.id }, _max: { displayOrder: true } });
    const m = await prisma.modifier.create({ data: { modifierGroupId: g.id, name: data.name, priceDelta: data.priceDelta, displayOrder: (last._max.displayOrder ?? 0) + 1 } });
    return { id: m.id };
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('That option already exists in this group');
    throw e;
  }
}

export async function updateModifier(restaurantId: string, modifierId: string, data: { name?: string; priceDelta?: number; available?: boolean }) {
  const m = await prisma.modifier.findFirst({ where: { id: modifierId, status: { not: 'ARCHIVED' }, group: { restaurantId } } });
  if (!m) throw ApiError.notFound('Option not found');
  try {
    await prisma.modifier.update({ where: { id: m.id }, data });
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('That option already exists in this group');
    throw e;
  }
  return { id: m.id };
}

export async function deleteModifier(restaurantId: string, modifierId: string) {
  const m = await prisma.modifier.findFirst({ where: { id: modifierId, status: { not: 'ARCHIVED' }, group: { restaurantId } } });
  if (!m) throw ApiError.notFound('Option not found');
  await prisma.$transaction(async (tx) => {
    await tx.modifierGroup.updateMany({ where: { id: m.modifierGroupId, defaultModifierId: m.id }, data: { defaultModifierId: null } });
    await tx.modifier.delete({ where: { id: m.id } }); // order lines keep their own name/price snapshot
  });
  return { id: m.id };
}

export async function updateCombo(restaurantId: string, comboId: string, data: { name?: string; description?: string | null; basePrice?: number }) {
  const c = await prisma.combo.findFirst({ where: { id: comboId, restaurantId, status: { not: 'ARCHIVED' } } });
  if (!c) throw ApiError.notFound('Combo not found');
  try {
    await prisma.combo.update({ where: { id: c.id }, data });
  } catch (e) {
    if (isPrismaCode(e, 'P2002')) throw ApiError.conflict('A combo with that name already exists');
    throw e;
  }
  return { id: c.id };
}

export async function setProductAvailability(restaurantId: string, productId: string, available: boolean) {
  const p = await prisma.product.findFirst({ where: { id: productId, category: { menu: { restaurantId } } } });
  if (!p) throw ApiError.notFound('Product not found');
  await prisma.product.update({ where: { id: p.id }, data: { available } });
  return { id: p.id, available };
}

export async function setModifierAvailability(restaurantId: string, modifierId: string, available: boolean) {
  const m = await prisma.modifier.findFirst({ where: { id: modifierId, group: { restaurantId } } });
  if (!m) throw ApiError.notFound('Modifier not found');
  await prisma.modifier.update({ where: { id: m.id }, data: { available } });
  return { id: m.id, available };
}

export async function setComboAvailability(restaurantId: string, comboId: string, available: boolean) {
  const c = await prisma.combo.findFirst({ where: { id: comboId, restaurantId } });
  if (!c) throw ApiError.notFound('Combo not found');
  await prisma.combo.update({ where: { id: c.id }, data: { available } });
  return { id: c.id, available };
}

export async function updateRestaurant(restaurantId: string, data: { status?: 'OPEN' | 'CLOSED' | 'TEMPORARILY_UNAVAILABLE'; orderingEnabled?: boolean }) {
  const r = await prisma.restaurant.update({ where: { id: restaurantId }, data });
  return { status: r.status, orderingEnabled: r.orderingEnabled };
}

export interface OrdersFilter {
  status?: string;
  page: number;
  limit: number;
  from?: string;
  to?: string;
  item?: string;
  tzOffset: number;
}

/** Local-midnight of a YYYY-MM-DD in the viewer's timezone, as a UTC instant. */
function dayStart(day: string, tzOffset: number, plusDays = 0) {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d + plusDays) + tzOffset * 60_000;
  return new Date(t);
}

export async function listOrders(restaurantId: string, f: OrdersFilter) {
  if (f.from && f.to && f.from > f.to) throw ApiError.badRequest('"from" must not be after "to"');
  const created: { gte?: Date; lt?: Date } = {};
  if (f.from) created.gte = dayStart(f.from, f.tzOffset);
  if (f.to) created.lt = dayStart(f.to, f.tzOffset, 1);
  if ((created.gte && Number.isNaN(created.gte.getTime())) || (created.lt && Number.isNaN(created.lt.getTime()))) throw ApiError.badRequest('Invalid date');

  const where = {
    restaurantId,
    ...(f.status ? { status: f.status as never } : { status: { notIn: ['DRAFT' as const] } }),
    ...(created.gte || created.lt ? { createdAt: created } : {}),
    ...(f.item ? { items: { some: { productNameSnapshot: { contains: f.item, mode: 'insensitive' as const } } } } : {}),
  };
  const [total, orders] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (f.page - 1) * f.limit, take: f.limit, include: orderInclude }),
  ]);
  return { orders: orders.map(toOrderView), page: f.page, limit: f.limit, total, totalPages: Math.max(1, Math.ceil(total / f.limit)) };
}

export async function getOrderDetail(restaurantId: string, orderId: string) {
  const o = await prisma.order.findFirst({ where: { id: orderId, restaurantId }, include: { ...orderInclude, events: { orderBy: { createdAt: 'asc' } } } });
  if (!o) throw ApiError.notFound('Order not found');
  return {
    order: toOrderView(o),
    events: o.events.map((e) => ({ id: e.id, type: e.type, payload: e.payload, actor: e.actor, createdAt: e.createdAt.toISOString() })),
  };
}

const ADMIN_TRANSITIONS: Record<string, string[]> = { SUBMITTED: ['COMPLETED', 'FAILED'], FAILED: ['SUBMITTED'] };
const EVENT_FOR: Record<string, string> = { COMPLETED: 'ORDER_COMPLETED', FAILED: 'ORDER_FAILED', SUBMITTED: 'ORDER_SUBMITTED' };

export async function setOrderStatus(restaurantId: string, orderId: string, status: 'COMPLETED' | 'FAILED' | 'SUBMITTED') {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const o = await tx.order.findFirst({ where: { id: orderId, restaurantId } });
    if (!o) throw ApiError.notFound('Order not found');
    if (o.status === status) return;
    if (!(ADMIN_TRANSITIONS[o.status] ?? []).includes(status)) throw new CommandRejected('BAD_TRANSITION', `Cannot move an order from ${o.status} to ${status}`);
    await tx.order.update({ where: { id: o.id }, data: { status, version: { increment: 1 } } });
    await tx.orderEvent.create({ data: { orderId: o.id, type: EVENT_FOR[status], payload: { by: 'admin' }, actor: 'SYSTEM' } });
  });
  return getOrderView(orderId);
}

export async function listEscalations(restaurantId: string) {
  const rows = await prisma.escalation.findMany({ where: { conversation: { restaurantId } }, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map((e) => ({ id: e.id, reason: e.reason, createdAt: e.createdAt.toISOString(), snapshot: e.snapshot }));
}
