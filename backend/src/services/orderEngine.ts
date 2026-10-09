import { Prisma } from '../../generated/prisma/client';
import { prisma, type Tx } from '../config/prisma';
import { priceLine, priceOrder } from '../domain/pricing';
import { CommandRejected, ApiError } from '../utils/errors';
import type { Catalog, ComboView, ProductView } from './catalog';
import { describePick, lineRef, parseLineRef, readBack, toOrderView, type ComboPick, type OrderView } from './orderView';
import {
  MAX_LINE_QTY,
  MAX_ORDER_UNITS,
  buildSelections,
  checkCanAdd,
  describeGroup,
  findIngredient,
  findModifier,
  missingGroups,
  modDraft,
  type ModDraft,
} from './selections';

export const orderInclude = {
  items: { include: { modifiers: true }, orderBy: { lineNo: 'asc' } },
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
type ItemRow = OrderRow['items'][number];
export type Actor = 'CUSTOMER' | 'AGENT' | 'SYSTEM';

export type Command =
  | { type: 'ADD_ITEM'; productId: string; quantity: number; modifierIds?: string[]; removeIngredients?: string[] }
  | { type: 'ADD_COMBO'; comboId: string; quantity: number; selections: { componentId: string; productId: string; modifierIds?: string[] }[] }
  | { type: 'CHANGE_COMBO'; line: string; selections: { componentId: string; productId: string; modifierIds?: string[] }[] }
  | { type: 'REMOVE_ITEM'; line: string }
  | { type: 'CHANGE_QUANTITY'; line: string; quantity: number }
  | { type: 'ADD_MODIFIER'; line: string; modifierId: string; units?: number }
  | { type: 'REMOVE_MODIFIER'; line: string; modifierId: string; units?: number }
  | { type: 'REMOVE_INGREDIENT'; line: string; ingredient: string; units?: number }
  | { type: 'RESTORE_INGREDIENT'; line: string; ingredient: string; units?: number }
  | { type: 'REPLACE_MODIFIER'; line: string; fromModifierId: string; toModifierId: string; units?: number }
  | { type: 'REPLACE_ITEM'; line: string; productId: string }
  | { type: 'SET_CUSTOMER_DETAILS'; name?: string | null; phone?: string | null; pickupAt?: Date | null; notes?: string | null }
  | { type: 'REQUEST_CONFIRMATION' }
  | { type: 'CONFIRM_ORDER'; expectedVersion: number }
  | { type: 'CANCEL_ORDER' }
  | { type: 'CLEAR_ORDER' };

export interface CommandOutcome {
  order: OrderView;
  message: string;
  affectedLines: string[];
  changed: boolean;
}

const EDITABLE: string[] = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_CONFIRMATION'];
const EDIT_TYPES = new Set([
  'ADD_ITEM', 'ADD_COMBO', 'CHANGE_COMBO', 'REMOVE_ITEM', 'CHANGE_QUANTITY', 'ADD_MODIFIER', 'REMOVE_MODIFIER', 'REMOVE_INGREDIENT',
  'RESTORE_INGREDIENT', 'REPLACE_MODIFIER', 'REPLACE_ITEM', 'CLEAR_ORDER',
]);

/* ---------- order lifecycle ---------- */

export async function createOrder(restaurantId: string, locationId: string | null, tx: Tx | typeof prisma = prisma) {
  const restaurant = await tx.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) throw ApiError.notFound('Restaurant not found');
  const order = await tx.order.create({
    data: { restaurantId, locationId, currency: restaurant.currency, status: 'DRAFT' },
    include: orderInclude,
  });
  await tx.orderEvent.create({ data: { orderId: order.id, type: 'ORDER_CREATED', payload: {}, actor: 'SYSTEM' } });
  return order;
}

export async function getOrderView(orderId: string): Promise<OrderView> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!o) throw ApiError.notFound('Order not found');
  return toOrderView(o);
}

/* ---------- command execution ---------- */

/** Applies one command atomically against the locked, current order state. The LLM never writes order rows directly. */
export async function runCommand(orderId: string, cmd: Command, actor: Actor, catalog: Catalog): Promise<CommandOutcome> {
  const outcomes = await runCommands(orderId, [cmd], actor, catalog);
  return outcomes[outcomes.length - 1];
}

