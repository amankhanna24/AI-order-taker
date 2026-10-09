import { z } from 'zod';
import { formatMoney } from '../domain/money';
import { canonicalAllergen, isAffirmative } from '../domain/language';
import { normalize, resolveNamed, tokens } from '../domain/text';
import { CommandRejected } from '../utils/errors';
import type { Catalog, ComboView, ProductView } from './catalog';
import { runCommands, getOrderView, type Command } from './orderEngine';
import { describeGroup } from './selections';
import { lineRef, parseLineRef, summarize, type OrderLineView, type OrderView } from './orderView';

export interface ConvContext {
  lastProduct?: string;
  lastOrderItem?: string;
  lastCategory?: string;
  lastAction?: string;
  currentReference?: string[];
  reviewedVersion?: number | null;
  misunderstandings: number;
}

export type StateHint = 'TAKING_ORDER' | 'CLARIFYING' | 'ANSWERING_QUESTION' | 'REVIEWING_ORDER' | 'COMPLETED' | 'ESCALATED' | 'CANCELLED';

const str = (max = 120) => z.string().trim().min(1).max(max);
const units = z.number().int().min(1).max(50).optional();
const schemas = {
  search_menu: z.object({ query: str().optional(), category: str().optional(), dietary: z.enum(['vegetarian', 'vegan', 'gluten_free']).optional() }),
  get_item_info: z.object({ item: str(), allergen: str(40).optional() }),
  add_item: z.object({
    item: str(),
    quantity: z.number().int().min(1).max(50).default(1),
    modifiers: z.array(str(60)).max(10).optional(),
    remove_ingredients: z.array(str(60)).max(10).optional(),
  }),
  add_combo: z.object({ combo: str(), quantity: z.number().int().min(1).max(50).default(1), choices: z.array(z.object({ component: str(40), item: str() })).max(10).default([]) }),
  change_quantity: z.object({ target: str(60), quantity: z.number().int().min(1).max(50), filter: str(60).optional() }),
  remove_item: z.object({ target: str(60), filter: str(60).optional() }),
  add_modifier: z.object({ target: str(60), modifier: str(60), units, filter: str(60).optional() }),
  remove_modifier: z.object({ target: str(60), modifier: str(60), units, filter: str(60).optional() }),
  remove_ingredient: z.object({ target: str(60), ingredient: str(60), units, filter: str(60).optional() }),
  replace_modifier: z.object({ target: str(60), from: str(60), to: str(60), units, filter: str(60).optional() }),
  replace_item: z.object({ target: str(60), item: str() }),
  set_customer_details: z.object({
    name: str(80),
    phone: str(30),
    pickup_in_minutes: z.number().int().min(5).max(1440).optional(),
    notes: z.string().trim().max(200).optional(),
  }),
  get_order_summary: z.object({}),
  request_confirmation: z.object({}),
  confirm_order: z.object({}),
  cancel_order: z.object({}),
  escalate_to_human: z.object({ reason: str(200) }),
} as const;
export type ToolName = keyof typeof schemas;
export const TOOL_NAMES = Object.keys(schemas) as ToolName[];

export interface ToolResult {
  status: 'OK' | 'AMBIGUOUS' | 'NEEDS_INFO' | 'NOT_FOUND' | 'REJECTED' | 'REFUSED' | 'INFO' | 'ESCALATED';
  [k: string]: unknown;
}

const WORD_ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 };
const ALL_WORDS = new Set(['all', 'both', 'those', 'these', 'everything', 'them', 'all of them', 'each']);
const CURRENT_WORDS = new Set(['this', 'that', 'it', 'current', 'that one', 'this one', 'the last one added']);

export class ToolRuntime {
  stateHint: StateHint = 'TAKING_ORDER';
  escalation: string | null = null;
  mutated = false;

  constructor(
    private readonly orderId: string,
    public order: OrderView,
    private readonly catalog: Catalog,
    public ctx: ConvContext,
    private readonly lastCustomerText: string,
  ) {}

  /** Execute a tool by name with untrusted arguments. Never throws for domain problems. */
  async exec(name: string, rawArgs: unknown): Promise<ToolResult> {
    if (!(name in schemas)) return { status: 'REJECTED', code: 'UNKNOWN_TOOL', message: `Unknown tool ${name}.` };
    const parsed = schemas[name as ToolName].safeParse(rawArgs ?? {});
    if (!parsed.success)
      return { status: 'REJECTED', code: 'BAD_ARGUMENTS', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ') };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (this as any)[`tool_${name}`](parsed.data);
    } catch (e) {
      if (e instanceof CommandRejected) {
        this.stateHint = e.code === 'NEEDS_INFO' ? 'CLARIFYING' : this.stateHint;
        return { status: e.code === 'NEEDS_INFO' ? 'NEEDS_INFO' : 'REJECTED', code: e.code, message: e.message, ...(e.details ?? {}) };
      }
      throw e;
    }
  }

