import { CommandRejected } from '../utils/errors';
import type { GroupView, ProductView } from './catalog';
import { normalize } from '../domain/text';

export interface ModDraft {
  kind: 'ADD' | 'REMOVAL';
  modifierId: string | null;
  modifierGroupId: string | null;
  ingredientName: string | null;
  name: string;
  price: number;
  quantity: number;
  source: 'EXPLICIT' | 'DEFAULT';
}

export const MAX_LINE_QTY = 50;
export const MAX_ORDER_UNITS = 100;

export function describeGroup(g: GroupView) {
  return {
    group: g.name,
    required: g.required,
    choose: g.maximumSelections === 1 ? 'one' : `${g.minimumSelections}-${g.maximumSelections}`,
    options: g.modifiers.filter((m) => m.available).map((m) => ({ name: m.name, extraCost: m.priceDelta })),
  };
}

export function findModifier(product: ProductView, modifierId: string) {
  for (const g of product.groups) {
    const m = g.modifiers.find((x) => x.id === modifierId);
    if (m) return { group: g, modifier: m };
  }
  return null;
}

export function findIngredient(product: ProductView, name: string) {
  const n = normalize(name);
  return product.ingredients.find((i) => normalize(i.name) === n) ?? null;
}

export function modDraft(group: GroupView, modifierId: string, source: 'EXPLICIT' | 'DEFAULT'): ModDraft {
  const m = group.modifiers.find((x) => x.id === modifierId)!;
  return { kind: 'ADD', modifierId: m.id, modifierGroupId: group.id, ingredientName: null, name: m.name, price: m.priceDelta, quantity: 1, source };
}

/** Throws if adding `modifierId` to a line that currently has `existing` is not allowed (§18). */
export function checkCanAdd(product: ProductView, existing: ModDraft[], modifierId: string): { replaceDefault: ModDraft | null; group: GroupView } {
  const found = findModifier(product, modifierId);
  if (!found) throw new CommandRejected('NOT_SUPPORTED', `That option is not available for ${product.name}.`);
  const { group, modifier } = found;
  if (!modifier.available) throw new CommandRejected('MODIFIER_UNAVAILABLE', `${modifier.name} is currently unavailable.`);
  const inGroup = existing.filter((m) => m.kind === 'ADD' && m.modifierGroupId === group.id);
  if (inGroup.some((m) => m.modifierId === modifierId)) throw new CommandRejected('ALREADY_PRESENT', `${modifier.name} is already on this item.`);
  if (group.selectionType === 'SINGLE' || group.maximumSelections === 1) {
    const explicit = inGroup.find((m) => m.source === 'EXPLICIT');
    if (explicit)
      throw new CommandRejected('GROUP_FULL', `${group.name} already has "${explicit.name}". Use replace to change it to ${modifier.name}.`, { currentSelection: explicit.name });
    return { replaceDefault: inGroup.find((m) => m.source === 'DEFAULT') ?? null, group };
  }
  const nonDefault = inGroup.length;
  if (nonDefault >= group.maximumSelections) throw new CommandRejected('GROUP_FULL', `At most ${group.maximumSelections} ${group.name} option(s) allowed.`);
  return { replaceDefault: null, group };
}

/** Build the full modifier set for a new/changed item: explicit picks + defaults, enforcing required groups. */
export function buildSelections(product: ProductView, modifierIds: string[], removeIngredients: string[], carry: ModDraft[] = []) {
  const drafts: ModDraft[] = [...carry];
  for (const id of modifierIds) {
    const { replaceDefault, group } = checkCanAdd(product, drafts, id);
    if (replaceDefault) drafts.splice(drafts.indexOf(replaceDefault), 1);
    drafts.push(modDraft(group, id, 'EXPLICIT'));
  }
  for (const raw of removeIngredients) {
    const ing = findIngredient(product, raw);
    if (!ing) throw new CommandRejected('UNKNOWN_INGREDIENT', `${product.name} doesn't list "${raw}" as an ingredient.`);
    if (!ing.removable) throw new CommandRejected('NOT_REMOVABLE', `${ing.name} can't be removed from ${product.name}.`);
    if (!drafts.some((d) => d.kind === 'REMOVAL' && d.ingredientName === ing.name))
      drafts.push({ kind: 'REMOVAL', modifierId: null, modifierGroupId: null, ingredientName: ing.name, name: ing.name, price: 0, quantity: 1, source: 'EXPLICIT' });
  }
  fillDefaults(product, drafts);
  const missing = missingGroups(product, drafts);
  return { drafts, missing };
}

export function fillDefaults(product: ProductView, drafts: ModDraft[]) {
  for (const g of product.groups) {
    if (drafts.some((d) => d.kind === 'ADD' && d.modifierGroupId === g.id)) continue;
    const def = g.defaultModifierId && g.modifiers.find((m) => m.id === g.defaultModifierId && m.available);
    if (def) drafts.push(modDraft(g, def.id, 'DEFAULT'));
  }
}

export function missingGroups(product: ProductView, drafts: ModDraft[]): GroupView[] {
  return product.groups.filter((g) => g.minimumSelections > 0 && drafts.filter((d) => d.kind === 'ADD' && d.modifierGroupId === g.id).length < g.minimumSelections);
}