/** Applies several commands in ONE transaction (e.g. "make both burgers spicy"): all succeed or none do. */
export async function runCommands(orderId: string, cmds: Command[], actor: Actor, catalog: Catalog): Promise<CommandOutcome[]> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const outcomes: CommandOutcome[] = [];
        for (const cmd of cmds) {
          const order = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude });
          if (!order) throw ApiError.notFound('Order not found');
          outcomes.push(await execute(tx, order, cmd, actor, catalog));
        }
        return outcomes;
      },
      { timeout: 15000 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new CommandRejected('DUPLICATE', 'That change collided with another request. Please try again.');
    throw e;
  }
}

async function event(tx: Tx, orderId: string, type: string, payload: Prisma.InputJsonValue, actor: Actor) {
  await tx.orderEvent.create({ data: { orderId, type, payload, actor } });
}

const activeItems = (o: OrderRow) => o.items.filter((i) => i.status === 'ACTIVE');
const totalUnits = (o: OrderRow) => activeItems(o).reduce((s, i) => s + i.quantity, 0);

function restaurantGate(catalog: Catalog) {
  if (!catalog.restaurant.orderingEnabled || catalog.restaurant.status !== 'OPEN')
    throw new CommandRejected('RESTAURANT_CLOSED', 'The restaurant is not taking orders right now.');
}

function getProduct(catalog: Catalog, id: string): ProductView {
  const p = catalog.products.find((x) => x.id === id);
  if (!p) throw new CommandRejected('UNKNOWN_PRODUCT', 'That item is not on the menu.');
  return p;
}

function requireOrderable(o: { name: string; orderable: { ok: boolean } }) {
  const ord = o.orderable as { ok: boolean; reason?: string };
  if (!ord.ok) throw new CommandRejected('NOT_ORDERABLE', `${o.name}: ${ord.reason}.`, { item: o.name });
}

function findLine(order: OrderRow, ref: string): ItemRow {
  const n = parseLineRef(ref);
  const item = n === null ? undefined : order.items.find((i) => i.lineNo === n && i.status === 'ACTIVE');
  if (!item) throw new CommandRejected('UNKNOWN_LINE', `There is no item ${ref} in the order.`);
  return item;
}

function productOfLine(catalog: Catalog, item: ItemRow): ProductView {
  if (!item.productId) throw new CommandRejected('COMBO_LINE', 'A combo cannot be changed once added. Remove it and add it again with the changes, or order the parts separately.');
  const p = catalog.products.find((x) => x.id === item.productId);
  if (!p) throw new CommandRejected('UNKNOWN_PRODUCT', `${item.productNameSnapshot} is no longer on the menu.`);
  return p;
}

const toDraft = (m: ItemRow['modifiers'][number]): ModDraft => ({
  kind: m.kind,
  modifierId: m.modifierId,
  modifierGroupId: m.modifierGroupId,
  ingredientName: m.ingredientName,
  name: m.modifierNameSnapshot,
  price: m.modifierPrice,
  quantity: m.quantity,
  source: m.source,
});

async function nextLineNo(tx: Tx, orderId: string) {
  const agg = await tx.orderItem.aggregate({ where: { orderId }, _max: { lineNo: true } });
  return (agg._max.lineNo ?? 0) + 1;
}

async function writeMods(tx: Tx, itemId: string, drafts: ModDraft[]) {
  await tx.orderModifier.deleteMany({ where: { orderItemId: itemId } });
  if (drafts.length)
    await tx.orderModifier.createMany({
      data: drafts.map((d) => ({
        orderItemId: itemId,
        kind: d.kind,
        modifierId: d.modifierId,
        modifierGroupId: d.modifierGroupId,
        ingredientName: d.ingredientName,
        modifierNameSnapshot: d.name,
        modifierPrice: d.price,
        quantity: d.quantity,
        source: d.source,
      })),
    });
}

/**
 * Isolate `units` of a line so a modifier can apply to just those (§42). If units covers the whole line,
 * the line itself is returned. Otherwise the original is reduced and a clone is created.
 */
