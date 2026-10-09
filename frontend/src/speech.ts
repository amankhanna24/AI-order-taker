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

const FATAL: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied.',
  'service-not-allowed': 'Microphone permission was denied.',
  'audio-capture': 'No microphone was found.',
  network: 'Voice input needs an internet connection. Please type instead.',
  'language-not-supported': 'Voice input is not available for this language. Please type instead.',
};

/**
 * Speech input. Keeps listening (restarting the browser recogniser when it times out)
 * until the customer taps stop; the whole utterance is then handed to onFinal.
 */
export function useSpeechInput(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<RecognitionLike | null>(null);
  const want = useRef(false);
  const finals = useRef('');
  const live = useRef('');
  const quickEnds = useRef(0);
  const cb = useRef(onFinal);
  useEffect(() => {
    cb.current = onFinal;
  }, [onFinal]);

  const finish = useCallback(() => {
    want.current = false;
    rec.current = null;
    setListening(false);
    setInterim('');
    const text = `${finals.current} ${live.current}`.trim();
    finals.current = '';
    live.current = '';
    if (text) cb.current(text);
  }, []);

  useEffect(
    () => () => {
      want.current = false;
      const r = rec.current;
      rec.current = null;
      if (r) {
        r.onend = null;
        r.onerror = null;
        r.onresult = null;
        r.abort();
      }
    },
    [],
  );

  const begin = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return false;
    const r = new Ctor();
    r.lang = 'en-IN';
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
      setInterim(`${finals.current} ${f}${i2}`.trim());
      // finals from this recogniser session are re-sent in full on every event
      (r as unknown as { _f: string })._f = f;
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
  }, [finish]);

  const start = useCallback(() => {
    if (!getCtor()) return setError('Voice input is not supported in this browser. Please type instead.');
    if (want.current) return;
    stopSpeaking(); // the assistant's own voice would otherwise be picked up as input
    setError(null);
    finals.current = '';
    live.current = '';
    quickEnds.current = 0;
    want.current = true;
    try {
      begin();
      setListening(true);
    } catch {
      want.current = false;
      setError('Could not start the microphone.');
    }
  }, [begin]);

  const stop = useCallback(() => {
    want.current = false;
    rec.current?.stop();
  }, []);
  return { listening, interim, error, start, stop };
}

export function speak(text: string) {
  if (!speechOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/line_\d+:/g, '').replace(/₹/g, 'rupees '));
    u.lang = 'en-IN';
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* speech is best-effort */
  }
}
export const stopSpeaking = () => {
  try {
    if (speechOutputSupported()) window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
};
