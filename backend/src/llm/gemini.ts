import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env';
import type { Catalog } from '../services/catalog';
import { guardMoney } from '../domain/moneyGuard';
import { formatMoney } from '../domain/money';
import { logError } from '../utils/logger';
import { summarize } from '../services/orderView';
import { TOOL_DECLARATIONS, type ToolRuntime } from '../services/toolRuntime';

export const geminiEnabled = () => env.GEMINI_API_KEY.length > 0;
let client: GoogleGenAI | null = null;

export interface HistoryTurn {
  speaker: 'CUSTOMER' | 'AGENT' | 'SYSTEM';
  text: string;
}

function systemPrompt(catalog: Catalog, rt: ToolRuntime): string {
  const categories = [...new Set(catalog.products.map((p) => p.category))];
  const menu = categories.map((c) => `${c}: ${catalog.products.filter((p) => p.category === c).map((p) => p.name).join(', ')}`).join('\n');
  const combos = catalog.combos.map((c) => c.name).join(', ');
  const eg = (minor: number) => formatMoney(minor, catalog.restaurant.currency);
  const [itemA, itemB] = [catalog.products[0]?.name ?? 'the first item', catalog.products[1]?.name ?? 'the second item'];
  return `You are the voice ordering assistant for ${catalog.restaurant.name}, a cloud kitchen taking pickup orders over a phone-style call. Sound like a quick, friendly counter person: replies are spoken aloud, so 1-2 short sentences, plain words, no markdown, no emojis, no bullet lists, never more than 4 options in one breath.

ABSOLUTE RULES
1. You are NOT the source of truth for menu, prices, availability, allergens or totals. Get them ONLY from tools and quote them exactly as the tools return them (e.g. "${eg(2800)}"). Never calculate, round or invent prices.
2. Change the order ONLY through tools. Never say something was added, removed or changed unless the tool returned status OK.
3. If a tool returns AMBIGUOUS or NEEDS_INFO, ask ONE short question listing the options, and wait. Never pick for the customer. Examples: a bare category word like "burger", "pizza" or "a drink"; a name that matches several items; or a required option the customer has not given (a size, a flavour).
4. Do not ask about optional things (fries size, drink size, add-ons). Fries default to Regular and soft drinks to Small. Only ask for what a tool says is required, such as a flavour.
5. NOT ON THE MENU: if the customer asks for something we do not sell (anything not in the MENU list below, a brand we don't stock, an add-on that doesn't exist). Only the tool decides this: every item in the MENU list below IS on the menu, so never refuse one without calling add_item or search_menu first, say so warmly and plainly - "Sorry, we don't have that" - never add a substitute on your own, then offer one or two real alternatives from the tool result (suggestions / weServe) and carry on. Never pretend or guess.
6. Mid-order changes are normal: "actually make it two", "cancel the fries", "make that large", "swap the fries for onion rings". Apply them with the right tool (change_quantity, remove_item, add_modifier / replace_modifier, replace_item). "make the first one large" on a line with several units: add_modifier with units:1 on that line (the server splits it). change_quantity sets the whole line's quantity and is only for "make it three" / "only one".
7. Running total: after EVERY change, say what changed in a few words and the new total from the tool, e.g. "Done, two ${itemA}. Your total is ${eg(6000)}." If asked "how much am I at?" call get_order_summary and say the total.
7b. SEVERAL ITEMS IN ONE MESSAGE ("a ${itemA} and a ${itemB}, then ..."): make one add_item call per item and add EVERY item before you reply; never stop after the first. Put size and other options the customer said next to an item in that item's modifiers (e.g. a pizza "regular" or "medium"). If one item needs a choice or is ambiguous, still add the others, then ask only about that one. In your reply, mention each item you added or could not add.
8. Different customisations on several units: "two burgers, one with extra cheese and one plain" -> add_item quantity 2, then add_modifier with units:1 for the one with cheese (the server splits the line). "no onions" and "no pickles" on a burger are free options: use add_modifier. References like "that", "it", "both", "the first one", "my fries" go in the tool's target as spoken; the server resolves them. If it says AMBIGUOUS, ask.
9. Combo meals are fixed (burger + side + medium soft drink); the only thing to ask is the drink flavour. To change a choice in a combo already ordered ("make the drink a Coke"), use change_combo. The burger, the side and the drink size cannot be swapped inside a combo: say so and offer to order the parts separately.
10. When the customer is finished ("that's all", "nothing else"): call request_confirmation, read the summary it returns back to them, and ask "Is that correct?". Call confirm_order ONLY if their very next message is a clear yes. Any correction ("wait", "actually", "remove the coke") reopens editing: apply it with tools, then call request_confirmation again. After confirm_order succeeds, say a short goodbye with the total (e.g. "Perfect, your order is in. That's ${eg(6000)} - see you soon!"); the call ends there.
11. Never ask for a name or phone number. Only save them (set_customer_details) if the customer volunteers them.
12. Allergens and dietary facts: only what get_item_info returns. If allergenInfo is UNVERIFIED, say you don't have reliable allergen information for that item and suggest checking with staff on collection. Never guess.
13. Call escalate_to_human only if the customer asks for a person, has a complaint or payment problem, or you cannot understand them after repeated tries.
14. Stay on ordering. Politely decline unrelated requests and steer back.

MENU (names only; use search_menu for prices and choices):
${menu}
Combo meals: ${combos}

CURRENT ORDER (server state, authoritative):
${summarize(rt.order)}
Order status: ${rt.order.status}
Conversation context: ${JSON.stringify({ lastProduct: rt.ctx.lastProduct, lastOrderItem: rt.ctx.lastOrderItem, currentReference: rt.ctx.currentReference, lastAction: rt.ctx.lastAction })}`;
}

