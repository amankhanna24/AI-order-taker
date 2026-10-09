export function money(paise: number, currency = 'INR'): string {
  const whole = Math.floor(Math.abs(paise) / 100);
  const frac = Math.abs(paise) % 100;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${paise < 0 ? '-' : ''}${symbol}${whole}${frac ? '.' + String(frac).padStart(2, '0') : ''}`;
}

/** Parse a rupee amount typed by a person ("120", "120.5", "120.50") into paise; null if invalid. */
export function parseRupees(input: string): number | null {
  const m = /^\d{1,6}(\.\d{1,2})?$/.exec(input.trim());
  if (!m) return null;
  const [whole, frac = ''] = input.trim().split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return paise <= 10_000_000 ? paise : null; // keep in step with the server's cap
}

export function rupeesInput(paise: number): string {
  return (paise / 100).toFixed(2).replace(/\.00$/, '');
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
