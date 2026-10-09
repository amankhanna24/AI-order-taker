import { formatMoney } from '../domain/money';

export const lineRef = (n: number) => `line_${String(n).padStart(3, '0')}`;
export function parseLineRef(ref: string): number | null {
  const m = /^line_(\d{1,6})$/.exec(ref.trim().toLowerCase());
  return m ? Number(m[1]) : null;
}

export interface OrderModifierView {
  kind: 'ADD' | 'REMOVAL';
  modifierId: string | null;
  modifierGroupId: string | null;
  name: string;
  price: number;
  quantity: number;
  source: 'EXPLICIT' | 'DEFAULT';
}
/** One product inside a combo line, with the variants fixed by the combo (preset) and the customer's own choices. */
export interface ComboPick {
  component: string;
  productId?: string;
  productName: string;
  upcharge: number;
  modifiers?: { id?: string; name: string; kind?: 'ADD' | 'REMOVAL'; price: number; preset: boolean }[];
}
export interface OrderLineView {
  lineRef: string;
  productId: string | null;
  comboId: string | null;
  name: string;
  quantity: number;
  unitBasePrice: number;
  modifierTotal: number;
  unitTotal: number;
  lineTotal: number;
  modifiers: OrderModifierView[];
  comboSelections: ComboPick[] | null;
}

/** "Soft Drink (Medium, Coke)" */
export function describePick(p: ComboPick): string {
  const mods = (p.modifiers ?? []).map((m) => m.name);
  return mods.length ? `${p.productName} (${mods.join(', ')})` : p.productName;
}
export interface OrderView {
  id: string;
  status: string;
  orderType: string;
  version: number;
  currency: string;
  customerName: string | null;
  createdAt: string;
  customerPhone: string | null;
  pickupAt: string | null;
  notes: string | null;
  lines: OrderLineView[];
  subtotal: number;
  discount: number;
  taxableAmount: number;
  tax: number;
  taxBreakdown: unknown;
  discountBreakdown: unknown;
  fees: number;
  total: number;
  display: { subtotal: string; discount: string; tax: string; fees: string; total: string };
  confirmedAt: string | null;
  submittedAt: string | null;
  updatedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toOrderView(o: any): OrderView {
  const lines: OrderLineView[] = o.items
    .filter((i: any) => i.status === 'ACTIVE')
    .sort((a: any, b: any) => a.position - b.position)
    .map((i: any) => ({
      lineRef: lineRef(i.lineNo),
      productId: i.productId,
      comboId: i.comboId,
      name: i.productNameSnapshot,
      quantity: i.quantity,
      unitBasePrice: i.unitBasePrice,
      modifierTotal: i.modifierTotal,
      unitTotal: i.unitTotal,
      lineTotal: i.lineTotal,
      comboSelections: i.comboSelections ?? null,
      modifiers: i.modifiers.map((m: any) => ({
        kind: m.kind,
        modifierId: m.modifierId,
        modifierGroupId: m.modifierGroupId,
        name: m.modifierNameSnapshot,
        price: m.modifierPrice,
        quantity: m.quantity,
        source: m.source,
      })),
    }));
  const c = o.currency;
  return {
    id: o.id,
    status: o.status,
    orderType: o.orderType,
    version: o.version,
    currency: c,
    customerName: o.customerName,
    createdAt: new Date(o.createdAt).toISOString(),
    customerPhone: o.customerPhone,
    pickupAt: o.pickupAt ? new Date(o.pickupAt).toISOString() : null,
    notes: o.notes,
    lines,
    subtotal: o.subtotal,
    discount: o.discount,
    taxableAmount: o.taxableAmount,
    tax: o.tax,
    taxBreakdown: o.taxBreakdown,
    discountBreakdown: o.discountBreakdown,
    fees: o.fees,
    total: o.total,
    display: {
      subtotal: formatMoney(o.subtotal, c),
      discount: formatMoney(o.discount, c),
      tax: formatMoney(o.tax, c),
      fees: formatMoney(o.fees, c),
      total: formatMoney(o.total, c),
    },
    confirmedAt: o.confirmedAt ? new Date(o.confirmedAt).toISOString() : null,
    submittedAt: o.submittedAt ? new Date(o.submittedAt).toISOString() : null,
    updatedAt: new Date(o.updatedAt).toISOString(),
  };
}

const modLabel = (m: OrderModifierView) => (m.kind === 'REMOVAL' ? `no ${m.name}` : m.name);

function lineExtras(l: OrderLineView): string[] {
  const combo = l.comboSelections?.map(describePick) ?? [];
  return [...combo, ...l.modifiers.map(modLabel)];
}

/** Internal state dump for the model/tools: keeps line refs so references can be resolved. Prices come from the engine only. */
export function summarize(v: OrderView): string {
  if (v.lines.length === 0) return 'Your order is empty.';
  const out = v.lines.map((l) => {
    const extras = lineExtras(l);
    return `${l.lineRef}: ${l.quantity} × ${l.name}${extras.length ? ` (${extras.join(', ')})` : ''} — ${formatMoney(l.lineTotal, v.currency)}`;
  });
  out.push(`Subtotal ${v.display.subtotal}`);
  if (v.discount) out.push(`Discount -${v.display.discount}`);
  if (v.tax) out.push(`Tax ${v.display.tax}`);
  if (v.fees) out.push(`Fees ${v.display.fees}`);
  out.push(`Total ${v.display.total}`);
  return out.join('\n');
}

const plural = (name: string, qty: number) => (qty === 1 || /s$/i.test(name) ? name : /(sh|ch|x)$/i.test(name) ? `${name}es` : `${name}s`);
const sayList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Natural-sounding read-back for the customer (spoken or typed): no line refs, defaults included so a
 * wrong size is audible, and a single closing total. The question "Is that correct?" is added by the caller.
 */
export function readBack(v: OrderView): string {
  if (v.lines.length === 0) return 'Your order is empty.';
  const parts = v.lines.map((l) => {
    const head = `${l.quantity} ${plural(l.name, l.quantity)}`;
    if (l.comboSelections?.length) return `${head}: ${lineExtras(l).join(', ')}`;
    // what the customer chose reads as "with ...", what we assumed reads as "(Regular)" so a wrong default is easy to catch
    const chosen = l.modifiers.filter((m) => m.source !== 'DEFAULT').map(modLabel);
    const assumed = l.modifiers.filter((m) => m.source === 'DEFAULT').map(modLabel);
    return `${head}${chosen.length ? ` with ${sayList(chosen)}` : ''}${assumed.length ? ` (${assumed.join(', ')})` : ''}`;
  });
  const money = [`Subtotal ${v.display.subtotal}`];
  if (v.discount) money.push(`discount minus ${v.display.discount}`);
  if (v.tax) money.push(`tax ${v.display.tax}`);
  if (v.fees) money.push(`fees ${v.display.fees}`);
  const breakdown = money.length > 1 ? ` (${money.join(', ')})` : '';
  return `Here is your order: ${parts.join('; ')}. Your total is ${v.display.total}${breakdown}.`;
}