async function takeUnits(tx: Tx, order: OrderRow, item: ItemRow, units: number | undefined, actor: Actor): Promise<ItemRow> {
  if (units === undefined || units === item.quantity) return item;
  if (!Number.isInteger(units) || units < 1) throw new CommandRejected('BAD_QUANTITY', 'Units must be a whole number of at least 1.');
  if (units > item.quantity) throw new CommandRejected('BAD_QUANTITY', `Only ${item.quantity} of ${item.productNameSnapshot} in that line.`);
  const lineNo = await nextLineNo(tx, order.id);
  await tx.orderItem.update({ where: { id: item.id }, data: { quantity: item.quantity - units } });
  const clone = await tx.orderItem.create({
    data: {
      lineNo,
      orderId: order.id,
      productId: item.productId,
      comboId: item.comboId,
      productNameSnapshot: item.productNameSnapshot,
      quantity: units,
      unitBasePrice: item.unitBasePrice,
      modifierTotal: item.modifierTotal,
      unitTotal: item.unitTotal,
      lineTotal: item.unitTotal * units,
      taxCategory: item.taxCategory,
      position: lineNo,
      comboSelections: item.comboSelections ?? undefined,
    },
  });
  await writeMods(tx, clone.id, item.modifiers.map(toDraft));
  await event(tx, order.id, 'ITEM_SPLIT', { from: lineRef(item.lineNo), to: lineRef(lineNo), units }, actor);
  return tx.orderItem.findUniqueOrThrow({ where: { id: clone.id }, include: { modifiers: true } });
}

async function reprice(tx: Tx, orderId: string, catalog: Catalog, status?: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  const lines = activeItems(order);
  const inputs = lines.map((l) => ({
    quantity: l.quantity,
    unitBasePrice: l.unitBasePrice,
    taxCategory: l.taxCategory,
    modifiers: l.modifiers.map((m) => ({ price: m.modifierPrice, quantity: m.quantity })),
  }));
  for (let i = 0; i < lines.length; i++) await tx.orderItem.update({ where: { id: lines[i].id }, data: priceLine(inputs[i]) });
  const priced = priceOrder(inputs, catalog.taxRatesBps, catalog.discounts);
  return tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: priced.subtotal,
      discount: priced.discount,
      taxableAmount: priced.taxableAmount,
      tax: priced.tax,
      fees: priced.fees,
      total: priced.total,
      taxBreakdown: priced.taxBreakdown,
      discountBreakdown: priced.discountBreakdown,
      feeBreakdown: priced.feeBreakdown as unknown as Prisma.InputJsonValue,
      status: (status ?? order.status) as never,
      version: { increment: 1 },
    },
    include: orderInclude,
  });
}

