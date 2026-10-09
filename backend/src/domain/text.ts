/** Symmetric normalisation used for menu names, aliases and customer phrases. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (/(?:sh|ch|x|z|ss)es$/.test(token)) return token.slice(0, -2); // smashes -> smash, sandwiches -> sandwich
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokens(input: string): string[] {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(stem);
}

export function normalize(input: string): string {
  return tokens(input).join(' ');
}

export interface Named {
  id: string;
  name: string;
  aliases?: string[];
}

/** Levenshtein distance with early exit; used only for single-token typo tolerance. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}

export type MatchResult<T> =
  | { kind: 'NONE' }
  | { kind: 'ONE'; match: T }
  | { kind: 'MANY'; matches: T[] };

/**
 * Resolve a customer phrase against named entities.
 * Tier 1: exact name/alias. Tier 2: every query token appears in name/alias tokens.
 * More than one hit in the winning tier is AMBIGUOUS — callers must clarify, never pick.
 */
export function resolveNamed<T extends Named>(query: string, items: T[], opts: { fuzzy?: boolean } = {}): MatchResult<T> {
  const q = normalize(query);
  if (!q) return { kind: 'NONE' };
  const labels = (i: T) => [i.name, ...(i.aliases ?? [])].map(normalize);

  const exact = items.filter((i) => labels(i).includes(q));
  if (exact.length === 1) return { kind: 'ONE', match: exact[0] };
  if (exact.length > 1) return { kind: 'MANY', matches: exact };

  const qt = tokens(query);
  const subset = items.filter((i) =>
    [i.name, ...(i.aliases ?? [])].some((label) => {
      const lt = new Set(tokens(label));
      return qt.every((t) => lt.has(t));
    }),
  );
  if (subset.length === 1) return { kind: 'ONE', match: subset[0] };
  if (subset.length > 1) return { kind: 'MANY', matches: subset };

  // Tier 3: typo tolerance (1 edit for tokens of 5+ letters) — e.g. "mozarella", "jalapeno". Short words are
  // too easily another word ("coke" is one edit from "cole"), so they must match exactly.
  if (opts.fuzzy === false) return { kind: 'NONE' };
  const near = items.filter((i) =>
    [i.name, ...(i.aliases ?? [])].some((label) => {
      const lt = tokens(label);
      return qt.every((t) => lt.includes(t) || (t.length >= 5 && lt.some((l) => within(t, l, t.length >= 8 ? 2 : 1))));
    }),
  );
  if (near.length === 1) return { kind: 'ONE', match: near[0] };
  if (near.length > 1) return { kind: 'MANY', matches: near };
  return { kind: 'NONE' };
}
