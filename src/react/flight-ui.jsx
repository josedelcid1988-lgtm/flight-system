import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Boxes, CalendarClock, Check, ChevronRight, CircleAlert, FileText, Search, SlidersHorizontal, X } from 'lucide-react';

const densityKey = 'flight-system-density-v1';
const queueKey = 'flight-system-queue-v1';
const titleOf = order => order.title || order.partName || order.product || order.partNumber || 'Work order';
const dueOf = order => order.dueDate || order.due || '';
const orderIsOpen = order => !['Closed', 'Cancelled', 'Scrapped'].includes(order.status);
const asText = value => String(value == null ? '' : value);
const holdText = value => typeof value === 'string' ? value : value && (value.title || value.message || value.reason || value.description || value.id) || 'A blocking record needs action.';

function RecordDrawer({ order, MES, onClose, onOpen }) {
  const dialog = useRef(null);
  const returnFocus = useRef(null);
  useEffect(() => {
    if (!order) return;
    returnFocus.current = document.activeElement;
    dialog.current.showModal();
    dialog.current.querySelector('[data-close-drawer]').focus();
    return () => { if (dialog.current && dialog.current.open) dialog.current.close(); if (returnFocus.current) returnFocus.current.focus(); };
  }, [order]);
  if (!order) return null;
  const holds = MES && MES.blockingTickets ? MES.blockingTickets(order).map(holdText) : [];
  const next = (order.operations || []).find(operation => !operation.done);
  const close = () => { if (dialog.current && dialog.current.open) dialog.current.close(); onClose(); };
  return <dialog className="fr-drawer" ref={dialog} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    <section className="fr-drawer-panel" aria-labelledby="fr-drawer-title">
      <div className="fr-drawer-top"><span>FLIGHT CONTROL · RECORD</span><button data-close-drawer aria-label="Close record details" onClick={close}><X size={19}/></button></div>
      <div className="fr-drawer-icon"><FileText size={23}/></div><h2 id="fr-drawer-title">{titleOf(order)}</h2>
      <p className="fr-drawer-id">{order.id} · {order.status}</p>
      <dl className="fr-drawer-fields">
        <div><dt>Part number</dt><dd>{order.partNumber || 'Not recorded'}</dd></div>
        <div><dt>Pedigree</dt><dd>{order.pedigree || 'Not recorded'}</dd></div>
        <div><dt>Owner</dt><dd>{order.owner || order.assignedTo || 'Unassigned'}</dd></div>
        <div><dt>Due</dt><dd>{dueOf(order) || 'Not scheduled'}</dd></div>
        <div><dt>Next operation</dt><dd>{next ? next.title || next.name : order.status}</dd></div>
      </dl>
      {holds.length > 0 && <div className="fr-hold-callout"><CircleAlert size={18}/><div><strong>Open holds</strong><ul>{holds.map((hold, index) => <li key={index}>{hold}</li>)}</ul></div></div>}
      <button className="fr-primary" onClick={() => { onOpen(order.id); close(); }}>Open full work order <ArrowUpRight size={17}/></button>
    </section>
  </dialog>;
}

