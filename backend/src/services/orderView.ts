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
  comboSelections: { component: string; productName: string; upcharge: number }[] | null;
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

/** Plain-text summary used for spoken/chat read-back (§58). Prices come from the engine only. */
export function summarize(v: OrderView): string {
  if (v.lines.length === 0) return 'Your order is empty.';
  const out = v.lines.map((l) => {
    const mods = l.modifiers
      .filter((m) => !(m.source === 'DEFAULT' && m.price === 0))
      .map((m) => (m.kind === 'REMOVAL' ? `no ${m.name}` : m.name));
    const combo = l.comboSelections?.map((s) => s.productName).join(', ');
    const extras = [...(combo ? [combo] : []), ...mods];
    return `${l.lineRef}: ${l.quantity} × ${l.name}${extras.length ? ` (${extras.join(', ')})` : ''} — ${formatMoney(l.lineTotal, v.currency)}`;
  });
  out.push(`Subtotal ${v.display.subtotal}`);
  if (v.discount) out.push(`Discount -${v.display.discount}`);
  out.push(`Tax ${v.display.tax}`);
  if (v.fees) out.push(`Fees ${v.display.fees}`);
  out.push(`Total ${v.display.total}`);
  return out.join('\n');
}
