import { useMemo, useState } from 'react';
import type { MenuData } from '../types';

interface Props {
  menu: MenuData | null;
  error: string | null;
  disabled: boolean;
  onAdd: (name: string) => void;
  onRetry: () => void;
}

const ALL = '__all__';
const COMBOS = '__combos__';

export function MenuPanel({ menu, error, disabled, onAdd, onRetry }: Props) {
  const [category, setCategory] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const q = query.trim().toLowerCase().slice(0, 60);

  const categories = useMemo(() => {
    if (!menu) return [];
    return menu.categories
      .map((c) => ({
        name: c.name,
        products: c.products.filter(
          (p) => !q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q),
        ),
      }))
      .filter((c) => c.products.length > 0);
  }, [menu, q]);

  const combos = useMemo(
    () => (menu ? menu.combos.filter((c) => !q || c.name.toLowerCase().includes(q)) : []),
    [menu, q],
  );

  if (error && !menu)
    return (
      <div className="ticket menu-panel">
        <p role="alert" className="error-text">{error}</p>
        <button className="btn btn-secondary btn-sm" onClick={onRetry}>Retry</button>
      </div>
    );
  if (!menu) return <div className="ticket menu-panel" role="status">Loading menu…</div>;

  const closed = !menu.restaurant.orderingEnabled || menu.restaurant.status !== 'OPEN';
  const tabNames = menu.categories.map((c) => c.name);
  const activeCategory =
    category === ALL || category === COMBOS || tabNames.includes(category) ? category : ALL;

  const visibleCategories = categories.filter((c) => activeCategory === ALL || activeCategory === c.name);
  const showCombos = combos.length > 0 && (activeCategory === ALL || activeCategory === COMBOS);
  const empty = visibleCategories.length === 0 && !showCombos;

  return (
    <section className="ticket menu-panel" aria-label="Menu">
      <header className="menu-top">
        <div className="ticket-head">
          <span className="label-ticket">Menu</span>
          {error && <span className="tiny error-text">Couldn't refresh</span>}
        </div>
        {closed && <div className="banner">The restaurant isn't taking orders right now.</div>}
        <input
          type="search"
          className="menu-search"
          placeholder="Search dishes…"
          aria-label="Search menu"
          maxLength={60}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="menu-cats" role="tablist" aria-label="Menu categories">
          {[
            { key: ALL, label: 'All' },
            ...tabNames.map((n) => ({ key: n, label: n })),
            ...(menu.combos.length > 0 ? [{ key: COMBOS, label: 'Combos' }] : []),
          ].map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={activeCategory === c.key}
              className={`suggest ${activeCategory === c.key ? 'is-active' : ''}`}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      <div className="menu-scroll">
        {empty && <p className="muted center menu-empty">No dishes match “{query}”.</p>}

        {visibleCategories.map((c) => (
          <div key={c.name} className="menu-block">
            <h3>{c.name}</h3>
            <ul className="menu-list">
              {c.products.map((p) => {
                const expanded = open === p.id;
                const hasDetails = !!p.description || p.allergens === null || (p.allergens?.length ?? 0) > 0;
                return (
                  <li key={p.id} className={`menu-item ${p.available ? '' : 'menu-item-off'}`}>
                    <div className="menu-item-row">
                      <span
                        className={`diet-dot ${p.vegan ? 'vegan' : p.vegetarian ? 'veg' : 'nonveg'}`}
                        title={p.vegan ? 'Vegan' : p.vegetarian ? 'Vegetarian' : 'Contains meat'}
                        aria-label={p.vegan ? 'Vegan' : p.vegetarian ? 'Vegetarian' : 'Contains meat'}
                      />
                      <div className="menu-item-main">
                        <div className="menu-item-name">
                          <span>{p.name}</span>
                          {!p.available && <span className="chip chip-remove">Sold out</span>}
                        </div>
                        {p.description && !expanded && <div className="muted tiny menu-desc-line">{p.description}</div>}
                      </div>
                      <strong className="menu-price">{p.priceDisplay}</strong>
                      <button
                        className="add-btn"
                        disabled={!p.available || closed || disabled}
                        aria-label={p.available ? `Add ${p.name}` : `${p.name} is sold out`}
                        onClick={() => onAdd(p.name)}
                      >
                        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 3v12M3 9h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" /></svg>
                      </button>
                    </div>
                    {hasDetails && (
                      <button
                        className="details-toggle"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : p.id)}
                      >
                        {expanded ? 'Hide details' : 'Details'} <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
                      </button>
                    )}
                    {expanded && (
                      <div className="menu-details">
                        {p.description && <p className="tiny">{p.description}</p>}
                        <div className="chips">
                          {(p.vegan || p.vegetarian) && <span className="chip chip-green">{p.vegan ? 'Vegan' : 'Vegetarian'}</span>}
                          {p.allergens && p.allergens.length > 0 && (
                            <span className="chip">Contains: {p.allergens.map((a) => a.replace('_', ' ').toLowerCase()).join(', ')}</span>
                          )}
                          {p.allergens === null && <span className="chip chip-warn">Allergen info: ask staff</span>}
                        </div>
                        {!p.available && p.unavailableReason && <div className="tiny error-text">{p.unavailableReason}</div>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {showCombos && (
          <div className="menu-block">
            <h3>Combos</h3>
            <ul className="menu-list">
              {combos.map((c) => (
                <li key={c.id} className={`menu-item menu-combo ${c.available ? '' : 'menu-item-off'}`}>
                  <div className="menu-item-row">
                    <div className="menu-item-main">
                      <div className="menu-item-name">
                        <span>{c.name}</span>
                        {!c.available && <span className="chip chip-remove">Sold out</span>}
                      </div>
                      {c.description && <div className="muted tiny menu-desc-line">{c.description}</div>}
                    </div>
                    <strong className="menu-price">{c.priceDisplay}</strong>
                    <button
                      className="add-btn"
                      disabled={!c.available || closed || disabled}
                      aria-label={c.available ? `Add ${c.name}` : `${c.name} is sold out`}
                      onClick={() => onAdd(c.name)}
                    >
                      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 3v12M3 9h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" /></svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
