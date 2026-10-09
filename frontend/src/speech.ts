import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

const getCtor = (): RecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export const speechInputSupported = () => typeof window !== 'undefined' && getCtor() !== null;
export const speechOutputSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

const LANG = 'en-US';

const FATAL: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied.',
  'service-not-allowed': 'Microphone permission was denied.',
  'audio-capture': 'No microphone was found.',
  network: 'Voice input needs an internet connection. Please type instead.',
  'language-not-supported': 'Voice input is not available for this language. Please type instead.',
};

export interface SpeechInputOptions {
  /** Hands-free: once the customer has said something, send it after this much silence (ms). 0 = wait for stop(). */
  silenceMs?: number;
  /** Hands-free: give up if nothing at all is heard for this long (ms) and call onIdle. 0 = never. */
  idleMs?: number;
  onIdle?: () => void;
}

/**
 * Speech input. Keeps listening (restarting the browser recogniser when it times out) until the customer taps
 * stop, pauses long enough (hands-free mode), or stays silent too long; the whole utterance is then handed to onFinal.
 */
export function useSpeechInput(onFinal: (text: string) => void, options: SpeechInputOptions = {}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<RecognitionLike | null>(null);
  const want = useRef(false);
  const finals = useRef('');
  const live = useRef('');
  const quickEnds = useRef(0);
  const silenceTimer = useRef<number | undefined>(undefined);
  const idleTimer = useRef<number | undefined>(undefined);
  const idleFired = useRef(false);
  const hands = useRef(false); // hands-free turn: a pause ends it, long silence gives up
  const discard = useRef(false); // hang-up: drop whatever was half-heard
  const cb = useRef(onFinal);
  const opts = useRef(options);
  useEffect(() => {
    cb.current = onFinal;
    opts.current = options;
  });

  const clearTimers = useCallback(() => {
    window.clearTimeout(silenceTimer.current);
    window.clearTimeout(idleTimer.current);
  }, []);

  const finish = useCallback(() => {
    clearTimers();
    want.current = false;
    rec.current = null;
    setListening(false);
    setInterim('');
    const text = `${finals.current} ${live.current}`.trim();
    const idle = idleFired.current;
    finals.current = '';
    live.current = '';
    idleFired.current = false;
    if (discard.current) {
      discard.current = false;
      return;
    }
    if (text) cb.current(text);
    else if (idle) opts.current.onIdle?.();
  }, [clearTimers]);

  useEffect(
    () => () => {
      want.current = false;
      clearTimers();
      const r = rec.current;
      rec.current = null;
      if (r) {
        r.onend = null;
        r.onerror = null;
        r.onresult = null;
        r.abort();
      }
    },
    [clearTimers],
  );

  const stop = useCallback(() => {
    want.current = false;
    rec.current?.stop();
  }, []);

  const begin = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return false;
    const r = new Ctor();
    r.lang = LANG;
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    const startedAt = Date.now();
    r.onresult = (e) => {
      let f = '';
      let i2 = '';
      for (let i = 0; i < e.results.length; i++) {
        const seg = e.results[i][0].transcript;
        if (e.results[i].isFinal) f += `${seg} `;
        else i2 += seg;
      }
      live.current = i2;
      const heard = `${finals.current} ${f}${i2}`.trim();
      setInterim(heard);
      // finals from this recogniser session are re-sent in full on every event
      (r as unknown as { _f: string })._f = f;
      window.clearTimeout(idleTimer.current); // they are talking
      window.clearTimeout(silenceTimer.current);
      const pause = hands.current ? (opts.current.silenceMs ?? 0) : 0;
      if (pause > 0 && heard) silenceTimer.current = window.setTimeout(stop, pause); // hands-free: a pause ends the turn
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // keep listening; onend restarts
      setError(FATAL[e.error] ?? 'Voice input failed. Please type instead.');
      want.current = false;
    };
    r.onend = () => {
      if (rec.current !== r) return; // superseded or unmounted
      finals.current = `${finals.current} ${(r as unknown as { _f?: string })._f || live.current}`.trim();
      live.current = '';
      if (!want.current) return finish();
      quickEnds.current = Date.now() - startedAt < 1000 ? quickEnds.current + 1 : 0;
      if (quickEnds.current >= 3) {
        setError('Voice input stopped unexpectedly. Please type instead.');
        return finish();
      }
      setTimeout(() => {
        if (!want.current) return finish();
        try {
          const next = begin();
          if (!next) finish();
        } catch {
          setError('Could not restart the microphone.');
          finish();
        }
      }, 150);
    };
    rec.current = r;
    r.start();
    return true;
  }, [finish, stop]);

  const start = useCallback((handsFree = false) => {
    if (!getCtor()) return setError('Voice input is not supported in this browser. Please type instead.');
    if (want.current) return;
    stopSpeaking(); // the assistant's own voice would otherwise be picked up as input
    setError(null);
    finals.current = '';
    live.current = '';
    quickEnds.current = 0;
    idleFired.current = false;
    discard.current = false;
    hands.current = handsFree;
    want.current = true;
    try {
      begin();
      setListening(true);
      const idle = handsFree ? (opts.current.idleMs ?? 0) : 0;
      if (idle > 0)
        idleTimer.current = window.setTimeout(() => {
          idleFired.current = true;
          stop();
        }, idle);
    } catch {
      want.current = false;
      setError('Could not start the microphone.');
    }
  }, [begin, stop]);

  /** Stop listening and throw away anything heard so far (used when hanging up). */
  const cancel = useCallback(() => {
    discard.current = true;
    stop();
  }, [stop]);

  return { listening, interim, error, start, stop, cancel };
}

