import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env';
import type { Catalog } from '../services/catalog';
import { summarize } from '../services/orderView';
import { TOOL_DECLARATIONS, type ToolRuntime } from '../services/toolRuntime';

export const geminiEnabled = () => env.GEMINI_API_KEY.length > 0;
let client: GoogleGenAI | null = null;

export interface HistoryTurn {
  speaker: 'CUSTOMER' | 'AGENT' | 'SYSTEM';
  text: string;
}

function systemPrompt(catalog: Catalog, rt: ToolRuntime): string {
  const menu = ['Burgers', 'Pizza', 'Sides', 'Drinks', 'Desserts']
    .map((c) => `${c}: ${catalog.products.filter((p) => p.category === c).map((p) => p.name).join(', ')}`)
    .join('\n');
  const combos = catalog.combos.map((c) => c.name).join(', ');
  return `You are the friendly, concise voice ordering assistant for ${catalog.restaurant.name} (pickup orders only). Replies are spoken aloud: short, natural, 1-3 sentences, no markdown, no emojis, no lists of more than 4 items.

ABSOLUTE RULES
1. You are NOT the source of truth for menu, prices, availability, allergens or totals. Get them ONLY from tools and quote them exactly as tools return them. Never calculate or invent prices.
2. Change the order ONLY through tools. Never claim something was added/removed unless the tool returned status OK.
3. If a tool returns AMBIGUOUS or NEEDS_INFO, ask the customer one short clarifying question listing the options. Never guess, never pick for them. (e.g. "burger" alone, "fries" alone, "add cheese" with several cheeses, a required pizza size.)
4. Optional choices that are missing: do NOT ask. Only ask for required ones (tool tells you).
5. If an item is unavailable/sold out, say so plainly and suggest one alternative from the menu.
6. Allergens: only state what get_item_info returns. If allergenInfo is UNVERIFIED, say you don't have reliable allergen information and call escalate_to_human. Never guess.
7. Quantities: "two burgers, one with cheese and one without" -> add_item quantity 2, then add_modifier with units:1 for the one with cheese (server splits the line). "Make the first one large" on a line with quantity>1 -> target that line, units:1.
7b. change_quantity sets the line's TOTAL quantity and is ONLY for "make it three"/"only one". NEVER use it for "make the first one large" or "one with cheese" — those use add_modifier/remove_ingredient with units:1 on the same line. Example: line_001 has 3 burgers; "make the first one large" -> add_modifier(target:"line_001", modifier:"large", units:1).
8. References ("that", "it", "both", "the first one", "my fries") -> pass them as the tool's target string; the server resolves them from the live order. If the tool says AMBIGUOUS, ask.
9. When the customer is finished: make sure pickup name and phone are saved (set_customer_details; ask for them if missing), call request_confirmation, read the returned summary back, and ask "Is that correct?". Call confirm_order ONLY if their very next message is a clear yes. Any correction reopens editing: apply it with tools, then request_confirmation again.
10. Escalate (escalate_to_human) when asked for a person, for complaints/refunds/payment problems, unusual requests, or if you repeatedly fail to understand.
11. Stay on topic (ordering). Politely decline unrelated requests.

MENU (names only; use search_menu for prices/choices):
${menu}
Combos: ${combos}

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
      return { reply: text || lastToolMessage || "Sorry, I didn't catch that. Could you say it again?", toolsUsed };
    }
    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);
    const parts = [];
    for (const call of calls) {
      toolsUsed.push(call.name ?? 'unknown');
      // Identical call repeated within one customer turn is a model duplicate, not a second request: reuse the first result.
      const sig = `${call.name}:${JSON.stringify(call.args ?? {})}`;
      const result = seen.get(sig) ?? (await rt.exec(call.name ?? '', call.args));
      seen.set(sig, result);
      if (typeof result.message === 'string') lastToolMessage = result.message;
      parts.push({ functionResponse: { name: call.name, response: result as Record<string, unknown> } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: lastToolMessage || 'Sorry, I am having trouble with that. Could you rephrase?', toolsUsed };
}