async function execute(tx: Tx, order: OrderRow, cmd: Command, actor: Actor, catalog: Catalog): Promise<CommandOutcome> {
  const isEdit = EDIT_TYPES.has(cmd.type);
  if (isEdit && !EDITABLE.includes(order.status))
    throw new CommandRejected('ORDER_CLOSED', `This order is ${order.status.toLowerCase()} and can no longer be changed.`);
  if (cmd.type === 'ADD_ITEM' || cmd.type === 'ADD_COMBO' || cmd.type === 'REPLACE_ITEM') restaurantGate(catalog);

  // A correction during review reopens editing (§59).
  if (isEdit && order.status === 'READY_FOR_CONFIRMATION') await event(tx, order.id, 'ORDER_REOPENED', { reason: cmd.type }, actor);

  const affected: number[] = [];
  let message = '';
  let changed = true;

  const assertCapacity = (extra: number) => {
    if (totalUnits(order) + extra > MAX_ORDER_UNITS)
      throw new CommandRejected('ORDER_TOO_LARGE', `An order can hold at most ${MAX_ORDER_UNITS} items. Please contact the restaurant for large orders.`);
  };
  const assertQty = (q: number) => {
    if (!Number.isInteger(q) || q < 1 || q > MAX_LINE_QTY)
      throw new CommandRejected('BAD_QUANTITY', `Quantity must be a whole number between 1 and ${MAX_LINE_QTY}.`);
  };

  switch (cmd.type) {
    case 'ADD_ITEM': {
      assertQty(cmd.quantity);
      assertCapacity(cmd.quantity);
      const product = getProduct(catalog, cmd.productId);
      requireOrderable(product);
      const { drafts, missing } = buildSelections(product, cmd.modifierIds ?? [], cmd.removeIngredients ?? []);
      if (missing.length)
        throw new CommandRejected('NEEDS_INFO', `${product.name} needs a choice for: ${missing.map((g) => g.name).join(', ')}.`, {
          missing: missing.map(describeGroup),
        });
      const lineNo = await nextLineNo(tx, order.id);
      const item = await tx.orderItem.create({
        data: {
          lineNo,
          orderId: order.id,
          productId: product.id,
          productNameSnapshot: product.name,
          quantity: cmd.quantity,
          unitBasePrice: product.basePrice,
          unitTotal: product.basePrice,
          lineTotal: product.basePrice * cmd.quantity,
          taxCategory: product.taxCategory,
          position: lineNo,
        },
      });
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'ITEM_ADDED', { line: lineRef(lineNo), product: product.name, quantity: cmd.quantity, modifiers: drafts.map((d) => d.name) }, actor);
      affected.push(lineNo);
      const chosen = drafts.filter((d) => d.source === 'EXPLICIT').map((d) => (d.kind === 'REMOVAL' ? `no ${d.name}` : d.name));
      message = `Added ${cmd.quantity} × ${product.name}${chosen.length ? ` (${chosen.join(', ')})` : ''}.`;
      break;
    }
    case 'ADD_COMBO': {
      assertQty(cmd.quantity);
      assertCapacity(cmd.quantity);
      const combo = catalog.combos.find((c) => c.id === cmd.comboId);
      if (!combo) throw new CommandRejected('UNKNOWN_PRODUCT', 'That combo is not on the menu.');
      requireOrderable(combo);
      const { picked, unit } = resolveComboPicks(catalog, combo, cmd.selections);
      const lineNo = await nextLineNo(tx, order.id);
      await tx.orderItem.create({
        data: {
          lineNo,
          orderId: order.id,
          comboId: combo.id,
          productNameSnapshot: combo.name,
          quantity: cmd.quantity,
          unitBasePrice: unit,
          unitTotal: unit,
          lineTotal: unit * cmd.quantity,
          taxCategory: combo.taxCategory,
          position: lineNo,
          comboSelections: picked as unknown as Prisma.InputJsonValue,
        },
      });
      await event(tx, order.id, 'ITEM_ADDED', { line: lineRef(lineNo), combo: combo.name, quantity: cmd.quantity, selections: picked.map(describePick) }, actor);
      affected.push(lineNo);
      message = `Added ${cmd.quantity} × ${combo.name} (${picked.map(describePick).join(', ')}).`;
      break;
    }
    case 'CHANGE_COMBO': {
      const item = findLine(order, cmd.line);
      const combo = item.comboId ? catalog.combos.find((c) => c.id === item.comboId) : undefined;
      if (!combo) throw new CommandRejected('NOT_COMBO', `${item.productNameSnapshot} is not a combo.`);
      requireOrderable(combo);
      const before = (item.comboSelections as unknown as ComboPick[] | null) ?? [];
      const { picked, unit } = resolveComboPicks(catalog, combo, cmd.selections);
      await tx.orderItem.update({
        where: { id: item.id },
        data: { unitBasePrice: unit, unitTotal: unit, lineTotal: unit * item.quantity, comboSelections: picked as unknown as Prisma.InputJsonValue },
      });
      await event(tx, order.id, 'COMBO_CHANGED', { line: cmd.line, combo: combo.name, from: before.map(describePick), to: picked.map(describePick) }, actor);
      affected.push(item.lineNo);
      message = `Updated the ${combo.name} (${lineRef(item.lineNo)}): ${picked.map(describePick).join(', ')}.`;
      break;
    }
    case 'REMOVE_ITEM': {
      const item = findLine(order, cmd.line);
      await tx.orderItem.update({ where: { id: item.id }, data: { status: 'REMOVED' } });
      await event(tx, order.id, 'ITEM_REMOVED', { line: cmd.line, product: item.productNameSnapshot, quantity: item.quantity }, actor);
      message = `Removed ${item.productNameSnapshot}.`;
      break;
    }
    case 'CHANGE_QUANTITY': {
      assertQty(cmd.quantity);
      const item = findLine(order, cmd.line);
      affected.push(item.lineNo);
      if (item.quantity === cmd.quantity) {
        changed = false;
        message = `Already ${cmd.quantity} × ${item.productNameSnapshot}.`;
        break;
      }
      assertCapacity(cmd.quantity - item.quantity);
      await tx.orderItem.update({ where: { id: item.id }, data: { quantity: cmd.quantity } });
      await event(tx, order.id, 'QUANTITY_CHANGED', { line: cmd.line, product: item.productNameSnapshot, from: item.quantity, to: cmd.quantity }, actor);
      message = `Changed ${item.productNameSnapshot} from ${item.quantity} to ${cmd.quantity}.`;
      break;
    }
    case 'ADD_MODIFIER': {
      const item0 = findLine(order, cmd.line);
      const product = productOfLine(catalog, item0);
      // validate before splitting so a rejected request leaves no trace (the transaction also rolls back)
      checkCanAdd(product, item0.modifiers.map(toDraft), cmd.modifierId);
      const item = await takeUnits(tx, order, item0, cmd.units, actor);
      const drafts = item.modifiers.map(toDraft);
      const { replaceDefault, group } = checkCanAdd(product, drafts, cmd.modifierId);
      if (replaceDefault) drafts.splice(drafts.indexOf(replaceDefault), 1);
      const d = modDraft(group, cmd.modifierId, 'EXPLICIT');
      drafts.push(d);
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'MODIFIER_ADDED', { line: lineRef(item.lineNo), product: item.productNameSnapshot, modifier: d.name, price: d.price }, actor);
      affected.push(item.lineNo);
      message = `Added ${d.name} to ${item.productNameSnapshot} (${lineRef(item.lineNo)}).`;
      break;
    }
    case 'REMOVE_MODIFIER': {
      const item0 = findLine(order, cmd.line);
      const product = productOfLine(catalog, item0);
      if (!item0.modifiers.some((m) => m.modifierId === cmd.modifierId && m.kind === 'ADD'))
        throw new CommandRejected('NOT_PRESENT', 'That option is not on this item.');
      const item = await takeUnits(tx, order, item0, cmd.units, actor);
      const drafts = item.modifiers.map(toDraft);
      const [gone] = drafts.splice(drafts.findIndex((m) => m.modifierId === cmd.modifierId), 1);
      const missing = missingGroups(product, drafts);
      if (missing.length)
        throw new CommandRejected('REQUIRED_GROUP', `${gone.name} can't just be removed — ${missing[0].name} is required. Replace it with another option instead.`, {
          missing: missing.map(describeGroup),
        });
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'MODIFIER_REMOVED', { line: lineRef(item.lineNo), product: item.productNameSnapshot, modifier: gone.name }, actor);
      affected.push(item.lineNo);
      message = `Removed ${gone.name} from ${item.productNameSnapshot} (${lineRef(item.lineNo)}).`;
      break;
    }
    case 'REMOVE_INGREDIENT': {
      const item0 = findLine(order, cmd.line);
      const product = productOfLine(catalog, item0);
      const ing = findIngredient(product, cmd.ingredient);
      if (!ing) throw new CommandRejected('UNKNOWN_INGREDIENT', `${product.name} doesn't list "${cmd.ingredient}" as an ingredient.`);
      if (!ing.removable) throw new CommandRejected('NOT_REMOVABLE', `${ing.name} can't be removed from ${product.name}.`);
      if (item0.modifiers.some((m) => m.kind === 'REMOVAL' && m.ingredientName === ing.name))
        throw new CommandRejected('ALREADY_PRESENT', `${ing.name} is already removed.`);
      const item = await takeUnits(tx, order, item0, cmd.units, actor);
      const drafts = item.modifiers.map(toDraft);
      drafts.push({ kind: 'REMOVAL', modifierId: null, modifierGroupId: null, ingredientName: ing.name, name: ing.name, price: 0, quantity: 1, source: 'EXPLICIT' });
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'MODIFIER_ADDED', { line: lineRef(item.lineNo), product: item.productNameSnapshot, modifier: `no ${ing.name}`, price: 0 }, actor);
      affected.push(item.lineNo);
      message = `${product.name} (${lineRef(item.lineNo)}) will be made without ${ing.name}.`;
      break;
    }
    case 'RESTORE_INGREDIENT': {
      const item0 = findLine(order, cmd.line);
      const want = cmd.ingredient.toLowerCase();
      const prior = item0.modifiers.find((m) => m.kind === 'REMOVAL' && m.ingredientName?.toLowerCase() === want);
      if (!prior) throw new CommandRejected('NOT_PRESENT', `${cmd.ingredient} hasn't been removed from that item.`);
      const item = await takeUnits(tx, order, item0, cmd.units, actor);
      const drafts = item.modifiers.map(toDraft).filter((m) => !(m.kind === 'REMOVAL' && m.ingredientName === prior.ingredientName));
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'MODIFIER_REMOVED', { line: lineRef(item.lineNo), modifier: `no ${prior.ingredientName}` }, actor);
      affected.push(item.lineNo);
      message = `${prior.ingredientName} is back on ${item.productNameSnapshot} (${lineRef(item.lineNo)}).`;
      break;
    }
    case 'REPLACE_MODIFIER': {
      const item0 = findLine(order, cmd.line);
      const product = productOfLine(catalog, item0);
      const fromG = findModifier(product, cmd.fromModifierId);
      const toG = findModifier(product, cmd.toModifierId);
      if (!fromG || !toG) throw new CommandRejected('NOT_SUPPORTED', 'That option is not available for this item.');
      if (fromG.group.id !== toG.group.id)
        throw new CommandRejected('DIFFERENT_GROUP', `${fromG.modifier.name} and ${toG.modifier.name} are different kinds of options; add or remove them separately.`);
      if (!item0.modifiers.some((m) => m.modifierId === cmd.fromModifierId && m.kind === 'ADD'))
        throw new CommandRejected('NOT_PRESENT', `${fromG.modifier.name} is not on this item.`);
      const item = await takeUnits(tx, order, item0, cmd.units, actor);
      let drafts = item.modifiers.map(toDraft).filter((m) => m.modifierId !== cmd.fromModifierId);
      const { replaceDefault } = checkCanAdd(product, drafts, cmd.toModifierId);
      if (replaceDefault) drafts = drafts.filter((d) => d !== replaceDefault);
      drafts.push(modDraft(toG.group, cmd.toModifierId, 'EXPLICIT'));
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'MODIFIER_REPLACED', { line: lineRef(item.lineNo), product: item.productNameSnapshot, from: fromG.modifier.name, to: toG.modifier.name }, actor);
      affected.push(item.lineNo);
      message = `Changed ${fromG.modifier.name} to ${toG.modifier.name} on ${item.productNameSnapshot} (${lineRef(item.lineNo)}).`;
      break;
    }
    case 'REPLACE_ITEM': {
      const item = findLine(order, cmd.line);
      const next = getProduct(catalog, cmd.productId);
      requireOrderable(next);
      if (item.productId === next.id) throw new CommandRejected('NO_CHANGE', `That line is already ${next.name}.`);
      // Preserve context where it still applies (§48): same-group picks and ingredient removals the new product supports.
      const carry: ModDraft[] = [];
      const dropped: string[] = [];
      for (const m of item.modifiers.map(toDraft)) {
        if (m.source === 'DEFAULT') continue;
        const ok =
          m.kind === 'ADD'
            ? next.groups.some((g) => g.id === m.modifierGroupId && g.modifiers.some((x) => x.id === m.modifierId && x.available))
            : !!findIngredient(next, m.ingredientName ?? '')?.removable;
        if (ok) carry.push(m);
        else dropped.push(m.name);
      }
      const { drafts, missing } = buildSelections(next, [], [], carry);
      if (missing.length)
        throw new CommandRejected('NEEDS_INFO', `${next.name} needs a choice for: ${missing.map((g) => g.name).join(', ')}.`, {
          missing: missing.map(describeGroup),
        });
      await tx.orderItem.update({
        where: { id: item.id },
        data: { productId: next.id, comboId: null, comboSelections: Prisma.DbNull, productNameSnapshot: next.name, unitBasePrice: next.basePrice, taxCategory: next.taxCategory },
      });
      await writeMods(tx, item.id, drafts);
      await event(tx, order.id, 'ITEM_REPLACED', { line: cmd.line, from: item.productNameSnapshot, to: next.name, droppedModifiers: dropped }, actor);
      affected.push(item.lineNo);
      message = `Replaced ${item.productNameSnapshot} with ${next.name}${dropped.length ? ` (${dropped.join(', ')} did not carry over)` : ''}.`;
      break;
    }
    case 'SET_CUSTOMER_DETAILS': {
      await tx.order.update({
        where: { id: order.id },
        data: {
          customerName: cmd.name ?? order.customerName,
          customerPhone: cmd.phone ?? order.customerPhone,
          pickupAt: cmd.pickupAt ?? order.pickupAt,
          notes: cmd.notes ?? order.notes,
        },
      });
      await event(tx, order.id, 'CUSTOMER_DETAILS_SET', { name: cmd.name ?? null, pickupAt: cmd.pickupAt?.toISOString() ?? null }, actor);
      message = cmd.name ? `Noted the order under the name ${cmd.name}.` : 'Saved the order details.';
      break;
    }
    case 'CLEAR_ORDER': {
      await tx.orderItem.updateMany({ where: { orderId: order.id, status: 'ACTIVE' }, data: { status: 'REMOVED' } });
      await event(tx, order.id, 'ORDER_CLEARED', {}, actor);
      message = 'Cleared the order.';
      break;
    }
    case 'CANCEL_ORDER': {
      if (order.status === 'CANCELLED') return { order: toOrderView(order), message: 'The order is already cancelled.', affectedLines: [], changed: false };
      if (!['DRAFT', 'IN_PROGRESS', 'READY_FOR_CONFIRMATION', 'CONFIRMED'].includes(order.status))
        throw new CommandRejected('ORDER_CLOSED', `This order is already ${order.status.toLowerCase()} and must be cancelled with the restaurant directly.`);
      await event(tx, order.id, 'ORDER_CANCELLED', {}, actor);
      const done = await reprice(tx, order.id, catalog, 'CANCELLED');
      return { order: toOrderView(done), message: 'The order has been cancelled.', affectedLines: [], changed: true };
    }
    case 'REQUEST_CONFIRMATION': {
      if (!EDITABLE.includes(order.status)) throw new CommandRejected('ORDER_CLOSED', `This order is ${order.status.toLowerCase()}.`);
      restaurantGate(catalog);
      validateWholeOrder(order, catalog);
      const reviewed = await reprice(tx, order.id, catalog, 'READY_FOR_CONFIRMATION');
      await event(tx, order.id, 'CONFIRMATION_REQUESTED', { total: reviewed.total }, actor);
      const view = toOrderView(reviewed);
      return { order: view, message: readBack(view), affectedLines: [], changed: order.status !== 'READY_FOR_CONFIRMATION' };
    }
    case 'CONFIRM_ORDER': {
      if (order.status === 'SUBMITTED' || order.status === 'COMPLETED')
        return { order: toOrderView(order), message: 'This order was already submitted.', affectedLines: [], changed: false };
      if (order.status !== 'READY_FOR_CONFIRMATION') throw new CommandRejected('NOT_REVIEWED', 'The order must be read back to the customer before it can be confirmed.');
      if (order.version !== cmd.expectedVersion) throw new CommandRejected('STALE', 'The order changed since it was read back. Please review it again.');
      restaurantGate(catalog);
      validateWholeOrder(order, catalog);
      const now = new Date();
      await event(tx, order.id, 'ORDER_CONFIRMED', { total: order.total }, actor);
      await tx.order.update({ where: { id: order.id }, data: { status: 'SUBMITTED', confirmedAt: now, submittedAt: now, version: { increment: 1 } } });
      await event(tx, order.id, 'ORDER_SUBMITTED', { total: order.total }, 'SYSTEM');
      const done = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      return { order: toOrderView(done), message: 'Order confirmed and sent to the kitchen.', affectedLines: [], changed: true };
    }
  }

  // Edit commands: reprice from current state; a correction during review returns the order to IN_PROGRESS.
  const hasLines = (await tx.orderItem.count({ where: { orderId: order.id, status: 'ACTIVE' } })) > 0;
  const updated = await reprice(tx, order.id, catalog, isEdit ? (hasLines ? 'IN_PROGRESS' : 'DRAFT') : undefined);
  return { order: toOrderView(updated), message, affectedLines: affected.map(lineRef), changed };
}