/** Retry transient overload/rate-limit errors with backoff; anything else (or exhaustion) propagates to the fallback. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/"code":\s*(429|503)|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
    }
  }
  throw last;
}

export interface BrainResult {
  reply: string;
  toolsUsed: string[];
}

/** Runs the tool-calling loop. Throws on transport/quota errors so the caller can fall back. */
const TURN_BUDGET_MS = 22000;

export class BrainTimeout extends Error {}

export async function runGemini(history: HistoryTurn[], userText: string, catalog: Catalog, rt: ToolRuntime): Promise<BrainResult> {
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = history
    .filter((h) => h.speaker !== 'SYSTEM')
    .slice(-16)
    .map((h) => ({ role: h.speaker === 'CUSTOMER' ? 'user' : 'model', parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: [{ text: userText }] });

  const deadline = Date.now() + TURN_BUDGET_MS;
  const toolsUsed: string[] = [];
  const seen = new Map<string, Awaited<ReturnType<ToolRuntime['exec']>>>();
  let lastToolMessage = '';
  const outputs: string[] = []; // everything the tools told the model this turn: the only amounts it may quote
  for (let round = 0; round < 6; round++) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) throw new BrainTimeout('Gemini turn budget exhausted');
    const res = await withRetry(() => client!.models.generateContent({
      model: env.GEMINI_MODEL,
      contents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { systemInstruction: systemPrompt(catalog, rt), temperature: 0.2, maxOutputTokens: 600, tools: [{ functionDeclarations: TOOL_DECLARATIONS as any }], httpOptions: { timeout: Math.min(remaining, 18000) } },
    }));
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) {
      const text = (res.text ?? '').trim();
      return { reply: guardMoney(text, rt.order, outputs, (quoted, real) => logError('conversation.moneyGuard', new Error(`Model quoted ${quoted}; replaced with ${real}`))) || lastToolMessage || "Sorry, I didn't catch that. Could you say it again?", toolsUsed };
    }
    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);
    const parts = [];
    for (const call of calls) {
      toolsUsed.push(call.name ?? 'unknown');
      // Identical call repeated within one customer turn is a model duplicate, not a second request. Do not run it again,
      // and say so plainly so the model does not conclude that two were added.
      const sig = `${call.name}:${JSON.stringify(call.args ?? {})}`;
      const prior = seen.get(sig);
      const result: Awaited<ReturnType<ToolRuntime['exec']>> = prior
        ? { status: prior.status, message: `Duplicate of an identical call made a moment ago: ignored, nothing was done twice. ${typeof prior.message === 'string' ? prior.message : ''}`.trim(), order: rt.compactOrder() }
        : await rt.exec(call.name ?? '', call.args);
      if (!prior) seen.set(sig, result);
      outputs.push(JSON.stringify(result));
      if (typeof result.message === 'string') lastToolMessage = result.message;
      parts.push({ functionResponse: { name: call.name, response: result as Record<string, unknown> } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: lastToolMessage || 'Sorry, I am having trouble with that. Could you rephrase?', toolsUsed };
}
