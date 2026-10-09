import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ALLERGENS, ApiFailure, api, type AdminCombo, type AdminMenu as MenuData, type AdminProduct, type AllergenName, type ProductInput } from '../../api';
import { amountInput, money, parseAmount } from '../../format';
import type { AdminCtx } from './AdminLayout';

type Category = MenuData['categories'][number];
type Dialog =
  | { kind: 'item'; categoryId: string; productId?: string }
  | { kind: 'category'; categoryId?: string }
  | { kind: 'combo'; comboId: string }
  | { kind: 'confirm'; title: string; body: string; action: string; run: () => Promise<unknown>; done: string };

const ALLERGEN_LABEL = (a: string) => a.charAt(0) + a.slice(1).toLowerCase().replace('_', ' ');

/* ---------- small shared pieces ---------- */

/** Error from the last failed save, shown inside whichever dialog is open. */
const DialogErrorContext = createContext<string | null>(null);
/** The restaurant's currency code, for price labels inside the dialogs. */
const CurrencyContext = createContext('AED');

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const error = useContext(DialogErrorContext);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      aria-labelledby="modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose(); // backdrop click
      }}
    >
      <div className="modal-body">
        <div className="card-row">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {error && <p role="alert" className="dialog-error">{error}</p>}
        {children}
      </div>
    </dialog>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field-label">
      {label}
      {children}
      {error ? <span className="error-text tiny" role="alert">{error}</span> : hint ? <span className="muted tiny">{hint}</span> : null}
    </label>
  );
}

/* ---------- forms ---------- */

function CategoryForm({ category, onSave, onClose, busy }: { category?: Category; onSave: (v: { name: string; description: string | null }) => void; onClose: () => void; busy: boolean }) {
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setErr('Name is required');
    onSave({ name: name.trim(), description: description.trim() || null });
  };
  return (
    <Modal title={category ? 'Edit category' : 'New category'} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Name" error={err}>
          <input type="text" value={name} maxLength={80} autoFocus onChange={(e) => { setName(e.target.value); setErr(''); }} />
        </Field>
        <Field label="Description (optional)">
          <input type="text" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function OptionsEditor({ product, onChange, busy }: { product: AdminProduct; onChange: (kind: 'add' | 'save' | 'remove', fn: () => Promise<unknown>, done: string) => void; busy: boolean }) {
  const { adminKey } = useOutletContext<AdminCtx>();
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; items: AdminProduct['modifiers'] }>();
    for (const o of product.modifiers) (m.get(o.groupId) ?? m.set(o.groupId, { id: o.groupId, name: o.group, items: [] }).get(o.groupId)!).items.push(o);
    return [...m.values()];
  }, [product.modifiers]);

  if (groups.length === 0) return <p className="muted tiny">This item has no customisation options (sizes, add-ons).</p>;
  return (
    <div className="stack options">
      {groups.map((g) => (
        <fieldset key={g.id} className="option-group">
          <legend>{g.name}</legend>
          {g.items.map((o) => (
            <OptionRow key={`${o.id}:${o.name}:${o.priceDelta}`} option={o} busy={busy} adminKey={adminKey} onChange={onChange} />
          ))}
          <NewOption groupId={g.id} busy={busy} adminKey={adminKey} onChange={onChange} />
        </fieldset>
      ))}
    </div>
  );
}

function OptionRow({ option: o, busy, adminKey, onChange }: { option: AdminProduct['modifiers'][number]; busy: boolean; adminKey: string; onChange: (kind: 'add' | 'save' | 'remove', fn: () => Promise<unknown>, done: string) => void }) {
  const cur = useContext(CurrencyContext);
  const [name, setName] = useState(o.name);
  const [price, setPrice] = useState(amountInput(o.priceDelta));
  const parsed = parseAmount(price);
  const dirty = name.trim() !== o.name || parsed !== o.priceDelta;
  const valid = name.trim().length > 0 && parsed !== null;
  return (
    <div className="option-row">
      <input type="text" aria-label="Option name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <span className="money-input">
        <span aria-hidden="true">+{cur}</span>
        <input type="text" inputMode="decimal" aria-label={`Extra price for ${o.name}`} aria-invalid={parsed === null} value={price} onChange={(e) => setPrice(e.target.value)} />
      </span>
      <label className="switch-row" title={o.available ? 'Available' : 'Sold out'}>
        <input type="checkbox" aria-label={`${o.name} available`} checked={o.available} disabled={busy} onChange={(e) => onChange('save', () => api.admin.updateModifier(adminKey, o.id, { available: e.target.checked }), 'Option updated')} />
      </label>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy || !dirty || !valid} onClick={() => onChange('save', () => api.admin.updateModifier(adminKey, o.id, { name: name.trim(), priceDelta: parsed! }), 'Option saved')}>Save</button>
      <button type="button" className="icon-btn icon-danger" aria-label={`Delete ${o.name}`} disabled={busy} onClick={() => onChange('remove', () => api.admin.deleteModifier(adminKey, o.id), 'Option deleted')}>🗑</button>
    </div>
  );
}

