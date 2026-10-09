import { resolveNamed, tokens } from './text';

export interface VariantProduct {
  id: string;
  name: string;
  aliases: string[];
  /** `required` is true for options from a group the customer must choose from (a flavour), not optional extras. */
  modifiers: { id: string; groupId: string; labels: string[]; required: boolean }[];
}

export interface VariantMatch {
  productId: string;
  modifierIds: string[];
}

const FILLER = new Set(['a', 'an', 'the', 'some', 'of', 'with', 'one']);

/** Position of `needle` as a contiguous run inside `hay`, or -1. */
function indexOfRun(hay: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((t, j) => hay[i + j] === t)) return i;
  return -1;
}

const key = (label: string) => tokens(label).join(' ');

/**
 * Resolve phrases like "a coke", "large fries" or "peach iced tea" where part of the phrase is an
 * option of the product ("coke" is a Soft Drink flavour) rather than part of its name.
 *
 * Returns a match only when exactly one product explains the whole phrase; anything else is
 * ambiguous and the caller must clarify instead of guessing.
 */
export function parseVariantPhrase(text: string, products: VariantProduct[]): VariantMatch | null {
  const words = tokens(text);
  if (words.length === 0) return null;
  const hits: (VariantMatch & { viaName: boolean; labels: string[] })[] = [];

  for (const p of products) {
    // Longest option labels first so "extra cheese" wins over "cheese".
    const candidates = p.modifiers
      .flatMap((m) => m.labels.map((label) => ({ id: m.id, groupId: m.groupId, required: m.required, label: tokens(label) })))
      .filter((c) => c.label.length > 0)
      .sort((a, b) => b.label.length - a.label.length);

    let rest = [...words];
    const taken: { id: string; groupId: string; label: string; required: boolean }[] = [];
    for (const c of candidates) {
      if (taken.some((t) => t.groupId === c.groupId)) continue; // one pick per group
      const at = indexOfRun(rest, c.label);
      if (at < 0) continue;
      rest = [...rest.slice(0, at), ...rest.slice(at + c.label.length)];
      taken.push({ id: c.id, groupId: c.groupId, label: c.label.join(' '), required: c.required });
    }
    if (taken.length === 0) continue;

    const remainder = rest.filter((w) => !FILLER.has(w));
    if (remainder.length > 0 && resolveNamed(remainder.join(' '), [{ id: p.id, name: p.name, aliases: p.aliases }]).kind !== 'ONE') continue;
    hits.push({ productId: p.id, modifierIds: taken.map((t) => t.id), viaName: remainder.length > 0, labels: taken.filter((t) => t.required).map((t) => t.label) });
  }

  if (hits.length !== 1) return null;
  const hit = hits[0];
  if (!hit.viaName) {
    // The product was not named, so a required choice has to identify it on its own: "coke" does; "large" or "extra cheese" do not.
    const others = products.filter((p) => p.id !== hit.productId);
    const distinctive = hit.labels.some((label) => !others.some((o) => o.modifiers.some((m) => m.labels.some((l) => key(l) === label))));
    if (!distinctive) return null;
  }
  return { productId: hit.productId, modifierIds: hit.modifierIds };
}