  /** True if the phrase refers to at least one menu product or combo (used by the deterministic parser). */
  knowsItem(text: string): boolean {
    return resolveNamed(text, this.catalog.products).kind !== 'NONE' || resolveNamed(text, this.catalog.combos).kind !== 'NONE';
  }

  /* ---------- resolution helpers ---------- */

  private productFor(line: OrderLineView): ProductView | undefined {
    return line.productId ? this.catalog.products.find((p) => p.id === line.productId) : undefined;
  }
  private matchesFilter(line: OrderLineView, filter: string): boolean {
    const ft = tokens(filter);
    const p = this.productFor(line);
    const hay = new Set([...tokens(line.name), ...(p ? tokens(p.category) : [])]);
    return ft.every((t) => hay.has(t));
  }

  private resolveTargets(target: string, filter?: string): { ok: true; lines: OrderLineView[] } | { ok: false; result: ToolResult } {
    const lines = this.order.lines;
    if (lines.length === 0) return { ok: false, result: { status: 'REJECTED', code: 'EMPTY_ORDER', message: 'There are no items in the order yet.' } };
    const t = normalize(target);
    const ref = parseLineRef(target);
    const describe = (ls: OrderLineView[]) => ls.map((l) => ({ lineRef: l.lineRef, item: l.name, quantity: l.quantity }));
    const ambiguous = (ls: OrderLineView[]): ToolResult => ({
      status: 'AMBIGUOUS',
      message: 'Several order items could match. Ask the customer which one they mean.',
      candidates: describe(ls),
    });
    const filtered = (ls: OrderLineView[]) => (filter ? ls.filter((l) => this.matchesFilter(l, filter)) : ls);

    if (ref !== null) {
      const l = lines.find((x) => x.lineRef === lineRef(ref));
      return l ? { ok: true, lines: [l] } : { ok: false, result: { status: 'REJECTED', code: 'UNKNOWN_LINE', message: `No item ${target} in the order.`, candidates: describe(lines) } };
    }
    if (ALL_WORDS.has(t)) {
      const ls = filtered(lines);
      return ls.length ? { ok: true, lines: ls } : { ok: false, result: { status: 'NOT_FOUND', message: 'No matching items in the order.' } };
    }
    if (CURRENT_WORDS.has(t)) {
      const cur = (this.ctx.currentReference ?? []).map((r) => lines.find((l) => l.lineRef === r)).filter(Boolean) as OrderLineView[];
      const ls = filtered(cur);
      if (ls.length) return { ok: true, lines: ls };
      if (lines.length === 1) return { ok: true, lines };
      return { ok: false, result: ambiguous(lines) };
    }
    const parts = t.split(' ');
    if (parts[0] in WORD_ORDINALS && parts.length <= 2) {
      const pool = filtered(lines);
      const l = pool[WORD_ORDINALS[parts[0]]];
      return l ? { ok: true, lines: [l] } : { ok: false, result: { status: 'REJECTED', code: 'UNKNOWN_LINE', message: `There is no ${target} item.`, candidates: describe(lines) } };
    }
    if (parts[0] === 'last' || t === 'last one') {
      const pool = filtered(lines);
      return pool.length ? { ok: true, lines: [pool[pool.length - 1]] } : { ok: false, result: { status: 'NOT_FOUND', message: 'No matching items.' } };
    }
    const kw = tokens(target);
    const hits = lines.filter((l) => {
      const p = this.productFor(l);
      const hay = new Set([...tokens(l.name), ...(p ? tokens(p.category) : [])]);
      return kw.every((k) => hay.has(k));
    });
    if (hits.length === 1) return { ok: true, lines: hits };
    if (hits.length > 1) return { ok: false, result: ambiguous(hits) };
    return { ok: false, result: { status: 'NOT_FOUND', message: `Nothing in the order matches "${target}".`, candidates: describe(lines) } };
  }

