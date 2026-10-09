import { tokens } from './text';

/** Customer wording → canonical allergen enum (spec review item 9). */
const ALLERGEN_SYNONYMS: Record<string, string> = {
  dairy: 'MILK', milk: 'MILK', lactose: 'MILK', cheese: 'MILK', paneer: 'MILK',
  egg: 'EGG', eggs: 'EGG',
  peanut: 'PEANUTS', peanuts: 'PEANUTS',
  nut: 'TREE_NUTS', nuts: 'TREE_NUTS', 'tree nut': 'TREE_NUTS', 'tree nuts': 'TREE_NUTS', cashew: 'TREE_NUTS', almond: 'TREE_NUTS',
  soy: 'SOY', soya: 'SOY',
  gluten: 'GLUTEN', wheat: 'GLUTEN',
  sesame: 'SESAME', til: 'SESAME',
  mustard: 'MUSTARD',
};

export function canonicalAllergen(input: string): string | null {
  const key = input.toLowerCase().trim().replace(/[^a-z\s]/g, '');
  if (ALLERGEN_SYNONYMS[key]) return ALLERGEN_SYNONYMS[key];
  const up = key.toUpperCase().replace(/\s+/g, '_');
  return ['MILK', 'EGG', 'PEANUTS', 'TREE_NUTS', 'SOY', 'GLUTEN', 'SESAME', 'MUSTARD'].includes(up) ? up : null;
}

const AFFIRM = [
  'yes', 'yeah', 'yep', 'yup', 'yea', 'correct', 'confirm', 'confirmed', 'right', 'ok', 'okay', 'sure',
  'go ahead', 'thats right', 'that is right', 'thats correct', 'that is correct', 'sounds good', 'looks good', 'place it', 'place the order', 'perfect',
];
const EDIT_MARKERS = ['no', 'nope', 'not', 'wait', 'actually', 'change', 'remove', 'add', 'instead', 'but', 'dont', 'cancel', 'hold', 'make', 'replace', 'more', 'also', 'without', 'extra', 'less'];

function plain(text: string): string {
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Server-side gate for order submission (§59): the LLM's opinion is not enough. */
export function isAffirmative(text: string): boolean {
  const t = plain(text);
  if (!t || t.split(' ').length > 12) return false;
  const words = t.split(' ');
  if (words.some((w) => EDIT_MARKERS.includes(w))) return false;
  const padded = ` ${t} `;
  return AFFIRM.some((a) => padded.includes(` ${a} `));
}

export function asksForHuman(text: string): boolean {
  const t = plain(text);
  return /\b(human|real person|manager|someone|staff|agent|representative|operator)\b/.test(t) && /\b(talk|speak|connect|transfer|want|need|get|put|call)\b/.test(t);
}

export function isFrustrated(text: string): boolean {
  return /\b(useless|stupid|terrible|ridiculous|worst|waste of time|fed up|not working|this is annoying|hate this)\b/.test(plain(text));
}

export function isPaymentOrComplaint(text: string): boolean {
  return /\b(refund|complaint|complain|payment|charged|overcharged|poisoning|sick)\b/.test(plain(text));
}

export function numberWord(w: string): number | null {
  const map: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  if (/^\d{1,3}$/.test(w)) return Number(w);
  return map[w.toLowerCase()] ?? null;
}

export const firstToken = (s: string) => tokens(s)[0];