/**
 * Validate a customer's choices for a combo and price it: fixed components are filled in, the variants the combo
 * fixes (e.g. Medium drink) are applied and included in the price, and the customer's own choices are checked.
 */
function resolveComboPicks(catalog: Catalog, combo: ComboView, selections: { componentId: string; productId: string; modifierIds?: string[] }[]) {
  if (selections.some((s) => !combo.components.some((c) => c.id === s.componentId))) throw new CommandRejected('NOT_SUPPORTED', `Unknown component for ${combo.name}.`);
  const picked: ComboPick[] = [];
  let extras = 0; // paid options the customer chose on top of what the combo includes
  for (const comp of combo.components) {
    let sel = selections.filter((s) => s.componentId === comp.id);
    // A component with a single possible product (Classic Combo's burger) needs no question.
    if (sel.length === 0 && comp.required && comp.options.length === 1) sel = [{ componentId: comp.id, productId: comp.options[0].productId }];
    if (sel.length < comp.min || sel.length > comp.max || (comp.required && sel.length === 0))
      throw new CommandRejected('NEEDS_INFO', `${combo.name} needs a choice for ${comp.name}.`, {
        missing: [{ group: comp.name, required: comp.required, options: comp.options.map((o) => ({ name: o.productName, extraCost: o.upcharge })) }],
      });
    for (const s of sel) {
      const opt = comp.options.find((o) => o.productId === s.productId);
      if (!opt) throw new CommandRejected('NOT_SUPPORTED', `That choice is not available for ${comp.name}.`);
      const product = getProduct(catalog, opt.productId);
      requireOrderable(product);
      const presets: ModDraft[] = [];
      for (const pr of opt.presets) {
        const group = product.groups.find((g) => g.id === pr.groupId);
        if (group?.modifiers.some((m) => m.id === pr.modifierId)) presets.push(modDraft(group, pr.modifierId, 'EXPLICIT'));
      }
      for (const id of s.modifierIds ?? []) {
        const found = findModifier(product, id);
        const fixed = found && presets.find((d) => d.modifierGroupId === found.group.id);
        if (fixed) throw new CommandRejected('NOT_SUPPORTED', `In the ${combo.name} the ${product.name} comes as ${fixed.name}; it can't be changed.`);
      }
      const { drafts, missing } = buildSelections(product, s.modifierIds ?? [], [], presets);
      if (missing.length)
        throw new CommandRejected('NEEDS_INFO', `The ${product.name} in the ${combo.name} needs a choice for: ${missing.map((g) => g.name).join(', ')}.`, {
          component: comp.name,
          missing: missing.map(describeGroup),
        });
      const fixedIds = new Set(presets.map((d) => d.modifierId));
      const mods = drafts.map((d) => ({
        id: d.modifierId ?? undefined,
        name: d.name,
        kind: d.kind,
        price: fixedIds.has(d.modifierId) ? 0 : d.price * d.quantity,
        preset: fixedIds.has(d.modifierId),
      }));
      extras += mods.reduce((sum, m) => sum + m.price, 0);
      picked.push({ component: comp.name, productId: opt.productId, productName: opt.productName, upcharge: opt.upcharge, modifiers: mods });
    }
  }
  return { picked, unit: combo.basePrice + picked.reduce((sum, p) => sum + p.upcharge, 0) + extras };
}

