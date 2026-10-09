import crypto from 'node:crypto';
import { prisma } from '../config/prisma';
import { asksForHuman, isFrustrated, isPaymentOrComplaint } from '../domain/language';
import { geminiEnabled, runGemini } from '../llm/gemini';
import { runFallback } from '../llm/fallback';
import { ApiError } from '../utils/errors';
import { logError } from '../utils/logger';
import { getRestaurantBySlug, loadCatalog } from './catalog';
import { createOrder, getOrderView, orderInclude, runCommand } from './orderEngine';
import { toOrderView, type OrderView } from './orderView';
import { ToolRuntime, type ConvContext } from './toolRuntime';

export const MAX_MESSAGE_LENGTH = 500;
const MAX_MESSAGES_PER_CONVERSATION = 300;
const MISUNDERSTANDING_LIMIT = 3;
const GREETING = (name: string) => `Hi, welcome to ${name}! What can I get started for you today?`;

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** One in-flight turn per conversation so double-sent messages cannot interleave (single-instance deployment). */
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  }).catch(() => undefined);
  return next;
}

export interface MessageView {
  id: string;
  speaker: string;
  text: string;
  createdAt: string;
}
export interface ConversationView {
  conversationId: string;
  state: string;
  order: OrderView;
  messages: MessageView[];
  restaurant: { name: string; currency: string };
}

const toMessage = (m: { id: string; speaker: string; text: string; createdAt: Date }): MessageView => ({
  id: m.id,
  speaker: m.speaker,
  text: m.text,
  createdAt: m.createdAt.toISOString(),
});

export async function startConversation(slug: string): Promise<ConversationView & { token: string }> {
  const restaurant = await getRestaurantBySlug(slug);
  const location = await prisma.location.findFirst({ where: { restaurantId: restaurant.id, status: 'ACTIVE' } });
  const token = crypto.randomBytes(32).toString('base64url');
  const { conversation, order } = await prisma.$transaction(async (tx) => {
    const o = await createOrder(restaurant.id, location?.id ?? null, tx);
    const c = await tx.conversation.create({
      data: {
        orderId: o.id,
        restaurantId: restaurant.id,
        tokenHash: hash(token),
        state: 'GREETING',
        context: { misunderstandings: 0 },
        messages: { create: { speaker: 'AGENT', text: GREETING(restaurant.name), intent: 'GREETING' } },
      },
      include: { messages: true },
    });
    return { conversation: c, order: o };
  });
  return {
    token,
    conversationId: conversation.id,
    state: conversation.state,
    order: toOrderView(order),
    messages: conversation.messages.map(toMessage),
    restaurant: { name: restaurant.name, currency: restaurant.currency },
  };
}

/** Authenticates the bearer session token against the conversation (prevents IDOR across customers). */
async function authorize(conversationId: string, token: string) {
  const c = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { restaurant: true } });
  const a = Buffer.from(hash(token));
  const b = Buffer.from(c?.tokenHash ?? hash('x'.repeat(8)));
  if (!c || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw ApiError.notFound('Conversation not found');
  return c;
}

export async function getConversation(conversationId: string, token: string): Promise<ConversationView> {
  const c = await authorize(conversationId, token);
  const messages = await prisma.conversationMessage.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' }, take: MAX_MESSAGES_PER_CONVERSATION });
  return {
    conversationId,
    state: c.state,
    order: await getOrderView(c.orderId),
    messages: messages.map(toMessage),
    restaurant: { name: c.restaurant.name, currency: c.restaurant.currency },
  };
}

