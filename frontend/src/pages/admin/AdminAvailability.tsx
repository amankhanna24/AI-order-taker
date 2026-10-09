import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ApiFailure, api, type AdminMenu } from '../../api';
import type { AdminCtx } from './AdminLayout';

export default function AdminAvailability() {
  const { adminKey, lock } = useOutletContext<AdminCtx>();
  const [menu, setMenu] = useState<AdminMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiFailure && err.status === 401) return lock('That admin key was not accepted.');
      setError(err instanceof ApiFailure ? err.message : fallback);
    },
    [lock],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      setMenu(await api.admin.menu(adminKey));
    } catch (err) {
      fail(err, 'Could not load the menu.');
    } finally {
      setLoading(false);
    }
  }, [adminKey, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      fail(err, 'Update failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && <p role="alert" className="error-text">{error}</p>}
      {loading && !menu && <p role="status">Loading…</p>}

      {menu && (
        <section className="card stack">
          <h2>Restaurant</h2>
          <div className="card-row">
            <label className="field-label">
              Status
              <select
                value={menu.restaurant.status}
                disabled={busy !== null}
                onChange={(e) => void run('status', () => api.admin.setRestaurant(adminKey, { status: e.target.value }))}
              >
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
                <option value="TEMPORARILY_UNAVAILABLE">Temporarily unavailable</option>
              </select>
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={menu.restaurant.orderingEnabled}
                disabled={busy !== null}
                onChange={(e) => void run('ordering', () => api.admin.setRestaurant(adminKey, { orderingEnabled: e.target.checked }))}
              />
              Ordering enabled
            </label>
          </div>
        </section>
      )}

      {menu && (
        <section className="card stack">
          <h2>Item availability</h2>
          {menu.categories.map((c) => (
            <div key={c.id}>
              <h3>{c.name}</h3>
              <ul className="admin-list">
                {c.products.map((p) => (
                  <li key={p.id} className="card-row">
                    <span>{p.name}{!p.allergenInfoVerified && <span className="chip chip-warn">allergens unverified</span>}</span>
                    <label className="switch-row">
                      <input type="checkbox" checked={p.available} disabled={busy !== null} onChange={(e) => void run(p.id, () => api.admin.setAvailability(adminKey, 'products', p.id, e.target.checked))} />
                      {p.available ? 'Available' : 'Sold out'}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <h3>Combos</h3>
          <ul className="admin-list">
            {menu.combos.map((c) => (
              <li key={c.id} className="card-row">
                <span>{c.name}</span>
                <label className="switch-row">
                  <input type="checkbox" checked={c.available} disabled={busy !== null} onChange={(e) => void run(c.id, () => api.admin.setAvailability(adminKey, 'combos', c.id, e.target.checked))} />
                  {c.available ? 'Available' : 'Sold out'}
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
