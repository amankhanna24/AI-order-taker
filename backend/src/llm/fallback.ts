import { asksForHuman, isAffirmative, numberWord } from '../domain/language';
import { formatMoney } from '../domain/money';
import type { ToolResult, ToolRuntime } from '../services/toolRuntime';
import type { BrainResult } from './gemini';

/**
 * Deterministic parser used when no Gemini key is configured or the API is unavailable.
 * It maps common phrasings onto exactly the same validated tools the LLM uses.
 */

const CLEAN = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9'\s,.&+-]/g, ' ').replace(/\s+/g, ' ').trim();
const LEAD = /^(?:please |ok |okay |so |and |also |hi |hello |hey )*(?:i(?:'d| would| want| will|'ll| need|'m having)?(?: like| have| want| get| take)?(?: to (?:order|have|get))?|give me|get me|can i (?:have|get)|could i (?:have|get)|let me (?:have|get)|add|order|i'll take|one more|another)(?=\s|$)\s*/;
/** "I want X", "can I get X", "give me X" -> X */
const ASK = /^(?:(?:please|hi|hello|hey|ok|okay|so|and|also)[, ]+)*(?:i(?:'d| would)? (?:like|love)(?: to (?:have|order|get))?|i (?:want|need)(?: to (?:order|get|have))?|i(?:'ll| will) (?:have|take|get)|can i (?:get|have|order)|could i (?:get|have|order)|give me|get me|let me (?:get|have)|can you (?:do|make))\s+(.+)$/;
/** "do you have X" -> X */
const HAVE = /^(?:(?:hi|hello|hey|ok|okay|so|and|also)[, ]+)*(?:do you (?:guys )?(?:have|sell|serve)|have you got|is there|are there|got any)\s+(.+)$/;
const GREETING = /^(?:hi|hello|hey|hiya|salam|good (?:morning|afternoon|evening))(?: there)?[.!]*$/;
const THANKS = /^(?:thanks|thank you|cheers|thanks a lot)[.! ]*$/;

/** "<qty> <item>, one with X and one without" */
const SPLIT = /^(?:(?:please|i(?:'d| would)? (?:like|want)|can i (?:get|have)|give me|get me)\s+)*(\d{1,2}|two|three|four|five|six)\s+(.+?),?\s+((?:and\s+)?(?:one|1|two|three|the other(?: one)?|another)\s+(?:with|without|plain|no)\b.*)$/;
/** where a new "one with ..." / "the other plain" clause starts */
const CLAUSE_BREAK = /\s*,?\s*(?:and\s+)?(?=(?:one|1|two|three|the other(?: one)?|another)\s+(?:with|without|plain|no)\b)/;

/** Options named by one clause: "with extra cheese" -> [extra cheese]; "without" alone -> [] (plain); "without onions" -> [no onions]. */
function clauseOptions(clause: string, previous: string[]): string[] {
  const c = clause.replace(/\s+(?:please|thanks)$/, '').trim();
  const w = /^with(?!out)\s+(.+)$/.exec(c);
  if (w) return w[1].split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
  const wo = /^(?:without|no)\s*(.*)$/.exec(c);
  if (wo) {
    const what = wo[1].replace(/^(?:the |any |it|extra )+/, '').trim();
    if (!what || previous.some((p) => p.replace(/^extra /, '') === what)) return []; // "...and one without": simply the plain version
    return what.split(/\s*(?:,|\band\b)\s*/).filter(Boolean).map((x) => `no ${x}`);
  }
  return []; // plain / regular
}

const MAX_PER_ITEM = 50;
const orList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const bare = (s: string) => s.replace(/^(?:an? |the |some |any |one )+/, '').replace(/[?.!]+$/, '').replace(/\s+(?:please|thanks|thank you)$/, '').trim();

function qtyAndName(seg: string): { qty: number; name: string } {
  let s = seg.trim().replace(LEAD, '').trim();
  const m = /^(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.*)$/.exec(s);
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
      const names = [...list(r.candidates).map((c) => (typeof c === 'string' ? c : `${(c as { item: string }).item} (${(c as { lineRef: string }).lineRef.replace('_', ' ')})`)), ...list(r.options).map((o) => (o as { name: string }).name)];
      return `Which one do you mean: ${orList(names)}?`;
    }
    case 'NEEDS_INFO': {
      const missing = list(r.missing) as { group: string; options: { name: string; extraCost: number }[] }[];
      const price = (c: number) => (c ? ` (+${formatMoney(c)})` : '');
      return missing.map((g) => `Which ${g.group.toLowerCase()} would you like? ${orList(g.options.map((o) => `${o.name}${price(o.extraCost)}`))}?`).join(' ');
    }
    case 'OK':
      return `${String(r.message)}${r.order ? ` Your total is now ${(r.order as { total: string }).total}.` : ''}`;
    case 'INFO': {
      if (Array.isArray(r.items)) {
        const items = r.items as { name: string; price: string; orderable: boolean }[];
        const combos = list(r.combos) as { name: string; price: string; orderable: boolean }[];
        const all = [...items, ...combos];
        return all.map((i) => `${i.name} ${i.price}${i.orderable ? '' : ' (unavailable)'}`).join(', ') || 'Nothing matched.';
      }
      if (r.summary) return String(r.summary).replace(/\n/g, '. ');
      if (r.allergenInfo === 'UNVERIFIED')
        return `I don't have reliable allergen information for ${String(r.item ?? 'that item')}, so I can't say. ${list(r.ingredients).length ? `The listed ingredients are ${andList(list(r.ingredients) as string[])}. ` : ''}Please check with our staff when you collect.`;
      if (typeof r.contains === 'boolean') return `${String(r.item)} ${r.contains ? 'does' : 'does not'} contain ${String(r.allergenQuestion)} according to our menu data.`;
      return String(r.message ?? '');
    }
    case 'NOT_FOUND': {
      const includes = list(r.includes) as { component: string; options: string[] }[];
      if (includes.length) return `Sorry, that isn't part of the combo. It comes with ${andList(includes.map((i) => orList(i.options)))}. I can add it separately if you like.`;
      const options = list(r.availableOptions) as { group: string; options: { name: string }[] }[];
      if (options.length)
        return `Sorry, that isn't an option. ${options.slice(0, 3).map((g) => `${g.group}: ${orList(g.options.map((o) => o.name))}`).join('. ')}.`;
      return String(r.message ?? "Sorry, I couldn't find that.");
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

  /** The curveball: something we don't sell. Say so plainly and steer to what we do have. */
  const notOnMenu = async (what: string) => {
    const r = await call('search_menu', { query: what });
    const suggestions = (r.suggestions as string[] | undefined) ?? [];
    const { categories, combos } = rt.menuOverview();
    if (suggestions.length) return done(`Sorry, we don't have ${what}. How about ${orList(suggestions)}?`);
    const serves = andList([...categories.map((c) => c.toLowerCase()), ...(combos.length ? ['combo meals'] : [])]);
    return done(`Sorry, we don't have ${what}. We have ${serves}. What would you like?`);
  };

  if (!t) return done("Sorry, I didn't catch that.", false);
  if (GREETING.test(t)) return done('Hi! What can I get for you?');
  if (THANKS.test(t)) return done("You're welcome! Anything else?");
  if (asksForHuman(t)) {
    await call('escalate_to_human', { reason: 'Customer asked for a person' });
    return done('Of course — I am connecting you with a team member now. Your order will be passed along.');
  }
  if (rt.order.status === 'READY_FOR_CONFIRMATION' && isAffirmative(t)) {
    const r = await call('confirm_order', {});
    return done(r.status === 'OK' ? `Perfect, your order is confirmed. That's ${String(r.total)}. See you soon!` : render(r));
  }
  if (/\bcancel (?:my |the |this )?(?:whole |entire )?order\b|\bforget it\b|\bstart over\b/.test(t)) {
    const r = await call('cancel_order', {});
    return done(render(r));
  }
  if (/\b(how much|total|what do i (?:have|owe)|what(?:'s| is) (?:in )?my order|read (?:it|my order) back|my order so far)\b/.test(t)) {
    const r = await call('get_order_summary', {});
    return done(render(r));
  }

  // An earlier add was waiting on a choice ("which flavour?"): a short answer completes it instead of starting a new item.
  const pending = rt.ctx.pending;
  if (pending && t.split(' ').length <= 4 && !/\b(that|all|done|cancel|remove|actually|wait|total|menu|replace|swap)\b/.test(t)) {
    const args = JSON.parse(JSON.stringify(pending.args)) as Record<string, unknown>;
    if (pending.tool === 'add_item') args.modifiers = [...((args.modifiers as string[]) ?? []), bare(t)];
    else args.choices = [...((args.choices as unknown[]) ?? []), { item: bare(t) }];
    const r = await call(pending.tool, args);
    if (r.status === 'OK') {
      rt.ctx.pending = undefined;
      return done(render(r) + ' Anything else?');
    }
    if (r.status === 'NEEDS_INFO') {
      rt.ctx.pending = { tool: pending.tool, args };
      return done(render(r));
    }
    rt.ctx.pending = undefined; // not an answer to the question: treat it as a fresh request below
  } else if (pending) {
    rt.ctx.pending = undefined;
  }

  const allergen = /\b(?:does|do|is|are)\b.*?\b(?:the |a |an )?(.+?)\s+(?:contain|have|has|include|made with)\s+(\w+(?: nuts)?)/.exec(t);
  if (allergen && /\b(dairy|milk|egg|eggs|nuts?|peanuts?|gluten|wheat|soy|sesame|mustard|lactose)\b/.test(allergen[2])) {
    const r = await call('get_item_info', { item: allergen[1].trim().replace(/^(?:the|a|an|my)\s+/, ''), allergen: allergen[2] });
    return done(render(r));
  }

  if (/\b(menu|what do you (?:have|sell|serve)|what(?:'s| is) available|any (?:burgers|sides|drinks|combos?))\b/.test(t)) {
    const cat = /\b(burgers?|sides|drinks|combos?)\b/.exec(t)?.[1];
    const r = await call('search_menu', cat && !/^combo/.test(cat) ? { category: cat.replace(/s$/, '') } : {});
    return done(render(r));
  }

  const asked = HAVE.exec(t)?.[1];
  if (asked) {
    const what = bare(asked);
    if (!rt.knowsItem(what)) return notOnMenu(what);
    return done(render(await call('search_menu', { query: what })));
  }
  const want = ASK.exec(t)?.[1];
  if (want && /^(?:to )?(?:order|place an order|make an order)\b/.test(bare(want))) return done('Sure, what would you like?');

  // "two zinger burgers, one with extra cheese and one without": add them together, then give some units their own options
  const split = SPLIT.exec(t);
  if (split) {
    const n = numberWord(split[1]);
    const clauses = split[3].split(CLAUSE_BREAK).map((c) => c.trim().replace(/^and\s+/, '')).filter(Boolean);
    if (n && n > 1 && rt.knowsItem(split[2]) && clauses.length > 0) {
      const added = await call('add_item', { item: split[2], quantity: n });
      if (added.status !== 'OK') return done(render(added));
      const line = rt.ctx.lastOrderItem as string;
      let remaining = n;
      let reply = String(added.message);
      let last: ToolResult = added;
      let previous: string[] = [];
      for (const clause of clauses) {
        const m = /^(one|1|two|three|four|the other(?: one)?|another)\s+(.*)$/.exec(clause);
        if (!m) continue;
        const count = /^other|^another/.test(m[1]) ? remaining : (numberWord(m[1]) ?? 1);
        const mods = clauseOptions(m[2], previous);
        previous = mods.length ? mods : previous;
        if (mods.length === 0 || count > remaining) {
          remaining -= Math.min(count, remaining);
          continue;
        }
        for (const mod of mods) {
          last = await call('add_modifier', { target: line, modifier: mod, ...(count < remaining ? { units: count } : {}) });
          if (last.status !== 'OK') return done(`${reply} ${render(last)}`);
        }
        remaining -= count;
        reply = `${reply} ${String(last.message)}`;
      }
      return done(`${reply} Your total is now ${(last.order as { total: string }).total}. Anything else?`);
    }
  }

  // "make the drink a coke" / "change the drink to fanta": a choice inside a combo that is already in the order
  const comboChange = /^(?:(?:please|actually|wait|ok|okay),?\s+)*(?:make|change|switch|swap)\s+(?:the |my )?(drink|side|burger)(?:\s+in\s+(?:the |my )?.+?)?\s+(?:to|for|with|into|a|an)\s+(?:a |an )?(.+)$/.exec(t);
  if (comboChange && rt.order.lines.some((l) => l.comboId)) {
    const component = comboChange[1][0].toUpperCase() + comboChange[1].slice(1);
    return done(render(await call('change_combo', { target: 'that', choices: [{ component, item: bare(comboChange[2]) }] })));
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
  // "make it two smashes": the noun says which line
  const qtyNoun = /(?:make|change|set|update)\s+(?:that|it|this|them)\s+(?:to\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?!more\b|please\b|thanks\b|instead\b)(.+?)(?:\s+please)?$/.exec(t);
  if (qtyNoun && !/(?:first|second|third|last|other) one/.test(t)) {
    const n = numberWord(qtyNoun[1]);
    if (n) return done(render(await call('change_quantity', { target: qtyNoun[2], quantity: n })));
  }
  const qty = /(?:make|change|set|update)\s+(?:that|it|this|the .+?|them)\s+(?:to\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b|^(?:actually,? )?(?:make (?:that|it) )?(\d{1,2}|one|two|three|four|five)(?: please)?$/.exec(t);
  if (qty && !/(?:first|second|third|last|other) one/.test(t)) {
    const n = numberWord(qty[1] ?? qty[2]);
    const targetText = /(?:make|change|set|update)\s+(the .+?)\s+(?:to\s+)?(?:\d|one|two|three|four|five|six|seven|eight|nine|ten)/.exec(t)?.[1]?.replace(/^the /, '');
    if (n) return done(render(await call('change_quantity', { target: targetText ?? 'that', quantity: n })));
  }

  // "no onions" / "without pickles": a free option on burgers
  const noIng = /^(?:and |also |but )?(?:no|without|hold the|skip the)\s+(?:the )?(?!thanks|thank|that|nothing|i )(.+)$/.exec(t);
  if (noIng && rt.order.lines.length > 0) {
    const what = noIng[1].replace(/\s+on (?:it|that)$/, '');
    return done(render(await call('add_modifier', { target: 'that', modifier: `no ${what}` })));
  }

  // "make the first one large" -> apply to one unit of the current line (server splits the line)
  const oneUnit = /^(?:please )?(?:make|put)\s+(?:the )?(?:first|second|third|last|other) one\s+(?:with\s+)?(.+)$/.exec(t);
  if (oneUnit) return done(render(await call('add_modifier', { target: 'that', modifier: oneUnit[1], units: 1 })));

  // "make both burgers large" -> modifier on every matching line (applied atomically)
  const group = /^(?:please )?make\s+(?:both|all)(?: of)?(?: the)?(?: my)?\s+(\w+?)(?:s|es)?\s+(?:with\s+)?(.+)$/.exec(t);
  if (group && rt.order.lines.length > 0) return done(render(await call('add_modifier', { target: 'all', filter: group[1], modifier: group[2] })));

  const asModifier = /^(?:and |also )?(?:(?:can you |please )?(?:add|put)\s+|make (?:it|that|them|both|all)\s+(?:with\s+)?|with\s+|extra\s+)(.+?)(?:\s+(?:to it|on it|please|instead))?$/.exec(t);
  if (asModifier && rt.order.lines.length > 0 && !rt.knowsItem(asModifier[1])) {
    const mods = asModifier[1].split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    const all = /\b(both|all|them)\b/.test(t);
    let last: ToolResult = { status: 'NOT_FOUND', message: '' };
    const said: string[] = [];
    for (const m of mods) {
      last = await call('add_modifier', { target: all ? 'all' : 'that', modifier: /^extra\s/.test(t) && !/^extra/.test(m) ? `extra ${m}` : m });
      if (last.status !== 'OK') return done(`${said.join(' ')}${said.length ? ' ' : ''}${render(last)}`);
      said.push(String(last.message));
    }
    return done(`${said.join(' ')} Your total is now ${(last.order as { total: string }).total}.`);
  }

  const details = /(?:my name is|name is|it's|this is|i am|i'm)\s+([a-z][a-z .'-]{1,60}?)(?:\s+and\b|,|\s+(?:my )?(?:phone|number|mobile)|$)[\s\S]*?(\+?\d[\d\s-]{8,15}\d)/.exec(t);
  if (details) {
    return done(render(await call('set_customer_details', { name: details[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()), phone: details[2] })));
  }

  if (/\b(that(?:'s| is) (?:all|it)|nothing else|no(?:,)? that(?:'s| is) all|i(?:'m| am) done|that will be all|done|checkout|place (?:the |my )?order|that is everything|that's everything)\b/.test(t)) {
    const r = await call('request_confirmation', {});
    return done(r.status === 'OK' ? `${String(r.summary).replace(/\n/g, '. ')} Is that correct?` : render(r));
  }

  // A short bare answer ("cheddar", "large") after a question is treated as an option for the current item.
  if (rt.order.lines.length > 0 && t.split(' ').length <= 3 && !rt.knowsItem(t)) {
    const r = await call('add_modifier', { target: 'that', modifier: t });
    if (r.status === 'OK' || r.status === 'AMBIGUOUS') return done(render(r));
  }

  // Add items: "two zinger burgers and a coke", "a large fries with extra cheese"
  const body = t.replace(/^(?:(?:please|ok|okay|hi|hello|hey|so|yes|yeah)[ ,]+)+/, '');
  const segments = body.split(/\s*(?:,|\band\b|\bplus\b|&)\s*/).filter(Boolean);
  const added: ToolResult[] = [];
  const unknown: string[] = [];
  let pendingMods: string[] | null = null;
  for (const seg of segments) {
    // "..., no pickles" / "..., with extra cheese": a clause that is an option for the item just added
    const clause = added.length > 0 ? /^(?:(with|extra|add|plus)\s+|(no|without)\s+)(.+)$/.exec(seg) : null;
    if (clause && !rt.knowsItem(clause[3])) {
      const modifier = clause[2] ? `no ${clause[3]}` : clause[1] === 'extra' ? `extra ${clause[3]}` : clause[3];
      const r = await call('add_modifier', { target: rt.ctx.lastOrderItem ?? 'that', modifier });
      if (r.status !== 'OK') return done(`${added.map((a) => String(a.message)).join(' ')} ${render(r)}`);
      added.push(r);
      continue;
    }
    const withIdx = seg.indexOf(' with ');
    const head = withIdx >= 0 ? seg.slice(0, withIdx) : seg;
    const { qty: q, name } = qtyAndName(head);
    if (!name) continue;
    if (q > MAX_PER_ITEM && rt.knowsItem(name)) return done(`Sorry, I can only take up to ${MAX_PER_ITEM} of one item in an order. How many would you like?`);
    if (!rt.knowsItem(name)) {
      if (pendingMods && added.length) pendingMods.push(seg); // continuation of a "with a and b" list
      else if (added.length === 0 && segments.length === 1 && !ASK.test(body) && !LEAD.test(body)) {
        const { categories } = rt.menuOverview();
        return done(`Sorry, I didn't catch that. We have ${andList([...categories.map((c) => c.toLowerCase()), 'combo meals'])} - what would you like?`, false);
      } else unknown.push(name); // the customer asked for something we don't sell
      continue;
    }
    const mods = withIdx >= 0 ? seg.slice(withIdx + 6).split(/\s*(?:,|\band\b)\s*/).filter(Boolean) : [];
    pendingMods = withIdx >= 0 ? mods : null; // only an explicit "with ..." can be continued by the next segment
    const r = await call('add_item', { item: name, quantity: q, modifiers: mods });
    if (mods.length && (r.status === 'AMBIGUOUS' || r.status === 'NOT_FOUND') && /option|could mean/i.test(String(r.message))) {
      // Item is fine, one option needs clarifying: add the item plain, then ask about the option for that line.
      const plain = await call('add_item', { item: name, quantity: q });
      if (plain.status !== 'OK') return done(render(plain));
      return done(`${String(plain.message)} ${render(r)}`);
    }
    if (r.status === 'NEEDS_INFO') {
      // remember what was being added so the customer's one-word answer completes it
      rt.ctx.pending = r.component || /combo/i.test(String(r.message ?? '')) ? { tool: 'add_combo', args: { combo: name, quantity: q, choices: [] } } : { tool: 'add_item', args: { item: name, quantity: q, modifiers: mods } };
      return done(`${added.length ? `${added.map((a) => String(a.message)).join(' ')} ` : ''}${render(r)}`);
    }
    if (r.status !== 'OK') return done(render(r));
    added.push(r);
  }
  const sorry = unknown.length ? ` Sorry, we don't have ${orList(unknown)}.` : '';
  if (added.length) return done(added.map((a) => String(a.message)).join(' ') + ` Your total is now ${(added[added.length - 1].order as { total: string }).total}.${sorry} Anything else?`);
  if (unknown.length) return notOnMenu(unknown[0]);
  return done("Sorry, I didn't catch that. You can say things like 'two zinger burgers', 'add extra cheese' or 'that's all'.", false);
}
