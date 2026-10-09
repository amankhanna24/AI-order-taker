import { asksForHuman, isAffirmative, numberWord } from '../domain/language';
import type { ToolResult, ToolRuntime } from '../services/toolRuntime';
import type { BrainResult } from './gemini';

/**
 * Deterministic parser used when no Gemini key is configured or the API is unavailable.
 * It maps common phrasings onto exactly the same validated tools the LLM uses.
 */

const CLEAN = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9'\s,.&+-]/g, ' ').replace(/\s+/g, ' ').trim();
const LEAD = /^(?:please |ok |okay |so |and |also |hi |hello |hey )*(?:i(?:'d| would| want| will|'ll| need|'m having)?(?: like| have| want| get)?(?: to (?:order|have|get))?|give me|get me|can i (?:have|get)|could i (?:have|get)|let me (?:have|get)|add|order|i'll take|one more|another)\s*/;

function qtyAndName(seg: string): { qty: number; name: string } {
  let s = seg.trim().replace(LEAD, '').trim();
  const m = /^(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.*)$/.exec(s);
  let qty = 1;
  if (m) {
    qty = numberWord(m[1]) ?? 1;
    s = m[2];
  }
  return { qty, name: s.replace(/^(?:of |the |some |my )/, '').replace(/\s+(?:please|thanks|thank you)$/, '').trim() };
}

function render(r: ToolResult): string {
  const list = (a: unknown) => (Array.isArray(a) ? a : []);
  switch (r.status) {
    case 'AMBIGUOUS': {
      const names = [...list(r.candidates).map((c) => (typeof c === 'string' ? c : `${(c as { item: string }).item} (${(c as { lineRef: string }).lineRef})`)), ...list(r.options).map((o) => (o as { name: string }).name)];
      return `Which one do you mean: ${names.join(', ')}?`;
    }
    case 'NEEDS_INFO': {
      const missing = list(r.missing) as { group: string; options: { name: string; extraCost: number }[] }[];
      const label = (n: string) => n.replace(/ Pizza$/, '');
      const price = (c: number) => (c ? ` (+₹${c / 100})` : '');
      const opts = missing.map((g) => `${g.group}: ${g.options.map((o) => `${label(o.name)}${price(o.extraCost)}`).join(', ')}`).join('; ');
      return `Which ${missing.map((g) => g.group.toLowerCase()).join(' and ')} would you like? ${opts}`;
    }
    case 'OK':
      return `${String(r.message)}${r.order ? ` Your total is now ${(r.order as { total: string }).total}.` : ''}`;
    case 'INFO': {
      if (Array.isArray(r.items)) {
        const items = r.items as { name: string; price: string; orderable: boolean }[];
        return items.map((i) => `${i.name} ${i.price}${i.orderable ? '' : ' (unavailable)'}`).join(', ') || 'Nothing matched.';
      }
      if (r.summary) return String(r.summary).replace(/\n/g, '. ');
      if (r.allergenInfo === 'UNVERIFIED') return "I don't have reliable allergen information for that item. Let me connect you with someone who can confirm.";
      if (typeof r.contains === 'boolean') return `${String(r.item)} ${r.contains ? 'does' : 'does not'} contain ${String(r.allergenQuestion)} according to our menu data.`;
      return String(r.message ?? '');
    }
    default:
      return String(r.message ?? "Sorry, I couldn't do that.");
  }
}

export async function runFallback(text: string, rt: ToolRuntime): Promise<BrainResult & { understood: boolean }> {
  const t = CLEAN(text);
  const used: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    used.push(name);
    return rt.exec(name, args);
  };
  const done = (reply: string, understood = true) => ({ reply, toolsUsed: used, understood });

  if (!t) return done("Sorry, I didn't catch that.", false);
  if (asksForHuman(t)) {
    await call('escalate_to_human', { reason: 'Customer asked for a person' });
    return done('Of course — I am connecting you with a team member now. Your order will be passed along.');
  }
  if (rt.order.status === 'READY_FOR_CONFIRMATION' && isAffirmative(t)) {
    const r = await call('confirm_order', {});
    return done(r.status === 'OK' ? `Done! Your order is confirmed. Total ${String(r.total)}. See you soon, ${String(r.pickupName ?? '')}.` : render(r));
  }
  if (/\bcancel (?:my |the |this )?(?:whole |entire )?order\b|\bforget it\b|\bstart over\b/.test(t)) {
    const r = await call('cancel_order', {});
    return done(render(r));
  }
  if (/\b(how much|total|what do i (?:have|owe)|what(?:'s| is) (?:in )?my order|read (?:it|my order) back|my order so far)\b/.test(t)) {
    const r = await call('get_order_summary', {});
    return done(render(r));
  }

  const allergen = /\b(?:does|do|is|are)\b.*?\b(?:the |a |an )?(.+?)\s+(?:contain|have|has|include|made with)\s+(\w+(?: nuts)?)/.exec(t);
  if (allergen && /\b(dairy|milk|egg|eggs|nuts?|peanuts?|gluten|wheat|soy|sesame|mustard|lactose)\b/.test(allergen[2])) {
    const r = await call('get_item_info', { item: allergen[1].trim().replace(/^(?:the|a|an|my)\s+/, ''), allergen: allergen[2] });
    return done(render(r));
  }

  if (/\b(menu|what do you (?:have|sell|serve)|what(?:'s| is) available|any (?:burgers|pizzas?|sides|drinks|desserts))\b/.test(t)) {
    const cat = /\b(burgers?|pizzas?|sides|drinks|desserts?)\b/.exec(t)?.[1];
    const r = await call('search_menu', cat ? { category: cat.replace(/s$/, '') } : {});
    return done(render(r));
  }

  const replaceItem = /^(?:please )?(?:replace|swap|change) (?:the |my )?(.+?) (?:with|for|to) (?:a |an |the )?(.+)$/.exec(t);
  if (replaceItem) {
    const r = await call('replace_item', { target: replaceItem[1], item: replaceItem[2] });
    return done(render(r));
  }
  const remove = /^(?:please |wait,? |actually,? )*(?:remove|delete|take off|drop|cancel|scrap)\s+(?:the |my |that |this )?(.+)$/.exec(t);
  if (remove) {
    const r = await call('remove_item', { target: remove[1] });
    return done(render(r));
  }
  const qty = /(?:make|change|set|update)\s+(?:that|it|this|the .+?|them)\s+(?:to\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b|^(?:actually,? )?(?:make (?:that|it) )?(\d{1,2}|one|two|three|four|five)(?: please)?$/.exec(t);
  if (qty && !/(?:first|second|third|last|other) one/.test(t)) {
    const n = numberWord(qty[1] ?? qty[2]);
    const targetText = /(?:make|change|set|update)\s+(the .+?)\s+(?:to\s+)?(?:\d|one|two|three|four|five|six|seven|eight|nine|ten)/.exec(t)?.[1]?.replace(/^the /, '');
    if (n) return done(render(await call('change_quantity', { target: targetText ?? 'that', quantity: n })));
  }

  const noIng = /^(?:and |also |but )?(?:no|without|hold the|skip the)\s+(?:the )?(?!thanks|thank|that|nothing|i )(.+)$/.exec(t);
  if (noIng) {
    const r = await call('remove_ingredient', { target: 'that', ingredient: noIng[1].replace(/\s+on (?:it|that)$/, '') });
    if (r.status === 'NOT_FOUND' || (r.status === 'REJECTED' && r.code === 'UNKNOWN_INGREDIENT')) {
      const m = await call('remove_modifier', { target: 'that', modifier: noIng[1] });
      if (m.status === 'OK') return done(render(m));
    }
    return done(render(r));
  }

  // "make the first one large" -> apply to one unit of the current line (server splits the line)
  const oneUnit = /^(?:please )?(?:make|put)\s+(?:the )?(?:first|second|third|last|other) one\s+(?:with\s+)?(.+)$/.exec(t);
  if (oneUnit) return done(render(await call('add_modifier', { target: 'that', modifier: oneUnit[1], units: 1 })));

  // "make both burgers spicy" -> modifier on every matching line (applied atomically)
  const group = /^(?:please )?make\s+(?:both|all)(?: of)?(?: the)?(?: my)?\s+(\w+?)(?:s|es)?\s+(?:with\s+)?(.+)$/.exec(t);
  if (group && rt.order.lines.length > 0) return done(render(await call('add_modifier', { target: 'all', filter: group[1], modifier: group[2] })));

  const asModifier = /^(?:and |also )?(?:(?:can you |please )?(?:add|put)\s+|make (?:it|that|them|both|all)\s+(?:with\s+)?|with\s+|extra\s+)(.+?)(?:\s+(?:to it|on it|please|instead))?$/.exec(t);
  if (asModifier && rt.order.lines.length > 0 && !rt.knowsItem(asModifier[1])) {
    const mods = asModifier[1].split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    const all = /\b(both|all|them)\b/.test(t);
    let last: ToolResult = { status: 'NOT_FOUND', message: '' };
    for (const m of mods) {
      last = await call('add_modifier', { target: all ? 'all' : 'that', modifier: m });
      if (last.status !== 'OK') return done(render(last));
    }
    return done(render(last));
  }

  const details = /(?:my name is|name is|it's|this is|i am|i'm)\s+([a-z][a-z .'-]{1,60}?)(?:\s+and\b|,|\s+(?:my )?(?:phone|number|mobile)|$)[\s\S]*?(\+?\d[\d\s-]{8,15}\d)/.exec(t);
  if (details) {
    return done(render(await call('set_customer_details', { name: details[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()), phone: details[2] })));
  }

  if (/\b(that(?:'s| is) (?:all|it)|nothing else|no(?:,)? that(?:'s| is) all|i(?:'m| am) done|that will be all|done|checkout|place (?:the |my )?order)\b/.test(t)) {
    if (!rt.order.customerName || !rt.order.customerPhone) return done('Sure. What name and phone number should the pickup be under?');
    const r = await call('request_confirmation', {});
    return done(r.status === 'OK' ? `${String(r.summary).replace(/\n/g, '. ')}. Is that correct?` : render(r));
  }

  // A short bare answer ("cheddar", "large") after a question is treated as an option for the current item.
  if (rt.order.lines.length > 0 && t.split(' ').length <= 3 && !rt.knowsItem(t)) {
    const r = await call('add_modifier', { target: 'that', modifier: t });
    if (r.status === 'OK' || r.status === 'AMBIGUOUS') return done(render(r));
  }

  // Add items: "two paneer burgers and a coke", "a large pizza with cheese"
  const body = t.replace(/^(?:please |ok |okay |hi |hello )+/, '');
  const segments = body.split(/\s*(?:,|\band\b|\bplus\b|&)\s*/).filter(Boolean);
  const added: ToolResult[] = [];
  let pendingMods: string[] | null = null;
  for (const seg of segments) {
    const withIdx = seg.indexOf(' with ');
    const head = withIdx >= 0 ? seg.slice(0, withIdx) : seg;
    const { qty: q, name } = qtyAndName(head);
    if (!rt.knowsItem(name)) {
      if (pendingMods && added.length) pendingMods.push(seg); // continuation of a "with a and b" list
      else if (added.length === 0) return done("Sorry, I didn't catch that. You can say things like 'two paneer burgers', 'add cheese' or 'that's all'.", false);
      continue;
    }
    const mods = withIdx >= 0 ? seg.slice(withIdx + 6).split(/\s*(?:,|\band\b)\s*/).filter(Boolean) : [];
    pendingMods = mods;
    const r = await call('add_item', { item: name, quantity: q, modifiers: mods });
    if (mods.length && (r.status === 'AMBIGUOUS' || r.status === 'NOT_FOUND') && /option|could mean/i.test(String(r.message))) {
      // Item is fine, one option needs clarifying: add the item plain, then ask about the option for that line.
      const plain = await call('add_item', { item: name, quantity: q });
      if (plain.status !== 'OK') return done(render(plain));
      return done(`${String(plain.message)} ${render(r)}`);
    }
    if (r.status !== 'OK') return done(render(r));
    added.push(r);
  }
  if (added.length) return done(added.map((a) => String(a.message)).join(' ') + ` Your total is now ${(added[added.length - 1].order as { total: string }).total}. Anything else?`);
  return done("Sorry, I didn't catch that. You can say things like 'two paneer burgers', 'add cheese' or 'that's all'.", false);
}