  /** Resolve a customer phrase to exactly one modifier of the given product. */
  private resolveModifier(product: ProductView, rawText: string) {
    // "extra cheese" / "some jalapenos" / "more mushrooms": drop filler so the option name itself is matched.
    // An exact name/alias hit on the raw phrase wins first: "extra cheese" is the "Extra Cheese" topping, not "cheese".
    const rawNorm = normalize(rawText);
    const rawExact = product.groups.flatMap((g) => g.modifiers.map((m) => ({ ...m, group: g }))).filter((m) => [m.name, ...m.aliases].map(normalize).includes(rawNorm));
    if (rawExact.length === 1) return { kind: 'ONE' as const, m: rawExact[0] };
    const stripped = rawText.replace(/^\s*(?:an? |some |more |additional |ext?ra |exta |extar |xtra )+/i, '').trim();
    const text = stripped || rawText;
    const all = product.groups.flatMap((g) => g.modifiers.map((m) => ({ ...m, group: g })));
    const q = normalize(text);
    const exact = all.filter((m) => [m.name, ...m.aliases].map(normalize).includes(q));
    if (exact.length === 1) return { kind: 'ONE' as const, m: exact[0] };
    if (exact.length > 1) return { kind: 'MANY' as const, options: exact };
    const g = product.groups.find((x) => normalize(x.name) === q || normalize(x.name).endsWith(` ${q}`)) ?? (q.length >= 5 ? product.groups.find((x) => tokens(x.name).some((t) => t.length >= 5 && t !== q && Math.abs(t.length - q.length) <= 1 && t.slice(0, 4) === q.slice(0, 4))) : undefined);
    if (g) {
      const opts = g.modifiers.filter((m) => m.available && !/^no\b/i.test(m.name)).map((m) => ({ ...m, group: g }));
      return opts.length === 1 ? { kind: 'ONE' as const, m: opts[0] } : { kind: 'MANY' as const, options: opts };
    }
    const r = resolveNamed(text, all);
    if (r.kind === 'ONE') return { kind: 'ONE' as const, m: r.match };
    if (r.kind === 'MANY') return { kind: 'MANY' as const, options: r.matches };
    return { kind: 'NONE' as const };
  }

  private modifierProblem(product: ProductView, text: string, res: ReturnType<ToolRuntime['resolveModifier']>): ToolResult | null {
    if (res.kind === 'MANY')
      return { status: 'AMBIGUOUS', message: `"${text}" could mean several options for ${product.name}. Ask which one.`, options: res.options.map((o) => ({ name: o.name, group: o.group.name, extraCost: formatMoney(o.priceDelta) })) };
    if (res.kind === 'NONE')
      return { status: 'NOT_FOUND', message: `${product.name} has no option "${text}".`, availableOptions: product.groups.map(describeGroup) };
    return null;
  }

  private async apply(cmds: Command[], action: string): Promise<ToolResult> {
    const outcomes = await runCommands(this.orderId, cmds, 'AGENT', this.catalog);
    const last = outcomes[outcomes.length - 1];
    this.order = last.order;
    const affected = [...new Set(outcomes.flatMap((o) => o.affectedLines))];
    if (outcomes.some((o) => o.changed)) this.mutated = true;
    this.ctx.lastAction = action;
    if (affected.length) {
      this.ctx.currentReference = affected;
      this.ctx.lastOrderItem = affected[affected.length - 1];
      const l = this.order.lines.find((x) => x.lineRef === this.ctx.lastOrderItem);
      if (l) {
        this.ctx.lastProduct = l.name;
        const p = this.productFor(l);
        if (p) this.ctx.lastCategory = p.category;
      }
    }
    this.ctx.reviewedVersion = null; // any change invalidates a previous read-back
    this.stateHint = 'TAKING_ORDER';
    return { status: 'OK', message: outcomes.map((o) => o.message).filter(Boolean).join(' '), order: this.compactOrder() };
  }

  compactOrder() {
    const o = this.order;
    return {
      status: o.status,
      lines: o.lines.map((l) => ({
        lineRef: l.lineRef,
        quantity: l.quantity,
        item: l.name,
        options: [
          ...(l.comboSelections?.map((s) => s.productName) ?? []),
          ...l.modifiers.map((m) => `${m.kind === 'REMOVAL' ? 'no ' : ''}${m.name}${m.source === 'DEFAULT' ? ' (default)' : ''}`),
        ],
        lineTotal: formatMoney(l.lineTotal, o.currency),
      })),
      subtotal: o.display.subtotal,
      tax: o.display.tax,
      total: o.display.total,
      pickupName: o.customerName,
    };
  }

  /* ---------- tools ---------- */

