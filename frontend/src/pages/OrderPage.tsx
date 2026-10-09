import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from '../api';
import { MenuPanel } from '../components/MenuPanel';
import { Ticket } from '../components/Ticket';
import { safeStorage } from '../format';
import { speak, speechInputSupported, speechOutputSupported, stopSpeaking, useSpeechInput } from '../speech';
import type { ConversationState, MenuData, Message, Order } from '../types';

const store = safeStorage();
const KEY = 'ordertaker.session';
const MAX_LEN = 500;
const CLOSE_DELAY_S = 5;
const SUGGESTIONS = ['What burgers do you have?', 'Two paneer tikka burgers please', "What's my total?", "That's all"];

interface Session {
  id: string;
  token: string;
}

export default function OrderPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState('GREETING');
  const [restaurant, setRestaurant] = useState('Green Spoon Kitchen');
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ text: string; message: string } | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [input, setInput] = useState('');
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [tab, setTab] = useState<'order' | 'menu'>('menu');
  const [closeIn, setCloseIn] = useState<number | null>(null); // seconds left before the finished chat closes
  const [closed, setClosed] = useState(false);
  const sendingRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const apply = (c: ConversationState) => {
    setMessages(c.messages);
    setOrder(c.order);
    setState(c.state);
    setRestaurant(c.restaurant.name);
  };

  const begin = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    try {
      const saved = store.get(KEY);
      if (saved) {
        try {
          const s = JSON.parse(saved) as Session;
          const c = await api.get(s.id, s.token);
          setSession(s);
          apply(c);
          return;
        } catch (e) {
          if (!(e instanceof ApiFailure) || e.status === 0) throw e;
          store.remove(KEY);
        }
      }
      const c = await api.start();
      const s = { id: c.conversationId, token: c.token };
      store.set(KEY, JSON.stringify(s));
      setSession(s);
      apply(c);
    } catch (e) {
      setFatal(e instanceof ApiFailure ? e.message : 'Could not start the assistant.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void begin();
  }, [begin]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  const loadMenu = useCallback(async () => {
    try {
      setMenu(await api.menu());
      setMenuError(null);
    } catch (e) {
      setMenuError(e instanceof ApiFailure ? e.message : 'Could not load the menu.');
    }
  }, []);

  useEffect(() => {
    void loadMenu();
    const t = setInterval(() => {
      if (!document.hidden) void loadMenu();
    }, 30000);
    return () => clearInterval(t);
  }, [loadMenu]);

  const terminal = state === 'COMPLETED' || state === 'CANCELLED';
  // Chat input locks as soon as the order is finished; the panel switches to its closed view after a short pause.
  const ended = terminal;

  useEffect(() => {
    if (!terminal) {
      setCloseIn(null);
      setClosed(false);
      return;
    }
    if (closed) return;
    // A conversation that was already finished when the page loaded closes immediately.
    if (closeIn === null) {
      setCloseIn(loading ? 0 : CLOSE_DELAY_S);
      return;
    }
    if (closeIn <= 0) {
      setClosed(true);
      return;
    }
    const t = setTimeout(() => setCloseIn((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [terminal, closeIn, closed, loading]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!session || !text || sendingRef.current || ended) return;
      if (text.length > MAX_LEN) return setSendError({ text, message: `Please keep messages under ${MAX_LEN} characters.` });
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      setInput('');
      stopSpeaking();
      const tempId = `tmp-${Date.now()}`;
      setMessages((m) => [...m, { id: tempId, speaker: 'CUSTOMER', text, createdAt: new Date().toISOString() }]);
      try {
        const r = await api.send(session.id, session.token, text);
        setMessages((m) => [...m, { id: `a-${Date.now()}`, speaker: 'AGENT', text: r.reply, createdAt: new Date().toISOString() }]);
        setOrder(r.order);
        setState(r.state);
        if (voiceReplies) speak(r.reply);
        void loadMenu();
      } catch (e) {
        setMessages((m) => m.filter((x) => x.id !== tempId));
        if (e instanceof ApiFailure && e.status === 404) {
          store.remove(KEY);
          setFatal('This session has expired. Please start again.');
        } else {
          setSendError({ text, message: e instanceof ApiFailure ? e.message : 'Message failed to send.' });
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [session, ended, voiceReplies, loadMenu],
  );

  const speech = useSpeechInput((t) => void send(t));

  const confirm = async () => {
    if (!session || !order || ticketBusy) return;
    setTicketBusy(true);
    setTicketError(null);
    try {
      const r = await api.confirm(session.id, session.token, order.version);
      setOrder(r.order);
      setState(r.state);
      setMessages((m) => [...m, { id: `s-${Date.now()}`, speaker: 'SYSTEM', text: `Order confirmed. Total ${r.order.display.total}. Thank you!`, createdAt: new Date().toISOString() }]);
    } catch (e) {
      setTicketError(e instanceof ApiFailure ? e.message : 'Could not confirm the order.');
      try {
        const c = await api.get(session.id, session.token);
        setOrder(c.order);
      } catch {
        /* keep current view */
      }
    } finally {
      setTicketBusy(false);
    }
  };

  const cancel = async () => {
    if (!session || ticketBusy) return;
    setTicketBusy(true);
    setTicketError(null);
    try {
      const r = await api.cancel(session.id, session.token);
      setOrder(r.order);
      setState(r.state);
      setMessages((m) => [...m, { id: `s-${Date.now()}`, speaker: 'SYSTEM', text: 'Your order has been cancelled.', createdAt: new Date().toISOString() }]);
    } catch (e) {
      setTicketError(e instanceof ApiFailure ? e.message : 'Could not cancel the order.');
    } finally {
      setTicketBusy(false);
    }
  };

  const newOrder = () => {
    store.remove(KEY);
    setSession(null);
    setMessages([]);
    setOrder(null);
    setState('GREETING');
    setTicketError(null);
    setCloseIn(null);
    setClosed(false);
    void begin();
  };

  if (loading) return <div className="center-screen" role="status">Setting the table…</div>;
  if (fatal || !session)
    return (
      <div className="center-screen">
        <p role="alert" className="error-text">{fatal ?? 'Something went wrong.'}</p>
        <button className="btn btn-primary" onClick={newOrder}>Try again</button>
      </div>
    );

  const unavailable = new Set<string>();
  if (menu && order) {
    const off = new Set([...menu.categories.flatMap((c) => c.products), ...menu.combos].filter((p) => !p.available).map((p) => p.id));
    for (const l of order.lines) if ((l.productId && off.has(l.productId)) || (l.comboId && off.has(l.comboId))) unavailable.add(l.lineRef);
  }

  const itemCount = order?.lines.reduce((s, l) => s + l.quantity, 0) ?? 0;

  return (
    <div className="order-layout">
      <section className="chat" aria-label="Chat with the order assistant">
        <header className="chat-head">
          <div>
            <h1>{restaurant}</h1>
            <p className="muted">Pickup orders · vegetarian kitchen</p>
          </div>
          {speechOutputSupported() && (
            <button
              className={`btn btn-secondary btn-sm ${voiceReplies ? 'is-on' : ''}`}
              aria-pressed={voiceReplies}
              onClick={() => { setVoiceReplies((v) => !v); stopSpeaking(); }}
            >
              {voiceReplies ? '🔊 Voice on' : '🔈 Voice off'}
            </button>
          )}
        </header>

        <button className="mobile-ticket-toggle" aria-expanded={ticketOpen} onClick={() => setTicketOpen((o) => !o)}>
          <span>Your order · {itemCount} item{itemCount === 1 ? '' : 's'}</span>
          <strong>{order?.display.total ?? '₹0'}</strong>
        </button>

        {terminal && !closed && (
          <div className="banner" role="status">
            {state === 'COMPLETED' ? 'Your order is placed!' : 'Order cancelled.'} This chat will close in {closeIn ?? CLOSE_DELAY_S}s…
          </div>
        )}
        {closed && <div className="banner" role="status">This chat has ended. Start a new order any time.</div>}

        {state === 'ESCALATED' && (
          <div className="banner" role="status">A team member has been notified and will take over. Your order details have been passed along.</div>
        )}

        <div className="messages" role="log" aria-live="polite">
          {messages.map((m) => (
            <div key={m.id} className={`bubble bubble-${m.speaker.toLowerCase()}`}>
              {m.text.split('\n').map((line, i) => (
                <span key={i}>{line}<br /></span>
              ))}
            </div>
          ))}
          {sending && (
            <div className="bubble bubble-agent typing" aria-label="Assistant is typing"><i /><i /><i /></div>
          )}
          <div ref={endRef} />
        </div>

        {sendError && (
          <div className="send-error" role="alert">
            <span>{sendError.message}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => void send(sendError.text)}>Retry</button>
          </div>
        )}
        {speech.error && <div className="send-error" role="alert">{speech.error}</div>}

        {!ended && (
          <div className="chips-row">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggest" disabled={sending} onClick={() => void send(s)}>{s}</button>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
        >
          <textarea
            ref={inputRef}
            value={speech.listening ? speech.interim : input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
            }}
            placeholder={ended ? (closed ? 'This chat has ended' : 'Closing shortly…') : 'Type or tap the mic to order…'}
            aria-label="Your message"
            maxLength={MAX_LEN}
            rows={1}
            disabled={ended || sending || speech.listening}
          />
          {speechInputSupported() && (
            <button
              type="button"
              className={`mic ${speech.listening ? 'mic-live' : ''}`}
              aria-label={speech.listening ? 'Stop listening' : 'Speak your order'}
              aria-pressed={speech.listening}
              disabled={ended || sending}
              onClick={() => (speech.listening ? speech.stop() : speech.start())}
            >
              🎤
            </button>
          )}
          <button className="btn btn-primary" type="submit" disabled={ended || sending || !input.trim()}>
            {sending ? '…' : 'Send'}
          </button>
        </form>
      </section>

      <aside className={`ticket-wrap ${ticketOpen ? 'open' : ''}`}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'menu'} className={tab === 'menu' ? 'tab on' : 'tab'} onClick={() => setTab('menu')}>
            Menu
          </button>
          <button role="tab" aria-selected={tab === 'order'} className={tab === 'order' ? 'tab on' : 'tab'} onClick={() => setTab('order')}>
            Your order{itemCount > 0 && <span className="badge">{itemCount}</span>}
          </button>
        </div>
        {tab === 'menu' ? (
          <MenuPanel
            menu={menu}
            error={menuError}
            disabled={ended || sending}
            onAdd={(name) => {
              void send(`Add ${name}`);
            }}
            onRetry={() => void loadMenu()}
          />
        ) : (
          <Ticket
            order={order}
            ended={closed}
            busy={ticketBusy || (terminal && !closed)}
            error={ticketError}
            unavailable={unavailable}
            onConfirm={() => void confirm()}
            onCancel={() => void cancel()}
            onNewOrder={newOrder}
          />
        )}
      </aside>
    </div>
  );
}
