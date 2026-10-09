import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { safeStorage } from '../../format';

const store = safeStorage();
export const ADMIN_KEY = 'ordertaker.adminKey';

export interface AdminCtx {
  adminKey: string;
  /** Drop the stored key and return to the unlock screen (e.g. after a 401). */
  lock: (message?: string) => void;
}

export default function AdminLayout() {
  const [key, setKey] = useState(store.get(ADMIN_KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const lock = (message?: string) => {
    store.remove(ADMIN_KEY);
    setKey('');
    setNotice(message ?? null);
  };

  if (!key)
    return (
      <main className="page narrow">
        <h1>Staff console</h1>
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            const k = draft.trim();
            if (!k) return;
            store.set(ADMIN_KEY, k);
            setKey(k);
            setDraft('');
            setNotice(null);
          }}
        >
          <label htmlFor="adminKey">Admin key</label>
          <input id="adminKey" type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {notice && <p role="alert" className="error-text">{notice}</p>}
          <button className="btn btn-primary" disabled={!draft.trim()}>Unlock</button>
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