  private findProduct(text: string): { kind: 'product'; product: ProductView } | { kind: 'combo'; combo: ComboView } | { kind: 'fail'; result: ToolResult } {
    const pr = resolveNamed(text, this.catalog.products);
    const cr = resolveNamed(text, this.catalog.combos);
    // An exact name/alias hit on a product outranks partial matches elsewhere (e.g. "veg burger" vs "Veg Burger Combo").
    const q = normalize(text);
    const exactP = this.catalog.products.filter((x) => [x.name, ...x.aliases].map(normalize).includes(q));
    const exactC = this.catalog.combos.filter((x) => [x.name, ...x.aliases].map(normalize).includes(q));
    if (exactP.length === 1 && exactC.length === 0) return { kind: 'product', product: exactP[0] };
    if (exactC.length === 1 && exactP.length === 0) return { kind: 'combo', combo: exactC[0] };
    const total = (pr.kind === 'ONE' ? 1 : pr.kind === 'MANY' ? pr.matches.length : 0) + (cr.kind === 'ONE' ? 1 : cr.kind === 'MANY' ? cr.matches.length : 0);
    if (total === 0) return { kind: 'fail', result: { status: 'NOT_FOUND', message: `"${text}" is not on the menu.`, hint: 'Use search_menu to see what is available.' } };
    if (total > 1) {
      this.stateHint = 'CLARIFYING';
      const names = [...(pr.kind === 'MANY' ? pr.matches : pr.kind === 'ONE' ? [pr.match] : []), ...(cr.kind === 'MANY' ? cr.matches : cr.kind === 'ONE' ? [cr.match] : [])].map((x) => x.name);
      return { kind: 'fail', result: { status: 'AMBIGUOUS', message: `"${text}" matches several menu items. Ask the customer which one. Do not choose for them.`, candidates: names } };
    }
    return pr.kind === 'ONE' ? { kind: 'product', product: pr.match } : { kind: 'combo', combo: (cr as { match: ComboView }).match };
  }

  private async tool_search_menu(a: z.infer<typeof schemas.search_menu>): Promise<ToolResult> {
    this.stateHint = 'ANSWERING_QUESTION';
    let items = this.catalog.products;
    if (a.category) items = items.filter((p) => normalize(p.category).includes(normalize(a.category!)) || normalize(a.category!).includes(normalize(p.category)));
    if (a.dietary === 'vegan') items = items.filter((p) => p.vegan);
    if (a.dietary === 'gluten_free') items = items.filter((p) => p.glutenFree);
    if (a.dietary === 'vegetarian') items = items.filter((p) => p.vegetarian);
    if (a.query) {
      const r = resolveNamed(a.query, items);
      items = r.kind === 'ONE' ? [r.match] : r.kind === 'MANY' ? r.matches : [];
    }
    const combos = a.query ? (() => { const r = resolveNamed(a.query!, this.catalog.combos); return r.kind === 'ONE' ? [r.match] : r.kind === 'MANY' ? r.matches : []; })() : a.category || a.dietary ? [] : this.catalog.combos;
    const fmt = (p: ProductView) => ({
      name: p.name,
      category: p.category,
      price: formatMoney(p.basePrice, this.catalog.restaurant.currency),
      orderable: p.orderable.ok,
      ...(p.orderable.ok ? {} : { unavailableBecause: (p.orderable as { reason: string }).reason }),
      choices: p.groups.map((g) => ({ group: g.name, required: g.required, options: g.modifiers.filter((m) => m.available).map((m) => `${m.name}${m.priceDelta ? ` (+${formatMoney(m.priceDelta)})` : ''}`) })),
    });
    if (items.length === 0 && combos.length === 0) return { status: 'NOT_FOUND', message: 'Nothing on the menu matches that.' };
    return {
      status: 'INFO',
      items: items.slice(0, 30).map(fmt),
      combos: combos.map((c) => ({ name: c.name, price: formatMoney(c.basePrice), orderable: c.orderable.ok, components: c.components.map((x) => ({ component: x.name, options: x.options.map((o) => o.productName) })) })),
    };
  }

