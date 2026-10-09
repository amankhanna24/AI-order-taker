export type Orderable = { ok: true } | { ok: false; reason: string };

/** HH:mm in the given IANA timezone. */
export function localHHmm(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

/** Inclusive start, exclusive end; windows may cross midnight. Null bounds mean always. */
export function withinWindow(hhmm: string, from: string | null, until: string | null): boolean {
  if (!from || !until) return true;
  if (from <= until) return hhmm >= from && hhmm < until;
  return hhmm >= from || hhmm < until;
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
