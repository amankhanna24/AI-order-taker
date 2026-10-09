import { useState } from 'react';
import { STATUS_LABEL, money } from '../format';
import type { Order } from '../types';

interface Props {
  order: Order | null;
  ended: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onNewOrder: () => void;
  /** lineRefs whose item is currently sold out / unavailable */
  unavailable: Set<string>;
}

export function Ticket({ order, ended, busy, error, onConfirm, onCancel, onNewOrder, unavailable }: Props) {
  const [askCancel, setAskCancel] = useState(false);
  const lines = order?.lines ?? [];
  const status = order?.status ?? 'DRAFT';
  const blocked = unavailable.size > 0;
  const canConfirm = status === 'READY_FOR_CONFIRMATION' && !busy && !ended && !blocked;
  const canCancel = !!order && lines.length > 0 && !ended && !busy;

  return (
    <section className="ticket" aria-label="Your order" aria-live="polite">
      <header className="ticket-head">
        <span className="label-ticket">Your order</span>
        <span className={`pill pill-${status.toLowerCase()}`}>{STATUS_LABEL[status] ?? status}</span>
      </header>

      {lines.length === 0 ? (
        <div className="ticket-empty">
          <p>Nothing here yet.</p>
          <p className="muted">Tell the assistant what you'd like — for example “two paneer tikka burgers, one without cheese”.</p>
        </div>
      ) : (
        <ul className="lines">
          {lines.map((l) => {
            const chips = l.modifiers.filter((m) => !(m.source === 'DEFAULT' && m.price === 0));
            return (
              <li key={l.lineRef} className={`line ${unavailable.has(l.lineRef) ? 'line-unavailable' : ''}`}>
                <span className="qty" aria-label={`Quantity ${l.quantity}`}>{l.quantity}×</span>
                <div className="line-main">
                  <div className="line-name">{l.name}</div>
                  {(chips.length > 0 || l.comboSelections) && (
                    <div className="chips">
                      {l.comboSelections?.map((s) => (
                        <span key={s.component + s.productName} className="chip">{s.productName}</span>
                      ))}
                      {chips.map((m) => (
                        <span key={m.kind + m.name} className={`chip ${m.kind === 'REMOVAL' ? 'chip-remove' : ''}`}>
                          {m.kind === 'REMOVAL' ? `No ${m.name}` : m.name}
                          {m.price > 0 && ` +${money(m.price, order?.currency)}`}
                        </span>
                      ))}
                    </div>
                  )}
                  {unavailable.has(l.lineRef) && <div className="error-text tiny">No longer available — remove it to continue</div>}
                  <div className="muted tiny">{l.lineRef.replace('_', ' ')}</div>
                </div>
                <div className="line-price">{money(l.lineTotal, order?.currency)}</div>
              </li>
            );
          })}
        </ul>
      )}

      {order && lines.length > 0 && (
        <dl className="totals">
          <div><dt>Subtotal</dt><dd>{order.display.subtotal}</dd></div>
          {order.discount > 0 && <div><dt>Discount</dt><dd>-{order.display.discount}</dd></div>}
          <div><dt>Tax (GST)</dt><dd>{order.display.tax}</dd></div>
          {order.fees > 0 && <div><dt>Fees</dt><dd>{order.display.fees}</dd></div>}
          <div className="grand"><dt>Total</dt><dd>{order.display.total}</dd></div>
        </dl>
      )}

      {blocked && !ended && (
        <p role="alert" className="error-text">Some items in your order are unavailable right now, so it can't be completed. Ask to remove or replace them.</p>
      )}
      {error && <p role="alert" className="error-text">{error}</p>}

      {ended ? (
        <div className="ticket-actions">
          <p className="muted center">
            {status === 'CANCELLED' ? 'This order was cancelled.' : 'Thank you! Your order has been sent to the kitchen.'}
          </p>
          <button className="btn btn-primary" onClick={onNewOrder}>Start a new order</button>
        </div>
      ) : (
        <div className="ticket-actions">
          <button className="btn btn-primary" disabled={!canConfirm} onClick={onConfirm}>
            {busy ? 'Working…' : 'Confirm order'}
          </button>
          {status !== 'READY_FOR_CONFIRMATION' && lines.length > 0 && (
            <p className="muted tiny center">Say “that's all” and I'll read your order back for confirmation.</p>
          )}
          {askCancel ? (
            <div className="cancel-confirm" role="alertdialog" aria-label="Cancel order?">
              <span>Cancel the whole order?</span>
              <button className="btn btn-danger" disabled={busy} onClick={() => { setAskCancel(false); onCancel(); }}>Yes, cancel</button>
              <button className="btn btn-secondary" onClick={() => setAskCancel(false)}>Keep it</button>
            </div>
          ) : (
            <button className="btn btn-secondary" disabled={!canCancel} onClick={() => setAskCancel(true)}>Cancel order</button>
          )}
        </div>
      )}
    </section>
  );
}
