import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ApiFailure, api, type OrdersPage } from '../../api';
import { STATUS_LABEL } from '../../format';
import type { AdminCtx } from './AdminLayout';

const PAGE_SIZE = 10;
const EMPTY = { from: '', to: '', item: '', status: '' };
const STATUSES = ['SUBMITTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'CONFIRMED', 'READY_FOR_CONFIRMATION', 'IN_PROGRESS'];

export default function AdminOrders() {
  const { adminKey, lock } = useOutletContext<AdminCtx>();
  const [draft, setDraft] = useState(EMPTY); // what the inputs show
  const [filters, setFilters] = useState(EMPTY); // what is applied
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OrdersPage | null>(null);
  const [escalations, setEscalations] = useState<{ id: string; reason: string; createdAt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiFailure && err.status === 401) return lock('That admin key was not accepted.');
      setError(err instanceof ApiFailure ? err.message : fallback);
    },
    [lock],
  );

  const load = useCallback(async () => {
    const id = ++reqId.current; // ignore out-of-order responses
    setLoading(true);
    setError(null);
    try {
      const res = await api.admin.orders(adminKey, {
        page,
        limit: PAGE_SIZE,
        from: filters.from || undefined,
        to: filters.to || undefined,
        item: filters.item.trim() || undefined,
        status: filters.status || undefined,
      });
      if (id !== reqId.current) return;
      if (res.page > res.totalPages) return setPage(res.totalPages); // e.g. last page emptied
      setData(res);
    } catch (err) {
      if (id === reqId.current) fail(err, 'Could not load orders.');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [adminKey, page, filters, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.admin.escalations(adminKey).then(setEscalations).catch(() => setEscalations([]));
  }, [adminKey]);

  const invalidRange = !!draft.from && !!draft.to && draft.from > draft.to;
  const dirty = JSON.stringify(draft) !== JSON.stringify(filters);
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (invalidRange) return;
    setPage(1);
    setFilters({ ...draft, item: draft.item.trim() });
  };
  const clear = () => {
    setDraft(EMPTY);
    setFilters(EMPTY);
    setPage(1);
  };

  const run = async (id: string, status: 'COMPLETED' | 'FAILED' | 'SUBMITTED') => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await api.admin.setOrderStatus(adminKey, id, status);
      await load();
    } catch (err) {
      fail(err, 'Update failed.');
    } finally {
      setBusy(null);
    }
  };

  const orders = data?.orders ?? [];

  return (
    <>
      <form className="card filters" onSubmit={apply} aria-label="Filter orders">
        <label>
          From
          <input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <label>
          Item
          <input type="search" placeholder="e.g. burger" maxLength={100} value={draft.item} onChange={(e) => setDraft({ ...draft, item: e.target.value })} />
        </label>
        <label>
          Status
          <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s}</option>)}
          </select>
        </label>
        <div className="row-gap">
          <button className="btn btn-primary btn-sm" disabled={invalidRange || (!dirty && !hasFilters)}>Apply</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={clear} disabled={!hasFilters && !dirty}>Clear</button>
        </div>
        {invalidRange && <p role="alert" className="error-text">“From” must not be after “To”.</p>}
      </form>

      {error && (
        <div className="send-error" role="alert">
          <span>{error}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}

      <section className="card stack" aria-busy={loading}>
        <div className="card-row">
          <h2>Orders</h2>
          {data && <span className="muted tiny">{data.total} order{data.total === 1 ? '' : 's'}</span>}
        </div>
        {loading && !data ? (
          <p role="status">Loading…</p>
        ) : orders.length === 0 ? (
          <p className="muted">{hasFilters ? 'No orders match these filters.' : 'No orders yet.'}</p>
        ) : (
          <ul className="admin-list" style={{ opacity: loading ? 0.6 : 1 }}>
            {orders.map((o) => (
              <li key={o.id} className="admin-order">
                <div className="card-row">
                  <strong>{o.customerName ?? 'Guest'} · {o.display.total}</strong>
                  <span className={`pill pill-${o.status.toLowerCase()}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
                </div>
                {o.createdAt && <div className="muted tiny">{new Date(o.createdAt).toLocaleString()}</div>}
                <div className="muted tiny">{o.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ') || 'No items'}</div>
                {o.status === 'SUBMITTED' && (
                  <div className="row-gap">
                    <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void run(o.id, 'COMPLETED')}>Mark picked up</button>
                    <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void run(o.id, 'FAILED')}>Mark failed</button>
                  </div>
                )}
                {o.status === 'FAILED' && (
                  <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void run(o.id, 'SUBMITTED')}>Retry submit</button>
                )}
              </li>
            ))}
          </ul>
        )}

        {data && data.totalPages > 1 && (
          <nav className="pager" aria-label="Pagination">
            <button className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(1)}>« First</button>
            <button className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
            <span className="muted tiny" aria-live="polite">Page {data.page} of {data.totalPages}</span>
            <button className="btn btn-secondary btn-sm" disabled={page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>Next ›</button>
            <button className="btn btn-secondary btn-sm" disabled={page >= data.totalPages || loading} onClick={() => setPage(data.totalPages)}>Last »</button>
          </nav>
        )}
      </section>

      {escalations.length > 0 && (
        <section className="card stack">
          <h2>Escalations</h2>
          <ul className="admin-list">
            {escalations.map((e) => (
              <li key={e.id}><strong>{e.reason}</strong> <span className="muted tiny">{new Date(e.createdAt).toLocaleString()}</span></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