/* ---------- speaking ---------- */

/** "AED 28" -> "28 dirhams", strips line refs and symbols that text-to-speech would read out loud. */
export function toSpeakable(text: string): string {
  return text
    .replace(/AED\s?(\d+)(?:\.(\d{1,2}))?/g, (_m, whole: string, frac?: string) => {
      const d = Number(whole);
      const dirhams = `${whole} ${d === 1 ? 'dirham' : 'dirhams'}`;
      const fils = frac ? Number(frac.padEnd(2, '0')) : 0;
      return fils ? `${dirhams} and ${fils} fils` : dirhams;
    })
    .replace(/line_\d+:?/g, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s*×\s*/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

let generation = 0; // bumped on every speak/stop so an interrupted utterance never fires its completion callback
let preferred: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
  if (preferred !== undefined && preferred !== null) return preferred;
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
  preferred =
    voices.find((v) => /natural|neural|google us english|samantha|jenny|aria/i.test(v.name)) ??
    voices.find((v) => v.lang === LANG) ??
    voices[0] ??
    null;
  return preferred;
}

/** Speak `text`; `onDone` runs when it has finished (or immediately if speech is unavailable). Not called if interrupted. */
export function speak(text: string, onDone?: () => void) {
  const say = toSpeakable(text);
  if (!speechOutputSupported() || !say) {
    onDone?.();
    return;
  }
  const mine = ++generation;
  let ended = false;
  let guard: number | undefined;
  const end = () => {
    if (ended || mine !== generation) return;
    ended = true;
    window.clearTimeout(guard);
    onDone?.();
  };
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(say);
    u.lang = LANG;
    u.rate = 1.05;
    const v = pickVoice();
    if (v) u.voice = v;
    u.onend = end;
    u.onerror = end;
    // some browsers never fire onend; never leave a call stuck waiting for it
    guard = window.setTimeout(end, Math.max(4000, say.length * 120 + 2000));
    window.speechSynthesis.speak(u);
  } catch {
    end();
  }
}

export const stopSpeaking = () => {
  generation++;
  try {
    if (speechOutputSupported()) window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
};