  private async tool_get_item_info(a: z.infer<typeof schemas.get_item_info>): Promise<ToolResult> {
    this.stateHint = 'ANSWERING_QUESTION';
    const r = this.findProduct(a.item);
    if (r.kind === 'fail') return r.result;
    if (r.kind === 'combo') return { status: 'INFO', message: `${r.combo.name}: ${r.combo.description ?? ''}`, price: formatMoney(r.combo.basePrice) };
    const p = r.product;
    const base = {
      status: 'INFO' as const,
      item: p.name,
      description: p.description,
      price: formatMoney(p.basePrice, this.catalog.restaurant.currency),
      vegetarian: p.vegetarian,
      vegan: p.vegan,
      glutenFreeLabel: p.glutenFree,
      ingredients: p.ingredients.map((i) => i.name),
      removableIngredients: p.ingredients.filter((i) => i.removable).map((i) => i.name),
    };
    if (!p.allergenInfoVerified) {
      this.ctx.lastProduct = p.name;
      return {
        ...base,
        allergenInfo: 'UNVERIFIED',
        instruction:
          "We do not have reliable allergen information for this item. Say: \"I don't have reliable allergen information for that item. Let me connect you with someone who can confirm.\" Then call escalate_to_human. Never guess.",
      };
    }
    if (a.allergen) {
      const canon = canonicalAllergen(a.allergen);
      if (!canon) return { ...base, allergenInfo: 'UNVERIFIED', instruction: `We have no structured data for "${a.allergen}". Do not guess; offer to connect the customer with staff via escalate_to_human.` };
      return { ...base, allergenQuestion: a.allergen, allergen: canon, contains: p.allergens.includes(canon), allAllergens: p.allergens };
    }
    return { ...base, allergens: p.allergens, allergenInfo: 'VERIFIED' };
  }

  private async tool_add_item(a: z.infer<typeof schemas.add_item>): Promise<ToolResult> {
    const r = this.findProduct(a.item);
    if (r.kind === 'fail') return r.result;
    if (r.kind === 'combo') return { status: 'REJECTED', code: 'USE_COMBO', message: `${r.combo.name} is a combo — use add_combo.` };
    const product = r.product;
    const modifierIds: string[] = [];
    for (const text of a.modifiers ?? []) {
      const res = this.resolveModifier(product, text);
      const problem = this.modifierProblem(product, text, res);
      if (problem) return problem;
      modifierIds.push((res as { m: { id: string } }).m.id);
    }
    return this.apply([{ type: 'ADD_ITEM', productId: product.id, quantity: a.quantity, modifierIds, removeIngredients: a.remove_ingredients }], 'ADD_ITEM');
  }

  private async tool_add_combo(a: z.infer<typeof schemas.add_combo>): Promise<ToolResult> {
    const cr = resolveNamed(a.combo, this.catalog.combos);
    if (cr.kind === 'NONE') return { status: 'NOT_FOUND', message: `No combo called "${a.combo}".` };
    if (cr.kind === 'MANY') return { status: 'AMBIGUOUS', candidates: cr.matches.map((c) => c.name) };
    const combo = cr.match;
    const selections: { componentId: string; productId: string }[] = [];
    for (const c of a.choices) {
      const comp = combo.components.find((x) => normalize(x.name) === normalize(c.component));
      if (!comp) return { status: 'NOT_FOUND', message: `${combo.name} has no "${c.component}" choice.`, components: combo.components.map((x) => x.name) };
      const opt = resolveNamed(c.item, comp.options.map((o) => ({ id: o.productId, name: o.productName })));
      if (opt.kind === 'NONE') return { status: 'NOT_FOUND', message: `"${c.item}" is not an option for ${comp.name}.`, options: comp.options.map((o) => o.productName) };
      if (opt.kind === 'MANY') return { status: 'AMBIGUOUS', candidates: opt.matches.map((m) => m.name) };
      selections.push({ componentId: comp.id, productId: opt.match.id });
    }
    return this.apply([{ type: 'ADD_COMBO', comboId: combo.id, quantity: a.quantity, selections }], 'ADD_COMBO');
  }

  private async withTargets(target: string, filter: string | undefined, build: (l: OrderLineView) => Command | ToolResult, action: string): Promise<ToolResult> {
    const t = this.resolveTargets(target, filter);
    if (!t.ok) return t.result;
    const cmds: Command[] = [];
    for (const l of t.lines) {
      const c = build(l);
      if ('status' in c) return { ...c, line: l.lineRef };
      cmds.push(c);
    }
    return this.apply(cmds, action);
  }

