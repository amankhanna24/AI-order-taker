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
const SUGGESTIONS = ['What burgers do you have?', 'A Classic Combo please', 'Two zinger burgers, one without onions', "That's all"];

/** Hands-free call timing: how long a pause ends the customer's turn, how long silence means they left. */
const SILENCE_MS = 1300;
const IDLE_MS = 9000;
const MAX_IDLE_ROUNDS = 3;

type Phase = 'off' | 'listening' | 'thinking' | 'speaking';
const PHASE_LABEL: Record<Phase, string> = { off: '', listening: 'Listening…', thinking: 'One moment…', speaking: 'Speaking…' };

interface Session {
  id: string;
  token: string;
}

export default function OrderPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState('GREETING');
  const [restaurant, setRestaurant] = useState('Smash & Go');
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
  const [call, setCall] = useState<Phase>('off');
  const [callNote, setCallNote] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const callRef = useRef<Phase>('off');
  const idleRounds = useRef(0);

  const setPhase = useCallback((p: Phase) => {
    callRef.current = p;
    setCall(p);
  }, []);

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

  /** Sends one customer message. Resolves with the agent's reply, or null if nothing was sent / it failed. */
  const send = useCallback(
    async (raw: string): Promise<{ reply: string; state: string } | null> => {
      const text = raw.trim();
      if (!session || !text || sendingRef.current || ended) return null;
      if (text.length > MAX_LEN) {
        setSendError({ text, message: `Please keep messages under ${MAX_LEN} characters.` });
        return null;
      }
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
        if (voiceReplies && callRef.current === 'off') speak(r.reply); // during a call the call flow does the talking
        void loadMenu();
        return { reply: r.reply, state: r.state };
      } catch (e) {
        setMessages((m) => m.filter((x) => x.id !== tempId));
        if (e instanceof ApiFailure && e.status === 404) {
          store.remove(KEY);
          setFatal('This session has expired. Please start again.');
        } else {
          setSendError({ text, message: e instanceof ApiFailure ? e.message : 'Message failed to send.' });
        }
        return null;
      } finally {
        sendingRef.current = false;
        setSending(false);
        if (callRef.current === 'off') inputRef.current?.focus();
      }
    },
    [session, ended, voiceReplies, loadMenu],
  );

  /* ---------- hands-free call ---------- */

  const speechRef = useRef<ReturnType<typeof useSpeechInput> | null>(null);

  const listen = useCallback(() => {
    if (callRef.current === 'off') return;
    setPhase('listening');
    speechRef.current?.start(true);
  }, [setPhase]);

  const talk = useCallback(
    (text: string, then: () => void) => {
      if (callRef.current === 'off') return;
      setPhase('speaking');
      speak(text, then);
    },
    [setPhase],
  );

  const hangUp = useCallback(
    (note?: string) => {
      setPhase('off');
      stopSpeaking();
      speechRef.current?.cancel();
      setCallNote(note ?? null);
    },
    [setPhase],
  );

  const converse = async (text: string) => {
    setPhase('thinking');
    const r = await send(text);
    if (callRef.current === 'off') return;
    if (!r) return talk('Sorry, I had trouble with that. Could you say it again?', listen);
    const finished = r.state === 'COMPLETED' || r.state === 'CANCELLED' || r.state === 'ESCALATED';
    talk(r.reply, finished ? () => hangUp() : listen);
  };

  const onHeard = (text: string) => {
    if (callRef.current === 'off') return void send(text);
    idleRounds.current = 0;
    void converse(text);
  };

  const onIdle = () => {
    if (callRef.current === 'off') return;
    idleRounds.current += 1;
    if (idleRounds.current >= MAX_IDLE_ROUNDS)
      return talk("I haven't heard anything, so I'll end the call for now. Call back any time.", () => hangUp('Call ended: no speech was heard.'));
    talk(idleRounds.current === 1 ? 'Are you still there?' : "I'm still here whenever you're ready.", listen);
  };

  const speech = useSpeechInput(onHeard, { silenceMs: SILENCE_MS, idleMs: IDLE_MS, onIdle });
  useEffect(() => {
    speechRef.current = speech;
  });

  const startCall = () => {
    if (!session || ended || callRef.current !== 'off') return;
    idleRounds.current = 0;
    setCallNote(null);
    setSendError(null);
    const last = [...messages].reverse().find((m) => m.speaker === 'AGENT')?.text;
    setPhase('speaking');
    speak(last ?? `Hi, welcome to ${restaurant}. What can I get started for you today?`, listen);
  };

  const skipSpeaking = () => {
    stopSpeaking();
    listen();
  };

  // Hang up if the microphone fails, the session dies, or the page goes away.
  useEffect(() => {
    if (speech.error && callRef.current !== 'off') hangUp();
  }, [speech.error, hangUp]);
  useEffect(() => {
    if (fatal) hangUp();
  }, [fatal, hangUp]);
  useEffect(
    () => () => {
      callRef.current = 'off';
      stopSpeaking();
    },
    [],
  );

  const confirm = async () => {
    if (!session || !order || ticketBusy) return;
    setTicketBusy(true);
    setTicketError(null);
    try {
      const r = await api.confirm(session.id, session.token, order.version);
      setOrder(r.order);
      setState(r.state);
      setMessages((m) => [...m, { id: `s-${Date.now()}`, speaker: 'SYSTEM', text: `Order confirmed. Total ${r.order.display.total}. Thank you!`, createdAt: new Date().toISOString() }]);
      if (callRef.current !== 'off') talk(`Your order is confirmed. That's ${r.order.display.total}. Thank you, see you soon!`, () => hangUp());
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
      if (callRef.current !== 'off') hangUp();
    } catch (e) {
      setTicketError(e instanceof ApiFailure ? e.message : 'Could not cancel the order.');
    } finally {
      setTicketBusy(false);
    }
  };

  const newOrder = () => {
    hangUp();
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

  if (loading) return <div className="center-screen" role="status">Warming up the grill…</div>;
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
  const inCall = call !== 'off';
  const canCall = speechInputSupported();

  return (
    <div className="order-layout">
      <section className="chat" aria-label="Talk to the order assistant">
        <header className="chat-head">
          <div>
            <h1>{restaurant}</h1>
            <p className="muted">Cloud kitchen · pickup orders · prices in AED</p>
          </div>
          <div className="head-actions">
            {!inCall && speechOutputSupported() && (
              <button
                className={`btn btn-secondary btn-sm ${voiceReplies ? 'is-on' : ''}`}
                aria-pressed={voiceReplies}
                onClick={() => { setVoiceReplies((v) => !v); stopSpeaking(); }}
              >
                {voiceReplies ? '🔊 Voice on' : '🔈 Voice off'}
              </button>
            )}
            {canCall && !inCall && (
              <button className="btn btn-primary btn-sm" disabled={ended || sending} onClick={startCall}>
                📞 Order by voice
              </button>
            )}
          </div>
        </header>

        <button className="mobile-ticket-toggle" aria-expanded={ticketOpen} onClick={() => setTicketOpen((o) => !o)}>
          <span>Your order · {itemCount} item{itemCount === 1 ? '' : 's'}</span>
          <strong>{order?.display.total ?? 'AED 0'}</strong>
        </button>

        {inCall && (
          <div className={`call-panel call-${call}`} role="status" aria-live="polite">
            <span className="call-orb" aria-hidden="true" />
            <div className="call-text">
              <strong>{PHASE_LABEL[call]}</strong>
              <span className="muted tiny">
                {call === 'listening' ? speech.interim || 'Go ahead, I’m listening. Pause when you’re done.' : call === 'thinking' ? 'Updating your order' : 'You can tap Skip to answer right away'}
              </span>
            </div>
            <div className="call-actions">
              {call === 'listening' && speech.interim && <button className="btn btn-secondary btn-sm" onClick={speech.stop}>Send now</button>}
              {call === 'speaking' && <button className="btn btn-secondary btn-sm" onClick={skipSpeaking}>Skip</button>}
              <button className="btn btn-danger btn-sm" onClick={() => hangUp()}>Hang up</button>
            </div>
          </div>
        )}
        {!inCall && callNote && <div className="banner" role="status">{callNote}</div>}
        {!canCall && !ended && (
          <p className="muted tiny">Voice ordering needs Chrome, Edge or Safari with a microphone. You can still type your order below.</p>
        )}

        {terminal && !closed && (
          <div className="banner" role="status">
            {state === 'COMPLETED' ? 'Your order is placed!' : 'Order cancelled.'} This chat will close in {closeIn ?? CLOSE_DELAY_S}s…
          </div>
        )}
        {closed && <div className="banner" role="status">This conversation has ended. Start a new order any time.</div>}

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

        {!ended && !inCall && (
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
            placeholder={ended ? (closed ? 'This conversation has ended' : 'Closing shortly…') : inCall ? 'On a call: just speak' : 'Type your order, or use the mic…'}
            aria-label="Your message"
            maxLength={MAX_LEN}
            rows={1}
            disabled={ended || sending || speech.listening || inCall}
          />
          {canCall && (
            <button
              type="button"
              className={`mic ${speech.listening ? 'mic-live' : ''}`}
              aria-label={speech.listening ? 'Stop listening' : 'Dictate your order'}
              aria-pressed={speech.listening}
              disabled={ended || sending || inCall}
              onClick={() => (speech.listening ? speech.stop() : speech.start())}
            >
              🎤
            </button>
          )}
          <button className="btn btn-primary" type="submit" disabled={ended || sending || inCall || !input.trim()}>
            {sending ? '…' : 'Send'}
          </button>
        </form>
      </section>

      <aside className={`ticket-wrap ${ticketOpen ? 'open' : ''}`}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'order'} className={tab === 'order' ? 'tab on' : 'tab'} onClick={() => setTab('order')}>
            Your order{itemCount > 0 && <span className="badge">{itemCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'menu'} className={tab === 'menu' ? 'tab on' : 'tab'} onClick={() => setTab('menu')}>
            Menu
          </button>
        </div>
        {tab === 'menu' ? (
          <MenuPanel
            menu={menu}
            error={menuError}
            disabled={ended || sending || inCall}
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
