import { useEffect, useState } from 'react';
import { ApiFailure, api } from '../api';
import type { MenuData } from '../types';

export default function MenuPage() {
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api.menu().then(setMenu).catch((e) => setError(e instanceof ApiFailure ? e.message : 'Could not load the menu.'));
  };
  useEffect(load, []);

  if (error)
    return (
      <div className="center-screen">
        <p role="alert" className="error-text">{error}</p>
        <button className="btn btn-primary" onClick={load}>Retry</button>
      </div>
    );
  if (!menu) return <div className="center-screen" role="status">Loading the menu…</div>;

  return (
    <main className="page">
      <h1>{menu.restaurant.name} menu</h1>
      {!menu.restaurant.orderingEnabled && <div className="banner">Ordering is paused right now.</div>}
      {menu.categories.map((c) => (
        <section key={c.name} className="menu-cat">
          <h2>{c.name}</h2>
          <ul className="menu-grid">
            {c.products.map((p) => (
              <li key={p.id} className={`card ${p.available ? '' : 'card-off'}`}>
                <div className="card-row">
                  <h3>{p.name}</h3>
                  <strong>{p.priceDisplay}</strong>
                </div>
                {p.description && <p className="muted">{p.description}</p>}
                <div className="chips">
                  <span className="chip chip-green">{p.vegan ? 'Vegan' : 'Vegetarian'}</span>
                  {p.allergens && p.allergens.length > 0 && <span className="chip">Contains: {p.allergens.map((a) => a.replace('_', ' ').toLowerCase()).join(', ')}</span>}
                  {p.allergens === null && <span className="chip chip-warn">Allergen info: ask staff</span>}
                  {!p.available && <span className="chip chip-remove">{p.unavailableReason ?? 'Unavailable'}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {menu.combos.length > 0 && (
        <section className="menu-cat">
          <h2>Combos</h2>
          <ul className="menu-grid">
            {menu.combos.map((c) => (
              <li key={c.id} className={`card ${c.available ? '' : 'card-off'}`}>
                <div className="card-row"><h3>{c.name}</h3><strong>{c.priceDisplay}</strong></div>
                {!c.available && <span className="chip chip-remove">Unavailable</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
