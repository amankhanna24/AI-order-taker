/** Money is integer minor units (fils for AED) everywhere. These helpers keep arithmetic deterministic. */

/** a * b / d rounded half-up for non-negative integers. */
export function mulDivRound(a: number, b: number, d: number): number {
  return Math.floor((a * b + Math.floor(d / 2)) / d);
}

export function formatMoney(minor: number, currency = 'AED'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${sign}${symbol}${whole}${frac ? '.' + String(frac).padStart(2, '0') : ''}`;
}

export function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer (minor units)`);
}
