import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ApiFailure, api } from '../../api';
import { safeStorage } from '../../format';

const store = safeStorage();
export const ADMIN_KEY = 'ordertaker.adminKey';

export interface AdminCtx {
  adminKey: string;
  /** Drop the stored key and return to the unlock screen (e.g. after a 401). */
  lock: (message?: string) => void;
}

/** Header values must be visible ASCII; anything else can never be a valid key (and would make fetch throw). */
const looksLikeKey = (k: string) => /^[\x21-\x7e]{1,200}$/.test(k);
const REJECTED = 'That admin key was not accepted.';

/**
 * The key is verified with the server before the console is shown, so a wrong key stays on this screen with an
 * error instead of unlocking pages that then fail with 401.
 */
export default function AdminLayout() {
  const [key, setKey] = useState(''); // only ever holds a key the server accepted
  const [checking, setChecking] = useState(() => !!store.get(ADMIN_KEY)); // re-verifying a key kept from earlier in this tab
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef(0);

  const verify = useCallback(async (candidate: string): Promise<'ok' | 'rejected' | 'unavailable'> => {
    if (!looksLikeKey(candidate)) return 'rejected';
    const id = ++attempt.current;
    try {
      await api.admin.session(candidate);
      return id === attempt.current ? 'ok' : 'rejected';
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) return 'rejected';
      setNotice(
        e instanceof ApiFailure && e.code === 'ADMIN_DISABLED'
          ? 'Staff access is not configured on the server.'
          : e instanceof ApiFailure && e.status === 429
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : e instanceof ApiFailure
              ? e.message
              : 'Could not verify the key. Please try again.',
      );
      return 'unavailable';
    }
  }, []);

  useEffect(() => {
    const saved = store.get(ADMIN_KEY);
    if (!saved) return;
    let live = true;
    void verify(saved).then((r) => {
      if (!live) return;
      if (r === 'ok') setKey(saved);
      else if (r === 'rejected') {
        store.remove(ADMIN_KEY);
        setNotice(REJECTED);
      }
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [verify]);

  const lock = useCallback((message?: string) => {
    attempt.current++;
    store.remove(ADMIN_KEY);
    setKey('');
    setNotice(message ?? null);
  }, []);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const k = draft.trim();
    if (!k || submitting) return;
    setSubmitting(true);
    setNotice(null);
    const r = await verify(k);
    setSubmitting(false);
    if (r === 'ok') {
      store.set(ADMIN_KEY, k);
      setKey(k);
      setDraft('');
    } else if (r === 'rejected') {
      setNotice(REJECTED);
      setDraft('');
    }
  };

  if (checking)
    return (
      <main className="page narrow">
        <h1>Staff console</h1>
        <p role="status">Checking access…</p>
      </main>
    );

  if (!key)
    return (
      <main className="page narrow">
        <h1>Staff console</h1>
        <form className="card stack" onSubmit={(e) => void unlock(e)} noValidate>
          <label htmlFor="adminKey">Admin key</label>
          <input
            id="adminKey"
            type="password"
            autoComplete="off"
            value={draft}
            maxLength={200}
            aria-invalid={!!notice}
            aria-describedby={notice ? 'adminKeyError' : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              if (notice) setNotice(null);
            }}
          />
          {notice && <p id="adminKeyError" role="alert" className="error-text">{notice}</p>}
          <button className="btn btn-primary" disabled={!draft.trim() || submitting}>{submitting ? 'Checking…' : 'Unlock'}</button>
        </form>
      </main>
    );

  return (
    <main className="page">
      <div className="card-row">
        <h1>Staff console</h1>
        <button className="btn btn-secondary btn-sm" onClick={() => lock()}>Lock</button>
      </div>
      <nav className="subnav" aria-label="Staff sections">
        <NavLink to="/staff/orders">Orders</NavLink>
        <NavLink to="/staff/menu">Menu</NavLink>
        <NavLink to="/staff/availability">Availability</NavLink>
      </nav>
      <Outlet context={{ adminKey: key, lock } satisfies AdminCtx} />
    </main>
  );
}