/** Final validation before review/submit (§60): every line present, orderable, required groups satisfied. */
function validateWholeOrder(order: OrderRow, catalog: Catalog) {
  const lines = activeItems(order);
  if (lines.length === 0) throw new CommandRejected('EMPTY_ORDER', 'The order is empty.');
  for (const l of lines) {
    if (l.comboId) {
      const c = catalog.combos.find((x) => x.id === l.comboId);
      if (!c) throw new CommandRejected('NOT_ORDERABLE', `${l.productNameSnapshot} is no longer on the menu.`, { line: lineRef(l.lineNo) });
      requireOrderable(c);
      continue;
    }
    const p = catalog.products.find((x) => x.id === l.productId);
    if (!p) throw new CommandRejected('NOT_ORDERABLE', `${l.productNameSnapshot} is no longer on the menu.`, { line: lineRef(l.lineNo) });
    requireOrderable(p);
    const missing = missingGroups(p, l.modifiers.map(toDraft));
    if (missing.length)
      throw new CommandRejected('NEEDS_INFO', `${p.name} (${lineRef(l.lineNo)}) still needs: ${missing.map((g) => g.name).join(', ')}.`, {
        missing: missing.map(describeGroup),
      });
    for (const m of l.modifiers) {
      if (m.kind !== 'ADD') continue;
      const f = m.modifierId ? findModifier(p, m.modifierId) : null;
      if (!f || !f.modifier.available)
        throw new CommandRejected('MODIFIER_UNAVAILABLE', `${m.modifierNameSnapshot} on ${p.name} is no longer available.`, { line: lineRef(l.lineNo) });
    }
  }
}
