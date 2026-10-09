export function money(minor: number, currency = 'AED'): string {
  const whole = Math.floor(Math.abs(minor) / 100);
  const frac = Math.abs(minor) % 100;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${minor < 0 ? '-' : ''}${symbol}${whole}${frac ? '.' + String(frac).padStart(2, '0') : ''}`;
}

/** Parse an amount typed by a person ("12", "12.5", "12.50") into minor units (fils); null if invalid. */
export function parseAmount(input: string): number | null {
  const m = /^\d{1,6}(\.\d{1,2})?$/.exec(input.trim());
  if (!m) return null;
  const [whole, frac = ''] = input.trim().split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return minor <= 10_000_000 ? minor : null; // keep in step with the server's cap
}

export function amountInput(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, '');
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Empty',
  IN_PROGRESS: 'In progress',
  READY_FOR_CONFIRMATION: 'Ready to confirm',
  CONFIRMED: 'Confirmed',
  SUBMITTED: 'Sent to kitchen',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

export function safeStorage() {
  return {
    get(key: string): string | null {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    remove(key: string) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