  private async tool_change_quantity(a: z.infer<typeof schemas.change_quantity>) {
    // A quantity belongs to one line; "make that three" with several candidate lines must be clarified, never guessed (§41).
    const t = this.resolveTargets(a.target, a.filter);
    if (!t.ok) return t.result;
    if (t.lines.length > 1 && !ALL_WORDS.has(normalize(a.target)))
      return { status: 'AMBIGUOUS', message: 'Several order items could match. Ask the customer which one they mean.', candidates: t.lines.map((l) => ({ lineRef: l.lineRef, item: l.name, quantity: l.quantity, options: l.modifiers.filter((m) => m.source === 'EXPLICIT').map((m) => m.name) })) };
    return this.withTargets(a.target, a.filter, (l) => ({ type: 'CHANGE_QUANTITY', line: l.lineRef, quantity: a.quantity }), 'CHANGE_QUANTITY');
  }
  private async tool_remove_item(a: z.infer<typeof schemas.remove_item>) {
    return this.withTargets(a.target, a.filter, (l) => ({ type: 'REMOVE_ITEM', line: l.lineRef }), 'REMOVE_ITEM');
  }

  private async tool_add_modifier(a: z.infer<typeof schemas.add_modifier>) {
    return this.withTargets(a.target, a.filter, (l) => {
      const p = this.productFor(l);
      if (!p) return { status: 'REJECTED', code: 'COMBO_LINE', message: `${l.name} cannot be customised.` } as ToolResult;
      const res = this.resolveModifier(p, a.modifier);
      const problem = this.modifierProblem(p, a.modifier, res);
      if (problem) return problem;
      const m = (res as { m: { id: string; group: { id: string; selectionType: string; maximumSelections: number } } }).m;
      // "make it large" when a size is already chosen means replace, not add (§49)
      const current = l.modifiers.find((x) => x.kind === 'ADD' && x.modifierGroupId === m.group.id && x.source === 'EXPLICIT');
      if (current && current.modifierId === m.id) return { status: 'OK', message: `${l.name} (${l.lineRef}) already has ${current.name}.`, order: this.compactOrder() } as ToolResult;
      if (current && (m.group.selectionType === 'SINGLE' || m.group.maximumSelections === 1) && current.modifierId)
        return { type: 'REPLACE_MODIFIER', line: l.lineRef, fromModifierId: current.modifierId, toModifierId: m.id, units: a.units };
      return { type: 'ADD_MODIFIER', line: l.lineRef, modifierId: m.id, units: a.units };
    }, 'ADD_MODIFIER');
  }

  private async tool_remove_modifier(a: z.infer<typeof schemas.remove_modifier>) {
    return this.withTargets(a.target, a.filter, (l) => {
      const p = this.productFor(l);
      if (!p) return { status: 'REJECTED', code: 'COMBO_LINE', message: `${l.name} cannot be customised.` } as ToolResult;
      // Only consider what is actually on this line, so "the cheese" resolves to the selected one.
      const selected = l.modifiers.filter((m) => m.kind === 'ADD' && m.modifierId);
      const r = resolveNamed(a.modifier, selected.map((m) => ({ id: m.modifierId!, name: m.name, aliases: p.groups.flatMap((g) => g.modifiers).find((x) => x.id === m.modifierId)?.aliases })));
      if (r.kind === 'NONE') {
        // maybe an ingredient removal request ("no onion") phrased as remove
        return { status: 'NOT_FOUND', message: `${l.name} (${l.lineRef}) has no selected option "${a.modifier}". To leave out an ingredient use remove_ingredient.`, selected: selected.map((m) => m.name) } as ToolResult;
      }
      if (r.kind === 'MANY') return { status: 'AMBIGUOUS', message: 'Several selected options match. Ask which one.', candidates: r.matches.map((m) => m.name) } as ToolResult;
      return { type: 'REMOVE_MODIFIER', line: l.lineRef, modifierId: r.match.id, units: a.units };
    }, 'REMOVE_MODIFIER');
  }

  private async tool_remove_ingredient(a: z.infer<typeof schemas.remove_ingredient>) {
    return this.withTargets(a.target, a.filter, (l) => ({ type: 'REMOVE_INGREDIENT', line: l.lineRef, ingredient: a.ingredient, units: a.units }), 'REMOVE_INGREDIENT');
  }

  private async tool_replace_modifier(a: z.infer<typeof schemas.replace_modifier>) {
    return this.withTargets(a.target, a.filter, (l) => {
      const p = this.productFor(l);
      if (!p) return { status: 'REJECTED', code: 'COMBO_LINE', message: `${l.name} cannot be customised.` } as ToolResult;
      const selected = l.modifiers.filter((m) => m.kind === 'ADD' && m.modifierId);
      const from = resolveNamed(a.from, selected.map((m) => ({ id: m.modifierId!, name: m.name })));
      if (from.kind !== 'ONE') return { status: from.kind === 'NONE' ? 'NOT_FOUND' : 'AMBIGUOUS', message: `Which current option on ${l.name} should change?`, selected: selected.map((m) => m.name) } as ToolResult;
      const to = this.resolveModifier(p, a.to);
      const problem = this.modifierProblem(p, a.to, to);
      if (problem) return problem;
      return { type: 'REPLACE_MODIFIER', line: l.lineRef, fromModifierId: from.match.id, toModifierId: (to as { m: { id: string } }).m.id, units: a.units };
    }, 'REPLACE_MODIFIER');
  }

