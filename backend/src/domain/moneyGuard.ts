/** The few order fields the guard needs (kept structural so it stays a pure, easily tested function). */
export interface GuardedOrder {
  display: { total: string; subtotal: string };
  lines: { lineTotal: number; unitTotal: number }[];
}

const AMOUNT = /AED\s?(\d+(?:\.\d{1,2})?)/g;
/** A sentence mentioning "total"; a '.' between digits (28.50) is a decimal point, not the end of the sentence. */
const SENTENCE_WITH_TOTAL = /(?:[^.!?]|\.(?=\d))*\btotal\b(?:[^.!?]|\.(?=\d))*[.!?]?/gi;
const norm = (n: string | number) => Number(n).toString();

/**
 * The language model is never the source of truth for money. In any sentence about the "total", an amount that the
 * server did not produce this turn (the order's own figures, or something a tool returned) is replaced with the real
 * order total. `outputs` is everything the tools told the model this turn.
 */
export function guardMoney(reply: string, order: GuardedOrder, outputs: string[], onReplace?: (quoted: string, real: string) => void): string {
  const known = new Set<string>();
  const collect = (text: string) => {
    for (const m of text.matchAll(AMOUNT)) known.add(norm(m[1]));
  };
  collect(`${order.display.total} ${order.display.subtotal} ${outputs.join(' ')}`);
  for (const l of order.lines) {
    known.add(norm(l.lineTotal / 100));
    known.add(norm(l.unitTotal / 100));
  }
  return reply.replace(SENTENCE_WITH_TOTAL, (sentence) =>
    sentence.replace(AMOUNT, (m, n: string) => {
      if (known.has(norm(n))) return m;
      onReplace?.(m, order.display.total);
      return order.display.total;
    }),
  );
}