function NewOption({ groupId, busy, adminKey, onChange }: { groupId: string; busy: boolean; adminKey: string; onChange: (kind: 'add' | 'save' | 'remove', fn: () => Promise<unknown>, done: string) => void }) {
  const cur = useContext(CurrencyContext);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('0');
  const parsed = parseAmount(price);
  const ok = name.trim().length > 0 && parsed !== null;
  return (
    <div className="option-row option-new">
      <input type="text" aria-label="New option name" placeholder="New option…" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <span className="money-input">
        <span aria-hidden="true">+{cur}</span>
        <input type="text" inputMode="decimal" aria-label="New option extra price" aria-invalid={parsed === null} value={price} onChange={(e) => setPrice(e.target.value)} />
      </span>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled={busy || !ok}
        onClick={() => {
          onChange('add', () => api.admin.createModifier(adminKey, groupId, { name: name.trim(), priceDelta: parsed! }), 'Option added');
          setName('');
          setPrice('0');
        }}
      >
        Add
      </button>
    </div>
  );
}

interface ItemDraft {
  name: string;
  description: string;
  price: string;
  categoryId: string;
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  allergens: AllergenName[];
  allergenInfoVerified: boolean;
  aliases: string;
  from: string;
  until: string;
}

function ItemForm({
  product,
  categories,
  categoryId,
  busy,
  onSave,
  onDelete,
  onOption,
  onClose,
}: {
  product?: AdminProduct;
  categories: Category[];
  categoryId: string;
  busy: boolean;
  onSave: (categoryId: string, v: ProductInput) => void;
  onDelete?: () => void;
  onOption: (kind: 'add' | 'save' | 'remove', fn: () => Promise<unknown>, done: string) => void;
  onClose: () => void;
}) {
  const cur = useContext(CurrencyContext);
  const [d, setD] = useState<ItemDraft>({
    name: product?.name ?? '',
    description: product?.description ?? '',
    price: product ? amountInput(product.basePrice) : '',
    categoryId,
    vegetarian: product?.vegetarian ?? true,
    vegan: product?.vegan ?? false,
    glutenFree: product?.glutenFree ?? false,
    allergens: product?.allergens ?? [],
    allergenInfoVerified: product?.allergenInfoVerified ?? false,
    aliases: (product?.aliases ?? []).join(', '),
    from: product?.availableFrom ?? '',
    until: product?.availableUntil ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((p) => ({ ...p, [k]: '' }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    const basePrice = parseAmount(d.price);
    if (!d.name.trim()) errs.name = 'Name is required';
    if (basePrice === null) errs.price = 'Enter a price like 120 or 120.50 (max 100000)';
    if (!!d.from !== !!d.until) errs.window = 'Set both times, or clear both';
    if (d.from && d.until && d.from === d.until) errs.window = 'Start and end must differ';
    const aliases = d.aliases.split(',').map((a) => a.trim()).filter(Boolean);
    if (aliases.length > 10 || aliases.some((a) => a.length > 40)) errs.aliases = 'Up to 10 aliases, each under 40 characters';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSave(d.categoryId, {
      name: d.name.trim(),
      description: d.description.trim() || null,
      basePrice: basePrice!,
      vegetarian: d.vegetarian || d.vegan,
      vegan: d.vegan,
      glutenFree: d.glutenFree,
      allergens: d.allergens,
      allergenInfoVerified: d.allergenInfoVerified,
      aliases,
      availableFrom: d.from || null,
      availableUntil: d.until || null,
    });
  };

  return (
    <Modal title={product ? 'Edit item' : 'New item'} onClose={onClose} wide>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            <input type="text" value={d.name} maxLength={80} autoFocus={!product} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={`Price (${cur})`} error={errors.price}>
            <input type="text" inputMode="decimal" value={d.price} placeholder="0.00" aria-invalid={!!errors.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
        </div>
        <Field label="Category">
          <select value={d.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Description (optional)" hint="Shown to customers on the menu">
          <textarea className="textarea" rows={2} maxLength={300} value={d.description} onChange={(e) => set('description', e.target.value)} />
        </Field>

        <fieldset className="option-group">
          <legend>Dietary</legend>
          <div className="row-gap">
            <label className="switch-row"><input type="checkbox" checked={d.vegetarian || d.vegan} disabled={d.vegan} onChange={(e) => set('vegetarian', e.target.checked)} />Vegetarian</label>
            <label className="switch-row">
              <input type="checkbox" checked={d.vegan} onChange={(e) => { set('vegan', e.target.checked); if (e.target.checked) set('vegetarian', true); }} />Vegan
            </label>
            <label className="switch-row"><input type="checkbox" checked={d.glutenFree} onChange={(e) => set('glutenFree', e.target.checked)} />Gluten free</label>
          </div>
        </fieldset>

        <fieldset className="option-group">
          <legend>Allergens</legend>
          <div className="row-gap">
            {ALLERGENS.map((a) => {
              const on = d.allergens.includes(a);
              return (
                <button type="button" key={a} className={`suggest${on ? ' is-active' : ''}`} aria-pressed={on} onClick={() => set('allergens', on ? d.allergens.filter((x) => x !== a) : [...d.allergens, a])}>
                  {ALLERGEN_LABEL(a)}
                </button>
              );
            })}
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={d.allergenInfoVerified} onChange={(e) => set('allergenInfoVerified', e.target.checked)} />
            Allergen info verified by staff
          </label>
          <p className="muted tiny">Customers only see allergens once this is switched on.</p>
        </fieldset>

        <div className="form-grid">
          <Field label="Available from (optional)" error={errors.window}>
            <input type="time" value={d.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Available until (optional)">
            <input type="time" value={d.until} onChange={(e) => set('until', e.target.value)} />
          </Field>
        </div>
        <Field label="Other names customers use (optional)" hint="Comma separated, helps the AI recognise the item" error={errors.aliases}>
          <input type="text" value={d.aliases} onChange={(e) => set('aliases', e.target.value)} />
        </Field>

        {product && (
          <section>
            <h3>Options & add-ons</h3>
            <OptionsEditor product={product} busy={busy} onChange={onOption} />
          </section>
        )}

        <div className="modal-actions">
          {onDelete && <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={onDelete}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : product ? 'Save changes' : 'Add item'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ComboForm({ combo, busy, onSave, onClose }: { combo: AdminCombo; busy: boolean; onSave: (v: { name: string; description: string | null; basePrice: number }) => void; onClose: () => void }) {
  const cur = useContext(CurrencyContext);
  const [name, setName] = useState(combo.name);
  const [description, setDescription] = useState(combo.description ?? '');
  const [price, setPrice] = useState(amountInput(combo.basePrice));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const basePrice = parseAmount(price);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (basePrice === null) errs.price = 'Enter a price like 42 or 42.50';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSave({ name: name.trim(), description: description.trim() || null, basePrice: basePrice! });
  };
  return (
    <Modal title="Edit combo" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Name" error={errors.name}><input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={`Price (${cur})`} error={errors.price}><input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Description (optional)"><textarea className="textarea" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- page ---------- */

export default function AdminMenuPage() {
  const { adminKey, lock } = useOutletContext<AdminCtx>();
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const reqId = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);

  const cur = menu?.restaurant.currency ?? 'AED';

  const fail = useCallback(
    (err: unknown, fallback: string): string => {
      if (err instanceof ApiFailure && err.status === 401) {
        lock('That admin key was not accepted.');
        return '';
      }
      if (err instanceof ApiFailure && err.code === 'VALIDATION_ERROR') return 'Some values are not valid. Please check the form and try again.';
      return err instanceof ApiFailure ? err.message : fallback;
    },
    [lock],
  );

  const load = useCallback(async () => {
    const id = ++reqId.current; // ignore out-of-order responses
    try {
      const m = await api.admin.menu(adminKey);
      if (id === reqId.current) {
        setMenu(m);
        setLoadError(null);
      }
    } catch (err) {
      if (id === reqId.current) setLoadError(fail(err, 'Could not load the menu.'));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [adminKey, fail]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const flash = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };

  /** Run one mutation: guards double-submits, reports errors inside the open dialog, refreshes the menu, closes on success. */
  const mutate = async (fn: () => Promise<unknown>, done: string, { close = true } = {}) => {
    if (busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      await fn();
      await load();
      flash(done);
      if (close) setDialog(null);
    } catch (err) {
      const msg = fail(err, 'That did not work. Please try again.');
      if (msg) {
        if (dialog) setDialogError(msg);
        else setLoadError(msg);
      }
      if (err instanceof ApiFailure && err.status === 404) void load(); // stale view: someone removed it
    } finally {
      setBusy(false);
    }
  };

  const openDialog = (d: Dialog | null) => {
    setDialogError(null);
    setDialog(d);
  };

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!menu) return [];
    return menu.categories
      .map((c) => ({ ...c, shown: q ? c.products.filter((p) => p.name.toLowerCase().includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q))) : c.products }))
      .filter((c) => !q || c.shown.length > 0 || c.name.toLowerCase().includes(q));
  }, [menu, q]);
  const visibleCombos = useMemo(() => (menu ? menu.combos.filter((c) => !q || c.name.toLowerCase().includes(q)) : []), [menu, q]);

  const editingProduct = dialog?.kind === 'item' && dialog.productId ? menu?.categories.flatMap((c) => c.products).find((p) => p.id === dialog.productId) : undefined;
  const editingCategory = dialog?.kind === 'category' && dialog.categoryId ? menu?.categories.find((c) => c.id === dialog.categoryId) : undefined;
  const editingCombo = dialog?.kind === 'combo' ? menu?.combos.find((c) => c.id === dialog.comboId) : undefined;

  const toggleAvailable = (p: AdminProduct, available: boolean) =>
    mutate(() => api.admin.updateProduct(adminKey, p.id, { available }), available ? `${p.name} is back on` : `${p.name} marked sold out`, { close: false });

  const confirmDelete = (title: string, body: string, run: () => Promise<unknown>, done: string) =>
    openDialog({ kind: 'confirm', title, body, action: 'Delete', run, done });

  return (
    <>
      <div className="menu-toolbar">
        <input type="search" className="grow" placeholder="Search items…" aria-label="Search menu items" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn btn-secondary" onClick={() => openDialog({ kind: 'category' })}>+ Category</button>
        <button className="btn btn-primary" disabled={!menu || menu.categories.length === 0} onClick={() => menu && openDialog({ kind: 'item', categoryId: menu.categories[0].id })}>+ Add item</button>
      </div>

      {loadError && (
        <p role="alert" className="error-text">
          {loadError} <button className="btn btn-sm btn-secondary" onClick={() => void load()}>Retry</button>
        </p>
      )}
      {loading && !menu && <p role="status">Loading…</p>}
      <div className="toast-region" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>

      {menu && menu.categories.length === 0 && (
        <section className="card center stack">
          <h2>No categories yet</h2>
          <p className="muted">Create your first category, then add items to it.</p>
          <div><button className="btn btn-primary" onClick={() => openDialog({ kind: 'category' })}>+ Create category</button></div>
        </section>
      )}

      {visible.map((c) => (
        <section key={c.id} className="card stack menu-section">
          <div className="card-row">
            <div>
              <h2>{c.name}</h2>
              <span className="muted tiny">{c.products.length} {c.products.length === 1 ? 'item' : 'items'}{c.description ? ` · ${c.description}` : ''}</span>
            </div>
            <div className="row-gap">
              <button className="btn btn-sm btn-secondary" onClick={() => openDialog({ kind: 'category', categoryId: c.id })}>Rename</button>
              <button
                className="btn btn-sm btn-danger-outline"
                onClick={() => confirmDelete(`Delete “${c.name}”?`, c.products.length ? 'Move or delete the items in this category first.' : 'This category is empty and will be removed.', () => api.admin.deleteCategory(adminKey, c.id), 'Category deleted')}
              >
                Delete
              </button>
            </div>
          </div>
          {c.shown.length === 0 && <p className="muted">{q ? 'No matching items.' : 'No items yet.'}</p>}
          <ul className="admin-list">
            {c.shown.map((p) => (
              <li key={p.id} className={`item-row${p.available ? '' : ' item-off'}`}>
                <span className={`diet-dot ${p.vegan ? 'vegan' : p.vegetarian ? 'veg' : 'nonveg'}`} title={p.vegan ? 'Vegan' : p.vegetarian ? 'Vegetarian' : 'Non-vegetarian'} />
                <button className="item-main linklike" onClick={() => openDialog({ kind: 'item', categoryId: c.id, productId: p.id })} aria-label={`Edit ${p.name}`}>
                  <span className="item-name">{p.name}</span>
                  <span className="muted tiny">
                    {p.modifiers.length > 0 && `${p.modifiers.length} options`}
                    {p.availableFrom && p.availableUntil && ` · ${p.availableFrom}–${p.availableUntil}`}
                    {!p.allergenInfoVerified && <span className="chip chip-warn">allergens unverified</span>}
                  </span>
                </button>
                <strong className="item-price">{money(p.basePrice, cur)}</strong>
                <label className="switch-row">
                  <input type="checkbox" aria-label={`${p.name} available`} checked={p.available} disabled={busy} onChange={(e) => void toggleAvailable(p, e.target.checked)} />
                  <span className="switch-text">{p.available ? 'On' : 'Sold out'}</span>
                </label>
                <button className="btn btn-sm btn-secondary" onClick={() => openDialog({ kind: 'item', categoryId: c.id, productId: p.id })}>Edit</button>
              </li>
            ))}
          </ul>
          <button className="btn btn-sm btn-secondary add-row" onClick={() => openDialog({ kind: 'item', categoryId: c.id })}>+ Add item to {c.name}</button>
        </section>
      ))}

      {menu && q && visible.length === 0 && visibleCombos.length === 0 && <p className="muted center">Nothing matches “{search.trim()}”.</p>}

      {visibleCombos.length > 0 && (
        <section className="card stack menu-section">
          <h2>Combos</h2>
          <ul className="admin-list">
            {visibleCombos.map((c) => (
              <li key={c.id} className={`item-row${c.available ? '' : ' item-off'}`}>
                <span className="diet-dot combo" />
                <span className="item-main"><span className="item-name">{c.name}</span></span>
                <strong className="item-price">{money(c.basePrice, cur)}</strong>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    aria-label={`${c.name} available`}
                    checked={c.available}
                    disabled={busy}
                    onChange={(e) => void mutate(() => api.admin.setAvailability(adminKey, 'combos', c.id, e.target.checked), e.target.checked ? `${c.name} is back on` : `${c.name} marked sold out`, { close: false })}
                  />
                  <span className="switch-text">{c.available ? 'On' : 'Sold out'}</span>
                </label>
                <button className="btn btn-sm btn-secondary" onClick={() => openDialog({ kind: 'combo', comboId: c.id })}>Edit</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* dialogs */}
      <CurrencyContext.Provider value={cur}>
      <DialogErrorContext.Provider value={dialogError}>
      {dialog?.kind === 'category' && (!dialog.categoryId || editingCategory) && (
        <>
          <CategoryForm
            key={dialog.categoryId ?? 'new'}
            category={editingCategory}
            busy={busy}
            onClose={() => openDialog(null)}
            onSave={(v) =>
              void mutate(() => (editingCategory ? api.admin.updateCategory(adminKey, editingCategory.id, v) : api.admin.createCategory(adminKey, v)), editingCategory ? 'Category updated' : 'Category created')
            }
          />
        </>
      )}

      {dialog?.kind === 'item' && (!dialog.productId || editingProduct) && menu && (
        <>
          <ItemForm
            key={dialog.productId ?? `new-${dialog.categoryId}`}
            product={editingProduct}
            categories={menu.categories}
            categoryId={dialog.categoryId}
            busy={busy}
            onClose={() => openDialog(null)}
            onOption={(_k, fn, done) => void mutate(fn, done, { close: false })}
            onSave={(categoryId, v) =>
              void mutate(
                () => (editingProduct ? api.admin.updateProduct(adminKey, editingProduct.id, { ...v, categoryId }) : api.admin.createProduct(adminKey, { ...v, categoryId })),
                editingProduct ? 'Item updated' : 'Item added',
              )
            }
            onDelete={
              editingProduct
                ? () => {
                    const p = editingProduct;
                    confirmDelete(`Delete “${p.name}”?`, 'It will be removed from the menu. Past orders keep their history.', () => api.admin.deleteProduct(adminKey, p.id), 'Item deleted');
                  }
                : undefined
            }
          />
        </>
      )}

      {dialog?.kind === 'combo' && editingCombo && (
        <>
          <ComboForm key={editingCombo.id} combo={editingCombo} busy={busy} onClose={() => openDialog(null)} onSave={(v) => void mutate(() => api.admin.updateCombo(adminKey, editingCombo.id, v), 'Combo updated')} />
        </>
      )}

      {dialog?.kind === 'confirm' && (
        <Modal title={dialog.title} onClose={() => openDialog(null)}>
          <p>{dialog.body}</p>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => openDialog(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void mutate(dialog.run, dialog.done)}>{busy ? 'Working…' : dialog.action}</button>
          </div>
        </Modal>
      )}
      </DialogErrorContext.Provider>
      </CurrencyContext.Provider>
    </>
  );
}