function Hangar({ state, MES, onOpen }) {
  const [savedQueue] = useState(() => { try { return JSON.parse(localStorage.getItem(queueKey) || '{}'); } catch { return {}; } });
  const [query, setQuery] = useState(savedQueue.query || '');
  const [filter, setFilter] = useState(savedQueue.filter === 'All' ? 'All' : 'Open');
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const [order, setOrder] = useState(null);
  const searchRef = useRef(null);
  useEffect(() => {
    const shortcut = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current.focus(); } };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => { try { localStorage.setItem(queueKey, JSON.stringify({ query, filter })); } catch {} }, [query, filter]);
  const rows = (state.orders || []).filter(item => {
    const searchable = [item.id, titleOf(item), item.partNumber, item.status, item.pedigree].map(asText).join(' ').toLowerCase();
    return (filter === 'All' || orderIsOpen(item)) && searchable.includes(query.trim().toLowerCase());
  }).sort((a, b) => asText(dueOf(a) || '9999').localeCompare(asText(dueOf(b) || '9999')));
  const holds = (state.orders || []).filter(orderIsOpen).flatMap(item => {
    const blockers = MES && MES.blockingTickets ? MES.blockingTickets(item) : [];
    return blockers.length ? [{ item, reason: holdText(blockers[0]) }] : [];
  }).slice(0, 4);
  const changeDensity = () => setCompact(value => {
    const next = !value;
    try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {}
    return next;
  });
  const open = item => setOrder(item);
  return <div className="flight-react">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT CONTROL</span><h1>Hangar<span>.</span></h1></div><div className="fr-workspace"><CalendarClock size={15}/> Current Flight System records</div></div>
    <section className="fr-top-row" aria-label="Work queue summary and open holds">
      <div className="fr-summary"><span className="fr-eyebrow">YOUR WORK QUEUE</span><strong>{rows.length} <small>{filter.toLowerCase()} work orders</small></strong><span>Sorted by due date from the current workspace.</span></div>
      <div className="fr-holds"><div className="fr-section-heading"><h2>Open holds</h2><span className="fr-count">{String(holds.length).padStart(2, '0')}</span></div>
        {holds.length ? holds.map(({ item, reason }) => <button className="fr-hold-row" key={item.id} onClick={() => open(item)}><span className="fr-hold-icon"><Boxes size={18}/></span><span><strong>{item.id} · {titleOf(item)}</strong><small>{reason}</small></span><ChevronRight size={16}/></button>) : <p className="fr-no-holds"><Check size={16}/> No blocking holds in open work orders.</p>}
      </div>
    </section>
    <section className="fr-queue" aria-labelledby="fr-queue-heading">
      <div className="fr-queue-heading"><div className="fr-section-heading"><h2 id="fr-queue-heading">Work orders</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-controls"><label className="fr-search"><Search size={16}/><input ref={searchRef} aria-label="Search work orders" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search work orders"/><kbd>⌘ K</kbd></label>
          <div className="fr-filter" aria-label="Work order filter">{['Open', 'All'].map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div>
          <button className="fr-density" aria-pressed={compact} onClick={changeDensity}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button>
        </div>
      </div>
      <div className="fr-table-scroll"><table className={compact ? 'fr-compact' : ''}><thead><tr><th>Work order / Assembly</th><th>Next step</th><th>Owner</th><th>Due</th><th><span className="fr-visually-hidden">Details</span></th></tr></thead><tbody>
        {rows.map(item => { const next = (item.operations || []).find(operation => !operation.done); const label = next && (next.title || next.name) || item.status || 'Review record'; return <tr key={item.id}><td><button className="fr-record-link" onClick={() => open(item)}><span className="fr-order-icon"><FileText size={18}/></span><span><strong>{titleOf(item)}</strong><small>{item.id}<i> · {item.partNumber || 'Part not assigned'}</i></small></span></button></td><td><span className="fr-status"><i/>{label}</span></td><td>{item.owner || item.assignedTo || 'Unassigned'}</td><td>{dueOf(item) || 'Not scheduled'}</td><td><button className="fr-open-button" aria-label={'Open ' + item.id} onClick={() => open(item)}><ArrowUpRight size={18}/></button></td></tr>; })}
      </tbody></table>{!rows.length && <div className="fr-empty">No work orders match the current search and filter.</div>}</div>
      <footer><span>{rows.length} work orders</span><span><Check size={13}/> Existing commands and approvals remain authoritative</span></footer>
    </section>
    <RecordDrawer order={order} MES={MES} onClose={() => setOrder(null)} onOpen={onOpen}/>
  </div>;
}

let root = null;
window.FlightReact = {
  renderHangar(element, state, MES, onOpen) { if (!root) root = createRoot(element); root.render(<Hangar state={state} MES={MES} onOpen={onOpen}/>); },
  unmount() { if (root) { root.unmount(); root = null; } }
};