  private async tool_replace_item(a: z.infer<typeof schemas.replace_item>) {
    const r = this.findProduct(a.item);
    if (r.kind === 'fail') return r.result;
    if (r.kind === 'combo') return { status: 'REJECTED', code: 'USE_COMBO', message: 'Cannot replace an item with a combo.' } as ToolResult;
    return this.withTargets(a.target, undefined, (l) => ({ type: 'REPLACE_ITEM', line: l.lineRef, productId: r.product.id }), 'REPLACE_ITEM');
  }

  private async tool_set_customer_details(a: z.infer<typeof schemas.set_customer_details>) {
    const phone = a.phone.replace(/[\s\-().]/g, '');
    if (!/^\+?\d{10,13}$/.test(phone)) return { status: 'REJECTED', code: 'BAD_PHONE', message: 'That phone number does not look valid. Ask the customer to repeat it (10 digits).' } as ToolResult;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>]/.test(a.name)) return { status: 'REJECTED', code: 'BAD_NAME', message: 'That name contains invalid characters.' } as ToolResult;
    const pickupAt = a.pickup_in_minutes ? new Date(Date.now() + a.pickup_in_minutes * 60000) : null;
    return this.apply([{ type: 'SET_CUSTOMER_DETAILS', name: a.name, phone, pickupAt, notes: a.notes ?? null }], 'SET_CUSTOMER_DETAILS');
  }

  private async tool_get_order_summary(): Promise<ToolResult> {
    this.order = await getOrderView(this.orderId);
    this.stateHint = 'ANSWERING_QUESTION';
    return { status: 'INFO', summary: summarize(this.order), order: this.compactOrder() };
  }

  private async tool_request_confirmation(): Promise<ToolResult> {
    const outcomes = await runCommands(this.orderId, [{ type: 'REQUEST_CONFIRMATION' }], 'AGENT', this.catalog);
    this.order = outcomes[0].order;
    this.ctx.reviewedVersion = this.order.version;
    this.stateHint = 'REVIEWING_ORDER';
    return { status: 'OK', message: 'Read this summary back to the customer exactly, then ask "Is that correct?".', summary: summarize(this.order) };
  }

  private async tool_confirm_order(): Promise<ToolResult> {
    // Server-side guardrails (§59/§60): LLM judgement alone can never submit an order.
    if (this.order.status !== 'READY_FOR_CONFIRMATION' || this.ctx.reviewedVersion !== this.order.version)
      return { status: 'REFUSED', message: 'The order has not been read back since its last change. Call request_confirmation first and wait for the customer to say yes.' };
    if (!isAffirmative(this.lastCustomerText))
      return { status: 'REFUSED', message: "The customer's latest message is not an explicit confirmation. Ask: \"Is that correct?\" and wait for a clear yes." };
    const outcomes = await runCommands(this.orderId, [{ type: 'CONFIRM_ORDER', expectedVersion: this.order.version }], 'CUSTOMER', this.catalog);
    this.order = outcomes[0].order;
    this.mutated = true;
    this.stateHint = 'COMPLETED';
    return { status: 'OK', message: outcomes[0].message, total: this.order.display.total, pickupName: this.order.customerName };
  }

  private async tool_cancel_order(): Promise<ToolResult> {
    const outcomes = await runCommands(this.orderId, [{ type: 'CANCEL_ORDER' }], 'CUSTOMER', this.catalog);
    this.order = outcomes[0].order;
    this.mutated = true;
    this.stateHint = 'CANCELLED';
    return { status: 'OK', message: outcomes[0].message };
  }

  private async tool_escalate_to_human(a: z.infer<typeof schemas.escalate_to_human>): Promise<ToolResult> {
    this.escalation = a.reason;
    this.stateHint = 'ESCALATED';
    return { status: 'ESCALATED', message: 'A team member has been notified and will take over with the current order attached. Tell the customer someone will be with them shortly.' };
  }
}

