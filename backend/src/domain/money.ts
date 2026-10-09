/** Money is integer paise everywhere. These helpers keep arithmetic deterministic. */

/** a * b / d rounded half-up for non-negative integers. */
export function mulDivRound(a: number, b: number, d: number): number {
  return Math.floor((a * b + Math.floor(d / 2)) / d);
}

export function formatMoney(paise: number, currency = 'INR'): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${sign}${symbol}${whole}${frac ? '.' + String(frac).padStart(2, '0') : ''}`;
}

export function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer (paise)`);
}
