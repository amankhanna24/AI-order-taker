import { mulDivRound } from './money';

export interface PricingLineInput {
  quantity: number;
  unitBasePrice: number;
  taxCategory: string;
  modifiers: { price: number; quantity: number }[];
}

export interface PricedLine {
  modifierTotal: number;
  unitTotal: number;
  lineTotal: number;
}

export interface DiscountRule {
  id: string;
  name: string;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  value: number; // bps for PERCENTAGE, paise for FIXED_AMOUNT
  minimumSubtotal: number;
}

export interface FeeRule {
  name: string;
  amount: number;
}

export interface OrderPricing {
  subtotal: number;
  discount: number;
  discountBreakdown: { id: string; name: string; applied: number }[];
  taxableAmount: number;
  tax: number;
  taxBreakdown: { category: string; rateBps: number; taxable: number; tax: number }[];
  fees: number;
  feeBreakdown: FeeRule[];
  total: number;
}

export function priceLine(l: PricingLineInput): PricedLine {
  const modifierTotal = l.modifiers.reduce((s, m) => s + m.price * m.quantity, 0);
  const unitTotal = l.unitBasePrice + modifierTotal;
  return { modifierTotal, unitTotal, lineTotal: unitTotal * l.quantity };
}

/**
 * Order-level pricing: items → subtotal → discounts → taxable → tax (per category, tax-exclusive,
 * half-up per category) → fees → total. The LLM never participates in this calculation.
 */
export function priceOrder(
  lines: PricingLineInput[],
  taxRatesBps: Record<string, number>,
  discounts: DiscountRule[] = [],
  fees: FeeRule[] = [],
): OrderPricing {
  const byCategory = new Map<string, number>();
  let subtotal = 0;
  for (const l of lines) {
    const lt = priceLine(l).lineTotal;
    subtotal += lt;
    byCategory.set(l.taxCategory, (byCategory.get(l.taxCategory) ?? 0) + lt);
  }

  let discount = 0;
  const discountBreakdown: OrderPricing['discountBreakdown'] = [];
  for (const d of discounts) {
    if (subtotal < d.minimumSubtotal) continue;
    const raw = d.type === 'PERCENTAGE' ? mulDivRound(subtotal, d.value, 10000) : d.value;
    const applied = Math.min(raw, subtotal - discount);
    if (applied <= 0) continue;
    discount += applied;
    discountBreakdown.push({ id: d.id, name: d.name, applied });
  }

  // Allocate the discount across tax categories proportionally (remainder to the last category).
  const entries = [...byCategory.entries()];
  let allocatedSoFar = 0;
  let tax = 0;
  const taxBreakdown: OrderPricing['taxBreakdown'] = [];
  entries.forEach(([category, catSubtotal], i) => {
    const share =
      i === entries.length - 1 ? discount - allocatedSoFar : subtotal === 0 ? 0 : Math.floor((discount * catSubtotal) / subtotal);
    allocatedSoFar += share;
    const taxable = catSubtotal - share;
    const rateBps = taxRatesBps[category] ?? 0;
    const catTax = mulDivRound(taxable, rateBps, 10000);
    tax += catTax;
    taxBreakdown.push({ category, rateBps, taxable, tax: catTax });
  });

  const feeTotal = fees.reduce((s, f) => s + f.amount, 0);
  const taxableAmount = subtotal - discount;
  return {
    subtotal,
    discount,
    discountBreakdown,
    taxableAmount,
    tax,
    taxBreakdown,
    fees: feeTotal,
    feeBreakdown: fees,
    total: taxableAmount + tax + feeTotal,
  };
}