/** Gemini function declarations (JSON-schema subset). */
export const TOOL_DECLARATIONS = [
  { name: 'search_menu', description: 'Look up menu items, prices, availability and choices. Use for any menu question. All prices come from here.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, category: { type: 'STRING' }, dietary: { type: 'STRING', enum: ['vegetarian', 'vegan', 'gluten_free'] } } } },
  { name: 'get_item_info', description: 'Ingredients, dietary and allergen facts for one item. For "does X contain dairy/egg/nuts" pass the allergen word. If allergenInfo is UNVERIFIED you must not guess — escalate.', parameters: { type: 'OBJECT', properties: { item: { type: 'STRING' }, allergen: { type: 'STRING' } }, required: ['item'] } },
  { name: 'add_item', description: 'Add a menu item. Pass the customer’s words for item and modifiers (e.g. "large", "jalapenos"); the server resolves them. If AMBIGUOUS or NEEDS_INFO is returned, ask the customer — do not guess. For different customisations on several units, call add_item once per variation.', parameters: { type: 'OBJECT', properties: { item: { type: 'STRING' }, quantity: { type: 'INTEGER' }, modifiers: { type: 'ARRAY', items: { type: 'STRING' } }, remove_ingredients: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['item'] } },
  { name: 'add_combo', description: 'Add a combo with the customer’s choice for each component (Burger/Side/Drink).', parameters: { type: 'OBJECT', properties: { combo: { type: 'STRING' }, quantity: { type: 'INTEGER' }, choices: { type: 'ARRAY', items: { type: 'OBJECT', properties: { component: { type: 'STRING' }, item: { type: 'STRING' } }, required: ['component', 'item'] } } }, required: ['combo'] } },
  { name: 'change_quantity', description: 'Set the quantity of an order line. target: a line ref like line_001, "that"/"this" (current subject), "first"/"second"/"last", "all"/"both", or a product word like "burger".', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, quantity: { type: 'INTEGER' }, filter: { type: 'STRING' } }, required: ['target', 'quantity'] } },
  { name: 'remove_item', description: 'Remove an order line entirely. Same target rules as change_quantity.', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, filter: { type: 'STRING' } }, required: ['target'] } },
  { name: 'add_modifier', description: 'Add an option (size, cheese, topping, spice level…) to order line(s). Use `units` to apply to only some units of a line (e.g. "one with cheese" out of two burgers → units:1); the server splits the line automatically. If a single-choice option already exists it is replaced.', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, modifier: { type: 'STRING' }, units: { type: 'INTEGER' }, filter: { type: 'STRING' } }, required: ['target', 'modifier'] } },
  { name: 'remove_modifier', description: 'Remove a selected option (e.g. "no jalapenos" when jalapenos were added, "remove the sauce").', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, modifier: { type: 'STRING' }, units: { type: 'INTEGER' }, filter: { type: 'STRING' } }, required: ['target', 'modifier'] } },
  { name: 'remove_ingredient', description: 'Leave a base ingredient out ("no onions", "without tomato"). Not for options the customer added.', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, ingredient: { type: 'STRING' }, units: { type: 'INTEGER' }, filter: { type: 'STRING' } }, required: ['target', 'ingredient'] } },
  { name: 'replace_modifier', description: 'Swap one selected option for another in the same group (cheddar → mozzarella). One logical change.', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, from: { type: 'STRING' }, to: { type: 'STRING' }, units: { type: 'INTEGER' }, filter: { type: 'STRING' } }, required: ['target', 'from', 'to'] } },
  { name: 'replace_item', description: 'Replace an order line with a different menu item, keeping compatible customisations.', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' }, item: { type: 'STRING' } }, required: ['target', 'item'] } },
  { name: 'set_customer_details', description: 'Save pickup name and phone number (required before confirmation). Optional pickup_in_minutes and notes.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, phone: { type: 'STRING' }, pickup_in_minutes: { type: 'INTEGER' }, notes: { type: 'STRING' } }, required: ['name', 'phone'] } },
  { name: 'get_order_summary', description: 'Current order with server-computed totals. Use for "how much am I at?" and "what do I have?".', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'request_confirmation', description: 'Run final validation and produce the read-back summary. Call when the customer is done ordering and details are saved. Then read the summary and ask if it is correct.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'confirm_order', description: 'Submit the order. ONLY after request_confirmation and an explicit yes from the customer in their latest message. The server refuses otherwise.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'cancel_order', description: 'Cancel the whole order when the customer asks to cancel/abandon it.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'escalate_to_human', description: 'Hand over to staff: customer asks for a human, allergen uncertainty, complaint, payment problem, repeated misunderstanding, frustration, or unusual request.', parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' } }, required: ['reason'] } },
];