function cleanText(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

export async function handleMessage(conversationId: string, token: string, rawText: string) {
  const c = await authorize(conversationId, token);
  const text = cleanText(rawText);
  if (!text) throw ApiError.badRequest('Message cannot be empty');
  if (text.length > MAX_MESSAGE_LENGTH) throw ApiError.badRequest(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);

  return serialize(conversationId, async () => {
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (['COMPLETED', 'CANCELLED'].includes(conv.state)) throw ApiError.conflict('This conversation has ended. Please start a new order.');
    const count = await prisma.conversationMessage.count({ where: { conversationId } });
    if (count >= MAX_MESSAGES_PER_CONVERSATION) throw ApiError.conflict('This conversation reached its message limit. Please start a new order.');

    const history = (await prisma.conversationMessage.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 16 })).reverse();
    await prisma.conversationMessage.create({ data: { conversationId, speaker: 'CUSTOMER', text } });

    if (conv.state === 'ESCALATED') {
      const reply = 'A team member has been notified and will assist you shortly.';
      await prisma.conversationMessage.create({ data: { conversationId, speaker: 'AGENT', text: reply, intent: 'ESCALATED' } });
      return respond(conversationId, c.orderId, 'ESCALATED', reply);
    }

    const catalog = await loadCatalog(c.restaurantId);
    const ctx: ConvContext = { misunderstandings: 0, ...((conv.context as Partial<ConvContext>) ?? {}) };
    const order = await getOrderView(c.orderId);
    const rt = new ToolRuntime(c.orderId, order, catalog, ctx, text);

    let reply = '';
    let toolsUsed: string[] = [];
    let understood = true;
    let escalateReason: string | null = null;

    if (asksForHuman(text)) escalateReason = 'Customer asked for a human';
    else if (isPaymentOrComplaint(text)) escalateReason = 'Complaint or payment-related request';
    else if (isFrustrated(text)) escalateReason = 'Customer frustration';

    if (escalateReason) {
      reply = 'I am sorry about that. Let me connect you with a team member who can help; your order details will be passed along.';
      rt.stateHint = 'ESCALATED';
    } else {
      try {
        if (geminiEnabled()) {
          const r = await runGemini(history.map((m) => ({ speaker: m.speaker, text: m.text })), text, catalog, rt);
          reply = r.reply;
          toolsUsed = r.toolsUsed;
        } else {
          const r = await runFallback(text, rt);
          reply = r.reply;
          toolsUsed = r.toolsUsed;
          understood = r.understood;
        }
      } catch (e) {
        logError('conversation.brain', e, { conversationId });
        if (rt.mutated) {
          // The model already changed the order before failing; re-parsing the message could apply it twice.
          reply = `${rt.lastMessage || "I've updated your order."} ${rt.order.lines.length ? `Your total is now ${rt.order.display.total}.` : ''} Anything else?`.replace(/\s+/g, ' ');
          toolsUsed = ['partial'];
        } else if (geminiEnabled()) {
          // Language model unavailable (quota/network): degrade to the deterministic parser for this turn.
          try {
            const r = await runFallback(text, rt);
            reply = r.reply;
            toolsUsed = r.toolsUsed;
            understood = r.understood;
          } catch (e2) {
            logError('conversation.fallback', e2, { conversationId });
            reply = 'Sorry, something went wrong on my side. Could you say that again?';
            understood = false;
          }
        } else {
          reply = 'Sorry, something went wrong on my side. Could you say that again?';
          understood = false;
        }
      }
    }

    ctx.misunderstandings = understood ? 0 : (ctx.misunderstandings ?? 0) + 1;
    if (!escalateReason && ctx.misunderstandings >= MISUNDERSTANDING_LIMIT) {
      escalateReason = 'Repeated misunderstanding';
      reply = "I'm sorry, I'm having trouble understanding. Let me connect you with a team member who can help.";
      rt.stateHint = 'ESCALATED';
    }
    escalateReason ??= rt.escalation;

    const finalState = escalateReason ? 'ESCALATED' : rt.stateHint;
    const latest = await getOrderView(c.orderId);

    await prisma.$transaction(async (tx) => {
      await tx.conversationMessage.create({
        data: { conversationId, speaker: 'AGENT', text: reply.slice(0, 2000), intent: toolsUsed.join(',') || (understood ? 'CHAT' : 'UNKNOWN'), entities: { tools: toolsUsed } },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          state: finalState,
          context: JSON.parse(JSON.stringify(rt.ctx)),
          endedAt: ['COMPLETED', 'CANCELLED'].includes(finalState) ? new Date() : null,
        },
      });
      if (escalateReason) {
        await tx.escalation.create({
          data: {
            conversationId,
            reason: escalateReason,
            snapshot: JSON.parse(JSON.stringify({ order: latest, recentMessages: [...history.map((m) => ({ speaker: m.speaker, text: m.text })), { speaker: 'CUSTOMER', text }, { speaker: 'AGENT', text: reply }] })),
          },
        });
        await tx.orderEvent.create({ data: { orderId: c.orderId, type: 'ESCALATED', payload: { reason: escalateReason }, actor: 'SYSTEM' } });
      }
    });

    return respond(conversationId, c.orderId, finalState, reply, !!escalateReason);
  });
}

async function respond(conversationId: string, orderId: string, state: string, reply: string, escalated = state === 'ESCALATED') {
  return { reply, state, escalated, order: await getOrderView(orderId), conversationId };
}

/** Button-driven confirm/cancel from the UI. Same engine checks as the conversational path. */
export async function confirmFromUi(conversationId: string, token: string, expectedVersion: number) {
  const c = await authorize(conversationId, token);
  return serialize(conversationId, async () => {
    const catalog = await loadCatalog(c.restaurantId);
    const outcome = await runCommand(c.orderId, { type: 'CONFIRM_ORDER', expectedVersion }, 'CUSTOMER', catalog);
    await finishConversation(conversationId, 'COMPLETED', `Order confirmed. Total ${outcome.order.display.total}. Thank you!`);
    return { order: outcome.order, state: 'COMPLETED', message: outcome.message };
  });
}

export async function cancelFromUi(conversationId: string, token: string) {
  const c = await authorize(conversationId, token);
  return serialize(conversationId, async () => {
    const catalog = await loadCatalog(c.restaurantId);
    const outcome = await runCommand(c.orderId, { type: 'CANCEL_ORDER' }, 'CUSTOMER', catalog);
    await finishConversation(conversationId, 'CANCELLED', 'Your order has been cancelled.');
    return { order: outcome.order, state: 'CANCELLED', message: outcome.message };
  });
}

async function finishConversation(conversationId: string, state: 'COMPLETED' | 'CANCELLED', text: string) {
  await prisma.$transaction([
    prisma.conversation.update({ where: { id: conversationId }, data: { state, endedAt: new Date() } }),
    prisma.conversationMessage.create({ data: { conversationId, speaker: 'SYSTEM', text, intent: state } }),
  ]);
}

export { orderInclude };
