import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ArrowRight, ArrowUpRight, Ban, Box, Boxes, CalendarClock, Check, ChevronRight, CircleAlert, Clock, Download, ExternalLink, FileText, Info, Layers, Link, List, Lock, Plus, Search, Shield, SlidersHorizontal, TriangleAlert, Upload, User, Video, Wrench, X, Zap } from 'lucide-react';

const densityKey = 'flight-system-density-v1';
const queueKey = 'flight-system-queue-v1';
const titleOf = order => order.title || order.partName || order.product || order.partNumber || 'Work order';
const dueOf = order => order.dueDate || order.due || '';
const displayFlightDate = value => {
  if (!value) return 'Not scheduled';
  const datePart = String(value).slice(0, 10);
  const parsed = new Date(`${datePart}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const orderIsOpen = order => !['Closed', 'Cancelled', 'Scrapped'].includes(order.status);
const recordIsTerminal = status => ['Closed', 'Cancelled', 'Approved', 'Resolved', 'Rejected', 'Completed', 'Stocked'].includes(asText(status));
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
  const holds = [...(MES && MES.blockingTickets ? MES.blockingTickets(order) : []), ...(MES && MES.sourceInspectionHolds ? MES.sourceInspectionHolds(null, order) : [])].map(holdText);
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
        <div><dt>Due</dt><dd>{displayFlightDate(dueOf(order))}</dd></div>
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
    const sourceInspections = MES && MES.sourceInspectionHolds ? MES.sourceInspectionHolds(state, item) : [];
    const allHolds = [...blockers, ...sourceInspections];
    return allHolds.length ? [{ item, reason: holdText(allHolds[0]) }] : [];
  }).slice(0, 4);
  const milestoneRisks = MES.milestoneRisks ? MES.milestoneRisks(state) : [];
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
    {milestoneRisks.length > 0 && <section className="fr-milestone-watch" aria-label="Project milestones at risk"><div className="fr-section-heading"><h2>Project milestones at risk</h2><span className="fr-count">{String(milestoneRisks.length).padStart(2, '0')}</span></div>{milestoneRisks.map(item => <div className="fr-milestone-watch-row" key={item.id}><div><strong>{item.id} · {item.title}</strong><span>{item.risk} · due {new Date(`${item.dueDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}{item.workOrderId ? ` · ${item.workOrderId}` : ''}</span></div>{item.workOrderId && <button className="fr-record-link" onClick={() => { const workOrder = state.orders.find(order => order.id === item.workOrderId); if (workOrder) onOpen(workOrder.id); }}>Open work order</button>}</div>)}</section>}
    <section className="fr-queue" aria-labelledby="fr-queue-heading">
      <div className="fr-queue-heading"><div className="fr-section-heading"><h2 id="fr-queue-heading">Work orders</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-controls"><label className="fr-search"><Search size={16}/><input ref={searchRef} aria-label="Search work orders" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search work orders"/><kbd>⌘ K</kbd></label>
          <div className="fr-filter" aria-label="Work order filter">{['Open', 'All'].map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div>
          <button className="fr-density" aria-pressed={compact} onClick={changeDensity}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button>
        </div>
      </div>
      <div className="fr-table-scroll"><table className={compact ? 'fr-compact' : ''}><thead><tr><th>Work order / Assembly</th><th>Next step</th><th>Owner</th><th>Due</th><th><span className="fr-visually-hidden">Details</span></th></tr></thead><tbody>
        {rows.map(item => { const next = (item.operations || []).find(operation => !operation.done); const label = next && (next.title || next.name) || item.status || 'Review record'; return <tr key={item.id}><td><button className="fr-record-link" onClick={() => open(item)}><span className="fr-order-icon"><FileText size={18}/></span><span><strong>{titleOf(item)}</strong><small>{item.id}<i> · {item.partNumber || 'Part not assigned'}</i></small></span></button></td><td><span className="fr-status"><i/>{label}</span></td><td>{item.owner || item.assignedTo || 'Unassigned'}</td><td>{displayFlightDate(dueOf(item))}</td><td><button className="fr-open-button" aria-label={'Open ' + item.id} onClick={() => open(item)}><ArrowUpRight size={18}/></button></td></tr>; })}
      </tbody></table>{!rows.length && <div className="fr-empty">No work orders match the current search and filter.</div>}</div>
      <footer><span>{rows.length} work orders</span><span><Check size={13}/> Existing commands and approvals remain authoritative</span></footer>
    </section>
    <RecordDrawer order={order} MES={MES} onClose={() => setOrder(null)} onOpen={onOpen}/>
  </div>;
}

function WorkOrderQueue({ state, MES, rows: sourceRows, initial, callbacks, onOpen }) {
  const [query, setQuery] = useState(initial.search || '');
  const [status, setStatus] = useState(initial.status || 'All');
  const [site, setSite] = useState(initial.site || 'All');
  const [aircraft, setAircraft] = useState(initial.aircraft || 'All');
  const [flagged, setFlagged] = useState(initial.flagged === true);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const [selected, setSelected] = useState(null);
  const searchRef = useRef(null);
  useEffect(() => {
    const shortcut = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const notifyFilters = next => callbacks?.onFilters?.(next);
  const matchStatus = item => status === 'All' || item.record.status === status || (status === 'Blocked' && item.held);
  const rows = sourceRows.filter(item => {
    const order = item.record;
    const searchable = [order.id, order.title, order.partNumber, order.status, order.pedigree, order.aircraft, MES.orderSite(order)].map(asText).join(' ').toLowerCase();
    return matchStatus(item) && (site === 'All' || MES.orderSite(order) === site) && (aircraft === 'All' || order.aircraft === aircraft) && (!flagged || item.flagged) && searchable.includes(query.trim().toLowerCase());
  });
  const density = () => setCompact(value => { const next = !value; try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {} return next; });
  const setSearch = value => { setQuery(value); notifyFilters({ search: value }); };
  const setStatusFilter = value => { setStatus(value); notifyFilters({ status: value }); };
  const setSiteFilter = value => { setSite(value); notifyFilters({ site: value }); };
  const setAircraftFilter = value => { setAircraft(value); notifyFilters({ aircraft: value }); };
  const setFlagFilter = value => { setFlagged(value); notifyFilters({ flagged: value }); };
  const clearFilters = () => { setSearch(''); setStatusFilter('All'); setSiteFilter('All'); setAircraftFilter('All'); setFlagFilter(false); callbacks?.onClear?.(); };
  return <div className="flight-react fr-order-page">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT CONTROL</span><h1>{initial.title || 'All work orders'}<span>.</span></h1>{initial.wiFilter && <p className="fr-order-filter-note">Cloned from <strong>{initial.wiFilter.id}</strong>{initial.wiFilter.revision ? ` Rev ${initial.wiFilter.revision}` : ' · all revisions'} <button className="fr-text-action" data-action="wi-filter-clear">Show all work orders</button></p>}</div><div className="fr-order-heading-actions" dangerouslySetInnerHTML={{ __html: initial.createButton }}/></div>
    <section className="fr-queue" aria-labelledby="fr-orders-heading">
      <div className="fr-queue-heading"><div className="fr-section-heading"><h2 id="fr-orders-heading">Work orders</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-controls"><label className="fr-search"><Search size={16}/><input id="order-search" ref={searchRef} type="search" aria-label="Search work orders" value={query} onChange={event => setSearch(event.target.value)} placeholder="Search orders"/><kbd>⌘ K</kbd></label>
          <label className="fr-filter-select"><span className="fr-visually-hidden">Work order status</span><select aria-label="Work order status" value={status} onChange={event => setStatusFilter(event.target.value)}>{['All', 'Blocked', 'Draft', 'Kitting', 'Building', 'Quality', 'Closed'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="fr-filter-select"><span className="fr-visually-hidden">Site</span><select aria-label="Work order site" value={site} onChange={event => setSiteFilter(event.target.value)}>{['All', ...MES.SITES].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="fr-filter-select"><span className="fr-visually-hidden">Aircraft</span><select aria-label="Work order aircraft" value={aircraft} onChange={event => setAircraftFilter(event.target.value)}>{['All', ...MES.AIRCRAFT].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="fr-order-flag"><input type="checkbox" checked={flagged} onChange={event => setFlagFilter(event.target.checked)}/> Flagged</label>
          <button className="fr-density" aria-pressed={compact} onClick={density}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button>
        </div>
      </div>
      <div className="fr-order-table-summary" dangerouslySetInnerHTML={{ __html: callbacks?.summary?.(rows.length) || '' }}/>
      <div className="fr-table-scroll table-wrap" role="region" aria-label="Work orders table" tabIndex="0">
        <table className={`fr-order-table${compact ? ' fr-compact' : ''}`}><thead><tr dangerouslySetInnerHTML={{ __html: initial.headers.join('') }}/></thead><tbody>{rows.map(item => { const order = item.record; return <tr key={order.id} className={`${item.held ? 'hold-row' : ''} ${item.aog ? 'aog-row' : ''}`} data-order-row={order.id}>
          <td><button className="fr-record-link" onClick={() => setSelected(order)}><strong>{order.id}</strong>{order.fai?.required && <span className="fr-fai-tag">FAI</span>}</button></td>
          <td><strong className="fr-mono">{order.partNumber} / Rev {order.revision}</strong><small>{titleOf(order)}</small>{order.aircraft && <small className="fr-mono">Aircraft {order.aircraft}</small>}{item.superseded && <small className="fr-revision-warning">Superseded revision</small>}</td>
          <td>{item.held ? <><span className="fr-order-blocked">Blocked</span><small>{order.status}{item.engineering ? ' · engineering change' : ''}{item.openTickets ? ` · ${item.openTickets} open NC` : ''}</small></> : <><span className="fr-status"><i/>{order.status}</span>{item.qaPending && <small>QA approval pending</small>}{item.openTickets ? <small>{item.openTickets} open NC</small> : null}</>}</td>
          <td className="fr-mono"><time dateTime={item.created}>{displayFlightDate(item.created)}</time></td>
          <td className={`fr-mono${item.overdue ? ' is-overdue' : ''}`}><time dateTime={order.due || ''}>{displayFlightDate(order.due)}</time></td>
          <td><div dangerouslySetInnerHTML={{ __html: item.progress }}/></td>
          <td>{order.pedigree}{order.subcategory && <small>{order.subcategory}</small>}</td>
          <td><select className={`fr-order-priority ${asText(order.priority).toLowerCase()}`} data-priority-order={order.id} aria-label={`Priority for ${order.id}`} disabled={order.status === 'Closed'} defaultValue={order.priority}>{MES.PRIORITIES.map(value => <option key={value}>{value}</option>)}</select></td>
        </tr>; })}</tbody></table>
        {!rows.length && <div className="fr-empty">No matching work orders. Adjust the search or filters.</div>}
      </div>
      <footer><span>{rows.length} of {state.orders.length} work orders · {site === 'All' ? 'all sites' : site}</span><span><Check size={13}/> Flight progress and existing MES command gates are preserved</span></footer>
    </section>
    <RecordDrawer order={selected} MES={MES} onClose={() => setSelected(null)} onOpen={onOpen}/>
  </div>;
}

function BigThree({ state, MES }) {
  const date = new Date().toISOString().slice(0, 10);
  const snap = MES.plannerStatus(state, date);
  if (!snap) return null;
  const hasPlan = !!state.planner.days[snap.username]?.[date];
  const displayDate = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const slots = hasPlan ? snap.day.big3 : snap.candidates.slice(0, 3);
  return <section className="panel big3-panel fr-big3" aria-labelledby="big3-heading">
    <div className="panel-head"><div><p className="hero-eyebrow">Flight Plan · {snap.username}</p><h2 id="big3-heading">Today's Big Three</h2></div><span className="fr-big3-date">{displayDate(date)}</span></div>
    {slots.length ? <ol className="big3-list">{slots.map((slot, index) => {
      const item = hasPlan ? slot : null;
      const task = item ? snap.candidates.find(candidate => candidate.id === item.ref?.id) : slot;
      const resolved = !!item?.done;
      const block = item?.ref && state.planner.calendar.blocks.find(record => record.username === snap.username && record.date === date && record.blockerId === item.ref.id && record.status !== 'Declined');
      const title = item ? item.t : task.title;
      const why = item ? item.why : `${task.kind.replaceAll('-', ' ')} · ${task.priority}${task.aog ? ' · AOG' : ''}`;
      return <li className={`big3-slot${resolved ? ' is-done' : ''}`} key={item?.ref?.id || task.id || index}>
        <div className="big3-slot-copy"><strong>{index + 1}. {title || 'Open priority slot'}</strong>{why && <span>{why}</span>}
          {task?.due && <time dateTime={task.due}>Due {displayDate(task.due)}</time>}{resolved && <span>Resolved in the record</span>}
          {block && <span className={`pill${block.status === 'Accepted' ? ' accepted' : ''}`}>{block.status} time · {block.start} to {block.end}</span>}
        </div>
        {!hasPlan && task && <span className="fr-big3-priority">Priority {index + 1}</span>}
        {hasPlan && !resolved && item?.t && <div className="big3-slot-actions">
          {item.status === 'accepted' ? <span className="pill accepted">Accepted</span> : <button className="btn quiet" data-action="big3-decide" data-index={index} data-decision="accept">Accept</button>}
          <label className="sr-only" htmlFor={`big3-reason-${index}`}>Reason for declining task {index + 1}</label><input id={`big3-reason-${index}`} className="big3-reason" maxLength="300" placeholder="Reason to decline"/>
          <button className="btn quiet" data-action="big3-decide" data-index={index} data-decision="decline">Decline</button>
          {!block ? <><label className="sr-only" htmlFor={`big3-start-${index}`}>Proposed start time for task {index + 1}</label><input id={`big3-start-${index}`} type="time" aria-label="Proposed start time"/><label className="sr-only" htmlFor={`big3-end-${index}`}>Proposed end time for task {index + 1}</label><input id={`big3-end-${index}`} type="time" aria-label="Proposed end time"/><button className="btn quiet" data-action="big3-time-propose" data-index={index}>Propose time</button></> : block.status === 'Proposed' && <><button className="btn quiet" data-action="big3-time-decide" data-id={block.id} data-decision="accept">Accept time</button><button className="btn quiet" data-action="big3-time-decide" data-id={block.id} data-decision="decline">Decline time</button></>}
          {window.skAuth?.can?.('post-notice') && <><label className="sr-only" htmlFor={`big3-escalation-${index}`}>Escalation reason</label><input id={`big3-escalation-${index}`} className="big3-reason" maxLength="500" placeholder="Escalation reason"/><button className="btn quiet" data-action="big3-escalate" data-index={index}>Escalate to QA</button></>}
        </div>}
      </li>;
    })}</ol> : <p className="muted">No open tasks are assigned to your capabilities.</p>}
    <div className="big3-footer">{!hasPlan && snap.candidates.length > 0 && <button className="btn primary" data-action="big3-create">Set today's Big Three</button>}
      {hasPlan && snap.day.big3.some(slot => slot.status === 'accepted' && !slot.done) && <button className="btn" data-action="big3-carry">Carry accepted tasks to tomorrow</button>}
      <span className="muted">{snap.total} open blocker{snap.total === 1 ? '' : 's'} in your queue</span>
      {state.planner.calendar.connectors.ical && <><button className="btn quiet" data-action="cal-export">Export iCal</button><label className="btn quiet" htmlFor="flight-cal-import">Import iCal<input id="flight-cal-import" className="sr-only" type="file" accept=".ics,text/calendar" data-cal-import/></label></>}
      {window.skAuth?.can?.('configure-org') && <button className="btn quiet" data-action="cal-toggle">{state.planner.calendar.connectors.ical ? 'Disable iCal' : 'Enable iCal'}</button>}
      <span className="muted">{state.planner.calendar.connectors.ical ? 'iCal file sync enabled' : 'iCal is off. Google and Outlook live connectors are not present in the supplied Datum source.'}</span>
    </div>
  </section>;
}

function PlanBoard({ state, MES, FlightPlan, onMutation, initialQuery = '', initialStatus = 'All' }) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const rows = FlightPlan.list(state).filter(item => {
    const c = item.configuration || {};
    const searchable = [item.id, item.masterWI?.id, item.masterWI?.title, c.partNumber, c.pedigree, c.subcategory].map(asText).join(' ').toLowerCase();
    return (status === 'All' || item.status === status) && searchable.includes(query.trim().toLowerCase());
  }).sort((a, b) => asText(a.needDate).localeCompare(asText(b.needDate)) || asText(a.id).localeCompare(asText(b.id)));
  const projectPlan = MES.ensureProjects(state);
  const displayDate = value => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not scheduled';
  const density = () => setCompact(value => {
    const next = !value;
    try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {}
    return next;
  });
  const Dispatch = () => {
    const centers = MES.WORK_CENTERS || [];
    const [centerId, setCenterId] = useState(centers[0]?.id || '');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const load = centerId ? MES.workCenterCapacity(state, centerId, date) : null;
    return <section className="fr-dispatch" aria-labelledby="fr-dispatch-heading">
      <div className="fr-section-heading"><div><h2 id="fr-dispatch-heading">Work-center dispatch</h2><span className="fr-count">{String(load?.queue.length || 0).padStart(2, '0')}</span></div>
        <div className="fr-dispatch-controls"><label>Work center<select aria-label="Work center" value={centerId} onChange={event => setCenterId(event.target.value)}>{centers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Capacity date<input type="date" aria-label="Capacity date" value={date} onChange={event => setDate(event.target.value)}/></label></div>
      </div>
      {load && <div className={`fr-capacity${load.overCapacity ? ' is-over' : ''}`}><strong>{load.plannedHours.toLocaleString()} of {load.availableHours} hours scheduled</strong><span>{load.workdays}-day horizon through {displayDate(load.horizonEnd)}</span><span>{load.overCapacity ? `${(load.plannedHours - load.availableHours).toLocaleString()} hours over capacity` : `${load.remainingHours.toLocaleString()} hours remaining`}</span>{load.unestimatedOperations > 0 && <span>{load.unestimatedOperations} operation{load.unestimatedOperations === 1 ? '' : 's'} missing standard hours</span>}</div>}
      <div className="fr-dispatch-table"><table><thead><tr><th>Rank</th><th>Work order</th><th>Operation</th><th>Due date</th><th>Hours remaining</th></tr></thead><tbody>{load?.queue.map(item => <tr key={`${item.workOrderId}/${item.operationId}`} className={item.aog ? 'fr-dispatch-aog' : ''}><td>{item.rank}</td><td><button className="fr-record-link" data-action="open-order" data-order={item.workOrderId}>{item.workOrderId}</button>{item.aog && <span className="fr-overdue-label">AOG</span>}</td><td><strong>{item.operationNumber} · {item.title}</strong><small>{item.workCenter} · {item.site}</small></td><td>{displayDate(item.due)}</td><td>{item.remainingHours === null ? <span className="fr-muted">Not estimated</span> : `${item.remainingHours.toLocaleString()} h`}{item.actualHours > 0 && <small>{item.actualHours.toLocaleString()} h logged</small>}</td></tr>)}</tbody></table>{!load?.queue.length && <div className="fr-empty">No open operations are assigned to this work center.</div>}</div>
    </section>;
  };
  const Projects = () => {
    const [notice, setNotice] = useState('');
    const [sensitivityReasons, setSensitivityReasons] = useState({});
    const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
    const today = new Date().toISOString().slice(0, 10);
    const report = sprint => MES.sprintReport(state, sprint.id);
    const submit = (event, run) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      const result = run(data);
      setNotice(result.message || (result.ok ? 'Planning record saved.' : 'Could not save planning record.'));
      if (result.ok) { form.reset(); onMutation?.(result); }
    };
    return <section className="fr-projects" aria-labelledby="fr-projects-heading">
      <div className="fr-section-heading"><div><h2 id="fr-projects-heading">Projects and milestones</h2><span className="fr-count">{String(projectPlan.projects.length).padStart(2, '0')}</span></div></div>
      <div className="fr-project-grid"><div className="fr-project-forms">
        <form onSubmit={event => submit(event, data => MES.createProject(state, { ...data }))}>
          <h3>New WBS project</h3><label>Project name<input name="name" maxLength="100" required/></label><label>Parent project<select name="parentId"><option value="">Top level</option>{projectPlan.projects.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}</select></label><div className="fr-project-row"><label>Lifecycle<select name="lifecycle">{MES.PROJECT_LIFECYCLES.filter(item => item !== 'Closed').map(item => <option key={item}>{item}</option>)}</select></label><label>Sensitivity<select name="sensitivity">{MES.PROJECT_SENSITIVITY.map(item => <option key={item}>{item}</option>)}</select></label></div><div className="fr-project-row"><label>Start date<input type="date" name="startDate" value={startDate} onChange={event => setStartDate(event.target.value)} required/></label><label>Due date<input type="date" name="dueDate" min={startDate} required/></label></div><button type="submit">Add project</button>
        </form>
        <form onSubmit={event => submit(event, data => MES.addProjectObjective(state, data))}>
          <h3>Dated objective</h3><label>Objective<input name="title" maxLength="120" required/></label><label>Due date<input type="date" name="dueDate" defaultValue={today} required/></label><button type="submit" disabled={!projectPlan.projects.length}>Add objective</button>
        </form>
        <form onSubmit={event => submit(event, data => MES.addProjectMilestone(state, { ...data, mustStart: event.currentTarget.elements.mustStart.checked }))}>
          <h3>Milestone</h3><label>Milestone<input name="title" maxLength="120" required/></label><label>Project<select name="projectId"><option value="">No project</option>{projectPlan.projects.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}</select></label><label>Objective<select name="objectiveId"><option value="">No objective</option>{projectPlan.objectives.map(item => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}</select></label><label>Linked work order<select name="workOrderId"><option value="">No work order</option>{state.orders.filter(item => item.status !== 'Closed').map(item => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}</select></label><label>Due date<input type="date" name="dueDate" defaultValue={today} required/></label><label className="fr-project-check"><input type="checkbox" name="mustStart"/> Must start</label><button type="submit" disabled={!projectPlan.projects.length && !projectPlan.objectives.length}>Add milestone</button>
        </form>
        <form onSubmit={event => submit(event, data => MES.createSprint(state, { ...data, backlog: [...event.currentTarget.elements.operationRef.selectedOptions].map(option => { const [workOrderId, operationId] = option.value.split('|'); return { workOrderId, operationId }; }) }))}>
          <h3>Work-center sprint</h3><label>Sprint name<input name="name" maxLength="100" required/></label><label>Work center<select name="workCenterId">{MES.WORK_CENTERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="fr-project-row"><label>Start<input type="date" name="startDate" defaultValue={today} required/></label><label>End<input type="date" name="endDate" defaultValue={today} required/></label></div><label>Open operations<select name="operationRef" multiple size="5">{state.orders.filter(order => order.status !== 'Closed').flatMap(order => (order.operations || []).filter(operation => !operation.done && operation.workCenterId).map(operation => <option key={`${order.id}/${operation.id}`} value={`${order.id}|${operation.id}`}>{order.id} · {operation.title}</option>))}</select></label><button type="submit">Create sprint</button>
        </form>
        <details className="fr-equipment-setup"><summary>Equipment, work units and maintenance</summary>
          <form onSubmit={event => submit(event, data => MES.addEquipmentArea(state, data))}><h3>Add site area</h3><label>Area name<input name="name" maxLength="80" required/></label><label>Site<select name="site">{MES.SITES.map(site => <option key={site}>{site}</option>)}</select></label><button type="submit">Add area</button></form>
          <form onSubmit={event => submit(event, data => MES.addEquipmentUnit(state, { ...data, tag: data.tag || undefined }))}><h3>Add work unit</h3><label>Unit name<input name="name" maxLength="80" required/></label><label>Unit tag<input name="tag" maxLength="60" placeholder="Assigned when added"/></label><label>Work center<select name="workCenterId">{MES.WORK_CENTERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Area<select name="areaId"><option value="">No area</option>{(state.resources?.areas || []).map(area => <option key={area.id} value={area.id}>{area.id} · {area.name}</option>)}</select></label><label>Calibrated tool<select name="toolTag"><option value="">No linked tool</option>{MES.calibratedToolChecks(state).map(c => c.tool).map(tool => <option key={tool.tag} value={tool.tag}>{tool.tag} · {tool.description}</option>)}</select></label><button type="submit">Add unit</button></form>
          <form onSubmit={event => submit(event, data => MES.recordMaintenance(state, data))}><h3>Open maintenance</h3><label>Asset<select name="assetTag">{MES.equipmentUnitsFor(state).map(unit => <option key={unit.tag} value={unit.tag}>{unit.tag} · {unit.name}</option>)}{MES.calibratedToolChecks(state).map(c => c.tool).map(tool => <option key={tool.tag} value={tool.tag}>{tool.tag} · {tool.description}</option>)}</select></label><label>Maintenance type<select name="type">{MES.MAINTENANCE_TYPES.map(type => <option key={type}>{type}</option>)}</select></label><label>Description<input name="description" maxLength="300" required/></label><button type="submit">Take out of service</button></form>
          <div className="fr-equipment-list"><h3>Registered work units</h3>{MES.equipmentUnitsFor(state).map(unit => <article key={unit.id}><strong>{unit.tag} · {unit.name}</strong><span>{unit.site} · {(state.resources?.areas || []).find(area => area.id === unit.areaId)?.name || 'Area not set'} · {unit.workCenterId}{unit.toolTag ? ` · ${unit.toolTag}` : ''}</span></article>)}<h3>Open maintenance</h3>{(state.resources?.maintenance || []).filter(item => item.status === 'Open').map(item => <form key={item.id} onSubmit={event => submit(event, data => MES.closeMaintenance(state, item.id, data.result))}><strong>{item.id} · {item.assetTag} · {item.type}</strong><span>{item.description} · opened by {item.openedBy.name}</span><label>Return-to-service result<input name="result" maxLength="300" minLength="3" required/></label><button type="submit">Verify and return to service</button></form>)}</div>
        </details>
        {notice && <p className="fr-project-notice" role="status">{notice}</p>}
      </div><div className="fr-project-register">
        <h3>WBS and objectives</h3>{projectPlan.projects.map(item => <article key={item.id}><div><strong>{item.id} · {item.name}</strong><span>{item.lifecycle} · {displayDate(item.startDate)} to {displayDate(item.dueDate)} · {MES.projectLaborRollup(state, item.id)?.hours || 0} h actual</span></div><label>Reason for raising sensitivity<input aria-label={`Reason for sensitivity change to ${item.name}`} value={sensitivityReasons[item.id] || ''} onChange={event => setSensitivityReasons(value => ({ ...value, [item.id]: event.target.value }))} placeholder="Why is the work more sensitive?"/></label><label>Sensitivity<select aria-label={`Sensitivity for ${item.name}`} value={item.sensitivity} onChange={event => { const result = MES.setProjectSensitivity(state, item.id, event.target.value, sensitivityReasons[item.id]); if (!result.ok) setNotice(result.message); else { setSensitivityReasons(value => ({ ...value, [item.id]: '' })); onMutation?.(result); } }}>{MES.PROJECT_SENSITIVITY.map(level => <option key={level}>{level}</option>)}</select></label></article>)}{!projectPlan.projects.length && <p className="fr-empty">No project WBS records yet.</p>}
        <h3>Milestone watch</h3>{projectPlan.milestones.filter(item => item.status === 'Open').sort((a,b) => a.dueDate.localeCompare(b.dueDate)).map(item => { const late = item.dueDate < today; return <article key={item.id} className={late ? 'fr-milestone-late' : ''}><div><strong>{item.id} · {item.title}</strong><span>{displayDate(item.dueDate)}{item.mustStart ? ' · Must start' : ''}{item.workOrderId ? ` · ${item.workOrderId}` : ''}</span></div>{late && <b>At risk</b>}</article>; })}
        <h3>Sprint burndown</h3>{projectPlan.sprints.map(item => { const data = report(item); return <article key={item.id}><div><strong>{item.id} · {item.name}</strong><span>{data.backlog} operations · {data.remainingHours} h remaining of {data.capacityHours} h · latest start {data.latestStartDate ? displayDate(data.latestStartDate) : 'insufficient throughput data'}</span></div></article>; })}{!projectPlan.sprints.length && <p className="fr-empty">No sprints yet.</p>}
      </div></div>
    </section>;
  };
  return <div className="flight-react fr-plan">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT PLAN</span><h1>Planned orders<span>.</span></h1></div><div className="fr-workspace"><CalendarClock size={15}/> Master WI based planning</div></div>
    <BigThree state={state} MES={MES}/>
    <Projects/>
    <Dispatch/>
    <section className="fr-queue" aria-labelledby="fr-plan-heading">
      <div className="fr-queue-heading"><div className="fr-section-heading"><h2 id="fr-plan-heading">Planning queue</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-controls"><label className="fr-search"><Search size={16}/><input aria-label="Search planned orders" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search planned orders"/></label>
          <label className="fr-filter-select"><span className="fr-visually-hidden">Planned order status</span><select aria-label="Planned order status" value={status} onChange={event => setStatus(event.target.value)}>{['All', ...FlightPlan.STATUSES].map(value => <option key={value}>{value}</option>)}</select></label>
          <button className="fr-density" aria-pressed={compact} onClick={density}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button>
          <button className="fr-primary" data-action="plan-create"><Plus size={16}/> Plan from master WI</button>
        </div>
      </div>
      <div className="fr-table-scroll"><table className={compact ? 'fr-compact' : ''}><thead><tr><th>Planned order</th><th>Master WI</th><th>Configuration</th><th>Quantity</th><th>Need date</th><th>NetSuite on hand</th><th>Status</th><th>Work order</th><th><span className="fr-visually-hidden">Actions</span></th></tr></thead><tbody>
        {rows.map(item => { const c = item.configuration; const late = FlightPlan.overdue(item); return <tr key={item.id} className={late ? 'fr-overdue' : ''}>
          <td><strong className="fr-mono">{item.id}</strong>{late && <small className="fr-overdue-label">Past need date</small>}</td>
          <td><strong className="fr-mono">{item.masterWI.id} Rev {item.masterWI.revision}</strong><small>{item.masterWI.title}</small></td>
          <td><strong className="fr-mono">{c.partNumber} / Rev {c.partRevision}</strong><small>{c.pedigree} · {c.subcategory}</small><small>{c.site || 'Unassigned'} · {c.aircraft}</small></td>
          <td>{item.quantity}</td><td><time dateTime={item.needDate}>{displayDate(item.needDate)}</time></td>
          <td>{item.netsuite ? <><strong>{item.netsuite.onHand}</strong><small>Snapshot {displayDate(item.netsuite.snapshotAt?.slice(0, 10))}</small></> : <span className="fr-muted">Not read</span>}</td>
          <td><span className="fr-status"><i/>{item.status}</span></td>
          <td>{item.workOrder ? <button className="fr-record-link" data-action="open-order" data-order={item.workOrder.id}>{item.workOrder.id}</button> : <span className="fr-muted">Not converted</span>}</td>
          <td className="fr-plan-actions">{item.status === 'Planned' && <button className="fr-text-action" data-action="plan-firm" data-plan={item.id}>Firm</button>}{item.status === 'Firm' && <button className="fr-text-action" data-action="plan-convert" data-plan={item.id}>Convert</button>}{['Planned', 'Firm'].includes(item.status) && <button className="fr-text-action" data-action="plan-cancel" data-plan={item.id}>Cancel</button>}</td>
        </tr>; })}
      </tbody></table>{!rows.length && <div className="fr-empty">No planned orders match these filters.</div>}</div>
      <footer><span>{rows.length} planned orders</span><span><Check size={13}/> Records stay linked to their released master WI</span></footer>
    </section>
  </div>;
}

function PlanningNav() {
  return <nav className="fr-planning-nav" aria-label="Flight Plan views">
    <button data-action="nav" data-view="plan">Planned orders</button>
    <button data-action="nav" data-view="plan-kanban" aria-current="page">Kanban</button>
    <button data-action="nav" data-view="plan-forecast">MRP forecast</button>
  </nav>;
}

function PlanKanban({ state, MES, FlightPlan }) {
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const all = FlightPlan.list(state);
  const covered = item => !item.netsuite || item.netsuite.onHand >= item.quantity;
  const columns = [
    { title: 'Created', hint: 'Planned, not yet firmed.', rows: all.filter(item => item.status === 'Planned') },
    { title: 'Pending materials', hint: 'Firm, with a recorded NetSuite shortage.', rows: all.filter(item => item.status === 'Firm' && !covered(item)) },
    { title: 'Pending work order', hint: 'Firm and covered. Conversion creates the Flight Control work order.', rows: all.filter(item => item.status === 'Firm' && covered(item)) },
    { title: 'Converted', hint: 'Linked to a Flight Control work order.', rows: all.filter(item => item.status === 'Converted') }
  ];
  const displayDate = value => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not scheduled';
  const toggleDensity = () => setCompact(value => { const next = !value; try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {} return next; });
  return <div className="flight-react fr-plan fr-kanban-page">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT PLAN</span><h1>Kanban<span>.</span></h1></div><button className="fr-primary" data-action="plan-create"><Plus size={16}/> Plan from master WI</button></div>
    <PlanningNav/>
    <div className="fr-section-heading fr-kanban-heading"><div><h2>Planned order flow</h2><span className="fr-count">{all.filter(item => item.status !== 'Cancelled').length} active</span></div><button className="fr-density" aria-pressed={compact} onClick={toggleDensity}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button></div>
    <div className={`fr-plan-lanes${compact ? ' is-compact' : ''}`}>{columns.map(column => {
      const rows = column.rows.slice().sort((a, b) => asText(a.needDate).localeCompare(asText(b.needDate)) || asText(a.id).localeCompare(asText(b.id)));
      return <section className="fr-plan-lane" aria-label={column.title} key={column.title}>
        <div className="fr-plan-lane-head"><div><h2>{column.title}</h2><p>{column.hint}</p></div><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-plan-lane-cards">{rows.map(item => {
          const config = item.configuration || {}, shortage = item.netsuite ? Math.max(0, item.quantity - item.netsuite.onHand) : 0, late = FlightPlan.overdue(item);
          return <article className={`fr-plan-card${late ? ' is-late' : ''}`} key={item.id}>
            <div className="fr-plan-card-top"><strong className="fr-mono">{item.id}</strong><span className="fr-status"><i/>{item.status}</span></div>
            <h3>{config.partNumber || 'Part not set'} <small>/ Rev {config.partRevision || 'Unassigned'}</small></h3>
            <p>{item.masterWI?.id} Rev {item.masterWI?.revision} · {item.masterWI?.title}</p>
            <div className="fr-plan-card-meta"><span>Qty {item.quantity}</span><time dateTime={item.needDate}>Need {displayDate(item.needDate)}</time></div>
            {late && <span className="fr-overdue-label">Past need date</span>}
            {item.netsuite && <p className={shortage ? 'fr-plan-shortage' : 'fr-plan-covered'}>NetSuite on hand {item.netsuite.onHand}{shortage ? ` · short ${shortage}` : ' · covered'}</p>}
            <div className="fr-plan-card-actions">
              <button className="fr-text-action" data-action="plan-open" data-plan={item.id}>View details</button>
              {item.status === 'Planned' && <button className="fr-text-action" data-action="plan-firm" data-plan={item.id}>Firm</button>}
              {item.status === 'Firm' && <button className="fr-text-action" data-action="plan-convert" data-plan={item.id}>Convert</button>}
              {['Planned', 'Firm'].includes(item.status) && <button className="fr-text-action is-muted" data-action="plan-cancel" data-plan={item.id}>Cancel</button>}
              {item.workOrder && <button className="fr-record-link" data-action="open-order" data-order={item.workOrder.id}>{item.workOrder.id}</button>}
            </div>
          </article>;
        })}{!rows.length && <p className="fr-empty">Nothing in this stage.</p>}</div>
      </section>;
    })}</div>
    <p className="fr-muted fr-plan-cancelled">{all.filter(item => item.status === 'Cancelled').length} cancelled planned orders are retained in the record.</p>
  </div>;
}

function ForecastTable({ title, columns, rows, empty, compact }) {
  return <section className="fr-forecast-section" aria-labelledby={`forecast-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
    <div className="fr-section-heading"><div><h2 id={`forecast-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{title}</h2><span className="fr-count">{rows.length}</span></div></div>
    {rows.length ? <div className="fr-table-scroll"><table className={compact ? 'fr-compact' : ''}><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows}</tbody></table></div> : <p className="fr-empty">{empty}</p>}
  </section>;
}

function ForecastOrderLinks({ orders }) {
  const visible = orders.slice(0, 3);
  const remaining = orders.slice(3);
  const link = id => <button key={id} className="fr-record-link" data-action="plan-open" data-plan={id}>{id}</button>;
  return <div className="fr-forecast-orders">
    {visible.map(link)}
    {remaining.length > 0 && <details className="fr-forecast-orders-more">
      <summary>+{remaining.length} more</summary>
      <div>{remaining.map(link)}</div>
    </details>}
  </div>;
}

function PlanForecast({ state, MES, FlightPlan }) {
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const forecast = FlightPlan.forecast(state), today = new Date().toISOString().slice(0, 10);
  const toggleDensity = () => setCompact(value => { const next = !value; try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {} return next; });
  const date = value => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not scheduled';
  return <div className="flight-react fr-plan fr-forecast-page">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT PLAN</span><h1>MRP forecast<span>.</span></h1></div><button className="fr-density" aria-pressed={compact} onClick={toggleDensity}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button></div>
    <PlanningNav/>
    <div className="fr-forecast-summary"><div><span>Open planned orders</span><strong>{forecast.open.length}</strong></div><div><span>Component demands</span><strong>{forecast.explosion.length}</strong></div><div><span>Expiring lots</span><strong>{forecast.shelfLife.length}</strong></div><div><span>Non-interchangeable changes</span><strong>{forecast.designChanges.length}</strong></div></div>
    <ForecastTable title="Component demand" columns={['Component', 'Qty per · demand', 'On hand', 'Short', 'Lead', 'Order by', 'From']} empty="No open planned orders produce component demand." compact={compact} rows={forecast.explosion.map((item, index) => <tr key={`${item.part}/${item.rev}/${index}`}><td><strong className="fr-mono">{item.part} / Rev {item.rev}</strong><small>{item.title}</small></td><td>{item.qtyPer} · {item.qty}</td><td>{item.onHand}</td><td>{item.short ? <span className="fr-status is-error"><i/>{item.short}</span> : <span className="fr-status is-ready"><i/>Covered</span>}</td><td>{item.leadDays} days</td><td className={item.orderBy && item.orderBy < today ? 'fr-overdue-label' : ''}>{date(item.orderBy)}</td><td><ForecastOrderLinks orders={item.orders}/></td></tr>)}/>
    <ForecastTable title="Lead time from actuals" columns={['Part', 'Runs', 'Average', 'Longest', 'Real closures']} empty="No completed work-order history is available." compact={compact} rows={forecast.leadTime.map(item => <tr key={item.part}><td><strong className="fr-mono">{item.part}</strong></td><td>{item.runs.join(', ')}</td><td>{item.avg} days</td><td>{item.max} days</td><td>{item.real ? <span className="fr-status is-ready"><i/>{item.real}</span> : <span className="fr-muted">Demo history only</span>}</td></tr>)}/>
    <ForecastTable title="First Production FAIR" columns={['Planned order', 'Part / revision', 'Trigger', 'Action']} empty="No open first-Production planned orders need a FAIR plan." compact={compact} rows={forecast.fair.map(item => <tr key={item.id}><td><button className="fr-record-link" data-action="plan-open" data-plan={item.id}>{item.id}</button></td><td>{item.configuration.partNumber} / Rev {item.configuration.partRevision}</td><td>First Production build of this revision</td><td><span className="fr-status"><i/>FAIR planning required</span></td></tr>)}/>
    <ForecastTable title="Shelf life" columns={['Lot', 'Component', 'On hand', 'Expires', 'Open demand', 'Action']} empty="No lots expire in the forecast window." compact={compact} rows={forecast.shelfLife.map(item => <tr key={item.lot}><td><strong className="fr-mono">{item.lot}</strong></td><td>{item.part} / Rev {item.rev}</td><td>{item.onHand}</td><td className={item.daysLeft <= 14 ? 'fr-overdue-label' : ''}>{date(item.expires)} · {item.daysLeft} days</td><td>{item.demand}</td><td>{item.demand ? <span className="fr-status is-error"><i/>Replacement demand</span> : <span className="fr-muted">Quarantine at expiry</span>}</td></tr>)}/>
    <ForecastTable title="Design changes" columns={['Component', 'Supersedes', 'Old revision stock', 'New revision stock', 'Open demand', 'Buy']} empty="No non-interchangeable design changes affect open demand." compact={compact} rows={forecast.designChanges.map((item, index) => <tr key={`${item.part}/${item.rev}/${index}`}><td><strong className="fr-mono">{item.part} / Rev {item.rev}</strong><small>{item.title}</small></td><td>Rev {item.supersedes}</td><td>{item.oldOnHand} · unavailable</td><td>{item.newOnHand}</td><td>{item.demand}</td><td>{item.buy ? <span className="fr-status is-error"><i/>{item.buy}</span> : <span className="fr-status is-ready"><i/>Covered</span>}</td></tr>)}/>
  </div>;
}

function ManeuverDrawer({ item, onClose, onOpen }) {
  const dialog = useRef(null);
  const returnFocus = useRef(null);
  const lastItem = useRef(null);
  if (item) lastItem.current = item;
  const record = item || lastItem.current;
  useEffect(() => {
    if (!item) return;
    returnFocus.current = document.activeElement;
    const frame = requestAnimationFrame(() => {
      if (!dialog.current || dialog.current.open) return;
      dialog.current.showModal();
      dialog.current.querySelector('[data-close-drawer]').focus();
    });
    return () => { cancelAnimationFrame(frame); };
  }, [item]);
  const close = () => { if (dialog.current?.open) dialog.current.close(); onClose(); };
  return <dialog className="fr-drawer" ref={dialog} onCancel={event => { event.preventDefault(); close(); }}>
    {record && <section className="fr-drawer-panel" aria-labelledby="fr-mnv-drawer-title">
      <div className="fr-drawer-top"><span>FLIGHT MANEUVER · {record.kind}</span><button data-close-drawer aria-label="Close record details" onClick={close}><X size={19}/></button></div>
      <div className="fr-drawer-icon"><CircleAlert size={23}/></div><h2 id="fr-mnv-drawer-title">{record.title}</h2>
      <p className="fr-drawer-id">{record.id} · {record.status}</p>
      <dl className="fr-drawer-fields">
        <div><dt>Owner</dt><dd>{record.owner || 'Unassigned'}</dd></div>
        <div><dt>Due</dt><dd>{displayFlightDate(record.dueDate)}</dd></div>
        {record.workOrderId && <div><dt>Work order</dt><dd>{record.workOrderId}</dd></div>}
        {record.partNumber && <div><dt>Part number</dt><dd>{record.partNumber}</dd></div>}
        <div><dt>Next permitted step</dt><dd>{record.nextStep || 'Open the record to review its current gate.'}</dd></div>
      </dl>
      {record.summary && <p className="fr-mnv-summary">{record.summary}</p>}
      <button className="fr-primary" onClick={() => { close(); onOpen(record); }}>Open full record <ArrowUpRight size={17}/></button>
    </section>}
  </dialog>;
}

function ManeuverHangar({ state, FM, view, onOpen }) {
  const pageKind = ({ 'mnv-intake': 'NC', 'mnv-cars': 'CAR', 'mnv-mrb': 'MRB', 'mnv-spr': 'SPR' })[view] || 'All';
  const pageTitle = ({ NC: 'NC Intake', CAR: 'Corrective Actions', MRB: 'Material Review Board', SPR: 'Problem Reports' })[pageKind] || 'Quality Hangar';
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState(pageKind);
  const [intakeFilter, setIntakeFilter] = useState('All');
  const [sourceFilter, setSourceFilter] = useState('All');
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const [selected, setSelected] = useState(null);
  useEffect(() => { setKind(pageKind); setSelected(null); }, [pageKind]);
  const metrics = FM.metrics(state);
  const intake = FM.intake(state).filter(row => pageKind === 'NC' ? (
    (intakeFilter === 'All' || (intakeFilter === 'Attention' ? row.mrbState === 'Needed' || row.mrb?.status === 'Open' || (row.ticketStatus === 'Open' && (row.hold || row.stock)) : intakeFilter === 'Open' ? row.ticketStatus === 'Open' : intakeFilter === 'Escapes' ? !!row.escape : row.ticketStatus === 'Resolved')) &&
    (sourceFilter === 'All' || (sourceFilter === 'Stock' ? row.stock : !row.stock))
  ) : row.ticketStatus === 'Open' || row.mrbState === 'Needed' || row.mrb?.status === 'Open').map(row => ({
    kind: 'NC', id: row.ticketId, title: row.title, status: row.mrb?.status || row.ticketStatus || row.mrbState,
    dueDate: row.dueDate, workOrderId: row.stock ? '' : row.orderId, partNumber: row.partNumber, source: row.stock ? 'STOCK' : row.orderId,
    summary: `${row.stock ? 'STOCK · ' : ''}${row.defect || row.dispo || ''}`.trim(), nextStep: row.mrbState === 'Needed' ? 'Open the linked record to start or review the MRB.' : 'Review NC intake and disposition.'
  }));
  const cars = FM.list(state, 'cars').filter(row => pageKind === 'CAR' || !['Closed', 'Cancelled'].includes(row.status)).map(row => ({
    kind: 'CAR', id: row.id, title: row.title, status: row.status, dueDate: row.dueDate || row.effectivenessDue,
    owner: row.owner?.name || row.owner, workOrderId: row.orderId, partNumber: row.partNumber, summary: row.description,
    nextStep: FM.carNext(row) || (FM.carOverdue(row) ? 'Past due: review corrective action.' : 'Review the corrective action record.')
  }));
  const boards = FM.list(state, 'mrb').filter(row => pageKind === 'MRB' || row.status === 'Open').map(row => ({
    kind: 'MRB', id: row.id, title: row.summary || `${row.proposed || 'Disposition'} review`, status: row.status,
    dueDate: row.dueDate, workOrderId: row.orderId, partNumber: row.partNumber, summary: `Ticket ${row.ticketId || 'not linked'} · ${row.proposed || 'Disposition pending'}`,
    nextStep: (row.seats || []).filter(seat => !(row.votes || []).some(vote => vote.seat === seat)).length ? 'An assigned MRB seat still needs to vote.' : 'Review the board decision.'
  }));
  const sprs = FM.list(state, 'sprs').filter(row => pageKind === 'SPR' || row.status !== 'Closed').map(row => ({
    kind: 'SPR', id: row.id, title: row.title, status: row.status, dueDate: row.dueDate,
    owner: row.owner?.name || row.owner, workOrderId: row.orderId, partNumber: row.partNumber, summary: row.description || row.foundAt,
    nextStep: row.jira?.key ? `Jira ${row.jira.key} · status is tracked here.` : 'Copy the record into Jira and record its key.'
  }));
  const rows = [...intake, ...cars, ...boards, ...sprs].filter(row => (kind === 'All' || row.kind === kind) && [row.id, row.kind, row.title, row.status, row.workOrderId, row.partNumber, row.owner, row.summary].map(asText).join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => asText(a.dueDate || '9999').localeCompare(asText(b.dueDate || '9999')) || a.id.localeCompare(b.id));
  const density = () => setCompact(value => { const next = !value; try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {} return next; });
  return <div className="flight-react fr-maneuver">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT MANEUVER</span><h1>{pageTitle}<span>.</span></h1></div><div className="fr-workspace">{pageKind === 'All' ? 'Corrective action · in-house' : `${pageTitle} · Flight Maneuver`}</div></div>
    <section className="fr-mnv-metrics" aria-label="Flight Maneuver current record metrics">
      {[['Open CARs', metrics.carsOpen, 'mnv-cars'], ['Overdue CARs', metrics.carsOverdue, 'mnv-cars'], ['MRB waiting', metrics.mrbNeeded + metrics.mrbOpen, 'mnv-mrb'], ['Open escapes', metrics.escapesOpen, 'mnv-intake'], ['SPR open', metrics.sprOpen, 'mnv-spr'], ['Waiting on Jira', metrics.jiraWaiting, 'mnv-spr']].map(([label, value, view]) => <button key={label} className={`fr-mnv-metric${/overdue|waiting/i.test(label) && value ? ' is-warning' : ''}`} data-action="nav" data-view={view}><span>{label}</span><strong>{value}</strong></button>)}
    </section>
    <section className="fr-queue fr-mnv-queue" aria-labelledby="fr-mnv-queue-heading">
      <div className="fr-queue-heading"><div className="fr-section-heading"><h2 id="fr-mnv-queue-heading">{pageKind === 'All' ? 'Records needing attention' : pageTitle}</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-controls"><label className="fr-search"><Search size={16}/><input aria-label="Search Flight Maneuver records" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ticket, part or work order"/></label>
          {pageKind === 'NC' && <><label className="fr-filter-select"><span className="fr-visually-hidden">Intake filter</span><select aria-label="Filter NC intake" value={intakeFilter} onChange={event => setIntakeFilter(event.target.value)}>{['All', 'Attention', 'Open', 'Escapes', 'Resolved'].map(value => <option key={value}>{value}</option>)}</select></label><label className="fr-filter-select"><span className="fr-visually-hidden">Source</span><select aria-label="Filter NC source" value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>{['All', 'Work order', 'Stock'].map(value => <option key={value}>{value}</option>)}</select></label></>}
          <label className="fr-filter-select"><span className="fr-visually-hidden">Record type</span><select aria-label="Filter record type" value={kind} onChange={event => setKind(event.target.value)}>{['All', 'NC', 'CAR', 'MRB', 'SPR'].map(value => <option key={value}>{value}</option>)}</select></label>
          <button className="fr-density" aria-pressed={compact} onClick={density}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button>
          {pageKind === 'All' || pageKind === 'CAR' ? <button className="fr-primary" data-action="mnv-car-new"><Plus size={16}/>{pageKind === 'CAR' ? 'Raise corrective action' : 'Raise corrective action'}</button> : null}
          {pageKind === 'NC' && <button className="fr-primary" data-action="mnv-nc-new"><Plus size={16}/> Raise NC</button>}
          {pageKind === 'SPR' && <button className="fr-primary" data-action="mnv-spr-new"><Plus size={16}/> Raise SPR</button>}
        </div>
      </div>
      <div className="fr-table-scroll"><table className={compact ? 'fr-compact' : ''}><thead><tr><th>Record</th><th>Details</th><th>Owner</th><th>Due</th><th>Status</th><th><span className="fr-visually-hidden">Open detail</span></th></tr></thead><tbody>
        {rows.map(row => <tr key={`${row.kind}/${row.id}`} className={row.dueDate && row.dueDate < new Date().toISOString().slice(0, 10) && !recordIsTerminal(row.status) ? 'fr-overdue' : ''}><td><button className="fr-record-link" onClick={() => setSelected(row)}><strong>{row.id}</strong><small>{row.kind} · {row.title}</small></button></td><td><strong>{row.summary || row.nextStep}</strong>{row.workOrderId && <small>{row.workOrderId}{row.partNumber ? ` · ${row.partNumber}` : ''}</small>}</td><td>{row.owner || 'Unassigned'}</td><td>{displayFlightDate(row.dueDate)}</td><td><span className="fr-status"><i/>{row.status || 'Open'}</span></td><td><button className="fr-open-button" aria-label={`View ${row.id} details`} onClick={() => setSelected(row)}><ArrowUpRight size={18}/></button></td></tr>)}
      </tbody></table>{!rows.length && <div className="fr-empty">No records match the current search and type filter.</div>}</div>
      <footer><span>{rows.length} {pageKind === 'All' ? 'current records' : pageTitle.toLowerCase() + ' records'}</span><span><Check size={13}/> Record detail and approval gates remain in Flight Maneuver</span></footer>
    </section>
    {pageKind === 'All' && <div className="fr-mnv-create"><button data-action="mnv-nc-new"><Plus size={15}/> Raise NC</button><button data-action="mnv-spr-new"><Plus size={15}/> Raise SPR</button><button data-action="nav" data-view="mnv-intake">NC intake <ArrowUpRight size={15}/></button></div>}
    <ManeuverDrawer item={selected} onClose={() => setSelected(null)} onOpen={onOpen}/>
  </div>;
}

function SerialRegister({ state, onTrace, onOpen }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(`${densityKey}-serials`) === 'compact'; } catch { return false; } });
  const [selected, setSelected] = useState(null);
  const rows = [...(state.serialLog || [])].reverse().filter(item => {
    const text = [item.serial, item.partNumber, item.revision, item.orderId, item.unit, item.lotNumber].join(' ').toLowerCase();
    return (status === 'All' || item.status === status) && text.includes(query.trim().toLowerCase());
  });
  const density = () => setCompact(value => {
    const next = !value;
    try { localStorage.setItem(`${densityKey}-serials`, next ? 'compact' : 'comfortable'); } catch {}
    return next;
  });
  return <div className="flight-react fr-serials">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT CONTROL</span><h1>Serial numbers<span>.</span></h1></div><div className="fr-workspace">Running serial assignment register</div></div>
    <section className="fr-queue" aria-labelledby="fr-serial-heading">
      <div className="fr-queue-heading"><div className="fr-section-heading"><h2 id="fr-serial-heading">Serial number register</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
        <div className="fr-controls"><label className="fr-search"><Search size={16}/><input aria-label="Search serial numbers" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search serial, part, work order or lot"/></label>
          <label className="fr-filter-select"><span className="fr-visually-hidden">Serial status</span><select aria-label="Serial status" value={status} onChange={event => setStatus(event.target.value)}>{['All', 'Assigned', 'In build', 'Closed', 'Voided'].map(value => <option key={value}>{value}</option>)}</select></label>
          <button className="fr-density" aria-pressed={compact} onClick={density}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button>
        </div>
      </div>
      <div className="fr-table-scroll"><table className={compact ? 'fr-compact' : ''}><thead><tr><th>Serial</th><th>Part / revision</th><th>Work order</th><th>Unit</th><th>Lot</th><th>Status</th><th>Created</th><th>Voided</th></tr></thead><tbody>
        {rows.map(item => { const lot = item.lotNumber || state.orders.find(order => order.id === item.orderId)?.inventory?.lotNumber || ''; return <tr key={item.serial} data-serial-row={item.serial} className={item.status === 'Voided' ? 'fr-serial-voided' : ''}>
          <td><button className="fr-record-link" onClick={() => setSelected(item)}><strong>{item.serial}</strong></button></td>
          <td><strong>{item.partNumber}</strong><small>Rev {item.revision}</small></td>
          <td><button className="fr-text-action" onClick={() => onOpen(item.orderId)}>{item.orderId}</button></td><td>{item.unit}</td>
          <td>{lot ? <button className="fr-text-action" onClick={() => onTrace(lot)}>{lot}</button> : <span className="fr-muted">Not stocked</span>}</td>
          <td><span className={`fr-status${item.status === 'Voided' ? ' is-error' : ''}`}><i/>{item.status}</span></td>
          <td>{displayFlightDate(item.assignedAt)}</td><td>{item.voidedAt ? <><time>{displayFlightDate(item.voidedAt)}</time><small>{item.voidReason}</small></> : <span className="fr-muted">None</span>}</td>
        </tr>; })}
      </tbody></table>{!rows.length && <div className="fr-empty">No serial numbers match the current search and status.</div>}</div>
      <footer><span>{rows.length} serial records</span><span>Assignment and void history remain in the Flight System record.</span></footer>
    </section>
    <SerialDrawer item={selected} onClose={() => setSelected(null)} onTrace={onTrace} onOpen={onOpen}/>
  </div>;
}

function SerialDrawer({ item, onClose, onTrace, onOpen }) {
  const dialog = useRef(null);
  const returnFocus = useRef(null);
  useEffect(() => {
    if (!item) return;
    returnFocus.current = document.activeElement;
    const frame = requestAnimationFrame(() => { if (dialog.current && !dialog.current.open) { dialog.current.showModal(); dialog.current.querySelector('[data-close-drawer]')?.focus(); } });
    return () => cancelAnimationFrame(frame);
  }, [item]);
  const close = () => { if (dialog.current?.open) dialog.current.close(); onClose(); queueMicrotask(() => returnFocus.current?.focus?.()); };
  return <dialog className="fr-drawer" ref={dialog} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    {item && <section className="fr-drawer-panel" aria-labelledby="fr-serial-drawer-title"><div className="fr-drawer-top"><span>FLIGHT CONTROL · SERIAL RECORD</span><button data-close-drawer aria-label="Close serial details" onClick={close}><X size={19}/></button></div>
      <div className="fr-drawer-icon"><FileText size={23}/></div><h2 id="fr-serial-drawer-title">{item.serial}</h2><p className="fr-drawer-id">{item.status} · {item.partNumber} Rev {item.revision}</p>
      <dl className="fr-drawer-fields"><div><dt>Work order</dt><dd>{item.orderId}</dd></div><div><dt>Unit</dt><dd>{item.unit}</dd></div><div><dt>Lot</dt><dd>{item.lotNumber || 'Not stocked'}</dd></div><div><dt>Created</dt><dd>{displayFlightDate(item.assignedAt)}</dd></div>{item.voidedAt && <div><dt>Voided</dt><dd>{displayFlightDate(item.voidedAt)} · {item.voidReason}</dd></div>}{item.reworkOrders?.length > 0 && <div><dt>Rework orders</dt><dd>{item.reworkOrders.map(id => <button key={id} className="fr-text-action" onClick={() => { close(); onOpen(id); }}>{id}</button>)}</dd></div>}</dl>
      <div className="fr-serial-actions"><button className="fr-primary" onClick={() => { close(); onTrace(item.serial); }}>Open traceability <ArrowUpRight size={17}/></button><button className="fr-text-action" onClick={() => { close(); onOpen(item.orderId); }}>Open work order inventory <ArrowUpRight size={15}/></button></div>
    </section>}
  </dialog>;
}

function TraceSearch({ state, MES, initialQuery, onSearch, onReport, onRoute }) {
  const [query, setQuery] = useState(initialQuery || '');
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(`${densityKey}-trace`) === 'compact'; } catch { return false; } });
  const result = query.trim() ? MES.traceSearch(state, query.trim()) : null;
  // On the shared server, closed orders move to the read-only archive, so the live workspace no longer holds them.
  // The server's trace search covers both; its archive matches are listed here beside the live results.
  const [archived, setArchived] = useState([]);
  useEffect(() => {
    const q = query.trim(), server = typeof window !== 'undefined' && window.skServer?.active ? window.skServer : null;
    if (!q || !server) { setArchived([]); return undefined; }
    let current = true;
    const timer = setTimeout(() => server.api(`/trace?q=${encodeURIComponent(q)}`).then(response => { if (current) setArchived(response.ok && Array.isArray(response.json?.results) ? response.json.results.filter(row => row.source === 'archive') : []); }).catch(() => { if (current) setArchived([]); }), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);
  // An archived order is read-only on the server: open its printed record or download its signed export there.
  const [archiveNote, setArchiveNote] = useState('');
  const openArchived = async (orderId, kind) => {
    const server = typeof window !== 'undefined' && window.skServer?.active ? window.skServer : null;
    if (!server) return;
    setArchiveNote('');
    // Open the print tab now, inside the click: a tab opened after the fetch can be blocked as a pop-up.
    const tab = kind === 'print' ? window.open('', '_blank') : null;
    if (kind === 'print' && !tab) { setArchiveNote(`${orderId} could not open a print tab. Allow pop-ups for Flight System, then retry.`); return; }
    if (tab) tab.opener = null;
    try {
      const response = await fetch(`${server.context.api}/archive/${encodeURIComponent(orderId)}/${kind}`, { headers: { Authorization: `Bearer ${server.token()}` } });
      if (!response.ok) { tab?.close(); let error = ''; try { error = (await response.json()).error || ''; } catch {} setArchiveNote(`${orderId} could not be opened from the archive${error ? `: ${error}` : ` (${response.status})`}. Sign in again, then retry.`); return; }
      const url = URL.createObjectURL(await response.blob());
      if (tab) tab.location.href = url;
      else { const link = document.createElement('a'); link.href = url; link.download = `${orderId}-archive.json`; document.body.appendChild(link); link.click(); link.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { tab?.close(); setArchiveNote(`${orderId} could not be opened because the server did not answer. Check the connection, then retry.`); }
  };
  const density = () => setCompact(value => {
    const next = !value;
    try { localStorage.setItem(`${densityKey}-trace`, next ? 'compact' : 'comfortable'); } catch {}
    return next;
  });
  const traceLink = value => <button className="fr-text-action" onClick={() => { setQuery(value); onSearch(value); }}>{value}</button>;
  const routeLink = (action, attrs, label) => <button className="fr-text-action" onClick={() => onRoute(action, attrs)}>{label}<ArrowUpRight size={13}/></button>;
  const table = (title, headers, rows, empty) => <section className="fr-trace-section" key={title} aria-label={title}>
    <div className="fr-section-heading"><h2>{title}</h2><span className="fr-count">{String(rows.length).padStart(2, '0')}</span></div>
    {rows.length ? <div className="fr-table-scroll" role="region" aria-label={`${title} results`} tabIndex="0"><table className={compact ? 'fr-compact' : ''}><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows}</tbody></table></div> : <p className="fr-empty">{empty}</p>}
  </section>;
  let sections = [];
  if (result) {
    if (result.tool) sections.push(<div className={`fr-trace-alert${result.tool.status === 'In Calibration' ? ' is-ready' : ' is-warning'}`} key="tool"><CircleAlert size={18}/><div><strong>{result.tool.tag} · {result.tool.description}</strong><p>{result.tool.status} · calibration due {displayFlightDate(result.tool.expires)} · {result.tool.location}. {result.tool.status !== 'In Calibration' || result.tool.expires < new Date().toISOString().slice(0, 10) ? 'Review every operation bought off with this tool.' : 'Every operation below was bought off with this tool.'}</p></div></div>);
    if (result.kind === 'lot' && result.orders.length) sections.push(<div className="fr-trace-alert" key="lot"><Boxes size={18}/><div><strong>{result.query}</strong><p>Stocked from {result.orders.filter(order => order.why.includes('lot')).map(order => <React.Fragment key={order.id}>{routeLink('open-order', { order: order.id }, order.id)} </React.Fragment>)}. Lot serials: {result.serials.map((serial, index) => <React.Fragment key={serial}>{index ? ', ' : ''}{traceLink(serial)}</React.Fragment>)}</p></div></div>);
    if (result.orders.length) sections.push(table('Work orders', ['Work order', 'Part / rev', 'Pedigree', 'Status', 'Lot', 'Serials', 'Matched because', result.tool ? 'Operations using tool' : 'Closed'], result.orders.map(order => <tr key={order.id}><td>{routeLink('open-order', { order: order.id }, order.id)}</td><td>{order.partNumber} / {order.revision}</td><td>{order.pedigree} · {order.subcategory}</td><td><span className="fr-status">{order.status}</span></td><td>{order.lot ? traceLink(order.lot) : <span className="fr-muted">Not stocked</span>}</td><td>{order.serials.length ? order.serials.map((serial, index) => <React.Fragment key={serial}>{index ? ', ' : ''}{traceLink(serial)}</React.Fragment>) : <span className="fr-muted">None</span>}</td><td>{order.why.join(', ')}</td><td>{result.tool ? order.ops.map(operation => <span key={operation.number}>Op {operation.number} {operation.title}{operation.by ? ` · ${operation.by} · ${displayFlightDate(operation.at)}` : ''}<br/></span>) : order.closedAt ? displayFlightDate(order.closedAt) : 'Open'}</td></tr>), 'No work orders.'));
    if (result.tickets.length) sections.push(table('NC', ['Ticket', 'Where', 'Title', 'Disposition', 'MRB', 'CAR', 'Status'], result.tickets.map(ticket => <tr key={ticket.id}><td>{ticket.stock ? routeLink('mnv-open-nc', { nc: ticket.id }, ticket.id) : routeLink('mnv-open-ticket', { order: ticket.orderId, ticket: ticket.id }, ticket.id)}</td><td>{ticket.stock ? <>Stock {ticket.serial && <>· {traceLink(ticket.serial)}</>}{ticket.escape ? ' · escape' : ''}</> : routeLink('open-order', { order: ticket.orderId }, ticket.orderId)}</td><td>{ticket.title}</td><td>{ticket.dispo || <span className="fr-muted">Not yet</span>}</td><td>{ticket.mrbId ? routeLink('mnv-open-board', { board: ticket.mrbId }, ticket.mrbId) : ''}</td><td>{ticket.carId ? routeLink('mnv-open-car', { car: ticket.carId }, ticket.carId) : ''}</td><td>{ticket.status}</td></tr>), 'No tickets.'));
    if (result.mrb.length) sections.push(table('Material Review Board', ['Board', 'Ticket', 'Proposed', 'Status', 'Opened'], result.mrb.map(board => <tr key={board.id}><td>{routeLink('mnv-open-board', { board: board.id }, board.id)}</td><td>{board.ticketId}</td><td>{board.proposed}</td><td>{board.status}</td><td>{displayFlightDate(board.openedAt)}</td></tr>), 'No boards.'));
    if (result.sprs.length) sections.push(table('Problem reports (SPR)', ['SPR', 'Title', 'Found at', 'Occurred', 'Jira', 'Status'], result.sprs.map(spr => <tr key={spr.id}><td>{routeLink('nav', { view: 'mnv-spr', search: spr.id }, spr.id)}</td><td>{spr.title}</td><td>{spr.foundAt}</td><td>{displayFlightDate(spr.occurred)}</td><td>{spr.jira || ''}</td><td>{spr.status}</td></tr>), 'No problem reports.'));
    if (result.cars.length) sections.push(table('Corrective actions', ['CAR', 'Title', 'Status', 'Due', 'SCAR'], result.cars.map(car => <tr key={car.id}><td>{routeLink('mnv-open-car', { car: car.id }, car.id)}</td><td>{car.title}</td><td>{car.status}</td><td>{displayFlightDate(car.dueDate)}</td><td>{car.scar || ''}</td></tr>), 'No corrective actions.'));
    if (result.changes.length) sections.push(table('Change requests', ['Request', 'Type', 'Title', 'Origin', 'ECO', 'Status'], result.changes.map(change => <tr key={change.id}><td>{routeLink('ecr-open', { id: change.id }, change.id)}</td><td>{change.type}</td><td>{change.title}</td><td>{change.origin}</td><td>{change.eco || ''}</td><td>{change.status}</td></tr>), 'No change requests.'));
    if (result.wis?.length) sections.push(table('Master WI revisions', ['WI', 'Revision', 'Status', 'Orders cloned'], result.wis.map(wi => <tr key={`${wi.id}/${wi.revision}`}><td>{routeLink('wi-open', { wi: wi.id, rev: wi.revision }, wi.id)}</td><td>{wi.revision}</td><td>{wi.status}</td><td>{wi.orders}</td></tr>), ''));
  }
  if (result && archived.length) sections.push(<React.Fragment key="archived">{archiveNote && <p className="fr-trace-alert is-warning" role="alert">{archiveNote}</p>}{table('Archived work orders', ['Work order', 'Title', 'Part', 'Serials', 'Lots', 'Closed', 'Archived record'], archived.map(row => <tr key={row.orderId}><td className="fr-mono">{row.orderId}</td><td>{row.title}</td><td className="fr-mono">{row.partNumber}</td><td className="fr-mono">{(row.serials || []).join(', ') || 'None'}</td><td className="fr-mono">{(row.lots || []).join(', ') || 'None'}</td><td>{row.closedAt ? String(row.closedAt).slice(0, 10) : ''}</td><td><button type="button" className="fr-text-action" aria-label={`Print archived ${row.orderId}`} onClick={() => openArchived(row.orderId, 'print')}>Print<ArrowUpRight size={13}/></button> <button type="button" className="fr-text-action" aria-label={`Export archived ${row.orderId}`} onClick={() => openArchived(row.orderId, 'export')}>Export<FileText size={13}/></button></td></tr>), 'No archived work orders match.')}</React.Fragment>);
  const hasRows = (result && ['orders', 'tickets', 'mrb', 'sprs', 'cars', 'changes', 'wis'].some(key => Array.isArray(result[key]) && result[key].length > 0)) || archived.length > 0;
  return <div className="flight-react fr-trace">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT CONTROL</span><h1>Traceability<span>.</span></h1><p>Search a serial, lot, calibrated tool, master WI or change number.</p></div><div className="fr-workspace">Current Flight System records</div></div>
    <section className="fr-queue" aria-label="Traceability search">
      <form className="fr-queue-heading" onSubmit={event => { event.preventDefault(); onSearch(query.trim()); }}><label className="fr-search"><Search size={16}/><input aria-label="Traceability search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Serial, lot, tool tag, WI or change number" autoComplete="off"/></label><div className="fr-controls"><button className="fr-primary" type="submit">Search</button><button className="fr-density" type="button" aria-pressed={compact} onClick={density}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button></div></form>
      {result && <><div className="fr-trace-summary"><strong>{result.kind === 'serial' ? 'Serial number' : result.kind === 'lot' ? 'Lot number' : result.kind === 'tool' ? 'Calibrated tool' : result.kind === 'wi' ? 'Master work instruction' : result.kind === 'change' ? 'Change number' : 'Search'} · {result.query}</strong><span>{result.orders.length} work orders · {result.tickets.length} NCs · {result.sprs.length} SPRs · {result.cars.length} CARs · {result.changes.length} changes</span></div>{['serial', 'lot'].includes(result.kind) && <button className="fr-primary fr-trace-report" onClick={() => onReport(result.query)}><FileText size={16}/> Full traceability report</button>}{sections.length ? <div className="fr-trace-sections">{sections}{!hasRows && <div className="fr-empty">No traceability records match that search.</div>}</div> : <div className="fr-empty">No traceability records match that search.</div>}</>}
      {!result && <div className="fr-empty"><h2>Enter a serial, lot, tool tag, WI or change number</h2><p>Related work orders, quality records and changes will appear here.</p></div>}
    </section>
  </div>;
}

function ActivityDrawer({ event, onClose, onOpenOrder, returnFocus }) {
  const closeButton = useRef(null);
  useEffect(() => {
    if (!event) return;
    closeButton.current?.focus();
    const handleKeyDown = click => {
      if (click.key === 'Escape') { click.preventDefault(); onClose(); }
      if (click.key === 'Tab') {
        const focusable = [...document.querySelectorAll('.fr-activity-overlay button:not([disabled]), .fr-activity-overlay a[href], .fr-activity-overlay input:not([disabled]), .fr-activity-overlay select:not([disabled]), .fr-activity-overlay [tabindex="0"]')];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (click.shiftKey && document.activeElement === first) { click.preventDefault(); last.focus(); }
        else if (!click.shiftKey && document.activeElement === last) { click.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [event, onClose]);
  if (!event) return null;
  const close = () => onClose();
  return <div className="fr-activity-overlay" onClick={click => { if (click.target === click.currentTarget) close(); }}>
    <section className="fr-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="fr-activity-drawer-title"><div className="fr-drawer-top"><span>FLIGHT CONTROL · ACTIVITY</span><button ref={closeButton} data-close-activity aria-label="Close activity details" onClick={close}><X size={19}/></button></div><div className="fr-drawer-icon"><CalendarClock size={23}/></div><h2 id="fr-activity-drawer-title">{event.kind}</h2><p className="fr-drawer-id">{event.date}</p><dl className="fr-drawer-fields"><div><dt>Person</dt><dd>{event.actor || 'Not recorded'}</dd></div><div><dt>Work order</dt><dd>{event.orderId || 'Not linked'}</dd></div></dl><div className="fr-activity-detail"><strong>Activity</strong><p>{event.action}</p></div>{event.orderId && <button className="fr-primary" onClick={() => { onOpenOrder(event.orderId); close(); }}>Open work order <ArrowUpRight size={17}/></button>}</section>
  </div>;
}

function ActivityLog({ events, onOpenOrder }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('All activity');
  const [actor, setActor] = useState('Everyone');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(densityKey) === 'compact'; } catch { return false; } });
  const [selected, setSelected] = useState(null);
  const returnFocus = useRef(null);
  const searchRef = useRef(null);
  const kinds = [...new Set(events.map(event => event.kind))].sort();
  const actors = [...new Set(events.map(event => event.actorName).filter(Boolean))].sort();
  const rows = events.filter(event => {
    const searchable = `${event.action} ${event.actor} ${event.orderId || ''}`.toLowerCase();
    return (!from || event.day >= from) && (!to || event.day <= to) && (kind === 'All activity' || event.kind === kind) && (actor === 'Everyone' || event.actorName === actor) && searchable.includes(query.trim().toLowerCase());
  });
  useEffect(() => {
    const shortcut = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (!selected && returnFocus.current?.isConnected) setTimeout(() => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    }, 0);
  }, [selected]);
  const closeDetails = () => {
    setSelected(null);
  };
  const setDensity = () => setCompact(value => {
    const next = !value;
    try { localStorage.setItem(densityKey, next ? 'compact' : 'comfortable'); } catch {}
    return next;
  });
  const clear = () => { setQuery(''); setKind('All activity'); setActor('Everyone'); setFrom(''); setTo(''); };
  return <div className="flight-react fr-activity">
    <div className="fr-page-heading"><div><span className="fr-eyebrow">FLIGHT CONTROL</span><h1>Activity record<span>.</span></h1><p>Search and review recorded work events.</p></div><div className="fr-workspace">Current Flight System records</div></div>
    <section className="fr-queue" aria-label="Activity record">
      <div className="fr-queue-heading fr-activity-filters">
        <label className="fr-search"><Search size={16}/><input ref={searchRef} type="search" aria-label="Search activity" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search activity, person or work order"/><kbd>⌘ K</kbd></label>
        <label className="fr-filter-select">From<input aria-label="Activity from date" type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
        <label className="fr-filter-select">To<input aria-label="Activity to date" type="date" value={to} onChange={event => setTo(event.target.value)}/></label>
        <label className="fr-filter-select">Activity<select aria-label="Activity type" value={kind} onChange={event => setKind(event.target.value)}><option>All activity</option>{kinds.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="fr-filter-select">Person<select aria-label="Activity person" value={actor} onChange={event => setActor(event.target.value)}><option>Everyone</option>{actors.map(value => <option key={value}>{value}</option>)}</select></label>
        <div className="fr-controls"><button className="fr-density" type="button" aria-pressed={compact} onClick={setDensity}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button><button className="fr-density" type="button" onClick={clear}>Clear filters</button></div>
      </div>
      <div className="fr-table-scroll" role="region" aria-label="Filtered activity events" tabIndex="0"><table className={compact ? 'fr-compact' : ''}><thead><tr><th>Date and time</th><th>Activity</th><th>Record</th><th>Person</th><th><span className="fr-visually-hidden">Details</span></th></tr></thead><tbody>
        {rows.map(event => <tr key={event.id}><td><time dateTime={event.at}>{event.date}</time></td><td><span className="fr-activity-kind">{event.kind}</span></td><td><span dangerouslySetInnerHTML={{ __html: event.actionHtml }}/>{event.orderId && <small className="fr-activity-order">Work order · <span dangerouslySetInnerHTML={{ __html: event.orderHtml }}/></small>}</td><td>{event.actor}</td><td><button className="fr-open-button" aria-label={`Details for ${event.kind} at ${event.date}`} onClick={click => { returnFocus.current = click.currentTarget; setSelected(event); }}><ArrowUpRight size={18}/></button></td></tr>)}
      </tbody></table>{!rows.length && <div className="fr-empty">No activity matches the current filters.</div>}</div>
      <footer><span aria-live="polite">{rows.length} of {events.length} activity events</span><span><Check size={13}/> Read-only record view</span></footer>
    </section>
    <ActivityDrawer event={selected} onClose={closeDetails} onOpenOrder={onOpenOrder} returnFocus={returnFocus}/>
  </div>;
}

/* ------------------------------------------------------------------
 * v2 outstanding-screen migrations (jinx/v2-react-screens).
 * These components port the remaining legacy views to React. They reuse
 * the application's existing CSS classes and keep every data-action,
 * form id and field name the global delegation layer already handles,
 * so server authority and approval gates are unchanged.
 * ------------------------------------------------------------------ */
const pillClass = status => String(status || '').toLowerCase().replace(/\s/g, '-');
// Callers pass the label either as `status` or as children (<Pill>{m.status}</Pill>).
const Pill = ({ status, children, className }) => { const label = status ?? children; return <span className={`pill ${pillClass(label)}${className ? ` ${className}` : ''}`}>{asText(label)}</span>; };
const legacyDateTime = value => {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? asText(value) : d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
};
const legacyDate = value => {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? asText(value) : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
};
const wiSequence = n => String((n + 1) * 10).padStart(3, '0');
const wiDerivedOrders = (state, wi) => (state.orders || []).filter(o => o.masterWI && o.masterWI.id === wi.id && (wi.revision == null || o.masterWI.revision === wi.revision));
const wiOrderSummaryText = orders => {
  const wip = orders.filter(o => !['Closed', 'Cancelled', 'Scrapped'].includes(o.status)).length;
  return orders.length ? `${orders.length} · ${wip} WIP · ${orders.length - wip} closed` : '0';
};

/* ------------------------------------------------------------------
 * v2 order-screen shared helpers (ported from legacy module scope).
 * ------------------------------------------------------------------ */
const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RECORD_PATTERNS = [
  [/\b(WO-\d{3,6})\b/g, 'order'],
  [/\b((?:IDR|NC)-\d{4,8})\b/g, 'ticket'],
  [/\b(ATP-\d{3,8})\b/g, 'report'],
  [/\b(ECR-[0-9]+-[0-9]+)\b/g, 'rev'],
  [/\b(LOT-\d{6,8}-\d{3,5})\b/g, 'lot'],
  [/\b(SNL-\d{4,6})\b/g, 'serial']
];
const buyoffDate = value => new Date(value).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
const fileSizeLabel = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const opDispoStatus = (oo, op) => { const t = (oo.tickets || []).find(x => x.status === 'Open' && x.operationId === op.id && x.reworkPlan); if (!t) return ''; const p = t.reworkPlan; return p.stage === 'Awaiting ME operation' ? ` · ${p.decision} required, awaiting ME ${p.decision.toLowerCase()} operation` : ` · ${p.decision} Op ${operationNumber(oo, p.opId)} awaiting QA release`; };
const fairPin = label => { const a = MES.masterAccess(); return a ? <><div className="stamp-check ok"><Shield size={16}/><div><strong>Master Access override · {asText(a.name)}</strong><small>All buy-off types · {asText(a.credentialId)}. No stamp number or PIN required. Recorded as an administrative override, not an issued stamp.</small></div></div><input type="hidden" name="pin" defaultValue=""/></> : <div className="field"><label>{label}</label><input name="pin" type="password" inputMode="numeric" maxLength={8} autoComplete="off" className="mono"/></div>; };
const confList = (items, cls) => items.length ? <ul className={cls}>{items.map((x, i) => <li key={i}>{asText(x)}</li>)}</ul> : null;
const confCheckRow = (oo, p, key, extra) => {
  const c = p.checks[key], qa = skCan('approve-wo'), locked = p.status === 'Closed', id = `cc-${p.serial}-${key}`.replace(/[^\w-]/g, '_');
  const val = c ? (c.value || 'Yes') : '';
  const pill = val === 'Yes' ? <span className="pill closed">Yes</span> : val === 'No' ? <span className="pill high">No</span> : val === 'N/A' ? <span className="pill">N/A</span> : null;
  const pick = qa && !locked ? (
    <form className="conf-acc" data-form="conf-check" data-order={asText(oo.id)} data-serial={asText(p.serial)} data-key={asText(key)}><fieldset><legend className="sr-only">Step {asText(key)} acceptable</legend><span className="conf-acc-label" aria-hidden="true">Acceptable</span>{MES.CONF_VALUES.map(v => <label key={v} className="conf-seg"><input type="radio" name="value" value={v} defaultChecked={val === v}/><span>{v}</span></label>)}</fieldset><div className="conf-just" hidden={val !== 'N/A' && val !== 'No'}><label htmlFor={`${id}-note`}>{val === 'No' ? 'What is not acceptable' : 'Justification for N/A'}</label><textarea id={`${id}-note`} name="note" rows={2} maxLength={300} defaultValue={asText(c && c.note || '')}/><button className="btn" type="submit">Record</button></div><p className="form-error" role="alert"/></form>
  ) : pill;
  return <div className={`conf-check ${val === 'No' ? 'bad' : val ? 'done' : ''}`}><p className="conf-step"><strong className="mono">{asText(key)}</strong>{' '}{asText(MES.CONF_CHECKS[key])}</p>{pick}{c ? <small>{asText(c.by.name)} · {legacyDateTime(c.at)}{c.note ? <> · {asText(c.note)}</> : null}</small> : null}{extra}</div>;
};
const confCurrentPage = (MES, p) => { const ph = n => MES.CONF_PHASES[n - 1]; return p.status !== 'Open' ? (p.status === 'Closed' ? 0 : p.status === 'Conformed' || p.status.startsWith('Ready') || p.status === 'DAR findings' ? 7 : 6) : [1, 3, 4, 5].find(n => ph(n).checks.some(k => !p.checks[k] && !(k === '5.2' && p.nc !== 'Yes'))) || 6; };
let fairPage = '1';
let selectedRev = 'Baseline';

function WILibrary({ state, MES, initialSearch, initialStatus, reworkPanelHtml }) {
  const [query, setQuery] = useState(initialSearch || '');
  const [status, setStatus] = useState(initialStatus || 'All');
  const [sort, setSort] = useState({ col: 'id', dir: 1 });
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(`${densityKey}-wis`) === 'compact'; } catch { return false; } });
  const term = query.trim().toLowerCase();
  const rows = (state.masterWIs || []).filter(wi => (status === 'All' || wi.status === status) && `${wi.id} ${wi.partNumber} ${wi.partRevision} ${wi.title}`.toLowerCase().includes(term)).sort((a, b) => {
    const key = sort.col === 'part' ? (x => `${x.partNumber} ${x.partRevision}`) : sort.col === 'ops' ? (x => x.operations.length) : sort.col === 'status' ? (x => x.status) : (x => `${x.id} ${x.revision}`);
    const va = key(a), vb = key(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  });
  const toggleSort = col => setSort(s => s.col === col ? { col, dir: -s.dir } : { col, dir: 1 });
  const th = (col, label) => <th scope="col" aria-sort={sort.col === col ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}><button type="button" className="fr-text-action" onClick={() => toggleSort(col)}>{label}{sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button></th>;
  const density = () => setCompact(value => { const next = !value; try { localStorage.setItem(`${densityKey}-wis`, next ? 'compact' : 'comfortable'); } catch {} return next; });
  const clear = () => { setQuery(''); setStatus('All'); };
  return <div className="flight-react"><section aria-labelledby="wi-heading">
    <div className="page-heading"><div><p className="hero-eyebrow">Work instructions</p><h1 id="wi-heading">Master WI library</h1><p></p></div><button className="btn primary" data-action="wi-create"><Plus size={16}/> New master WI</button></div>
    <div className="filter-bar log-filters"><label className="search"><span className="sr-only">Search master WIs</span><Search size={16}/><input type="search" placeholder="Search WIs" aria-label="Search master WIs" value={query} onChange={event => setQuery(event.target.value)}/></label><label className="log-select"><span>Status</span><select className="select-filter" aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}>{['All', 'Draft', 'Released', 'Obsolete'].map(value => <option key={value}>{value}</option>)}</select></label>{(term || status !== 'All') && <button className="btn quiet" data-action="wi-clear-filters" onClick={clear}>Clear filters</button>}<button className="fr-density" aria-pressed={compact} onClick={density}><SlidersHorizontal size={15}/>{compact ? 'Comfortable' : 'Compact'}</button></div>
    <div className="panel"><div className="table-wrap" tabIndex="0" role="region" aria-label="Master WI table"><table className={`data-table wi-table${compact ? ' fr-compact' : ''}`}><thead><tr>{th('id', 'Master WI')}{th('part', 'Part / rev')}{th('ops', 'Operations')}<th scope="col">Inspection points</th>{th('status', 'Status')}<th scope="col">Created</th><th scope="col">Work orders</th></tr></thead><tbody>
      {rows.map(wi => { const steps = wi.operations.reduce((n, op) => n + op.steps.length, 0), inspections = wi.operations.filter(op => op.inspectionPoint).length; const derived = wiDerivedOrders(state, wi); const wip = derived.filter(o => !['Closed', 'Cancelled', 'Scrapped'].includes(o.status)).length;
        return <tr key={`${wi.id}/${wi.revision}`} className={wi.status === 'Obsolete' ? 'wi-obsolete' : ''}><td><button className="order-link" data-action="wi-open" data-wi={wi.id} data-rev={wi.revision}>{wi.id} · Rev {wi.revision}</button><small>{wi.title}</small></td><td><strong className="mono">{wi.partNumber} / Rev {wi.partRevision}</strong></td><td>{wi.operations.length} operations<small>{steps} steps</small></td><td className="mono">{inspections}</td><td><Pill status={wi.status}/></td><td className="mono">{asText((((wi.history || [])[0] || {}).at || wi.releasedAt || '')).slice(0, 10)}</td><td>{derived.length ? <><button className="order-link" data-action="wi-orders" data-wi={wi.id} data-rev={wi.revision} aria-label={`Open the work orders cloned from ${wi.id} Rev ${wi.revision}`}><span className="mono">{derived.length}</span></button><small>{wip} WIP · {derived.length - wip} closed</small></> : <span className="mono muted">0</span>}</td></tr>; })}
    </tbody></table></div>{rows.length ? null : <div className="empty"><h2>No matching master WIs</h2><p>Try another part number, master WI number, or status.</p><button className="btn" onClick={clear}>Clear filters</button></div>}<p className="table-count">{rows.length} master WI revisions</p></div>
    {reworkPanelHtml ? <div dangerouslySetInnerHTML={{ __html: reworkPanelHtml }}/> : null}
  </section></div>;
}

function SupportLog({ state, MES }) {
  const [kind, setKind] = useState('All');
  const [rule, setRule] = useState('All');
  const [q, setQ] = useState('');
  const log = Array.isArray(state.supportLog) ? state.supportLog : [];
  const rules = (MES && MES.SUPPORT_RULES) || {};
  const term = q.trim().toLowerCase();
  const rows = log.filter(e => (kind === 'All' || e.kind === kind) && (rule === 'All' || e.rule === rule) && (!term || [e.id, e.person, e.credentialId, e.account, e.recordType, e.recordId, e.reason].join(' ').toLowerCase().includes(term)));
  return <div className="flight-react"><section><div className="page-heading"><div><h1>Support overrides</h1><p className="muted">Every use of Support Access, every grant and removal, and system notices. Newest first. Overrides never lift separation of duties.</p></div></div>
    <div className="panel"><form className="support-filters" role="search" onSubmit={event => event.preventDefault()}><label>Kind<select value={kind} onChange={event => setKind(event.target.value)}>{['All', ...((MES && MES.SUPPORT_KINDS) || [])].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Rule<select value={rule} onChange={event => setRule(event.target.value)}>{['All', ...Object.keys(rules)].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Search<input value={q} onChange={event => setQ(event.target.value)} placeholder="Person, credential, record or reason" autoComplete="off" aria-label="Search support log"/></label></form>
    <p className="small muted">{rows.length} of {log.length} entries</p>
    {rows.length ? <div className="table-wrap"><table className="support-log"><thead><tr><th scope="col">Entry</th><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Person and credential</th><th scope="col">Rule lifted</th><th scope="col">Record</th><th scope="col">Reason</th></tr></thead><tbody>
      {rows.map(e => <tr key={e.id}><td className="mono">{e.id}</td><td>{legacyDateTime(e.at)}</td><td>{e.kind}</td><td>{e.person}<br/><span className="mono small">{e.credentialId}</span></td><td>{e.rule ? (rules[e.rule] || e.rule) : <span className="muted">none</span>}</td><td>{e.recordType} <span className="mono">{e.recordId || ''}</span></td><td>{e.reason}</td></tr>)}
    </tbody></table></div> : <div className="empty">No entries match. Support Access overrides appear here as soon as one is used.</div>}</div></section></div>;
}

function TraceReport({ state, MES, query }) {
  const rep = query ? MES.traceReport(state, query) : { ok: false, message: 'Search a serial or lot first.' };
  const wo = id => <button className="order-link" data-action="open-order" data-order={id}>{id}</button>;
  const q = v => <button className="order-link" data-action="trace" data-q={v}>{v}</button>;
  const Tbl = ({ label, head, rows, empty }) => rows.length ? <div className="table-wrap" tabIndex="0" role="region" aria-label={label}><table className="data-table tr-table"><thead><tr>{head.map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((cells, i) => <tr key={i}>{cells.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div> : <p className="small muted">{empty}</p>;
  const Sec = ({ title, count, children }) => <section className="panel tr-section"><div className="panel-head"><h2>{title}</h2>{count === '' ? null : <span className="mono">{count}</span>}</div><div className="panel-body">{children}</div></section>;
  if (!rep.ok) return <div className="flight-react"><section aria-labelledby="tr-h"><div className="page-heading"><div><h1 id="tr-h">Traceability report</h1><p className="small muted">{rep.message}</p></div><div className="heading-actions"><button className="btn" data-action="nav" data-view="trace">Back to search</button></div></div></section></div>;
  const Node = ({ n, level }) => {
    const facts = [['Work order', wo(n.id)], ['Part / revision', <span className="mono">{n.partNumber} Rev {n.revision}</span>], ['Description', n.title], ['Pedigree', `${n.pedigree} / ${n.subcategory || ''}`], ['Status', n.status], ['Master WI', n.masterWI], ['Drawing rev', n.drawingRev], ['WO revision', n.woRev], ['Lot', n.lot ? q(n.lot) : 'Not stocked'], ['Serials', n.serials.length ? n.serials.map((s, i) => <span key={s}>{i > 0 ? ', ' : null}{q(s)}</span>) : 'Lot-tracked'], ['Aircraft', n.aircraft || ''], ['Quantity', String(n.quantity)],
      ['Released by', n.release ? `${n.release.by} · ${n.release.credentialId} · ${legacyDateTime(n.release.at)}` : 'Not QA-gated'], ['Stocked', n.stocked ? `${legacyDateTime(n.stocked.at)} · ${n.stocked.by} · ${n.stocked.location}${n.stocked.bin ? ` / ${n.stocked.bin}` : ''}` : 'Not stocked'], ['NetSuite', n.stocked ? <>{n.stocked.netsuite}{n.stocked.postedRef ? ` · ${n.stocked.postedRef}` : ''}</> : ''], ['Kit list', (n.kitFiles || []).join(', ') || 'None attached'], ['FAI', n.fai], ['Conformity (8130-9 / DAR / 8130-3)', n.soc], ['ATP test equipment', n.tests || 'None recorded']];
    return <div className="tr-node" style={{ '--lvl': level }}>
      <Sec title={level ? `Sub-assembly · ${n.id}` : `Build record · ${n.id}`} count=""><dl className="tr-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></Sec>
      <Sec title="Operations and buy-offs" count={n.operations.length}><Tbl label="Operations" head={['Op', 'Operation', 'Type', 'Steps', 'Bought off by', 'When', 'Tools / torque', 'PO / evidence']} empty="No operations." rows={n.operations.map(op => [<span className="mono">{op.number}</span>, <><strong>{op.title}</strong>{op.inspectionPoint ? <small>Inspection point</small> : null}{op.callouts.length ? <small>{op.callouts.join(', ')}</small> : null}</>, <>{op.classification}<small>{op.buyoffType}</small></>, <span className="mono">{op.checked}/{op.steps}</span>, op.by ? <>{op.by}<small>{op.stamp || op.credentialId}</small></> : (op.done ? 'Done' : <span className="muted">Open</span>), op.at ? legacyDateTime(op.at) : '', <>{op.tools.join(', ')}{op.torque.length ? <small>{op.torque.join(', ')}</small> : null}</>, <>{op.po ? `PO ${op.po}` : ''}{op.evidence ? <small>{op.evidence} file{op.evidence === 1 ? '' : 's'}</small> : null}</>])}/></Sec>
      <Sec title="Materials and lots" count={n.materials.length}><Tbl label="Materials" head={['Material', 'Part number', 'Lot', 'Qty', 'Source']} empty="No materials." rows={n.materials.map(m => [m.name, <span className="mono">{m.partNumber}</span>, m.lot ? q(m.lot) : <span className="muted">Not recorded</span>, String(m.required), m.source ? <>Sub-assembly {wo(m.source.orderId)}{m.source.serials.length ? <small>{m.source.serials.map((s, i) => <span key={s}>{i > 0 ? ', ' : null}{q(s)}</span>)}</small> : null}</> : 'Stores'])}/></Sec>
      {n.tickets.length ? <Sec title="NC on this order" count={n.tickets.length}><Tbl label="Tickets" head={['Ticket', 'Title', 'Disposition', 'Defect', 'Status', 'Closed by']} empty="" rows={n.tickets.map(t => [<button className="order-link" data-action="mnv-open-ticket" data-order={n.id} data-ticket={t.id}>{t.id}</button>, t.title, t.dispo || '', t.defect || '', t.status, t.resolvedBy ? <>{t.resolvedBy}<small>{legacyDateTime(t.resolvedAt)}</small></> : ''])}/></Sec> : null}
      {n.reports.length ? <Sec title="ATP records" count={n.reports.length}><Tbl label="ATP" head={['Record', 'Result', 'When', 'Link']} empty="" rows={n.reports.map(r => [r.title || r.id, r.result, r.at ? legacyDateTime(r.at) : '', r.link ? <a href={r.link} target="_blank" rel="noopener">Open</a> : ''])}/></Sec> : null}
      {n.revisions.length > 1 ? <Sec title="Work order revisions and redlines" count={n.revisions.length}><Tbl label="Revisions" head={['Rev', 'Summary', 'Changes', 'Approved by', 'When']} empty="" rows={n.revisions.map(r => [<span className="mono">{r.rev}</span>, r.summary || '', r.changes.join(', '), r.approvedBy || '', legacyDateTime(r.at)])}/></Sec> : null}
      <details className="resolve-details tr-history"><summary>Full record history for {n.id} ({n.history.length})</summary><ol className="task-list">{n.history.map((h, i) => <li key={i}><span className="task-main"><strong>{h.action}</strong><small>{h.actor} · {legacyDateTime(h.at)}</small></span></li>)}</ol></details>
      {n.children.map(c => <div className="tr-child" key={c.node.id}><p className="small"><strong>{c.via}</strong> issued from {wo(c.node.id)} · lot {q(c.lot)}{c.serials.length ? <> · {c.serials.map((s, i) => <span key={s}>{i > 0 ? ', ' : null}{q(s)}</span>)}</> : null}</p><Node n={c.node} level={level + 1}/></div>)}
    </div>;
  };
  const Up = ({ list }) => list.length ? <ul className="tr-used">{list.map(u => <li key={`${u.orderId}/${u.serials.join(',')}`}><>{wo(u.orderId)} · <span className="mono">{u.partNumber}</span> · {u.status}{u.aircraft ? ` · aircraft ${u.aircraft}` : ''}{u.lot ? <> · lot {q(u.lot)}</> : ''}<small> {u.serials.length ? u.serials.join(', ') : `quantity ${u.quantity}`} · issued {legacyDateTime(u.at)} by {u.by}</small><Up list={u.up}/></></li>)}</ul> : null;
  const b = rep.build;
  return <div className="flight-react"><section aria-labelledby="tr-h" className="trace-report"><div className="page-heading"><div><p className="hero-eyebrow">Traceability report · {rep.kind === 'serial' ? 'serial number' : 'lot number'}</p><h1 id="tr-h" className="mono">{rep.serial || rep.query}</h1><p className="hero-meta"><span className="mono">{b.partNumber} Rev {b.revision}</span><span>{b.title}</span><span>Built on {b.id}</span>{b.lot ? <span className="mono">{b.lot}</span> : null}</p><p className="small muted">Generated {legacyDateTime(rep.generatedAt)} by {rep.generatedBy} from the MES record. NetSuite, Jira and PDM remain the sources of truth for their own records.</p></div><div className="heading-actions"><button className="btn" data-action="nav" data-view="trace">Back to search</button><button className="btn" data-action="trace-report-csv">Download CSV</button><button className="btn" data-action="trace-report-json">Download JSON</button><button className="btn primary" data-action="trace-report-print">Print or save PDF</button></div></div>
    <Sec title="Where it was used" count={rep.whereUsed.length}>{rep.whereUsed.length ? <Up list={rep.whereUsed}/> : <p className="small muted">Not issued into another work order.</p>}</Sec>
    {rep.reworks.length ? <Sec title="Rework, repair and upgrade orders" count={rep.reworks.length}><Tbl label="Rework orders" head={['Work order', 'Type', 'Status', 'Link']} empty="" rows={rep.reworks.map(r => [wo(r.id), r.subcategory, r.status, r.why])}/></Sec> : null}
    {rep.materialLotUse.length ? <Sec title="Orders that consumed this lot as material" count={rep.materialLotUse.length}><p>{rep.materialLotUse.map((id, i) => <span key={id}>{i > 0 ? ', ' : null}{wo(id)}</span>)}</p></Sec> : null}
    <Node n={b} level={0}/>
    <Sec title="Quality records" count={rep.tickets.length + rep.mrb.length + rep.cars.length + rep.sprs.length}>
      <Tbl label="Tickets" head={['Ticket', 'Where', 'Title', 'Disposition', 'Status']} empty="No NC." rows={rep.tickets.map(t => [t.stock ? <button className="order-link" data-action="mnv-open-nc" data-nc={t.id}>{t.id}</button> : <button className="order-link" data-action="mnv-open-ticket" data-order={t.orderId} data-ticket={t.id}>{t.id}</button>, t.stock ? 'Stock' : wo(t.orderId), t.title, t.dispo || '', t.status])}/>
      {rep.mrb.length ? <Tbl label="MRB" head={['Board', 'Ticket', 'Proposed', 'Status']} empty="" rows={rep.mrb.map(m => [<button className="order-link" data-action="mnv-open-board" data-board={m.id}>{m.id}</button>, m.ticketId, m.proposed, m.status])}/> : null}
      {rep.cars.length ? <Tbl label="CAR" head={['CAR', 'Title', 'Status', 'SCAR']} empty="" rows={rep.cars.map(c => [<button className="order-link" data-action="mnv-open-car" data-car={c.id}>{c.id}</button>, c.title, c.status, c.scar || ''])}/> : null}
      {rep.sprs.length ? <Tbl label="SPR" head={['SPR', 'Title', 'Found at', 'Jira', 'Status']} empty="" rows={rep.sprs.map(f => [<span className="mono">{f.id}</span>, f.title, f.foundAt, f.jira || '', f.status])}/> : null}
    </Sec>
    <Sec title="Change requests" count={rep.changes.length}><Tbl label="Changes" head={['Request', 'Type', 'Title', 'ECO', 'Status']} empty="No change requests." rows={rep.changes.map(e => [<button className="order-link" data-action="ecr-open" data-id={e.id}>{e.id}</button>, e.type, e.title, e.eco || '', e.status])}/></Sec>
  </section></div>;
}

function WIDetail({ state, MES, FM, wi, perms, peerOptionsHtml, qaOptionsHtml, peerAssignee, qaAssignee }) {
  const draft = wi.status === 'Draft';
  const qa = perms.approveWi;
  const revisions = (state.masterWIs || []).filter(x => x.id === wi.id).sort((a, b) => b.revision.localeCompare(a.revision));
  const hasDraft = revisions.some(x => x.status === 'Draft');
  const derived = wiDerivedOrders(state, wi);
  const derivedAll = (state.orders || []).filter(o => o.masterWI && o.masterWI.id === wi.id);
  const steps = wi.operations.reduce((n, op) => n + op.steps.length, 0);
  const pfmeaTicket = FM && FM.pfmeaFor ? FM.pfmeaFor(state, wi.id, wi.revision) : null;
  const ecrList = (state.ecrRequests || []).filter(e => e.type === 'process' && e.wiId === wi.id && (e.status === 'Open' || (e.status === 'Incorporating' && e.incorporatedIn === wi.revision)));
  const pfmeaHeadButton = () => {
    if (wi.qaReview && pfmeaTicket) return <button className="btn primary" data-action="mnv-open-pfmea" data-id={pfmeaTicket.id}>Open PFMEA {pfmeaTicket.id}</button>;
    if (!perms.approveWi) return <span className="pill missing">Awaiting QA review</span>;
    return <button className="btn primary" data-action="wi-qa-pfmea" disabled={!wi.peerReview} title={wi.peerReview ? 'Record the QA review and move to PFMEA' : 'Peer review first'}>QA review · move to PFMEA</button>;
  };
  const pfmeaBanner = () => {
    if (!wi.criticalSafety) return null;
    const stage = wi.status !== 'Draft' ? (pfmeaTicket && pfmeaTicket.safety ? `Released by the Safety Team buy-off on ${pfmeaTicket.id} (${pfmeaTicket.safety.by.name}).` : 'Released.') : !wi.peerReview ? 'Next: Manufacturing Engineering peer review.' : !wi.qaReview ? 'Next: QA review, which opens the PFMEA.' : pfmeaTicket ? `PFMEA ${pfmeaTicket.id} is at ${pfmeaTicket.status}. The Safety Team buy-off releases this WI.` : 'QA review recorded.';
    return <div className={`inline-info ${wi.status === 'Draft' ? 'warning' : 'success'} pfm-banner`} role="status"><Shield size={18}/><div><p><strong>Critical safety part</strong> · ME creates the WI, QA reviews it, the PFMEA walks every operation, and the Safety Team buy-off releases it.</p><p>{stage}{pfmeaTicket ? <> <button className="order-link" data-action="mnv-open-pfmea" data-id={pfmeaTicket.id}>{pfmeaTicket.id}</button></> : null}</p></div></div>;
  };
  return <div className="flight-react"><section aria-labelledby="wi-title"><div className="page-heading"><div><p className="wi-eyebrow mono">{wi.partNumber} · Part Rev {wi.partRevision}</p><h1 id="wi-title" tabIndex="-1">{wi.id} Rev {wi.revision} <Pill status={wi.status}/>{wi.criticalSafety ? <span className="pill high">Critical safety part</span> : null}{wi.drawingReleased === false ? <span className="pill unrel-pill" title="Written to an unreleased drawing">Unreleased drawing</span> : null}{wi.eco ? <span className="pill eco-pill mono">{wi.eco}</span> : null}</h1><p>{wi.title}</p></div><div className="heading-actions">
    {wi.status === 'Unreleased' && perms.approveWi ? <button className="btn" data-action="wi-eco-release">Release with ECO</button> : null}
    {['Released', 'Unreleased'].includes(wi.status) ? <><button className="btn primary" data-action="wi-create-order" data-wi={wi.id} data-rev={wi.revision}><Plus size={16}/> Create work order</button>{hasDraft ? null : <button className="btn" data-action="wi-revise">Revise to Rev {MES.nextWIRevision(state, wi.id)}</button>}</> : null}
    {draft ? <>{wi.peerReview ? <span className="pill ready" title={`${wi.peerReview.name} · ${wi.peerReview.credentialId}`}>Peer reviewed · {wi.peerReview.name}</span> : perms.peerReviewWi ? <button className="btn" data-action="wi-peer-review">ME peer review Rev {wi.revision}</button> : <span className="pill missing">Awaiting ME peer review</span>}{wi.criticalSafety ? pfmeaHeadButton() : <button className="btn primary" data-action="wi-release" disabled={!wi.peerReview} title={wi.peerReview ? (wi.drawingReleased === false ? 'Approve as Unreleased (development orders only)' : 'Release this revision against its ECO') : 'Peer review first'}>{wi.drawingReleased === false ? `QE approve Rev ${wi.revision} as Unreleased` : `QE release Rev ${wi.revision}`}</button>}</> : null}
    {wi.status !== 'Draft' && (perms.editWi || perms.approveWi) ? <button className="btn" data-action="wi-impact" data-wi={wi.id} data-rev={wi.revision}>Impact assessment</button> : null}
    {perms.submitEcr && wi.status === 'Released' ? <button className="btn" data-action="ecr-process-wi">Submit MCR</button> : null}<button className="btn dark" data-action="nav" data-view="wis">Master WI library <ArrowUpRight size={16}/></button></div></div>
    {ecrList.length ? <div className="inline-info warning ecr-banner" role="status"><Info size={18}/><p><strong>{draft ? `MCRs to incorporate in Rev ${wi.revision}` : 'Open MCRs on this work instruction'}</strong><br/>{ecrList.map((e, i) => { const op = e.opId ? wi.operations.find(x => x.id === e.opId) : null; return <span key={e.id}>{i > 0 ? <br/> : null}<button type="button" className="order-link" data-action="ecr-open" data-id={e.id}>{e.id}</button> · {e.title}{op ? ` · ${op.title}` : ''}{e.status === 'Incorporating' ? ' (marked for this revision)' : ''}</span>; })}</p></div> : null}
    <div className="wi-layout">
      <section className="panel" aria-labelledby="wi-release-heading"><div className="panel-head"><h2 id="wi-release-heading">Release</h2><Pill status={wi.status}/></div><div className="panel-body">
        {draft ? <>
          <form id="wi-header-form" className="wi-title-form"><div className="field"><label htmlFor="wi-title-input">Title</label><input id="wi-title-input" name="title" maxLength="120" required defaultValue={wi.title}/></div><button className="btn" type="submit">Save title</button><p id="wi-header-error" className="form-error" role="alert"></p></form>
          <label className="check-label wi-critical"><input type="checkbox" id="wi-critical-safety" defaultChecked={!!wi.criticalSafety} disabled={!perms.editWi}/><span><strong>Critical safety part</strong> · after ME peer review and QA review it moves to a PFMEA ticket; the Safety Team buy-off releases it</span></label>
          <form id="wi-drawing-form" className="wi-drawing-form"><fieldset className="wi-drawing-set"><legend>Drawing and ECO</legend><label className="check-label"><input type="radio" name="drawingStatus" value="released" defaultChecked={wi.drawingReleased !== false} disabled={!perms.editWi}/><span>Released drawing</span></label><label className="check-label"><input type="radio" name="drawingStatus" value="unreleased" defaultChecked={wi.drawingReleased === false} disabled={!perms.editWi}/><span>Unreleased (preliminary) drawing</span></label></fieldset><div className="form-grid"><div className="field"><label htmlFor="wi-drawref-input">Preliminary drawing reference</label><input id="wi-drawref-input" name="drawingRef" maxLength="80" defaultValue={wi.drawingRef || ''} disabled={!perms.editWi}/></div><div className="field"><label htmlFor="wi-eco-field">ECO number <span className="muted">(required to release)</span></label><input id="wi-eco-field" name="eco" className="mono" maxLength="40" defaultValue={wi.eco || ''} placeholder="ECO-0000" disabled={!perms.editWi}/></div></div>{perms.editWi ? <button className="btn" type="submit">Save drawing and ECO</button> : null}<p id="wi-drawing-error" className="form-error" role="alert"></p></form>
          {(perms.editWi || perms.assignWork) ? <form id="wi-assign-form" className="wi-assign"><div className="field"><label htmlFor="wi-assign-peer">Peer review</label><select id="wi-assign-peer" name="peer" data-current={peerAssignee?.username || ''} disabled={!!wi.peerReview} dangerouslySetInnerHTML={{ __html: peerOptionsHtml }}/></div><div className="field"><label htmlFor="wi-assign-qa">QA review</label><select id="wi-assign-qa" name="qa" data-current={qaAssignee?.username || ''} dangerouslySetInnerHTML={{ __html: qaOptionsHtml }}/></div><button className="btn" type="submit">Assign reviewers</button></form> : null}
          <div className={`inline-info ${qa ? 'success' : 'warning'}`}>{qa ? <><Shield size={18}/><div><p>{`Signed in as ${perms.roleLabel}. `}</p></div></> : <><Lock size={18}/><div><p>Manufacturing Engineering peer-reviews this draft, then a Quality Engineering or QA Manager account releases it.</p></div></>}</div>
        </> : <dl className="dialog-context"><div><dt>Released</dt><dd>{wi.releasedAt ? legacyDate(wi.releasedAt) : '-'}</dd></div><div><dt>Released by</dt><dd>{wi.releasedBy ? `${wi.releasedBy.name} · ${wi.releasedBy.credentialId}` : 'QA ()'}</dd></div><div><dt>Drawing</dt><dd>{wi.drawingReleased === false ? `Unreleased${wi.drawingRef ? ` · ${wi.drawingRef}` : ''}` : `Released · ${wi.partNumber} Rev ${wi.partRevision}`}</dd></div><div><dt>ECO</dt><dd className="mono">{wi.eco || (wi.status === 'Released' ? 'Not recorded (released before ECO was required)' : 'None')}</dd></div><div><dt>Operations</dt><dd>{wi.operations.length} · {steps} steps</dd></div><div><dt>Inspection points</dt><dd>{wi.operations.filter(op => op.inspectionPoint).length}</dd></div></dl>}
      </div></section>
      <section className="panel" aria-labelledby="wi-derived-heading"><div className="panel-head"><h2 id="wi-derived-heading">Work orders cloned from this revision</h2><span className="mono">{wiOrderSummaryText(derived)}</span></div><div className="panel-body">
        {derived.length ? <ul className="wi-plain-list">{derived.map(o => <li key={o.id}><button className="order-link" data-action="open-order" data-order={o.id}>{o.id}</button> <Pill status={o.status}/></li>)}</ul> : <p className="small muted">{wi.status === 'Released' ? 'No work orders yet.' : 'None until QA releases this revision.'}</p>}
        {derived.length || derivedAll.length ? <p className="wi-order-actions">{derived.length ? <button className="btn" data-action="wi-orders" data-wi={wi.id} data-rev={wi.revision}>Open these work orders <ArrowUpRight size={16}/></button> : null}<button className="btn quiet" data-action="wi-orders" data-wi={wi.id} data-rev="">All revisions of {wi.id}</button></p> : null}
        <h3 className="wi-subhead">Revisions</h3><ul className="wi-plain-list wi-rev-list">{revisions.map(x => <li key={x.revision} className={x === wi ? 'is-current' : ''} aria-current={x === wi ? 'true' : undefined}>{x === wi ? <span className="wi-rev-name">Rev {x.revision}</span> : <button className="order-link wi-rev-name" data-action="wi-open" data-wi={x.id} data-rev={x.revision}>Rev {x.revision}</button>} <Pill status={x.status}/>{x === wi ? <span className="wi-rev-note">This revision</span> : null}</li>)}</ul>
        <h3 className="wi-subhead">History</h3><ol className="wi-history">{(wi.history || []).slice(-5).reverse().map((h, i) => <li key={i}><span>{h.action}</span><small>{legacyDate(h.at)} · {h.actor}</small></li>)}{!(wi.history || []).length ? <li><small>No history yet.</small></li> : null}</ol>
      </div></section>
    </div>
    <section className="panel" aria-labelledby="wi-form3-heading"><div className="panel-head"><h2 id="wi-form3-heading">AS9102 Form 3 plan</h2><span className="pill">{wi.form3Plan ? `${wi.form3Plan.balloonCount} planned characteristics` : 'No plan'}</span></div><div className="panel-body">{draft ? <form data-form3-plan data-wi={wi.id} data-revision={wi.revision}><p className="small muted">Define balloon number, characteristic and drawing requirement for this WI draft. The signed plan hash follows the released revision into its FAIR.</p><label className="field">Planned characteristics JSON<textarea name="characteristics" rows="5" required placeholder='[{"balloon":1,"characteristic":"Bore diameter","requirement":"10.00 ±0.05 mm"}]' defaultValue={wi.form3Plan ? JSON.stringify(wi.form3Plan.characteristics, null, 2) : ''}></textarea></label><button className="btn" type="submit">Save Form 3 plan</button></form> : wi.form3Plan ? <p>Plan SHA-256 <span className="mono">{wi.form3Plan.sha256}</span> · {wi.form3Plan.characteristics.map(c => `#${c.balloon} ${c.characteristic}`).join(' · ')}</p> : <p className="muted">No Form 3 plan was released with this revision.</p>}</div></section>
    {pfmeaBanner()}
    <WIPfmeaSection state={state} MES={MES} wi={wi} draft={draft} perms={perms}/>
    <section className="panel" aria-labelledby="wi-ops-heading"><div className="panel-head"><h2 id="wi-ops-heading">Operations and steps</h2><span className="mono">{wi.operations.length} ops · {steps} steps</span></div>{draft ? <WIEditor state={state} MES={MES} wi={wi} perms={perms}/> : <WIReadOnly state={state} MES={MES} wi={wi}/>}</section>
  </section></div>;
}

function WIReadOnly({ state, MES, wi }) {
  const ecrOpFlag = op => { const list = MES.ecrsForOperation(state, wi, op.id); if (!list.length) return null; return <div className="ecr-op-flag" role="status"><Info size={16}/><div><strong>Change to apply{list.length > 1 ? ` (${list.length})` : ''}</strong>{list.map(e => <span className="ecr-op-line" key={e.id}><button type="button" className="order-link" data-action="ecr-open" data-id={e.id}>{e.id}</button> {e.title}{e.status === 'Incorporating' ? ' · marked for this revision' : ''}</span>)}</div></div>; };
  const calloutBadges = op => Array.isArray(op?.callouts) && op.callouts.length ? <span className="callouts" role="list" aria-label="Operation callouts">{op.callouts.map(c => <span key={c} className={`callout callout-${c.toLowerCase()}`} role="listitem" title={c}><span>{c}</span></span>)}</span> : null;
  const buyoffLabel = op => <>{op.buyoffType || 'Technician'} buy-off{op.inspectionPoint ? <> · <span className="inspection-tag">{op.buyoffType === 'Conformity Inspector' ? 'Conformity hold point' : 'Inspection point'}</span></> : null}</>;
  const stdInspBanner = op => MES.isInspectionOp(op) ? <div className="std-insp" role="note"><Shield size={16}/><div><strong>{MES.STD_INSPECTION.title}</strong><p>{MES.STD_INSPECTION.text}</p></div></div> : null;
  return <><ol className="wi-ops">{wi.operations.map((op, i) => <li className="wi-op" key={op.id || i}>{ecrOpFlag(op)}<div className="wi-op-head"><span className="op-number">{wiSequence(i)}</span><div><strong>{op.title}{calloutBadges(op)}</strong><small>{op.description}</small><small className="wi-buyoff">{buyoffLabel(op)}{op.requiresTooling ? ' · Calibrated tooling' : ''}{op.requiresRecording ? ' · Reviewed video required' : ''}</small></div></div>{stdInspBanner(op)}<ol className="wi-steps">{op.steps.map(s => <li key={s.id}><strong>{s.title}</strong>{s.recordsTorque ? ' <span className="inspection-tag">Torque value</span>' : ''}{(s.consumables || []).map(c => <span key={c} className="inspection-tag consumable-tag"> {c}</span>)}<p>{s.instruction}</p>{s.image ? <><img className="step-thumb" src={s.image.dataUrl} alt={s.image.caption || s.title} loading="lazy"/>{s.image.caption ? <small>{s.image.caption}</small> : null}</> : null}</li>)}</ol></li>)}</ol><p className="small muted wi-note">{wi.status === 'Released' ? 'Released revisions are locked. Use Revise to change operations or steps.' : 'Obsolete revision, kept for traceability.'}</p></>;
}

function WIPfmeaSection({ state, MES, wi, draft, perms }) {
  if (!wi.criticalSafety && !(wi.pfmea && wi.pfmea.rows.length)) return null;
  const rows = (wi.pfmea && wi.pfmea.rows) || [], gate = MES.pfmeaGate(wi), high = r => r.rpn >= MES.PFMEA_HIGH.rpn || r.s >= MES.PFMEA_HIGH.severity;
  const opName = id => { const op = wi.operations.find(x => x.id === id); return op ? op.title : id; };
  const table = rows.length ? <div className="table-wrap" tabIndex="0" role="region" aria-label="PFMEA"><table className="data-table pfmea-table"><thead><tr><th scope="col">Row</th><th scope="col">Operation</th><th scope="col">Failure mode</th><th scope="col">Effect / cause</th><th scope="col">S</th><th scope="col">O</th><th scope="col">D</th><th scope="col">RPN</th><th scope="col">Action</th><th scope="col">Status</th></tr></thead><tbody>{rows.map(r => <tr key={r.id} className={high(r) ? 'pfmea-high' : ''}><td className="mono">{r.id}</td><td>{opName(r.opId)}</td><td>{r.mode}</td><td><small>{r.effect}{r.effect && r.cause ? ' · ' : ''}{r.cause}</small></td><td className="mono">{r.s}</td><td className="mono">{r.o}</td><td className="mono">{r.d}</td><td className="mono"><strong>{r.rpn}</strong>{high(r) ? ' <span className="pill high">High</span>' : ''}</td><td>{r.action ? <>{r.action}<small>{r.owner} · due {r.due || ''}</small></> : <span className="muted">None</span>}</td><td>{r.action ? (r.done ? <span className="pill closed">Done</span> : <span className="pill kitting">Open</span>) : ''}{draft && perms.editWi ? <div className="plan-actions">{r.action ? <button className="btn quiet" type="button" data-action="pfmea-done" data-row={r.id} data-done={r.done ? '0' : '1'}>{r.done ? 'Reopen' : 'Mark done'}</button> : null}<button className="btn quiet" type="button" data-action="pfmea-remove" data-row={r.id}>Remove</button></div> : ''}</td></tr>)}</tbody></table></div> : <p className="muted small">No failure modes recorded yet.</p>;
  const form = draft && perms.editWi ? <form id="pfmea-form" className="pfmea-form"><div className="form-grid">
    <div className="field"><label htmlFor="pf-op">Operation</label><select id="pf-op" name="opId" required>{wi.operations.map((op, i) => <option key={op.id} value={op.id}>{wiSequence(i)} · {op.title}</option>)}</select></div>
    <div className="field"><label htmlFor="pf-mode">Failure mode</label><input id="pf-mode" name="mode" maxLength="200" required placeholder="Fastener under-torqued"/></div>
    <div className="field"><label htmlFor="pf-effect">Effect</label><input id="pf-effect" name="effect" maxLength="300" placeholder="Loss of retention in flight"/></div>
    <div className="field"><label htmlFor="pf-cause">Cause</label><input id="pf-cause" name="cause" maxLength="300" placeholder="Wrench unit set to in-lb"/></div>
    <div className="field pf-score"><label htmlFor="pf-s">Severity 1 to 10</label><input id="pf-s" name="s" type="number" min="1" max="10" required/></div>
    <div className="field pf-score"><label htmlFor="pf-o">Occurrence 1 to 10</label><input id="pf-o" name="o" type="number" min="1" max="10" required/></div>
    <div className="field pf-score"><label htmlFor="pf-d">Detection 1 to 10</label><input id="pf-d" name="d" type="number" min="1" max="10" required/></div>
    <div className="field wide"><label htmlFor="pf-action">Action <span className="muted">(required when RPN {MES.PFMEA_HIGH.rpn}+ or severity {MES.PFMEA_HIGH.severity}+)</span></label><input id="pf-action" name="action" maxLength="400" placeholder="Add torque value and unit to the step; add an inspection point"/></div>
    <div className="field"><label htmlFor="pf-owner">Action owner</label><input id="pf-owner" name="owner" maxLength="80"/></div>
    <div className="field"><label htmlFor="pf-due">Due</label><input id="pf-due" name="due" type="date"/></div>
  </div><p id="pfmea-error" className="form-error" role="alert"></p><div className="dialog-actions"><button className="btn" type="submit">Add failure mode</button></div></form> : null;
  return <section className="panel" aria-labelledby="wi-pfmea-heading"><div className="panel-head"><h2 id="wi-pfmea-heading">PFMEA · critical safety part</h2>{gate ? <span className="pill high">Blocks release</span> : <span className="pill closed">Complete</span>}</div>{gate ? <div className="inline-info warning"><Lock size={16}/><p>{gate}</p></div> : null}<p className="small muted">Score each failure mode. High-risk rows get an action that lands in the work instruction as a step, an inspection point, a hold point or a required tool. The PFMEA is revised with every WI revision.</p>{table}{form}</section>;
}

const CALLOUT_TEXT = { ESD: 'ESD sensitive · static control required', FOD: 'FOD · foreign object debris / damage prevention', MSDS: 'MSDS · hazardous material, consult the safety data sheet' };
const FOD_INFO_TEXT = {
  awareness: { label: 'FOD Awareness Area', desc: 'General FOD prevention applies. Clean as you go and keep the work area free of loose items and debris.' },
  critical: { label: 'FOD Critical Area', desc: 'High risk of FOD entering the product. Controlled access, tool and hardware accountability, loose-item control and a FOD inspection before close-out. Adds a Tool control callout.' }
};

function WIEditor({ state, MES, wi, perms }) {
  const n = wi.operations.length;
  return <form id="wi-ops-form"><ol className="wi-ops">{wi.operations.map((op, i) => <WIOpEditor key={op.id || i} state={state} MES={MES} wi={wi} op={op} index={i} total={n} />)}</ol>
    <div className="wi-editor-actions"><button type="button" className="btn" data-action="wi-op-add" disabled={n >= 20}><Plus size={16}/> Add operation</button><span className="small muted" id="wi-save-state" role="status">Changes save when you leave a field.</span></div><p id="wi-ops-error" className="form-error wi-ops-error" role="alert"></p></form>;
}

function WIOpEditor({ state, MES, wi, op, index, total }) {
  const i = index, n = total;
  const ecrList = MES.ecrsForOperation(state, wi, op.id);
  const ecrFlag = ecrList.length ? <div className="ecr-op-flag" role="status"><Info size={16}/><div><strong>Change to apply{ecrList.length > 1 ? ` (${ecrList.length})` : ''}</strong>{ecrList.map(e => <span className="ecr-op-line" key={e.id}><button type="button" className="order-link" data-action="ecr-open" data-id={e.id}>{e.id}</button> {e.title}{e.status === 'Incorporating' ? ' · marked for this revision' : ''}</span>)}</div></div> : null;
  const showStdInsp = MES.isInspectionOp({ inspectionPoint: true }) && !MES.INSPECTION_BUYOFF_TYPES.includes(op.buyoffType);
  const stdBanner = MES.isInspectionOp({ inspectionPoint: true }) ? <div className="std-insp" role="note" hidden={showStdInsp ? false : true}><Shield size={16}/><div><strong>{MES.STD_INSPECTION.title}</strong><p>{MES.STD_INSPECTION.text}</p></div></div> : null;
  return <li className="wi-op editing" data-wi-op>{ecrFlag}<div className="wi-op-head"><span className="op-number">{wiSequence(i)}</span><div className="wi-op-fields">{stdBanner}
    <div className="field"><label htmlFor={`wi-op-${i}-title`}>Operation title</label><input id={`wi-op-${i}-title`} name="title" maxLength="120" required defaultValue={op.title}/></div>
    <div className="field"><label htmlFor={`wi-op-${i}-desc`}>Summary</label><textarea id={`wi-op-${i}-desc`} name="description" maxLength="400" rows="2" required defaultValue={op.description}></textarea></div>
    <div className="wi-op-options">
      <div className="field"><label htmlFor={`wi-op-${i}-class`}>Classification</label><select id={`wi-op-${i}-class`} name="classification" defaultValue={op.classification || 'Manufacturing'}>{MES.OP_CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
      <div className="field wi-source-code" hidden={op.classification !== MES.SOURCE_INSPECTION_CLASS}><label htmlFor={`wi-op-${i}-source-code`}>Source inspection sub-code</label><select id={`wi-op-${i}-source-code`} name="sourceInspectionCode" defaultValue={(op.sourceInspectionPlan || {}).code}>{MES.sourceInspectionCodes(state).map(item => <option key={item.code} value={item.code}>{item.name}{item.leadDays ? ` · ${item.leadDays} day notice` : ''}</option>)}</select></div>
      <div className="field wi-operation-subcode" hidden={!['Conformity', 'Test'].includes(op.classification)}><label htmlFor={`wi-op-${i}-subcode`}>{op.classification || 'Operation'} sub-code</label><select id={`wi-op-${i}-subcode`} name="operationSubcode" defaultValue={op.subCode || ''}>{MES.operationSubcodes(state, op.classification).map(item => <option key={item.code} value={item.code}>{item.name}{item.reference ? ` · ${item.reference}` : ''}</option>)}</select></div>
      <div className="field"><label htmlFor={`wi-op-${i}-buyoff`}>Buy-off type</label><select id={`wi-op-${i}-buyoff`} name="buyoffType" defaultValue={op.buyoffType}>{MES.BUYOFF_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
      <div className="field"><label htmlFor={`wi-op-${i}-center`}>Work center</label><select id={`wi-op-${i}-center`} name="workCenterId" defaultValue={op.workCenterId || ''}><option value="">Unassigned</option>{MES.WORK_CENTERS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="field"><label htmlFor={`wi-op-${i}-hours`}>Standard hours per unit</label><input id={`wi-op-${i}-hours`} name="standardHours" type="number" min="0" max="10000" step="0.01" defaultValue={op.standardHours ?? ''}/></div>
      <label className="check-label" hidden><input type="checkbox" name="inspectionPoint" defaultChecked={!!op.inspectionPoint}/><span>Inspection point</span></label>
      <label className="check-label"><input type="checkbox" name="requiresTooling" defaultChecked={!!op.requiresTooling}/><span>Requires calibrated tooling</span></label>
      <label className="check-label"><input type="checkbox" name="requiresRecording" defaultChecked={!!op.requiresRecording}/><span>Require reviewed video</span></label>
    </div>
    <WICalloutChecks op={op} index={i} MES={MES} />
    <WITrainingChecks state={state} MES={MES} op={op} index={i} />
    <WIAtpBaseline op={op} index={i} MES={MES} state={state} />
  </div>
  <div className="wi-tools"><button type="button" className="btn quiet" data-action="wi-op-move" data-op={i} data-dir="-1" disabled={i === 0} aria-label={`Move operation ${wiSequence(i)} up`}>Up</button><button type="button" className="btn quiet" data-action="wi-op-move" data-op={i} data-dir="1" disabled={i === n - 1} aria-label={`Move operation ${wiSequence(i)} down`}>Down</button><button type="button" className="btn quiet" data-action="wi-op-remove" data-op={i} disabled={n === 1} aria-label={`Remove operation ${wiSequence(i)}`}>Remove</button></div></div>
  <ol className="wi-steps">{op.steps.map((s, j) => <WIStepEditor key={s.id || j} state={state} MES={MES} op={op} step={s} opIndex={i} stepIndex={j} />)}</ol>
  <button type="button" className="btn wi-add-step" data-action="wi-step-add" data-op={i}><Plus size={16}/> Add step</button></li>;
}

function WICalloutChecks({ op, index, MES }) {
  const i = index, selected = op.callouts || [], idPrefix = `wi-op-${i}-callout`, fodLevel = op.fodLevel || 'awareness', msdsLinks = op.msdsLinks || [];
  return <fieldset className="callout-fieldset"><legend>Callouts · shown on this operation</legend>{MES.CALLOUTS.map(c => <div key={c}>
    <label className="check-label callout-check"><input type="checkbox" name="callouts" value={c} defaultChecked={selected.includes(c)} id={`${idPrefix}-${c.toLowerCase()}`}/><span className={`callout callout-${c.toLowerCase()}`}><span>{c}</span></span><span className="callout-desc">{CALLOUT_TEXT[c] || c}</span></label>
    {c === 'ESD' && selected.includes('ESD') ? <div className="grounding-options grounding-fixed" data-grounding><span className="grounding-title">Required grounding</span><strong>Smock &amp; Wrist Strap / Foot Grounding</strong></div> : null}
    {c === 'FOD' && selected.includes('FOD') ? <div className="grounding-options fod-options" data-fod role="radiogroup" aria-label="FOD area classification"><span className="grounding-title">FOD area classification</span>{['awareness', 'critical'].map(l => <label key={l} className="fod-opt"><input type="radio" name={`${idPrefix}-fod`} value={l} defaultChecked={l === fodLevel}/><span><strong>{FOD_INFO_TEXT[l].label}</strong><small>{FOD_INFO_TEXT[l].desc}</small></span></label>)}</div> : null}
    {c === 'MSDS' && selected.includes('MSDS') ? <div className="grounding-options" data-msds><span className="grounding-title">SDS links · one per line as Label | https://…</span><textarea name="msdsLinks" rows="2" maxLength="2600" placeholder="Loctite 242 | https://…" defaultValue={(msdsLinks || []).map(l => `${l.label} | ${l.url}`).join('\n')}></textarea><small className="muted">The master SDS book link is set by the QA Manager in Your credentials and shown on every MSDS operation.</small></div> : null}
  </div>)}</fieldset>;
}

function WITrainingChecks({ state, MES, op, index }) {
  const list = MES.trainingCatalog(state).filter(t => t.status === 'Active' && !MES.CALLOUTS.includes(t.code));
  if (!list.length) return null;
  const idPrefix = `wi-op-${index}`, selected = op.training || [];
  return <fieldset className="callout-fieldset training-fieldset"><legend>Training required · beyond the ESD and FOD callouts</legend>{list.map(t => <label key={t.code} className="check-label"><input type="checkbox" name="training" value={t.code} defaultChecked={selected.includes(t.code)} id={`${idPrefix}-training-${t.code.toLowerCase()}`}/><span><strong>{t.code}</strong> {t.name}{t.qmsDoc ? <small className="muted"> {t.qmsDoc} Rev {t.qmsRev}</small> : null}</span></label>)}</fieldset>;
}

function WIAtpBaseline({ op, index, MES, state }) {
  const i = index;
  const code = op.subCode || (op.classification === MES.ATP_CLASS ? 'ATP' : '');
  const configured = op.classification === MES.ATP_CLASS || (MES.operationSubcode(state, 'Test', code) || {}).softwareBaseline === true;
  const baseline = (op.atp && op.atp.baseline) || {};
  if (!configured) return null;
  return <fieldset className="field wide wi-atp-baseline" data-wi-atp-baseline><legend>Approved software baseline · required</legend><label htmlFor={`wi-op-${i}-atp-repo`}>HTTPS repository</label><input id={`wi-op-${i}-atp-repo`} name="atpRepo" type="url" maxLength="200" placeholder="https://git.example.com/skyryse/test-software" defaultValue={op.atp?.repo || ''} required/><label htmlFor={`wi-op-${i}-atp-version`}>Approved version</label><input id={`wi-op-${i}-atp-version`} name="atpVersion" maxLength="40" placeholder="v2.4.1" defaultValue={baseline.version || ''} required/><label htmlFor={`wi-op-${i}-atp-sha`}>Approved commit</label><input id={`wi-op-${i}-atp-sha`} name="atpSha" maxLength="40" placeholder="3f9c2ab" autoCapitalize="none" spellCheck="false" defaultValue={baseline.sha || ''} required/></fieldset>;
}

function WIStepEditor({ state, MES, op, step, opIndex, stepIndex }) {
  const s = step, i = opIndex, j = stepIndex;
  const inspLocked = op.classification === 'Inspection' && j === 0;
  const chosen = Array.isArray(s.consumables) ? s.consumables : [], custom = chosen.filter(c => !MES.CONSUMABLES.includes(c));
  return <li data-wi-step data-step-key={`${op.id}/${s.id}`}>
    <div className="field"><label htmlFor={`wi-op-${i}-step-${j}-title`}>Step {MES.stepLetter(j)} title</label><input id={`wi-op-${i}-step-${j}-title`} name="stepTitle" maxLength="120" required defaultValue={s.title} readOnly={inspLocked} aria-readonly={inspLocked ? 'true' : undefined}/></div>
    <div className="field"><label htmlFor={`wi-op-${i}-step-${j}-text`}>Step {MES.stepLetter(j)} instruction</label><textarea id={`wi-op-${i}-step-${j}-text`} name="instruction" maxLength="1000" rows="3" required defaultValue={s.instruction} readOnly={inspLocked} aria-readonly={inspLocked ? 'true' : undefined}></textarea></div>
    <label className="check-label"><input type="checkbox" name="recordsTorque" defaultChecked={!!s.recordsTorque} disabled={inspLocked}/><span>Records a torque value</span></label>
    {!inspLocked && chosen.length >= 0 ? <details className="consumable-pick" open={chosen.length > 0}><summary>Consumables · lot number and shelf life recorded{chosen.length ? <span className="consumable-count">{chosen.length}</span> : null}</summary><div className="consumable-grid">{MES.CONSUMABLES.map(c => <label key={c} className="consumable-opt"><input type="checkbox" name="consumable" value={c} defaultChecked={chosen.includes(c)}/><span>{c}</span></label>)}</div><label className="consumable-other"><span>Other consumable <span className="muted">(optional)</span></span><input name="consumableOther" maxLength="60" placeholder="Loctite 290" defaultValue={custom[0] || ''}/></label></details> : null}
    {!inspLocked ? <div className="step-media">{s.image ? <><figure className="step-media-preview"><img src={s.image.dataUrl} alt={s.image.caption || s.title}/>{s.image.name ? <figcaption>{s.image.name}</figcaption> : null}</figure><div className="field"><label htmlFor={`wi-op-${i}-step-${j}-caption`}>Picture caption</label><input id={`wi-op-${i}-step-${j}-caption`} name="imageCaption" maxLength="200" defaultValue={s.image.caption || ''}/></div><button type="button" className="btn quiet" data-action="wi-step-image-remove" data-op={op.id} data-step={s.id}>Remove picture</button></> : <><label className="btn wi-image-btn" htmlFor={`wi-image-${i}-${j}`}><Upload size={16}/> Add picture</label><input className="sr-only" type="file" id={`wi-image-${i}-${j}`} accept="image/png,image/jpeg,image/webp" data-wi-image data-op={op.id} data-step={s.id}/></>}</div> : null}
    <div className="wi-tools"><button type="button" className="btn quiet" data-action="wi-step-move" data-op={i} data-step={j} data-dir="-1" disabled={j === 0 || (op.classification === 'Inspection' && j === 1)} aria-label={`Move step ${MES.stepLetter(j)} up`}>Up</button><button type="button" className="btn quiet" data-action="wi-step-move" data-op={i} data-step={j} data-dir="1" disabled={j === op.steps.length - 1 || (op.classification === 'Inspection' && j === 0)} aria-label={`Move step ${MES.stepLetter(j)} down`}>Down</button><button type="button" className="btn quiet" data-action="wi-step-remove" data-op={i} data-step={j} disabled={op.steps.length === 1 || (op.classification === 'Inspection' && j === 0)}>Remove step</button></div></li>;
}

function RecordFiles({ files, canAdd, recKey, dataAttrs }) {
  const list = Array.isArray(files) ? files : [];
  const fileSizeLabel = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
  const dateLabel = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' }); };
  return <section className="attachments record-files"><div className="linked-heading"><h3>Files and photos <span className="mono">{list.length}</span></h3></div>
    {list.length ? <ul className="att-list">{list.map(f => <li key={f.id}>{f.dataUrl && String(f.type || '').startsWith('image/') ? <button type="button" className="att-thumb" data-action="rec-att-view" {...dataAttrs} data-file={f.id} aria-label={`View ${f.name}`}><img src={f.dataUrl} alt="" loading="lazy"/></button> : <span className="att-icon"><FileText size={16}/></span>}<span className="att-meta"><strong>{f.name}</strong><small>{fileSizeLabel(f.size)} · {f.addedBy?.name || ''} · {dateLabel(f.addedAt)}{f.storage === 'reference' ? ' · logged by name only' : ''}</small></span>{canAdd ? <button className="btn quiet" data-action="rec-att-remove" {...dataAttrs} data-file={f.id}>Remove</button> : ''}</li>)}</ul> : <p className="small muted no-links">No files.</p>}
    {canAdd ? <div className="media-actions"><label className="btn att-btn" htmlFor={`rec-att-${recKey}`}><Upload size={16}/> Add files or photos</label><input className="sr-only" id={`rec-att-${recKey}`} type="file" multiple accept="image/*,.pdf,.txt,.csv" aria-label="Attach files" data-rec-attachment {...dataAttrs}/></div> : ''}</section>;
}

function MnvField({ id, label, wide, children, required }) { return <div className={`field${wide ? ' wide' : ''}`}><label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>{children}</div>; }
function MnvSelect({ id, name, options, current }) { return <select id={id} name={name} defaultValue={current}>{options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option>; })}</select>; }
function MnvErr({ id }) { return <div id={id} className="form-error" role="alert" tabIndex="-1"></div>; }
function MnvWait({ children }) { return <div className="inline-info"><Lock size={16}/><p>{children}</p></div>; }
function MnvTable({ caption, columns, rows, empty, className }) {
  return <div className="table-wrap" tabIndex="0" role="region" aria-label={caption}><table className={`data-table${className ? ` ${className}` : ''}`}><caption className="sr-only">{caption}</caption><thead><tr>{columns.map(c => <th scope="col" key={c.col}>{c.label}</th>)}</tr></thead><tbody>{rows.length ? rows : <tr><td colSpan={columns.length} className="muted">{empty}</td></tr>}</tbody></table></div>;
}

// A signer as "name · credential", shared by the Flight Maneuver detail views.
const mnvWho = a => a ? <>{a.name} · {a.credentialId}</> : '';

function ManeuverDetail({ state, MES, FM, sel, skCan, helpers, view }) {
  const { dt } = helpers;
  const who = mnvWho;
  // A record's history, newest first, as the legacy Flight Maneuver view shows it. helpers.historyList is that view's
  // HTML string, which React would print as text, so the same markup is built here.
  const historyList = h => <details className="resolve-details"><summary>History ({h.length})</summary><ol className="task-list mnv-history">{h.slice().reverse().map((e, i) => <li key={i}><span className="task-main"><strong>{e.action}</strong><small>{e.actor} · {dt(e.at)}</small></span></li>)}</ol></details>;
  const carLink = id => id ? <button className="order-link" data-action="mnv-open-car" data-car={id}>{id}</button> : <span className="muted">None</span>;
  const waitNote = m => <MnvWait>{m}</MnvWait>;
  const pfmeaEditorCan = () => skCan('edit-wi') || skCan('approve-wi');
  const seatsFor = m => FM.seatsOf(m).map(s => { const v = m.votes.find(x => x.seat === s); return <div key={s} className={`mnv-seat ${v ? (v.vote === 'Approve' ? 'is-approve' : 'is-reject') : ''}`}><strong>{s}</strong>{v ? <><p><Pill>{v.vote === 'Approve' ? 'Approved' : 'Rejected'}</Pill></p><p>{v.note || ''}</p><p className="small muted">{who(v.by)} · {dt(v.at)}</p></> : <p className="muted small">No vote yet</p>}</div>; });

  if (view === 'mnv-changes' || view === 'mnv-feedback') {
    const term = sel.search.trim().toLowerCase();
    const all = (state.ecrRequests || []).slice().reverse();
    const kindOf = e => e.type === 'process' ? 'MCR' : 'ECR';
    const rows = all.filter(e => sel.changeType === 'All' || kindOf(e) === sel.changeType).filter(e => sel.changeStatus === 'All' || (sel.changeStatus === 'Open' ? !['Closed', 'Rejected', 'Withdrawn', 'Declined', 'Incorporated'].includes(e.status) : sel.changeStatus === 'Feedback' ? e.status === 'Feedback' : e.status === sel.changeStatus)).filter(e => !term || `${e.id} ${e.title} ${e.partNumber} ${(e.origin || {}).id || ''} ${e.wiId || ''}`.toLowerCase().includes(term));
    const statuses = [...new Set(all.map(e => e.status))];
    return <section aria-labelledby="mnv-chg-h"><div className="page-heading"><div><h1 id="mnv-chg-h">Change requests</h1><p className="small muted">MCR: manufacturing change to a work instruction, stays in the MES. ECR: design change, pushed to Jira. Feedback is an ECR that engineering has not yet decided on.</p></div><div className="plan-actions">{skCan('submit-ecr') ? <><button className="btn" data-action="ecr-new" data-type="process"><Plus size={16}/> Raise MCR</button><button className="btn" data-action="ecr-feedback"><Plus size={16}/> Raise design feedback</button><button className="btn primary" data-action="ecr-new" data-type="design"><Plus size={16}/> Raise ECR</button></> : ''}</div></div>
      <div className="filter-bar log-filters"><label className="search"><span className="sr-only">Search</span><Search size={16}/><input id="mnv-search" type="search" placeholder="Search MCR, ECR, part, WI or origin" defaultValue={sel.search}/></label><label className="log-select"><span>Type</span><select className="select-filter" id="mnv-change-type" defaultValue={sel.changeType}>{['All', 'MCR', 'ECR'].map(x => <option key={x}>{x}</option>)}</select></label><label className="log-select"><span>Status</span><select className="select-filter" id="mnv-change-status" defaultValue={sel.changeStatus}>{['Open', 'Feedback', ...statuses.filter(x => x !== 'Feedback'), 'All'].map(x => <option key={x}>{x}</option>)}</select></label></div>
      <div className="panel"><MnvTable caption="Change requests" columns={[{col:'Request',label:'Request'},{col:'Type',label:'Type'},{col:'Part / WI',label:'Part / WI'},{col:'Origin',label:'Origin'},{col:'Requested',label:'Created'},{col:'Status',label:'Status'},{col:'',label:''}]} rows={rows.map(e => <tr key={e.id}><td><button className="order-link" data-action="ecr-open" data-id={e.id}><strong className="mono">{e.id}</strong></button><small>{e.title}</small></td><td>{kindOf(e)}<small>{e.type === 'process' ? 'Work instruction' : e.status === 'Feedback' ? 'Design feedback' : 'Design'}</small></td><td><span className="mono">{e.partNumber || ''}</span>{e.wiId ? <small className="mono">{e.wiId} Rev {e.wiRevision || ''}</small> : ''}</td><td>{e.origin ? <>{e.origin.kind} <span className="mono">{e.origin.id}</span></> : <span className="muted">Direct</span>}</td><td>{(e.requestedBy || {}).name || ''}<small>{dt(e.at)}</small></td><td><Pill>{e.status}</Pill></td><td><div className="plan-actions">{e.status === 'Feedback' && skCan('accept-software') || e.status === 'Feedback' && skCan('approve-wo') ? <button className="btn quiet" data-action="ecr-feedback-review" data-id={e.id}>Review</button> : ''}</div></td></tr>)} empty="No change requests match"/><p className="table-count">{rows.length} request{rows.length === 1 ? '' : 's'}</p></div></section>;
  }

  if (view === 'mnv-metrics') {
    const r = FM.metricsReport(state, sel.mFrom, sel.mTo);
    const groups = [...new Set(r.rows.map(x => x.group))];
    return <section aria-labelledby="mnv-metrics-h"><div className="page-heading"><div><h1 id="mnv-metrics-h">Metrics</h1><p className="small muted">Computed from the records, not entered by hand. Pick the range, then export the CSV to start the trend file.</p></div><button className="btn primary" data-action="mnv-metrics-csv"><FileText size={16}/> Export CSV</button></div>
      <form id="mnv-metrics-form" className="filter-bar log-filters"><label className="log-select"><span>From</span><input type="date" name="from" defaultValue={sel.mFrom}/></label><label className="log-select"><span>To</span><input type="date" name="to" defaultValue={sel.mTo}/></label><button className="btn" type="submit">Apply</button></form>
      <div className="mnv-metric-grid">{groups.map(g => <section key={g} className="panel"><div className="panel-head"><h2>{g}</h2></div><table className="data-table mnv-mini"><tbody>{r.rows.filter(x => x.group === g).map((x, i) => <tr key={i}><td>{x.metric}</td><td className="mono" style={{ textAlign: 'right' }}><strong>{x.value}</strong>{x.unit ? <small> {x.unit}</small> : ''}</td></tr>)}</tbody></table></section>)}</div>
      <section className="panel" aria-labelledby="mnv-series-h"><div className="panel-head"><h2 id="mnv-series-h">Monthly series · last six months</h2></div><div className="table-wrap"><table className="data-table mnv-mini"><thead><tr><th scope="col">Month</th><th scope="col">NC</th><th scope="col">IDR</th><th scope="col">CARs</th><th scope="col">Escapes</th><th scope="col">SPRs</th></tr></thead><tbody>{r.series.map((m, i) => <tr key={i}><td className="mono">{m.month}</td><td className="mono">{m.nc}</td><td className="mono">{m.idr}</td><td className="mono">{m.cars}</td><td className="mono">{m.escapes}</td><td className="mono">{m.failures}</td></tr>)}</tbody></table></div></section></section>;
  }

  if (sel.board) {
    const m = FM.get(state, 'mrb', sel.board);
    if (!m) return <section><div className="empty"><h2>Board not found</h2><button className="btn" data-action="nav" data-view="mnv-mrb">All boards</button></div></section>;
    const seats = FM.seatsForAccount(), open = m.status === 'Open', actorId = window.skAuth?.actor?.()?.credentialId, ownVote = m.votes.find(v => v.by?.credentialId === actorId);
    const meSeat = 'Manufacturing Engineering', meVoted = m.votes.some(v => v.seat === meSeat), carry = (!meVoted && seats.indexOf(meSeat) !== -1) ? helpers.mrbProposalNote(m) : '';
    const startSeat = carry ? meSeat : seats[0];
    return <section aria-labelledby="mnv-board-h"><div className="page-heading"><div><p className="hero-eyebrow">Material Review Board · {m.id}</p><h1 id="mnv-board-h">{m.proposed} · {m.partNumber}</h1><p className="hero-meta"><Pill>{m.status}</Pill><button className="order-link" data-action="mnv-open-ticket" data-order={m.orderId} data-ticket={m.ticketId}>{m.ticketId}</button><button className="order-link" data-action="open-order" data-order={m.orderId}>{m.orderId}</button><span>{m.pedigree}</span>{m.serials.length ? <span className="mono">{m.serials.join(', ')}</span> : ''}</p><p className="small muted">Convened by {who(m.openedBy)} · {dt(m.openedAt)}{m.carId ? <> · corrective action {carLink(m.carId)}</> : ''}</p></div><div className="dash-actions"><button className="btn" data-action="mnv-print" data-kind="mrb" data-id={m.id}><FileText size={16}/> Print</button><button className="btn" data-action="nav" data-view="mnv-mrb">All boards</button>{open && skCan('dispo-nc') && !m.carId ? <button className="btn quiet" data-action="mnv-car-new" data-order={m.orderId} data-ticket={m.ticketId} data-source="NC" data-board={m.id}>Raise CAR</button> : ''}{skCan('submit-ecr') ? <><button className="btn quiet" data-action="ecr-from" data-kind="MRB" data-ref={m.id} data-order={m.orderId} data-part={m.partNumber} data-ecrtype="design">Raise ECR</button><button className="btn quiet" data-action="ecr-from" data-kind="MRB" data-ref={m.id} data-order={m.orderId} data-part={m.partNumber} data-ecrtype="process">Raise MCR</button></> : ''}</div></div>
      <section className="panel mnv-summary" aria-labelledby="mnv-board-summary"><div className="panel-head"><h2 id="mnv-board-summary">Nonconformance and technical justification</h2></div><p>{m.summary}</p></section>
      <RecordFiles files={m.attachments} canAdd={open} recKey={`b-${m.id}`} dataAttrs={{ 'data-scope': 'mnv', 'data-kind': 'mrb', 'data-rec': m.id }} />
      <section className="panel" aria-labelledby="mnv-votes-h"><div className="panel-head"><h2 id="mnv-votes-h">Seats</h2></div><div className="mnv-seats">{seatsFor(m)}</div>{open && ownVote ? <div className="inline-info warning" role="status"><Lock size={16}/><div><p><strong>{ownVote.by.name} already voted in the {ownVote.seat} seat.</strong></p><p>This three-seat board needs three distinct credentialed accounts. Switch to the next voter, or add the missing account.</p><div className="media-actions"><button className="btn primary" type="button" data-fs-review-signin="">Switch account <ArrowRight size={16}/></button><button className="btn" type="button" data-action="profile">Manage accounts</button></div></div></div> : open && seats.length ? <form id="mnv-vote-form" data-board={m.id}>{carry ? <p className="small muted">The {meSeat} note is carried from the disposition on {m.ticketId}. Confirm it or change it before recording the vote.</p> : ''}<div className="form-grid"><MnvField id="mnv-seat" label="Your seat"><MnvSelect id="mnv-seat" name="seat" options={seats} current={startSeat}/></MnvField><MnvField id="mnv-vote" label="Vote"><MnvSelect id="mnv-vote" name="vote" options={FM.VOTES} current="Approve"/></MnvField><MnvField id="mnv-vote-note" label="Note (required for a rejection)" wide required><textarea id="mnv-vote-note" name="note" rows="2" maxLength="1000" defaultValue={carry}></textarea></MnvField></div><MnvErr id="mnv-vote-error"/><div className="dialog-actions"><button className="btn primary" type="submit">Record vote</button></div></form> : open ? <p className="muted small">Your roles do not include an MRB seat. Ask a QA Manager to assign the appropriate role.</p> : ''}</section>
      {m.decision ? <div className={`inline-info ${m.status === 'Approved' ? 'success' : 'warning'}`}><Info size={16}/><div><p><strong>Board {m.status.toLowerCase()}</strong> · {m.decision.note}</p><p className="small">{who(m.decision.by)} · {dt(m.decision.at)}</p><p className="small mono">Signature manifest SHA-256 {m.decision.manifest.hash.slice(0, 16)}… · {m.decision.manifest.meaning}</p></div></div> : open && skCan('approve-nc') ? <section className="panel"><div className="panel-head"><h2>Decision</h2></div><p className="panel-description">{FM.seatsOf(m).every(s => m.votes.some(v => v.seat === s)) ? <>All seats have voted. The decision will be <strong>{m.votes.every(v => v.vote === 'Approve') ? 'Approved' : 'Rejected'}</strong> (any rejection rejects).</> : <>Waiting on {FM.seatsOf(m).filter(s => !m.votes.some(v => v.seat === s)).join(', ')}.</>}</p><form id="mnv-decide-form" data-board={m.id}><MnvField id="mnv-decide" label="Decision rationale" wide required><textarea id="mnv-decide" name="note" rows="3" maxLength="2000" required></textarea></MnvField><label className="check-label"><input type="checkbox" name="acknowledge" required/><span>I record the board decision. A signature manifest is written with my credential and the ticket is updated in Flight Control.</span></label><MnvErr id="mnv-decide-error"/><div className="dialog-actions"><button className="btn primary" type="submit">Record decision and sign</button></div></form></section> : ''}
      {historyList(m.history)}</section>;
  }

  if (sel.nc) {
    const t = FM.get(state, 'ncs', sel.nc);
    if (!t) return <section><div className="empty"><h2>NC not found</h2><button className="btn" data-action="nav" data-view="mnv-intake">Intake</button></div></section>;
    const open = t.status === 'Open', me = skCan('dispo-nc'), qa = skCan('approve-nc');
    const board = FM.needsMRB({ pedigree: t.pedigree }, t), m = t.mrbId ? FM.get(state, 'mrb', t.mrbId) : FM.mrbFor(state, FM.STOCK, t.id);
    const dispoOpts = MES.DISPOSITIONS.map(d => [d, `${d}${FM.MRB_REQUIRED.includes(d) ? ' · MRB route (deviation)' : d === 'Use for Dev' ? ' · QA Manager approval, pedigree to Development' : ' · quick route'}`]);
    const dispo = t.dispo ? <><p><strong>{t.dispo.decision}</strong> · {t.dispo.note}</p><p className="small muted">{t.dispo.name} · {t.dispo.credentialId} · {dt(t.dispo.at)}</p>{(t.dispoReturns || []).length ? <details className="resolve-details"><summary>Earlier dispositions ({t.dispoReturns.length})</summary><ul>{t.dispoReturns.map((d, i) => <li key={i}>{d.decision} · {d.note} <small className="muted">{d.name} · {dt(d.at)}{d.returnedBy ? ` · returned by ${d.returnedBy}` : ''}</small></li>)}</ul></details> : ''}</> : '';
    const dispoForm = open && me ? <form id="mnv-nc-dispo-form" data-id={t.id}><div className="form-grid"><MnvField id="mnv-ncd-dec" label={t.dispo ? 'New disposition' : 'Disposition'}><MnvSelect id="mnv-ncd-dec" name="decision" options={dispoOpts} current={t.dispo ? t.dispo.decision : 'Rework'}/></MnvField><MnvField id="mnv-ncd-note" label="Rationale" wide required><textarea id="mnv-ncd-note" name="note" rows="3" maxLength="500" required></textarea></MnvField></div><p className="small muted">Rework, Scrap, Return to supplier and Rejected in Error take the quick route. Use as is and Repair are deviations and open an MRB sub-ticket.</p><MnvErr id="mnv-nc-dispo-error"/><div className="dialog-actions"><button className="btn primary" type="submit">{t.dispo ? 'Replace disposition' : 'Record disposition'}</button></div></form> : '';
    const containment = t.containment ? <><p className="record-note">{t.containment.note}</p><p className="small muted">{who(t.containment.by)} · {dt(t.containment.at)}</p></> : open && me ? <form id="mnv-nc-contain-form" data-id={t.id}><MnvField id="mnv-ncc-note" label={t.escape ? 'This is an escape. What was done to find and hold every affected unit?' : 'Containment (optional for a non-escape)'} wide required><textarea id="mnv-ncc-note" name="note" rows="3" maxLength="2000" required></textarea></MnvField><MnvErr id="mnv-nc-contain-error"/><div className="dialog-actions"><button className="btn primary" type="submit">Record containment</button></div></form> : <p className="muted small">Not recorded.</p>;
    const mrbBody = !board ? <p className="muted small">{t.dispo ? `${t.dispo.decision} takes the quick route. No board.` : 'Decided by the disposition: Use as is and Repair go to the board.'}</p> : !m ? <p>{t.dispo.decision} is a deviation, so the board decides before Quality approves.{open && me ? <button className="btn" data-action="mnv-mrb-new" data-order={FM.STOCK} data-ticket={t.id}>Convene MRB sub-ticket</button> : ''}</p> : <><p><button className="order-link" data-action="mnv-open-board" data-board={m.id}><strong className="mono">{m.id}</strong></button> <Pill>{m.status}</Pill> · proposed {m.proposed}</p><div className="mnv-seats">{seatsFor(m)}</div>{m.status === 'Rejected' && open ? <p className="small">The board rejected the disposition. Manufacturing Engineering records a new one above.</p> : ''}</>;
    const approval = t.resolution ? <div><div className="inline-info success"><Check size={16}/><div><p><strong>Approved {t.dispo.decision}</strong> · {t.resolution.note}</p><p className="small">{who(t.resolution.by)} · {dt(t.resolution.at)}</p>{t.affected ? <p className="small">Defect <span className="mono">{t.affected.defectCode}{t.affected.subCode ? ` ${t.affected.subCode}` : ''}</span> · {t.affected.defectName} · qty {t.affected.quantity}</p> : ''}{t.resolution.manifest ? <p className="small mono">Signature manifest SHA-256 {t.resolution.manifest.hash.slice(0, 16)}… · {t.resolution.manifest.meaning}</p> : ''}</div></div>{['Rework', 'Repair'].includes(t.dispo.decision) ? <p>{t.reworkOrderId ? <>Rework order <button className="order-link" data-action="open-order" data-order={t.reworkOrderId}>{t.reworkOrderId}</button></> : <button className="btn" data-action="create-adhoc" data-nc={t.id} data-serial={t.serial} data-part={t.partNumber}>Create rework order for {t.serial || t.lot}</button>}</p> : ''}</div> : open && qa && t.dispo ? <form id="mnv-nc-approve-form" data-id={t.id}><div className="form-grid"><MnvField id="mnv-nca-code" label="Defect code"><select id="mnv-nca-code" name="defectCode" required defaultValue=""><option value="">Not coded</option>{(MES.DEFECT_CODES || []).map(d => <option key={d.code} value={d.code}>{d.code} · {d.name}</option>)}</select></MnvField><MnvField id="mnv-nca-sub" label="Sub-code"><select id="mnv-nca-sub" name="subCode" required defaultValue=""><option value="">Choose a code first</option></select></MnvField><MnvField id="mnv-nca-qty" label="Affected quantity"><input id="mnv-nca-qty" name="quantity" type="number" min="1" max={t.quantity} defaultValue={t.quantity} required/></MnvField><MnvField id="mnv-nca-note" label={`Approve ME disposition: ${t.dispo.decision}`} wide required><textarea id="mnv-nca-note" name="note" rows="3" maxLength="1500" required></textarea></MnvField></div><MnvErr id="mnv-nc-approve-error"/><div className="dialog-actions"><button className="btn primary" type="submit">Approve disposition and close</button></div></form> : <p className="muted small">Waiting on the disposition.</p>;
    const ncStep = (n, title, done, body, extra) => <section className={`panel mnv-step ${done ? 'is-done' : ''}`} aria-labelledby={`mnv-nc-step-${n}`}><div className="panel-head"><h2 id={`mnv-nc-step-${n}`}><span className="step-dot">{done ? <Check size={16}/> : n}</span> {title}</h2>{extra}</div>{body}</section>;
    return <section aria-labelledby="mnv-nc-h"><div className="page-heading"><div><p className="hero-eyebrow">{t.type} outside a work order · {t.id}</p><h1 id="mnv-nc-h">{t.title}</h1><p className="hero-meta"><Pill>{t.status}</Pill>{t.escape ? <Pill>Escape</Pill> : ''}<span className="mono">{t.partNumber}{t.revision ? ` Rev ${t.revision}` : ''}</span>{t.serial ? <span className="mono">S/N {t.serial}</span> : ''}{t.lot ? <span className="mono">Lot {t.lot}</span> : ''}<span>Qty {t.quantity}</span><span>Found at {t.foundAt}</span><span>{t.pedigree}</span>{t.escape ? <span>Got past {t.escape.from}</span> : ''}</p><p className="small muted">Raised by {who(t.raisedBy)} · {dt(t.createdAt)}</p><div className="plan-actions"><button className="btn" data-action="mnv-print" data-kind="ncs" data-id={t.id}><FileText size={16}/> Print</button><button className="btn" data-action="nav" data-view="mnv-intake">Intake <ArrowRight size={16}/></button>{t.carId ? <span>CAR {carLink(t.carId)}</span> : open ? <button className="btn" data-action="mnv-car-new" data-order={FM.STOCK} data-ticket={t.id} data-source={t.type}>Raise CAR</button> : ''}{skCan('submit-ecr') ? <><button className="btn" data-action="ecr-from" data-kind={t.type} data-ref={t.id} data-order={FM.STOCK} data-part={t.partNumber} data-ecrtype="design">Raise ECR from this {t.type}</button><button className="btn" data-action="ecr-from" data-kind={t.type} data-ref={t.id} data-order={FM.STOCK} data-part={t.partNumber} data-ecrtype="process">Raise MCR from this {t.type}</button></> : ''}</div></div></div>
      <section className="panel mnv-summary" aria-labelledby="mnv-nc-desc"><div className="panel-head"><h2 id="mnv-nc-desc">Observation</h2></div><p>{t.description}</p></section>
      <RecordFiles files={t.attachments} canAdd={open} recKey={`n-${t.id}`} dataAttrs={{ 'data-scope': 'mnv', 'data-kind': 'ncs', 'data-rec': t.id }} />
      {t.escape ? ncStep('E', 'Containment', !!t.containment, containment) : ''}
      {ncStep(1, 'Manufacturing Engineering disposition', !!t.dispo, <>{dispo}{dispoForm}</>)}
      {ncStep(2, 'MRB sub-ticket', !!(m && m.status === 'Approved'), mrbBody, board ? <Pill>{m ? m.status : 'Needed'}</Pill> : '')}
      {ncStep(3, 'Quality approval', !!t.resolution, approval)}
      {historyList(t.history)}</section>;
  }

  if (sel.pfmea) {
    const t = FM.get(state, 'pfmeas', sel.pfmea);
    if (!t) { return <ManeuverDetailPfmeaList state={state} MES={MES} FM={FM} sel={sel} skCan={skCan} helpers={helpers}/>; }
    const wi = (state.masterWIs || []).find(w => w.id === t.wiId && w.revision === t.wiRevision);
    const ops = wi ? wi.operations : [];
    const cov = FM.pfmeaCoverage(t, wi);
    const pfmeaOp = sel.pfmeaOp && ops.some(op => op.id === sel.pfmeaOp) ? sel.pfmeaOp : (cov.missing[0] || ops[0] || {}).id || null;
    const op = ops.find(x => x.id === pfmeaOp) || null;
    const opNo = id => { const i = ops.findIndex(x => x.id === id); return i < 0 ? id : String((i + 1) * 10).padStart(3, '0'); };
    const open = t.status !== 'Approved', edit = skCan('edit-wi');
    const idx = FM.PFMEA_STEPS.findIndex(([k]) => k === t.status);
    const rpnCell = r => <span className={`mono ${FM.pfmeaHigh(r) ? 'pfm-high' : ''}`}>{r.rpn}</span>;
    const steps = <ol className="pfm-steps" aria-label="PFMEA steps">{FM.PFMEA_STEPS.map(([k, l], i) => <li key={k} className={i < idx || t.status === 'Approved' ? 'done' : i === idx ? 'current' : ''}><span className="pfm-dot">{i < idx || t.status === 'Approved' ? <Check size={16}/> : i + 1}</span><span>{l}</span></li>)}</ol>;
    const left = <section className="panel pfm-wi" aria-labelledby="pfm-wi-h"><div className="panel-head"><h2 id="pfm-wi-h">Work instruction · {t.wiId} Rev {t.wiRevision}</h2><span className="mono">{cov.covered} / {cov.total} reviewed</span></div>
      {wi ? <ol className="pfm-ops">{ops.map(o => { const n = t.rows.filter(r => r.opId === o.id), hi = n.filter(FM.pfmeaHigh).length, rv = t.reviewed[o.id]; return <li key={o.id}><button className={`pfm-op ${o.id === pfmeaOp ? 'active' : ''}`} data-action="mnv-pfmea-op" data-op={o.id} aria-pressed={o.id === pfmeaOp}><span className="pfm-op-no mono">{opNo(o.id)}</span><span className="pfm-op-main"><strong>{o.title}</strong><small>{o.classification || 'Manufacturing'} · {o.buyoffType}{o.inspectionPoint ? ' · inspection point' : ''}{(o.callouts || []).length ? ` · ${o.callouts.join(', ')}` : ''}</small></span><span className="pfm-op-state">{n.length ? <span className={`pill ${hi ? 'high' : 'building'}`}>{n.length} mode{n.length === 1 ? '' : 's'}{hi ? ` · ${hi} high` : ''}</span> : rv ? <span className="pill closed">No credible risk</span> : <span className="pill missing">Not reviewed</span>}</span></button>
        {o.id === pfmeaOp ? <div className="pfm-op-body"><p className="small">{o.description || ''}</p><ol className="pfm-op-steps">{(o.steps || []).map(s => <li key={s.id}><strong>{s.title}</strong><span className="small muted">{s.instruction || ''}</span></li>)}</ol></div> : ''}</li>; })}</ol> : <p className="panel-body muted">The work instruction revision is no longer in the library.</p>}</section>;
    let work = '';
    if (t.status === 'Scoping') work = <><h3>Step 1 · Scope and team</h3><p className="small muted">Who is on the cross-functional team, and what the analysis covers.</p>{pfmeaEditorCan() ? <form id="pfm-scope-form" data-id={t.id}><div className="field"><label htmlFor="pfm-team">Team (names and roles)</label><textarea id="pfm-team" name="team" rows="3" maxLength="400" required placeholder="R. Ortega (ME), A. Napoleon (QE), P. Nair (Design), Safety Team rep"></textarea></div><div className="field"><label htmlFor="pfm-bound">Scope and boundaries</label><textarea id="pfm-bound" name="boundaries" rows="3" maxLength="800" placeholder="Every operation of this revision, from kit verification to final inspection."></textarea></div><p id="pfm-scope-error" className="form-error" role="alert"></p><div className="pfm-btns"><button className="btn primary" type="submit">Save scope and start analysis</button></div></form> : waitNote('Manufacturing Engineering or Quality sets the scope.')}</>;
    else if (t.status === 'Analysis') {
      const rows = t.rows.filter(r => r.opId === pfmeaOp);
      work = <><h3>Step 2 · Failure modes for Op {opNo(pfmeaOp)}{op ? ` · ${op.title}` : ''}</h3><p className="small muted">Pick an operation on the left. Record each way it can fail, or record why none is credible. {cov.covered} of {cov.total} operations reviewed.</p>
        {rows.length ? <ul className="pfm-rows">{rows.map(r => <li key={r.id}><span className="mono">{r.id}</span><span><strong>{r.mode}</strong><small>{r.effect || ''}{r.cause ? ` · cause: ${r.cause}` : ''}{r.controls ? ` · controls: ${r.controls}` : ''}</small></span><span className="mono">S{r.s} O{r.o} D{r.d} · {rpnCell(r)}</span>{edit ? <button className="btn quiet" data-action="mnv-pfmea-remove" data-id={t.id} data-row={r.id}>Remove</button> : ''}</li>)}</ul> : t.reviewed[pfmeaOp] ? <div className="inline-info success"><Check size={16}/><p>No credible failure mode: {t.reviewed[pfmeaOp].note} <small>{who(t.reviewed[pfmeaOp].by)}</small></p></div> : ''}
        {edit ? <><form id="pfm-mode-form" data-id={t.id} className="pfm-form"><input type="hidden" name="opId" value={pfmeaOp || ''}/><div className="form-grid"><MnvField id="pfm-mode" label="Failure mode" wide required><input id="pfm-mode" name="mode" maxLength="200" required placeholder="Fastener under-torqued"/></MnvField><MnvField id="pfm-effect" label="Effect"><input id="pfm-effect" name="effect" maxLength="300" placeholder="Loss of retention in flight"/></MnvField><MnvField id="pfm-cause" label="Cause"><input id="pfm-cause" name="cause" maxLength="300" placeholder="Wrench unit set to in-lb"/></MnvField><MnvField id="pfm-controls" label="Current controls" wide><input id="pfm-controls" name="controls" maxLength="300" placeholder="Torque step records value and unit"/></MnvField><MnvField id="pfm-s" label="Severity"><input id="pfm-s" name="s" type="number" min="1" max="10" required/></MnvField><MnvField id="pfm-o" label="Occurrence"><input id="pfm-o" name="o" type="number" min="1" max="10" required/></MnvField><MnvField id="pfm-d" label="Detection"><input id="pfm-d" name="d" type="number" min="1" max="10" required/></MnvField></div><p id="pfm-mode-error" className="form-error" role="alert"></p><div className="pfm-btns"><button className="btn" type="submit">Add failure mode</button></div></form>
        {!rows.length && !t.reviewed[pfmeaOp] ? <form id="pfm-norisk-form" data-id={t.id} data-op={pfmeaOp || ''} className="pfm-form"><div className="field"><label htmlFor="pfm-norisk">Or: no credible failure mode, because</label><input id="pfm-norisk" name="note" maxLength="300" required placeholder="Visual check only, no fastening, no fit-up"/></div><p id="pfm-norisk-error" className="form-error" role="alert"></p><div className="pfm-btns"><button className="btn quiet" type="submit">Mark operation reviewed</button></div></form> : ''}
        <div className="pfm-btns"><button className="btn primary" data-action="mnv-pfmea-analysis-done" data-id={t.id} disabled={cov.missing.length > 0 || !t.rows.length}>Analysis complete</button></div></> : waitNote('Manufacturing Engineering records the failure modes.')}</>;
    } else if (t.status === 'Actions') {
      const high = t.rows.filter(FM.pfmeaHigh);
      work = <><h3>Step 3 · Actions on high risk</h3><p className="small muted">Every row with RPN {MES.PFMEA_HIGH.rpn}+ or severity {MES.PFMEA_HIGH.severity}+ needs an action, an owner and a date, then evidence and a re-score.</p>
        <ul className="pfm-actions">{high.map(r => <li key={r.id} className={r.done ? 'done' : ''}><div className="pfm-action-head"><span className="mono">{r.id} · Op {opNo(r.opId)}</span><strong>{r.mode}</strong><span className="mono">RPN {rpnCell(r)}{r.done ? <> to <strong>{r.done.rpn}</strong></> : ''}</span></div>
          {r.action ? <p className="small">{r.action} · <strong>{r.owner}</strong> · due {r.due}</p> : ''}
          {r.done ? <p className="small muted">Evidence: {r.done.evidence} · {who(r.done.by)}</p> : edit && !r.action ? <form className="pfm-form" id={`pfm-action-form-${r.id}`} data-form="pfm-action" data-id={t.id} data-row={r.id}><div className="form-grid"><MnvField id={`pfm-action-${r.id}`} label="Action" wide required><input id={`pfm-action-${r.id}`} name="action" maxLength="400" required/></MnvField><MnvField id={`pfm-owner-${r.id}`} label="Owner" required><input id={`pfm-owner-${r.id}`} name="owner" maxLength="80" required/></MnvField><MnvField id={`pfm-due-${r.id}`} label="Due" required><input id={`pfm-due-${r.id}`} name="due" type="date" required/></MnvField></div><p className="form-error" role="alert"></p><div className="pfm-btns"><button className="btn" type="submit">Assign action</button></div></form>
          : r.action && pfmeaEditorCan() ? <form className="pfm-form" id={`pfm-close-form-${r.id}`} data-form="pfm-close" data-id={t.id} data-row={r.id}><div className="form-grid"><MnvField id={`pfm-ev-${r.id}`} label="Evidence the action is in place" wide required><input id={`pfm-ev-${r.id}`} name="evidence" maxLength="1000" required placeholder="WI step 030-B now states 25 ft-lb and records the unit; inspection point added"/></MnvField><MnvField id={`pfm-cs-${r.id}`} label="Severity"><input id={`pfm-cs-${r.id}`} name="s" type="number" min="1" max="10" defaultValue={r.s} required/></MnvField><MnvField id={`pfm-co-${r.id}`} label="Occurrence"><input id={`pfm-co-${r.id}`} name="o" type="number" min="1" max="10" required/></MnvField><MnvField id={`pfm-cd-${r.id}`} label="Detection"><input id={`pfm-cd-${r.id}`} name="d" type="number" min="1" max="10" required/></MnvField></div><p className="form-error" role="alert"></p><div className="pfm-btns"><button className="btn" type="submit">Close action and re-score</button></div></form> : ''}</li>)}</ul>
        {pfmeaEditorCan() ? <div className="pfm-btns"><button className="btn primary" data-action="mnv-pfmea-actions-done" data-id={t.id} disabled={high.some(r => !r.done)}>Send to the Safety Team</button></div> : ''}</>;
    } else if (t.status === 'Safety review') {
      const high = t.rows.filter(FM.pfmeaHigh), residual = t.rows.filter(r => r.done && r.done.rpn >= MES.PFMEA_HIGH.rpn);
      const maxBefore = Math.max(0, ...t.rows.map(r => r.rpn)), maxAfter = Math.max(0, ...t.rows.map(r => r.done ? r.done.rpn : r.rpn));
      work = <><h3>Step 4 · Safety Team buy-off</h3><dl className="dialog-context"><div><dt>Failure modes</dt><dd>{t.rows.length} across {cov.total} operations</dd></div><div><dt>High risk</dt><dd>{high.length}, all actioned</dd></div><div><dt>Highest RPN</dt><dd className="mono">{maxBefore} before, {maxAfter} after</dd></div><div><dt>Residual high</dt><dd>{residual.length ? residual.map(r => r.id).join(', ') : 'None'}</dd></div></dl>
        <p className="small muted">Approving signs the PFMEA and releases {t.wiId} Rev {t.wiRevision}. Return sends it back to analysis with your note.</p>
        {skCan('safety-buyoff') ? <form id="pfm-safety-form" data-id={t.id}><MnvField id="pfm-decision" label="Decision"><select id="pfm-decision" name="decision"><option value="Approve">Approve and release the WI</option><option value="Return">Return to analysis</option></select></MnvField><MnvField id="pfm-safety-note" label="Safety Team rationale" required><textarea id="pfm-safety-note" name="note" rows="3" maxLength="1000" required></textarea></MnvField><p id="pfm-safety-error" className="form-error" role="alert"></p><div className="pfm-btns"><button className="btn primary" type="submit">Record Safety Team decision</button></div></form> : waitNote('Waiting for the Safety Team buy-off. Only a Safety Team account can sign it.')}</>;
    } else work = <div className="inline-info success"><Check size={16}/><div><p><strong>Safety Team buy-off · {who(t.safety.by)} · {dt(t.safety.at)}</strong></p><p>{t.safety.note}</p><p className="small mono">SHA-256 {(t.safety.manifest || {}).hash || ''}</p><p className="small">{t.wiId} Rev {t.wiRevision} released by this buy-off.</p></div></div>;
    const returns = t.returns.length ? <div className="inline-info warning"><Info size={16}/><div>{t.returns.map((r, i) => <p key={i}><strong>Returned by the Safety Team</strong> · {who(r.by)} · {dt(r.at)}<br/>{r.note}</p>)}</div></div> : '';
    const right = <section className="panel pfm-work" aria-labelledby="pfm-work-h"><div className="panel-head"><h2 id="pfm-work-h">PFMEA walkthrough</h2><Pill>{t.status}</Pill></div><div className="panel-body">{t.scope ? <p className="small"><strong>Team:</strong> {t.scope.team}{t.scope.boundaries ? <><br/><strong>Scope:</strong> {t.scope.boundaries}</> : ''}</p> : ''}{returns}{work}</div></section>;
    const sheet = <section className="panel" aria-labelledby="pfm-sheet-h"><div className="panel-head"><h2 id="pfm-sheet-h">PFMEA worksheet</h2></div><MnvTable caption="PFMEA worksheet" columns={[{col:'Row',label:'Row'},{col:'Op',label:'Op'},{col:'Failure mode',label:'Failure mode'},{col:'Effect / cause',label:'Effect / cause'},{col:'Controls',label:'Controls'},{col:'S O D',label:'S O D'},{col:'RPN',label:'RPN'},{col:'Action',label:'Action'},{col:'Revised',label:'Revised'}]} rows={t.rows.map(r => <tr key={r.id}><td className="mono">{r.id}</td><td className="mono">{opNo(r.opId)}</td><td>{r.mode}</td><td>{r.effect || ''}<small>{r.cause || ''}</small></td><td>{r.controls || ''}</td><td className="mono">{r.s} {r.o} {r.d}</td><td>{rpnCell(r)}</td><td>{r.action ? <>{r.action}<small>{r.owner} · {r.due}</small></> : <span className="muted">None</span>}</td><td>{r.done ? <span className="mono">{r.done.s} {r.done.o} {r.done.d} · {r.done.rpn}</span> : ''}</td></tr>)} empty="No failure modes yet."/></section>;
    return <section aria-labelledby="mnv-pfmd-h"><div className="page-heading"><div><p className="hero-eyebrow">PFMEA · {t.id}</p><h1 id="mnv-pfmd-h">{t.wiId} Rev {t.wiRevision} · {t.title}</h1><p className="hero-meta"><Pill>{t.status}</Pill><span className="pill high">Critical safety part</span><span className="mono">{t.partNumber}</span><span>Opened by {who(t.openedBy)} · {dt(t.openedAt)}</span></p></div><div className="dash-actions"><button className="btn" data-action="mnv-print" data-kind="pfmeas" data-id={t.id}><FileText size={16}/> Print</button><button className="btn" data-action="wi-open" data-wi={t.wiId} data-rev={t.wiRevision}>Open work instruction</button><button className="btn" data-action="nav" data-view="mnv-pfmea">All PFMEAs</button></div></div>
      {steps}<div className="pfm-split">{left}{right}</div>{sheet}{historyList(t.history)}</section>;
  }

  return <ManeuverDetailPfmeaList state={state} MES={MES} FM={FM} sel={sel} skCan={skCan} helpers={helpers}/>;
}

function ManeuverDetailPfmeaList({ state, MES, FM, sel, skCan, helpers }) {
  const { dt } = helpers, who = mnvWho;
  const rows = FM.list(state, 'pfmeas').slice().sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return <section aria-labelledby="mnv-pfm-h"><div className="page-heading"><div><h1 id="mnv-pfm-h">PFMEA</h1><p className="small muted">Critical safety work instructions move here after QA review. The Safety Team buy-off releases the WI.</p></div></div>
    <div className="panel"><MnvTable caption="PFMEA tickets" columns={[{col:'PFMEA',label:'PFMEA'},{col:'Work instruction',label:'Work instruction'},{col:'Step',label:'Step'},{col:'Rows',label:'Rows'},{col:'High risk',label:'High risk'},{col:'Opened',label:'Created'},{col:'Safety',label:'Safety'}]} rows={rows.map(t => { const high = t.rows.filter(FM.pfmeaHigh), doneHigh = high.filter(r => r.done).length; return <tr key={t.id}><td><button className="order-link" data-action="mnv-open-pfmea" data-id={t.id}><strong className="mono">{t.id}</strong></button><small>{t.title}</small></td><td><button className="order-link" data-action="wi-open" data-wi={t.wiId} data-rev={t.wiRevision}>{t.wiId} Rev {t.wiRevision}</button><small className="mono">{t.partNumber}</small></td><td><Pill>{t.status}</Pill></td><td>{t.rows.length}</td><td>{high.length}{doneHigh ? <small> {doneHigh} closed</small> : ''}</td><td>{dt(t.openedAt)}<small>{who(t.openedBy)}</small></td><td>{t.safety ? <>{who(t.safety.by)}<small>{dt(t.safety.at)}</small></> : <span className="muted">Pending</span>}</td></tr>; })} empty="No PFMEA yet. Flag a draft WI as a critical safety part; after ME peer review, QA review opens its PFMEA here."/></div></section>;
}

/* ------------------------------------------------------------------
 * v2 outstanding screens: plan home, QMS, and the work order record.
 * ------------------------------------------------------------------ */
function PlanHome({ state, MES, FlightPlan, skCan }) {
  FlightPlan.ensure(state);
  const me = (window.skAuth && window.skAuth.actor && window.skAuth.actor()) || { name: state.profile.name };
  const first = String(me.name || '').trim().split(/\s+/)[0] || 'there';
  const all = FlightPlan.list(state), open = all.filter(po => ['Planned', 'Firm'].includes(po.status));
  const covered = po => !po.netsuite || po.netsuite.onHand >= po.quantity;
  let f = { explosion: [] }; try { f = FlightPlan.forecast(state); } catch (e) {}
  const shorts = (f.explosion || []).filter(d => d.short > 0).sort((a, b) => String(a.orderBy || '').localeCompare(String(b.orderBy || '')));
  const byNeed = l => l.slice().sort((a, b) => a.needDate.localeCompare(b.needDate) || a.id.localeCompare(b.id));
  const groups = [
    ['Past need date', byNeed(open.filter(po => FlightPlan.overdue(po))), 'overdue'],
    ['To firm', byNeed(all.filter(po => po.status === 'Planned')), 'po'],
    ['Pending materials', byNeed(all.filter(po => po.status === 'Firm' && !covered(po))), 'po'],
    ['Ready to convert', byNeed(all.filter(po => po.status === 'Firm' && covered(po))), 'po'],
    ['Component shortages', shorts, 'short'],
    ['Converted', all.filter(po => po.status === 'Converted').sort((a, b) => String(b.workOrder && b.workOrder.convertedAt || '').localeCompare(String(a.workOrder && a.workOrder.convertedAt || ''))), 'conv']
  ].filter(([, l]) => l.length);
  const slug = g => 'plan-' + g.replace(/\s+/g, '-').toLowerCase();
  const openG = window.__dashOpen === null ? null : groups.some(([g]) => g === window.__dashOpen) ? window.__dashOpen : (groups[0] && groups[0][0]);
  const today = new Date().toISOString().slice(0, 10);
  const poRow = po => <li key={po.id}><button className={`task-row ${FlightPlan.overdue(po) ? 'task-aog' : ''}`} data-action="plan-open" data-plan={asText(po.id)}><span className="task-main"><strong><span className="mono">{asText(po.id)}</span> · {asText(po.configuration.partNumber)} × {asText(po.quantity)}</strong><small>{asText(po.masterWI.id)} Rev {asText(po.masterWI.revision)} · need {asText(po.needDate)}{po.netsuite ? <> · on hand {asText(po.netsuite.onHand)}</> : null}</small></span><Pill status={po.status}/><span className="task-go" aria-hidden="true"><ChevronRight size={16}/></span></button></li>;
  const shortRow = (d, i) => <li key={i}><button className="task-row" data-action="nav" data-view="plan-forecast"><span className="task-main"><strong><span className="mono">{asText(d.part)} / Rev {asText(d.rev)}</span> · short {asText(d.short)}</strong><small>{asText(d.title || '')} · need {asText(d.qty)}, on hand {asText(d.onHand)}{d.orderBy ? <> · order by {asText(d.orderBy)}</> : null}</small></span>{d.orderBy && d.orderBy < today ? <span className="pill high">Order late</span> : <span className="pill kitting">Buy</span>}<span className="task-go" aria-hidden="true"><ChevronRight size={16}/></span></button></li>;
  const convRow = po => { const o = MES.getOrder(state, po.workOrder && po.workOrder.id); return <li key={po.id}><button className="task-row" data-action="open-order" data-order={asText((po.workOrder && po.workOrder.id) || '')}><span className="task-main"><strong><span className="mono">{asText(po.id)}</span> → <span className="mono">{asText((po.workOrder && po.workOrder.id) || '')}</span></strong><small>{asText(po.configuration.partNumber)} × {asText(po.quantity)} · converted {asText(String((po.workOrder && po.workOrder.convertedAt) || '').slice(0, 10))}</small></span>{o ? <Pill status={o.status}/> : null}<span className="task-go" aria-hidden="true"><ChevronRight size={16}/></span></button></li>; };
  const units = open.reduce((n, po) => n + Number(po.quantity || 0), 0), next = byNeed(open)[0];
  return <section aria-labelledby="plan-dash-heading">
    <div className="page-heading dash-heading"><div><p className="hero-eyebrow">Flight Plan</p><h1 id="plan-dash-heading">Planning Hangar, {asText(first)}</h1><p>{open.length} open planned order{open.length === 1 ? '' : 's'} · {units} unit{units === 1 ? '' : 's'}{next ? <> · next need date {asText(next.needDate)} ({asText(next.id)})</> : null}{shorts.length ? <> · {shorts.length} component shortage{shorts.length === 1 ? '' : 's'}</> : null}</p><div className="dash-actions">{skCan('create-wo') ? <button className="btn primary" data-action="plan-create"><Plus size={16}/> Plan from master WI</button> : null}<button className="btn" data-action="nav" data-view="plan-kanban">Kanban <ChevronRight size={16}/></button><button className="btn" data-action="nav" data-view="plan-forecast">MRP forecast <ChevronRight size={16}/></button></div></div></div>
    {groups.length ? <div className="dash-tasks-top"><div className="dash-summary dash-summary-top" role="group" aria-label="Planning items by type">{groups.map(([g, l]) => <button key={g} type="button" className={`dash-card${openG === g ? ' is-open' : ''}`} data-action="dash-toggle" data-group={asText(g)} aria-expanded={openG === g} aria-controls={slug(g)}><span className="dash-count">{l.length}</span><span className="dash-card-label">{asText(g)}<span className="dash-caret" aria-hidden="true"></span></span></button>)}</div>{groups.map(([g, l, kind]) => <section key={g} className="panel dash-group dash-drop" id={slug(g)} aria-labelledby={`${slug(g)}-h`} hidden={openG !== g}><div className="panel-head"><h2 id={`${slug(g)}-h`}>{asText(g)}</h2><span className="mono">{l.length}</span></div><ol className="task-list">{l.map((item, i) => kind === 'short' ? shortRow(item, i) : kind === 'conv' ? convRow(item) : poRow(item))}</ol></section>)}</div> : <div className="panel empty dash-empty"><Check size={16}/><p>No planned orders yet.</p></div>}
    {all.length ? <section className="panel dash-group" aria-labelledby="plan-status-h"><div className="panel-head"><h2 id="plan-status-h">Planned orders by status</h2><span className="mono">{all.length}</span></div><div className="table-wrap" tabIndex="0" role="region" aria-label="Planned orders by status"><table className="data-table"><thead><tr><th scope="col">Status</th><th scope="col">Orders</th><th scope="col">Units</th><th scope="col">Earliest need date</th></tr></thead><tbody>{FlightPlan.STATUSES.map(st => { const l = all.filter(po => po.status === st); const e = byNeed(l)[0]; return <tr key={st}><td><Pill status={st}/></td><td className="mono">{l.length}</td><td className="mono">{l.reduce((n, po) => n + Number(po.quantity || 0), 0)}</td><td className="mono">{e ? asText(e.needDate) : '-'}</td></tr>; })}</tbody></table></div></section> : null}
  </section>;
}

let qmsExportCfgCache = null, qmsExportCfgLoading = false, qmsExportCfgError = '', qmsExportJobsCache = null, qmsExportJobsLoading = false, qmsExportJobsError = '';

function QmsConfig({ state, MES, skCan }) {
  const source = MES.sourceInspectionCodes(state), conformity = MES.conformitySubcodes(state), tests = MES.testSubcodes(state);
  const [, bump] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  if (!skCan('configure-qms')) return <section className="panel"><h1>QMS configuration</h1><p className="inline-info warning">Only a QA Manager or Master Access account can change QMS settings.</p></section>;
  if (window.skServer && window.skServer.active && !qmsExportCfgCache && !qmsExportCfgLoading) { qmsExportCfgLoading = true; window.skServer.api('/record-exports/settings').then(function (r) { qmsExportCfgLoading = false; if (r.ok) { qmsExportCfgCache = r.json; qmsExportCfgError = ''; } else { qmsExportCfgError = (r.json && r.json.error) || 'Record export settings could not be loaded.'; } if (mounted.current) bump(function (n) { return n + 1; }); }).catch(function () { qmsExportCfgLoading = false; qmsExportCfgError = 'Record export settings could not be loaded from the server.'; if (mounted.current) bump(function (n) { return n + 1; }); }); }
  if (window.skServer && window.skServer.active && !qmsExportJobsCache && !qmsExportJobsLoading) { qmsExportJobsLoading = true; window.skServer.api('/record-exports/jobs').then(function (r) { qmsExportJobsLoading = false; if (r.ok) { qmsExportJobsCache = (r.json && r.json.jobs) || []; qmsExportJobsError = ''; } else { qmsExportJobsError = (r.json && r.json.error) || 'Record export history could not be loaded.'; } if (mounted.current) bump(function (n) { return n + 1; }); }).catch(function () { qmsExportJobsLoading = false; qmsExportJobsError = 'Record export history could not be loaded from the server.'; if (mounted.current) bump(function (n) { return n + 1; }); }); }
  const rows = (kind, items) => items.map((item, i) => <fieldset key={i} className="source-code-row"><legend>Sub-code {i + 1}</legend><div className="form-grid"><label className="field">Code<input name="code" maxLength="20" required defaultValue={asText(item.code)}/></label><label className="field">Display name<input name="name" maxLength="100" required defaultValue={asText(item.name)}/></label>{kind === 'source' ? <><label className="field">Notice lead time in days<input name="leadDays" type="number" min="0" max="365" step="1" required defaultValue={item.leadDays}/></label><label className="field wide">Standard notification text<input name="notificationText" maxLength="300" required defaultValue={asText(item.notificationText)}/></label></> : kind === 'conformity' ? <label className="field">SOP reference<input name="reference" maxLength="20" pattern="SOP-[0-9]{3}-[0-9]{3}" required defaultValue={asText(item.reference)}/></label> : <><input type="hidden" name="testAssets" defaultValue="true"/><label className="check-label"><input type="checkbox" name="softwareBaseline" defaultChecked={!!item.softwareBaseline}/><span>Require software baseline</span></label></>}</div></fieldset>);
  const panel = (kind, title, items, help) => <section className="panel"><div className="panel-head"><h2>{title}</h2><span className="pill">{items.length} sub-codes</span></div><p className="small muted">{help}</p><form data-operation-register={kind}><div className="qms-source-codes">{rows(kind, items)}</div><div className="qms-config-add"><button type="button" className="btn" data-qms-add={kind}>Add sub-code</button></div><label className="field wide">Reason for change<textarea name="rationale" maxLength="500" required rows="2"></textarea></label><p className="form-error" data-qms-error role="alert"></p><button type="submit" className="btn primary">Save {title.toLowerCase()}</button></form></section>;
  const sourcePanel = panel('source', 'Source inspection register', source, 'Each code sets its display name, notice lead time, and notification text. Existing work instructions keep their recorded plan.');
  const conformityPanel = panel('conformity', 'Conformity register', conformity, 'Each conformity sub-code carries its governing SOP reference. Parts Conformity uses the existing checklist and approval phases.');
  const testPanel = panel('test', 'Test register', tests, 'ATP, SIL, and HIL operations share test asset and calibration capture. Test configuration does not change external testing or its purchase-order gate.');
  const catalog = MES.trainingCatalog(state).filter(item => item.status === 'Active');
  const tierRows = MES.DISPOSITIONS.map(disposition => <label key={disposition} className="field">{asText(disposition)}<select name="tier" data-disposition={asText(disposition)} defaultValue={MES.mrbTrainingTiers(state)[disposition] || ''}><option value="">Off</option>{catalog.map(item => <option key={item.code} value={asText(item.code)}>{asText(item.code + ' · ' + item.name)}</option>)}</select></label>);
  const mrbTiers = <section className="panel"><div className="panel-head"><h2>MRB training tiers</h2><span className="pill">Off by default</span></div><p className="small muted">MRB seats follow role capabilities. Optionally require additional current training by proposed disposition; when enabled, every voting seat holder must also have the listed training.</p><form data-mrb-training-tiers><div className="form-grid">{tierRows}</div><label className="field wide">Reason for change<textarea name="rationale" maxLength="500" required rows="2"></textarea></label><p className="form-error" data-tier-error role="alert"></p><button type="submit" className="btn primary">Save MRB training tiers</button></form></section>;
  const cfgSettings = (qmsExportCfgCache && qmsExportCfgCache.settings) || [], exportTypes = (qmsExportCfgCache && qmsExportCfgCache.recordTypes) || [];
  const exportForms = exportTypes.map(type => { const current = cfgSettings.find(item => item.recordType === type) || {}, kind = current.destinationKind || 'folder'; return <form key={type} className="panel export-setting-form" data-export-setting={asText(type)}><div className="panel-head"><h3>{asText(type)}</h3><span className="pill">{current.enabled ? 'Enabled' : 'Off'}</span></div><div className="form-grid"><label className="check-label"><input type="checkbox" name="enabled" defaultChecked={!!current.enabled}/><span>Deliver final {asText(type)} records</span></label><label className="field">Destination type<select name="destinationKind" defaultValue={kind}><option value="folder">Server folder</option><option value="https">HTTPS endpoint</option></select></label><label className="field wide">Destination<input name="destination" maxLength="1000" required defaultValue={asText(current.destination || '')} placeholder={kind === 'folder' ? '/srv/flight/exports' : 'https://records.example.com/flight'}/></label><label className="field" data-export-token-field hidden={kind !== 'https'}>Server token setting name<input name="tokenSetting" maxLength="64" pattern="[A-Z][A-Z0-9_]{0,63}" defaultValue={asText(current.tokenSetting || '')} required={kind === 'https'} placeholder="FLIGHT_EXPORT_TOKEN"/></label><label className="field wide">File naming pattern<input name="namingPattern" maxLength="160" required defaultValue={asText(current.namingPattern || `${type}-{recordId}-{exportId}.json`)} title="Include {recordId} and {exportId}; {recordType} is optional."/></label><label className="field wide">Reason for change<textarea name="rationale" minLength="3" maxLength="500" required rows="2" placeholder="Why this destination or delivery setting changed"></textarea></label></div><p className="small muted">Secrets stay in the server environment. Enter only the environment setting name; never enter a token value here.</p><p className="form-error" data-export-error role="alert"></p><button className="btn primary" type="submit">Save {asText(type)} export settings</button></form>; });
  const exportsPanel = <section className="panel"><div className="panel-head"><h2>Final record delivery</h2><span className="pill">Server managed</span></div><p className="small muted">Each final record is queued after its transaction commits. Delivery is immutable, hashed, retried up to three times, and logged. Folder paths refer to the server. Failed deliveries can be retried in the delivery log.</p>{!window.skServer?.active ? <p className="inline-info warning">Configure delivery from an authenticated Flight System server. Browser-only installations cannot store server destinations.</p> : qmsExportCfgLoading ? <p className="muted">Loading server export settings…</p> : qmsExportCfgError ? <p className="inline-info warning" role="alert">{asText(qmsExportCfgError)}</p> : exportForms.length ? exportForms : <p className="muted">No record types are available.</p>}</section>;
  const jobRows = (qmsExportJobsCache || []).map(job => <tr key={job.id}><td className="mono">{asText(job.exportId)}</td><td>{asText(job.recordType)} · <span className="mono">{asText(job.recordId)}</span></td><td><span className={`pill ${job.status === 'delivered' ? 'closed' : job.status === 'failed' ? 'high' : 'kitting'}`}>{asText(job.status)}</span></td><td>{job.attempts} / 3</td><td className="mono">{asText(job.sha256)}</td><td>{job.status === 'failed' ? <button className="btn quiet small" type="button" data-export-retry={asText(job.id)}>Retry</button> : null}{job.lastError ? <small className="form-error">{asText(job.lastError)}</small> : null}</td></tr>);
  const jobsPanel = <section className="panel"><div className="panel-head"><h2>Delivery history</h2><span className="pill">{(qmsExportJobsCache || []).length} recent</span></div>{!window.skServer?.active ? <p className="small muted">Available from the authenticated server.</p> : qmsExportJobsLoading ? <p className="muted">Loading delivery history…</p> : qmsExportJobsError ? <p className="inline-info warning" role="alert">{asText(qmsExportJobsError)}</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Export ID</th><th>Record</th><th>Status</th><th>Attempts</th><th>SHA-256</th><th>Action</th></tr></thead><tbody>{jobRows.length ? jobRows : <tr><td colSpan="6" className="muted">No final records have been queued for delivery.</td></tr>}</tbody></table></div>}</section>;
  const history = (state.qmsConfig && state.qmsConfig.history) || [];
  return <section className="qms-config-page"><div className="page-heading"><div><p className="hero-eyebrow">Flight Maneuver · Quality system</p><h1>QMS configuration</h1></div></div>{sourcePanel}{conformityPanel}{testPanel}{mrbTiers}{exportsPanel}{jobsPanel}<section className="panel"><div className="panel-head"><h2>Configuration history</h2></div>{history.length ? history.slice().reverse().map((item, i) => <p key={i} className="small">{legacyDateTime(item.at)} · {asText(item.by.name)} · {asText(item.rationale)}</p>) : <p className="muted">No configuration changes recorded.</p>}</section></section>;
}

function AIGovernance({ state, MES }) {
  const model = state.modelAdapter || { enabled: false, provider: '', settingName: '' }, log = (state.aiActionLog || []).slice().reverse().slice(0, 10), canConfigure = !!(window.skAuth && window.skAuth.role && ['qm', 'admin'].includes(window.skAuth.role()));
  const drafts = (state.aiSkillDrafts || []).slice().reverse().slice(0, 6); const triggers = state.aiSkillTriggers || [];
  return <section className="panel"><div className="panel-head"><h2>AI governance</h2><button className="btn quiet" type="button" data-ai-governance-export>Export ISO/IEC 42001 evidence</button></div><p className="small muted">Model adapter: <strong>{model.enabled ? 'Enabled' : 'Off'}</strong>{model.provider ? <> · {asText(model.provider)} · server setting {asText(model.settingName)}</> : null}. Flight approvals and signatures remain person-controlled.</p>{canConfigure ? <form data-ai-model-config><div className="form-grid"><label className="field">Model adapter<select name="enabled" defaultValue={model.enabled ? 'true' : 'false'}><option value="false">Off</option><option value="true">On</option></select></label><label className="field">Provider<input name="provider" maxLength="80" defaultValue={asText(model.provider || '')} placeholder="Approved provider"/></label><label className="field">Server environment-setting name<input name="settingName" maxLength="64" defaultValue={asText(model.settingName || '')} placeholder="MODEL_API_KEY"/></label><label className="field wide">Rationale<textarea name="rationale" minLength={8} maxLength={500} rows="2" required placeholder="Approved model use, validation and data-flow review"></textarea></label></div><p className="small muted">Enter the environment variable name only. Never enter a key or secret value here. Enabling requires a configured server adapter.</p><button className="btn" type="submit">Save model configuration</button><p className="access-add-error" role="alert" data-ai-model-error></p></form> : <p className="small muted">Only QA Manager and Master Access accounts can change model adapter settings.</p>}<div className="panel-head"><h3>AI risk register</h3><span className="pill">{MES.AI_RISK_REGISTER.length} controls</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Risk</th><th>Tool</th><th>Impact</th><th>Control</th></tr></thead><tbody>{MES.AI_RISK_REGISTER.map(item => <tr key={item.id}><td>{asText(item.id)}</td><td>{asText(item.tool)}</td><td>{asText(item.impact)}</td><td>{asText(item.controls)}</td></tr>)}</tbody></table></div><h3>Hash-chained AI action log</h3><p className="small muted">{(state.aiActionLog || []).length} actions · chain {MES.verifyAIActionLog(state).ok ? 'intact' : 'invalid'}</p>{log.length ? <ul>{log.map(item => <li key={item.id}><strong>{asText(item.id)} · {asText(item.skill)} v{asText(item.version)}</strong> · {asText(item.method)} · {asText(item.by.name)} · {legacyDateTime(item.at)} · SHA-256 {asText(item.hash)}</li>)}</ul> : <p className="muted">No automated runs recorded.</p>}<h3>Governance procedures</h3><ul>{MES.AI_GOVERNANCE_PROCEDURES.map(item => <li key={item.id}><strong>{asText(item.id)}</strong> · {asText(item.title)} · <span className="mono">{asText(item.path)}</span></li>)}</ul><p className="small muted">Draft copies are in the source package under qms/governance/. Import and release them through the controlled document register before using them as effective procedures.</p><div className="panel-head"><h3>Approved analysis skills</h3><span className="pill">{MES.FLIGHT_SKILLS.length} skills</span></div><form data-flight-skill-run><div className="form-grid"><label className="field">Skill<select name="skill" required>{MES.FLIGHT_SKILLS.map(skill => <option key={skill.key} value={asText(skill.key)}>{asText(skill.title)}</option>)}</select></label><label className="field wide">Input JSON<textarea name="input" rows={3} required placeholder='{"problem":"Describe the record question","targetRefs":["NC-0001"]}'></textarea></label><label className="field wide">Reason<textarea name="reason" rows={2} required minLength={8} maxLength={300} placeholder="Why this analysis is needed"></textarea></label></div><button className="btn primary" type="submit">Create analysis draft</button><p className="small muted">Manager-enabled triggers run on compatible events after successful source actions. Trigger runs create review-only drafts and identical inputs are deduplicated.</p><p role="alert" data-flight-skill-error></p></form>{canConfigure ? <><h3>Manager-controlled skill triggers</h3><form data-flight-skill-trigger><div className="form-grid"><label className="field">Skill<select name="skill">{MES.FLIGHT_SKILLS.map(skill => <option key={skill.key} value={asText(skill.key)}>{asText(skill.title)}</option>)}</select></label><label className="field">Event<select name="event"><option value="manual">Manual review</option><option value="nc-raised">NC raised</option><option value="car-raised">CAR raised</option><option value="car-verified">CAR verified</option><option value="fair-approved">FAIR approved</option><option value="wi-released">WI released</option></select></label><label className="field">State<select name="enabled"><option value="false">Off</option><option value="true">On</option></select></label><label className="field">Existing trigger<select name="id"><option value="">New trigger</option>{triggers.map(t => <option key={t.id} value={asText(t.id)}>{asText(t.id)} · {asText(t.skill)} · {t.enabled ? 'On' : 'Off'}</option>)}</select></label><label className="field wide">Rationale<textarea name="rationale" required minLength={8} maxLength={500}></textarea></label></div><button className="btn" type="submit">Save skill trigger</button></form></> : null}<h3>Analysis drafts</h3>{drafts.length ? drafts.map(d => <article key={d.id} className="qms-record-card"><h4>{asText(d.id)} · {asText(d.title)}</h4><p>{asText(d.status)} · {asText(d.reason)}</p><pre>{asText(JSON.stringify(d.body, null, 2))}</pre>{d.status === 'Draft' ? <form data-flight-skill-edit={asText(d.id)}><label className="field">Edit verified analysis JSON<textarea name="body" rows={4} required defaultValue={JSON.stringify(d.body, null, 2)}></textarea></label><label className="field">Edit rationale<textarea name="rationale" minLength={8} maxLength={300} required></textarea></label><button className="btn quiet" type="submit">Save analysis edits</button><button className="btn" type="button" data-flight-skill-review={asText(d.id)}>Review draft</button></form> : null}{d.status === 'Reviewed' ? <button className="btn primary" data-flight-skill-accept={asText(d.id)}>Accept analysis</button> : null}</article>) : <p className="muted">No analysis drafts.</p>}<p className="small muted">Acceptance records human review only. The target record and its approval state never change through skill acceptance. Drafts containing [confirm] placeholders cannot be accepted.</p></section>;
}

function ControlledDocumentBlock({ state, MES }) {
  const docs = Array.isArray(state.controlledDocuments) ? state.controlledDocuments : [], released = docs.filter(doc => doc.status === 'Released');
  const rows = docs.slice().reverse().map(doc => <article key={doc.id} className="panel qms-record-card"><div className="panel-head"><div><h3>{asText(doc.documentNumber)} · {asText(doc.title)} · Rev {asText(doc.revision)}</h3><p className="small muted">{asText(doc.kind)} · {asText(doc.status)} · SHA-256 {asText(doc.file.sha256)}</p><p className="small muted">Author {asText(doc.author.name)}{doc.reviewer ? <> · Reviewer {asText(doc.reviewer.name)}</> : null}{doc.releaser ? <> · Released by {asText(doc.releaser.name)}</> : null}</p></div><span className={`pill ${doc.status === 'Released' ? 'closed' : 'kitting'}`}>{asText(doc.status)}</span></div><div className="media-actions"><button className="btn quiet" type="button" data-controlled-doc-download={asText(doc.id)}>Download verified file</button>{doc.status === 'Draft' ? <button className="btn" type="button" data-controlled-doc-review={asText(doc.id)}>Sign review</button> : null}{doc.status === 'Reviewed' ? <button className="btn primary" type="button" data-controlled-doc-release={asText(doc.id)}>Sign release</button> : null}</div></article>);
  const revisionOptions = released.map(doc => <option key={doc.id} value={asText(doc.id)}>{asText(doc.documentNumber)} Rev {asText(doc.revision)} · {asText(doc.title)}</option>);
  return <section className="panel"><div className="panel-head"><h2>Controlled documents</h2><span className="pill">{docs.length} revisions</span></div><p className="small muted">Each revision keeps its signed author, review, release, file, and SHA-256 record. The author, reviewer, and releaser must be three different people.</p><form data-controlled-document="create"><div className="form-grid"><label className="field">Document number<input name="documentNumber" maxLength="40" required placeholder="SOP-750-001"/></label><label className="field">Title<input name="title" maxLength="160" minLength="3" required/></label><label className="field">Kind<select name="kind"><option value="procedure">Procedure</option><option value="SOP">SOP</option><option value="form">Form</option></select></label><label className="field wide">File<input name="file" type="file" required/></label></div><p className="small muted">PDF or other source file, maximum 2 MiB. A new document starts at revision A.</p><button className="btn primary" type="submit">Author document</button><p className="access-add-error" role="alert" data-controlled-doc-error></p></form>{revisionOptions.length ? <form data-controlled-document="revision"><div className="form-grid"><label className="field">Released document<select name="documentId" required>{revisionOptions}</select></label><label className="field">New revision title<input name="title" maxLength="160" minLength="3" required/></label><label className="field wide">Revised file<input name="file" type="file" required/></label></div><button className="btn" type="submit">Start next revision</button><p className="access-add-error" role="alert" data-controlled-doc-error></p></form> : null}{rows.length ? rows : <p className="muted">No controlled documents recorded.</p>}</section>;
}

// A correction of the current entry for a tag (MES.updateCalibration through the page's [data-qms-calibration-correct]
// handler). It appends a signed superseding entry; returning a retired tool to service needs the reason in the note.
function CalibrationCorrection({ row }) {
  return <details className="resolve-details"><summary>Correct this entry</summary><form data-qms-calibration-correct={asText(row.id)}><div className="form-grid"><label className="field">Description<input name="description" maxLength="80" required defaultValue={asText(row.description)}/></label><label className="field">Serial number<input name="serial" maxLength="40" defaultValue={asText(row.serial)}/></label><label className="field">Calibrated on<input name="calibratedAt" type="date" required defaultValue={asText(row.calibratedAt)}/></label><label className="field">Due date<input name="expires" type="date" required defaultValue={asText(row.expires)}/></label><label className="field">Status<select name="status" defaultValue={asText(row.status)}><option>In Calibration</option><option>Out for Calibration</option><option>Quarantined</option><option>Retired</option></select></label><label className="field">Location<input name="location" maxLength="80" defaultValue={asText(row.location)}/></label><label className="field wide">Note or reason<input name="note" maxLength="300" defaultValue={asText(row.note)}/></label></div><p className="small muted">The correction is signed and appended; {asText(row.id)} stays in the log. To return a retired tool to service, give the reason in the note.</p><button className="btn" type="submit">Sign correction</button></form></details>;
}

// The calibration log and its record form (MES.recordCalibration). The page's [data-qms-record] submit handler records
// the entry, so this matches the legacy renderQmsRecords markup field for field.
function CalibrationLog({ state, MES }) {
  const log = Array.isArray(state.calibrationLog) ? state.calibrationLog : [];
  const superseded = new Set(log.map(e => e && e.supersedes).filter(Boolean));
  const canCorrect = !!(window.skAuth && window.skAuth.can && window.skAuth.can('configure-qms'));
  const isCurrent = row => { const cur = MES.calibrationStatus(state, row.tag); return !!cur && cur.id === row.id; };
  const rows = log.slice().reverse().map(row => <li key={row.id}><strong>{asText(row.id)}</strong> · {asText(row.tag)} · {asText(row.description)} · due {asText(row.expires)} <span className={`pill ${row.status === 'In Calibration' ? 'closed' : 'high'}`}>{asText(row.status)}</span>{row.supersedes ? <> <span className="muted">corrects {asText(row.supersedes)}</span></> : null}{superseded.has(row.id) ? <> <span className="muted">superseded</span></> : null}<br/><span className="muted">Recorded by {asText(row.recordedBy)} · {legacyDateTime(row.recordedAt)} · SHA-256{row.note ? ' · ' + asText(row.note) : ''}</span>{canCorrect && isCurrent(row) ? <CalibrationCorrection row={row}/> : null}</li>);
  return <section className="panel"><div className="panel-head"><h2>Calibration log</h2><span className="pill">{log.length} records</span></div><form data-qms-record="calibration"><div className="form-grid"><label className="field">Tool asset tag<input name="tag" maxLength="40" required placeholder="CAL-022"/></label><label className="field">Description<input name="description" maxLength="80" required placeholder="DIGITAL CALIPER"/></label><label className="field">Serial number<input name="serial" maxLength="40"/></label><label className="field">Calibrated on<input name="calibratedAt" type="date" required/></label><label className="field">Due date<input name="expires" type="date" required/></label><label className="field">Status<select name="status"><option>In Calibration</option><option>Out for Calibration</option><option>Quarantined</option><option>Retired</option></select></label><label className="field">Location<input name="location" maxLength="80" placeholder="Production Floor"/></label><label className="field wide">Note<input name="note" maxLength="300" placeholder="Certificate reference or lab"/></label></div><p className="small muted">New entries supersede the shipped tool snapshot at point of use. A correction appends a new superseding entry; the original stays in the log. Entries are never deleted: to take a tool out of use for good, record it as Retired.</p><button className="btn primary" type="submit">Record calibration</button></form><ul>{rows.length ? rows : <li className="muted">No calibrations recorded.</li>}</ul></section>;
}

function QmsRecords({ state, MES }) {
  const audits = (state.audits || []).slice().reverse().map(audit => <article key={audit.id} className="panel qms-record-card"><div className="panel-head"><div><h3>{asText(audit.id)} · {asText(audit.scope)}</h3><p className="small muted">Opened {legacyDateTime(audit.openedAt || (audit.findings && audit.findings[0] && audit.findings[0].openedAt) || '')} by {asText(audit.openedBy && audit.openedBy.name || '')}</p></div><span className={`pill ${audit.status === 'Closed' ? 'closed' : 'high'}`}>{asText(audit.status)}</span></div><ul>{(audit.findings || []).map(finding => <li key={finding.id}><strong>{asText(finding.id)}</strong> · {asText(finding.text)} <span className={`pill ${finding.status === 'Closed' ? 'closed' : 'kitting'}`}>{asText(finding.status)}</span>{finding.status === 'Open' ? <button className="btn quiet small" data-audit-close-finding={asText(audit.id)} data-finding={asText(finding.id)}>Sign finding closed</button> : null}{finding.closer ? <small className="muted">Closed by {asText(finding.closer.name)} · {legacyDateTime(finding.closedAt)}</small> : null}</li>)}</ul>{audit.status === 'Open' ? ((audit.findings || []).every(f => f.status === 'Closed') ? <button className="btn" data-audit-close={asText(audit.id)}>Sign audit closed</button> : <p className="small muted">Close every finding before closing this audit. The audit author cannot close it.</p>) : null}</article>);
  const certifications = (state.certifications || []).slice().reverse().map(row => <li key={row.id}><strong>{asText(row.id)}</strong> · {asText(row.statement)} <span className="muted">Signed by {asText(row.by.name)} · {legacyDateTime(row.at)} · SHA-256</span></li>);
  const suppliers = (state.supplierApprovals || []).slice().reverse().map(row => <li key={row.id}><strong>{asText(row.id)}</strong> · {asText(row.supplier)} · {asText(row.decision)} <span className="muted">Signed by {asText(row.by.name)} · {legacyDateTime(row.at)} · SHA-256</span></li>);
  const values = (state.qualityValues || []).slice().reverse().map(row => <option key={row.id} value={asText(row.id)} data-kind={asText(row.kind)}>{asText(row.id)} · {asText(row.kind)} · {asText(row.value)}{row.name ? ' · ' + asText(row.name) : ''}</option>);
  const verdicts = (state.qualityVerdicts || []).slice().reverse().map(row => <li key={row.id}><strong>{asText(row.id)}</strong> · {asText(row.kind)} {asText(row.value)} · {asText(row.verdict)} <span className="muted">Signed by {asText(row.by.name)} · {legacyDateTime(row.at)} · SHA-256</span></li>);
  return <section className="qms-config-page"><div className="page-heading"><div><p className="hero-eyebrow">Flight Maneuver · Quality system</p><h1>System QMS records</h1><p className="lede">Audits, controlled documents, supplier approvals, certifications, recorded quality study results, and the calibration log. Signatures and content hashes are checked by the Flight record verifier.</p></div></div><AIGovernance state={state} MES={MES}/><section className="panel"><div className="panel-head"><h2>Audits</h2><span className="pill">{(state.audits || []).length} records</span></div><form data-qms-record="audit"><div className="form-grid"><label className="field">Audit scope<input name="scope" maxLength="200" minLength="3" required placeholder="Internal process audit"/></label><label className="field wide">Findings<textarea name="findings" rows="3" required placeholder="One finding per line"></textarea></label></div><p className="small muted">The person who records a finding cannot close it. A different person signs each closure.</p><button className="btn primary" type="submit">Open audit</button></form>{audits.length ? audits : <p className="muted">No audits recorded.</p>}</section><ControlledDocumentBlock state={state} MES={MES}/><CalibrationLog state={state} MES={MES}/><div className="form-grid qms-record-columns"><section className="panel"><div className="panel-head"><h2>Certifications</h2><span className="pill">{(state.certifications || []).length}</span></div><form data-qms-record="certification"><label className="field">Certification statement<textarea name="statement" minLength="5" maxLength="300" required rows="3" placeholder="What this certification covers"></textarea></label><button className="btn primary" type="submit">Sign certification</button></form><ul>{certifications.length ? certifications : <li className="muted">No certifications recorded.</li>}</ul></section><section className="panel"><div className="panel-head"><h2>Supplier approvals</h2><span className="pill">{(state.supplierApprovals || []).length}</span></div><form data-qms-record="supplier"><label className="field">Supplier name<input name="supplier" minLength="2" maxLength="120" required/></label><button className="btn primary" type="submit">Sign supplier approval</button></form><ul>{suppliers.length ? suppliers : <li className="muted">No supplier approvals recorded.</li>}</ul></section></div><section className="panel"><div className="panel-head"><h2>Quality study values and verdicts</h2><span className="pill">The app records values; it does not calculate them.</span></div><div className="form-grid qms-record-columns"><form data-qms-record="quality-value"><label className="field">Study type<select name="kind"><option value="gage">Gage</option><option value="capability">Capability</option><option value="sampling">Sampling</option></select></label><label className="field">Computed value<input name="value" type="number" step="any" required/></label><label className="field">Study or characteristic name<input name="name" maxLength="80"/></label><button className="btn" type="submit">Store computed value</button></form><form data-qms-record="quality-verdict"><label className="field">Stored study value<select name="valueId" required><option value="">Choose a value</option>{values}</select></label><label className="field">Verdict<input name="verdict" minLength="2" maxLength="80" required placeholder="Acceptable"/></label><p className="small muted">A verdict cites the stored result and is signed as a separate record.</p><button className="btn primary" type="submit">Sign verdict</button></form></div><ul>{verdicts.length ? verdicts : <li className="muted">No signed verdicts recorded.</li>}</ul></section></section>;
}

const slackMark = () => <svg className="slack-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#E01E5A" d="M5.1 15.2a2.1 2.1 0 1 1-2.1-2.1h2.1v2.1Zm1.1 0a2.1 2.1 0 0 1 4.2 0v5.3a2.1 2.1 0 0 1-4.2 0v-5.3Z"/><path fill="#36C5F0" d="M8.3 6.7a2.1 2.1 0 1 1 2.1-2.1v2.1H8.3Zm0 1.1a2.1 2.1 0 0 1 0 4.2H3a2.1 2.1 0 0 1 0-4.2h5.3Z"/><path fill="#2EB67D" d="M18.9 8.8a2.1 2.1 0 1 1 2.1 2.1h-2.1V8.8Zm-1.1 0a2.1 2.1 0 0 1-4.2 0V3.5a2.1 2.1 0 0 1 4.2 0v5.3Z"/><path fill="#ECB22E" d="M15.7 17.3a2.1 2.1 0 1 1-2.1 2.1v-2.1h2.1Zm0-1.1a2.1 2.1 0 0 1 0-4.2H21a2.1 2.1 0 0 1 0 4.2h-5.3Z"/></svg>;

const skActorId = state => (window.skAuth && window.skAuth.actor() && window.skAuth.actor().credentialId) || state.profile.credentialId;
const orderBlocked = (MES, o) => MES.blockingTickets(o).length > 0 || !!MES.engineeringChange(o);
const doneCount = o => o.operations.filter(op => op.done).length;
const currentIndex = o => { const i = o.operations.findIndex(op => !op.done); return i < 0 ? o.operations.length - 1 : i; };
const sequence = n => String((n + 1) * 10).padStart(3, '0');
const operationNumber = (o, opId) => sequence(o.operations.findIndex(op => op.id === opId));
const openTickets = (o, opId) => o.tickets.filter(t => t.status === 'Open' && (!opId || t.operationId === opId));

function ncHoldStage(state, o, t) {
  const base = `ME disposition ${t.dispo.decision}, awaiting Quality approval`;
  try {
    const FM = window.FlightManeuver;
    if (!FM || !FM.needsMRB(o, t)) return base;
    const m = FM.mrbFor(state, o.id, t.id);
    if (!m) return `${t.dispo.decision} on ${o.pedigree} pedigree: a Material Review Board decision is required before Quality can approve`;
    if (m.status === 'Open') { const waiting = FM.seatsOf(m).filter(s => !m.votes.some(v => v.seat === s)); return `${m.id} open${waiting.length ? ` · waiting on ${waiting.join(', ')}` : ' · all seats voted, Quality records the decision'}`; }
    if (m.status === 'Rejected') return `${m.id} rejected ${m.proposed} · ME records a new disposition`;
    if (m.proposed !== t.dispo.decision) return `${m.id} approved ${m.proposed}, but the ticket now proposes ${t.dispo.decision} · convene a new board`;
    return `${m.id} approved ${m.proposed} · Quality can now approve ${t.id} to lift this hold`;
  } catch (error) { return base; }
}

function aogBanner(MES, o) {
  if (!MES.aogActive(o)) return null;
  const aog = o.aog || {}, post = aog.lastPost;
  return <section className="aog-banner" role="alert">
    <div className="aog-head">
      <Shield size={16}/>
      <div>
        <strong>AOG · escalation every 2 hours</strong>
        <p>{aog.notified || 0} escalation{(aog.notified || 0) === 1 ? '' : 's'} added to <strong>{asText(MES.AOG_THREAD.label)}</strong>{aog.lastNotifiedAt ? ` · last ${legacyDateTime(aog.lastNotifiedAt)}` : ''}{aog.nextNotifyAt ? ` · next ${legacyDateTime(aog.nextNotifyAt)}` : ''}.</p>
      </div>
      {post ? <button className="btn slack-btn" data-action="operation" data-op={asText(post.operationId)}>{slackMark()}<span>Open the thread</span></button> : null}
      <button className="btn" data-action="aog-resolve">Clear AOG</button>
    </div>
    <p className="small">Escalations are posted to the {asText(MES.AOG_THREAD.label)} thread on the current operation and recorded here. Copy the text into your AOG channel.</p>
    <details className="aog-message">
      <summary>Broadcast text</summary>
      <textarea id="aog-text" className="mono ns-code" readOnly rows="6" defaultValue={asText(MES.aogMessage(o))}/>
      <div className="aog-actions"><button className="btn" data-action="copy-text" data-target="aog-text">Copy message</button></div>
    </details>
  </section>;
}

function splitChips(o) {
  const parts = [];
  if (o.splitFrom) parts.push(<button key={`from-${o.splitFrom}`} className="wi-ref" data-action="open-order" data-order={asText(o.splitFrom)}><Layers size={16}/> Split from {asText(o.splitFrom)}</button>);
  if (Array.isArray(o.splitInto) && o.splitInto.length) o.splitInto.forEach(id => parts.push(<button key={`into-${id}`} className="wi-ref" data-action="open-order" data-order={asText(id)}><Layers size={16}/> {asText(id)}</button>));
  return parts;
}

function pedigreeChips(state, o, skCan) {
  const c = o.pedigreeChange;
  if (!c) return null;
  const actorId = skActorId(state);
  const mine = c.approvals.some(a => a.credentialId === actorId);
  const myRole = window.skAuth ? window.skAuth.role() : null;
  const roleTaken = c.approvals.some(a => a.discipline === myRole);
  const canApprove = skCan('approve-pedigree') && !mine && !roleTaken;
  return <div className="pedigree-pending inline-info" role="status">
    <Shield size={16}/>
    <p><strong>Pedigree change {asText(c.from)} → {asText(c.to)} · {c.approvals.length} of 2 approvals</strong><br/>{asText(c.reason)}<br/><span className="small">Requested by {asText(c.requestedBy.name)}. {c.approvals.length ? `Approved by ${c.approvals.map(a => `${asText(a.name)} (${asText(a.discipline)})`).join(', ')}. ` : null}Second approval must come from a different discipline; General User accounts cannot approve.</span></p>
    {canApprove ? <button className="btn primary" data-action="pedigree-approve">Approve pedigree change</button> : mine ? <span className="pill ready">You approved</span> : roleTaken ? <span className="pill missing">Needs another discipline</span> : null}
  </div>;
}

function closureBanner(state, o, skCan) {
  const r = o.closureRequest;
  if (!r) return o.closure ? <div className="inline-info closure-info" role="status"><Lock size={16}/><p><strong>Closed as {asText(o.closure.reason)}{o.closure.ticket ? ` · ${asText(o.closure.ticket.ticketId)}` : null}</strong><br/>{asText(o.closure.note)}<br/><span className="small">Requested by {asText(o.closure.requestedBy?.name || '')} · approved by {asText(o.closure.approvedBy?.name || '')}</span></p></div> : null;
  const me = window.skAuth?.actor?.();
  const canDecide = skCan('approve-wo') && me && r.requestedBy?.credentialId !== me.credentialId;
  return <div className="pedigree-pending inline-info closure-pending" role="status">
    <Shield size={16}/>
    <p><strong>Closure requested · {asText(r.reason)}{r.ticket ? ` · ${asText(r.ticket.ticketId)}` : null}</strong><br/>{asText(r.note)}<br/><span className="small">Requested by {asText(r.requestedBy?.name || '')}. Needs Quality approval from a different person.</span></p>
    {canDecide ? <button className="btn primary" data-action="closure-decide">Review closure</button> : null}
    {r.requestedBy?.credentialId === skActorId(state) ? <button className="btn" data-action="reject-item" data-kind="closure-withdraw">Withdraw request</button> : null}
  </div>;
}

function revStrip(MES, state, o) {
  const log = (state.serialLog || []).filter(e => e.orderId === o.id);
  const live = log.filter(e => e.status !== 'Voided').map(e => e.serial);
  const dead = log.filter(e => e.status === 'Voided').map(e => e.serial);
  const all = [...live, ...dead.map(x => x + ' (voided)')];
  const shown = all.length ? all[0] : 'None assigned';
  return <div className="rev-strip" aria-label="Work order revisions">
    {o.plannedOrder ? <button type="button" className="rev-chip rev-chip-action" data-action="open-plan" data-plan={asText(o.plannedOrder.id)} title="Open in Flight Plan"><small>Planned order</small><strong className="mono">{asText(o.plannedOrder.id)}</strong></button> : null}
    <span className="rev-chip"><small>Drawing rev</small><strong className="mono">{asText(o.drawingRev || '-')}</strong></span>
    <span className="rev-chip"><small>WI rev</small><strong className="mono">{asText(o.wiRev || '-')}</strong></span>
    <button type="button" className="rev-chip rev-chip-action" data-action="tab" data-tab="record"><small>WO rev</small><strong className="mono">{asText(MES.woRevLabel(o.woRev || 'Baseline'))}</strong></button>
    <span className="rev-chip wo-fact"><small>WO qty</small><strong className="mono">{asText(o.quantity)}</strong></span>
    {all.length > 1
      ? <details className="rev-chip wo-fact wo-serials wo-serial-list"><summary aria-label={`Show the ${all.length} serial numbers on this work order`}><small>Serials ({all.length})</small><strong className="mono">Multiple</strong></summary><ul className="serial-pop">{all.map((x, i) => <li key={i} className="mono">{asText(x)}</li>)}</ul></details>
      : <span className="rev-chip wo-fact wo-serials"><small>Serial</small><strong className="mono">{asText(shown)}</strong></span>}
    <span className="rev-chip wo-fact"><small>Category</small><strong>{asText(o.pedigree || '-')}</strong></span>
    {(o.fai && o.fai.required) || o.subcategory === 'FAI'
      ? <button type="button" className="rev-chip rev-chip-action wo-fact" data-action="goto-fair" title="Open the AS9102 FAIR on the Quality tab"><small>Subcategory · FAIR {o.fair ? asText(o.fair.status === 'Approved' ? 'approved' : o.fair.status) : 'not started'}</small><strong>{asText(String(o.subcategory || '-'))} <ChevronRight size={16}/></strong></button>
      : <span className="rev-chip wo-fact"><small>Subcategory</small><strong>{asText(String(o.subcategory || '-'))}</strong></span>}
  </div>;
}

function qualityBanner(MES, o) {
  const tickets = openTickets(o), held = MES.blockingTickets(o);
  if (!tickets.length) return null;
  return <div className={`quality-banner${held.length ? ' hold-banner' : ''}`}>
    <Shield size={16}/>
    <div><strong>{held.length ? 'Work order flagged · Quality hold' : 'Work order flagged · NC open'}</strong><p>{tickets.length} open {tickets.length === 1 ? 'ticket' : 'tickets'}{held.length ? ' · Operation buy-off or handoff restricted by the linked hold.' : ' · Flagged for review; no operation hold selected.'}</p></div>
    <button className="btn" data-action="tab" data-tab="quality">View {tickets.length === 1 ? 'ticket' : 'tickets'} <ChevronRight size={16}/></button>
  </div>;
}

function holdActionButtons(MES, state, o, h, skCan) {
  const me = skActorId(state);
  const out = [];
  if (/^Engineering change/.test(h.label)) { const ec = MES.engineeringChange(o); if (skCan('approve-wo')) out.push(['ec-reject', 'Reject']); if (ec && ec.requestedBy?.credentialId === me) out.push(['ec-withdraw', 'Withdraw']); }
  if (/^Operation sequence change/.test(h.label)) { const sc = MES.pendingSequenceChange(o); if (skCan('approve-wo')) out.push(['seq-reject', 'Reject']); if (sc && sc.entries.some(e => e.by?.credentialId === me)) out.push(['seq-withdraw', 'Withdraw']); }
  if (/^Pedigree change/.test(h.label)) { if (skCan('approve-pedigree')) out.push(['pedigree-reject', 'Reject']); if (o.pedigreeChange?.requestedBy?.credentialId === me) out.push(['pedigree-withdraw', 'Withdraw']); }
  return out.map(([k, l]) => <button key={k} type="button" className="btn quiet hold-act" data-action="reject-item" data-kind={k}>{l}</button>);
}

function shellReleaseSummary(MES, o, holdFlash) {
  if (!o.creationVersion && o.status !== 'Draft' && !o.sourceTicket) return null;
  const approval = MES.releaseApproval(o), required = MES.requiresReleaseQA(o);
  if (!required) return null;
  return <section className={`release-summary${holdFlash ? ' hold-flash' : ''}`} aria-label="Work order release">
    <div><strong>{required ? (approval ? 'QA release approved' : 'QA approval required before issue') : 'QA approval not required before issue'}</strong><p className="small muted">{approval ? `${asText(approval.name)} · ${asText(approval.role)} · ${asText(approval.credentialId)} · ${legacyDateTime(approval.at)}` : required ? 'Approval covers this part, revision, quantity, pedigree, subcategory, site, and source ticket.' : 'Exempt under the selected pedigree and subcategory. Final review and quality holds still apply.'}</p></div>
    {o.sourceTicket ? <button className="btn" data-action="source-ticket" data-source-order={asText(o.sourceTicket.orderId)} data-source-ticket={asText(o.sourceTicket.ticketId)}>Linked {asText(o.sourceTicket.ticketId)} <ExternalLink size={16}/></button> : null}
  </section>;
}

function orderHolds(MES, state, o) {
  const H = [], opn = id => operationNumber(o, id), add = (sev, label, detail, go) => H.push({ sev, label, detail, go });
  if (o.status === 'Closed') return H;
  if (o.status === 'Draft' && MES.requiresReleaseQA(o) && !MES.releaseApproval(o)) add('hold', 'QA release approval required', 'Must be approved before the work order is issued to kitting.', { tab: 'record' });
  const ec = MES.engineeringChange(o);
  if (ec) add('hold', `Engineering change ${ec.id} · ${ec.status}`, ec.needsECR ? `${ec.ecrId} and QA re-release required. Work is paused.` : 'QA re-release required. Work is paused.', { tab: 'record' });
  const sc = MES.pendingSequenceChange?.(o);
  if (sc) {
    const linked = new Set((o.tickets || []).filter(t => t.status === 'Open' && t.reworkPlan && t.reworkPlan.opId).map(t => t.reworkPlan.opId));
    const own = (sc.entries || []).filter(e => !linked.has(e.opId));
    if (own.length || !(sc.entries || []).length) add('hold', 'Operation sequence change awaiting QA release', `${own.length || 1} change${(own.length || 1) === 1 ? '' : 's'}. Step check-offs and buy-offs are blocked.`, { tab: 'operations' });
  }
  (o.tickets || []).filter(t => t.status === 'Open').forEach(t => {
    const p = t.reworkPlan;
    const stage = p ? (p.stage === 'Awaiting ME operation' ? `${p.decision} approved, awaiting ME ${p.decision.toLowerCase()} operation` : `${p.decision} Op ${opn(p.opId)} awaiting QA release · step check-offs and buy-offs are blocked`) : t.dispo ? ncHoldStage(state, o, t) : (t.dispoReturns || []).length ? 'Returned by Quality, awaiting ME re-disposition' : 'Awaiting ME disposition';
    add(t.hold ? 'hold' : 'flag', `${t.id} ${t.hold ? 'hold' : 'flag'} on Op ${opn(t.operationId)} · ${t.title}`, stage, { tab: 'quality', ticket: t.id });
  });
  (o.splitRequests || []).filter(r => r.status === 'Open').forEach(r => add('flag', `Split request ${r.id}`, `${r.quantity} of ${r.of} units${r.serials?.length ? ` (${r.serials.join(', ')})` : ''} for ${r.ticketId}`, { tab: 'quality', ticket: r.ticketId }));
  if (o.pedigreeChange) add('hold', `Pedigree change ${o.pedigreeChange.from} → ${o.pedigreeChange.to}`, `${(o.pedigreeChange.approvals || []).length} of 2 approvals recorded.`, { tab: 'record' });
  if (o.closureRequest) add('flag', `Closure requested as ${o.closureRequest.reason}`, 'Awaiting Quality approval.', { tab: 'record' });
  (o.operations || []).forEach(op => {
    if (op.done) return;
    const pend = MES.atpPending ? MES.atpPending(op) : [];
    if (pend.length) add('hold', `Op ${opn(op.id)} · software push awaiting review`, op.title, { tab: 'operations', op: op.id });
    if (op.classification === MES.EXTERNAL_CLASS && !op.externalPO) add('hold', `Op ${opn(op.id)} · NetSuite PO missing`, op.title, { tab: 'operations', op: op.id });
    if (op.atpLinkDeferred) add('flag', `Op ${opn(op.id)} · ATP software not linked`, op.title, { tab: 'operations', op: op.id });
  });
  if (o.status === 'Kitting') { const n = o.materials.filter(m => !m.ready).length; if (n) add('flag', `Kit not verified · ${n} item${n === 1 ? '' : 's'} open`, 'Verify every lot before the build can start.', { tab: 'materials' }); }
  if (MES.aogActive?.(o)) add('flag', 'AOG priority active', 'Escalation running for this work order.', { tab: 'operations' });
  return H;
}

function holdsSummary(MES, state, o, skCan) {
  const H = orderHolds(MES, state, o).filter(h => h.sev === 'hold' && !(o.status === 'Draft' && h.label === 'QA release approval required'));
  const holds = H.length;
  const list = H.length ? <ul className="holds-list">{H.map((h, i) => <li key={i}><button type="button" className={`hold-link${h.sev === 'hold' ? ' hold-flash' : ''}`} data-action="hold-go" data-i={String(i)} data-tab={asText(h.go.tab || '')} data-op={asText(h.go.op || '')} data-ticket={asText(h.go.ticket || '')}><span className={`pill ${h.sev === 'hold' ? 'high' : 'kitting'}`}>{h.sev === 'hold' ? 'Hold' : 'Flag'}</span><span className="hold-text"><strong>{asText(h.label)}</strong><small>{asText(h.detail)}</small></span><span className="task-go" aria-hidden="true"><ChevronRight size={16}/></span></button>{holdActionButtons(MES, state, o, h, skCan)}</li>)}</ul> : null;
  const releaseRaw = o.status === 'Draft' ? shellReleaseSummary(MES, o, MES.requiresReleaseQA(o) && !MES.releaseApproval(o)) : null;
  const lastReturn = (o.releaseReturns || []).at(-1);
  const release = lastReturn && !MES.releaseApproval(o) ? <>{releaseRaw}<div className="inline-info warning release-return-note" role="status"><CircleAlert size={16}/><p><strong>Returned by QA for revision</strong> {asText(lastReturn.reason)} <span className="small muted">{asText(lastReturn.by?.name || '')} · {legacyDateTime(lastReturn.at)}</span></p></div></> : releaseRaw;
  if (!H.length && !release) return null;
  return <>{release}{H.length ? <section className="release-summary holds-summary" aria-label="Holds on this work order"><div className="holds-head"><strong>{holds} hold{holds === 1 ? '' : 's'} on this work order</strong></div>{list}</section> : null}</>;
}

function handoff(MES, o, tab) {
  if (MES.engineeringChange(o)) return <div className="inline-info warning"><Lock size={16}/><p>Engineering hold: review the proposed change above before continuing execution.</p></div>;
  if ((MES.blockingTickets(o).length && ['Kitting', 'Quality'].includes(o.status)) || (MES.blockingTickets(o).length && o.status === 'Building' && o.operations.every(op => op.done))) return <div className="inline-info warning"><Lock size={16}/><div><p>Open ticket hold: {MES.blockingTickets(o).map(t => asText(t.id)).join(', ')}. A quality disposition is required before handoff or closure.</p><button className="btn" data-action="tab" data-tab="quality">Review quality holds</button></div></div>;
  if (o.status === 'Draft') return MES.requiresReleaseQA(o) && !MES.releaseApproval(o)
    ? <div className="task-actions"><p>QA approval is required before issuing this draft to kitting.</p><button className="btn primary" data-action="review-release">Review release <Shield size={16}/></button></div>
    : <div className="task-actions"><p>{MES.requiresReleaseQA(o) ? 'QA approval recorded.' : 'Pre-release QA approval is not required.'} Issuing changes only this local record.</p><button className="btn primary" data-action="advance">Move to kitting <ChevronRight size={16}/></button></div>;
  if (o.status === 'Kitting') {
    const ready = o.materials.every(m => m.ready);
    return <div className="task-actions"><p>{ready ? 'All materials are ready.' : 'Resolve the missing material checks to continue.'}</p><button className="btn primary" data-action={ready ? 'advance' : 'tab'} data-tab="materials" disabled={!ready && tab === 'materials'}>{ready ? 'Start build' : tab === 'materials' ? `${o.materials.filter(m => !m.ready).length} of ${o.materials.length} lots still to verify` : 'Review kit'} <ChevronRight size={16}/></button></div>;
  }
  if (o.status === 'Building' && o.operations.every(op => op.done)) return <><div className="inline-info success"><Check size={16}/><p>All operations recorded. The work order is ready for a separate quality review.</p></div><div className="task-actions"><p>Closure remains a human decision in the proposed workflow.</p><button className="btn primary" data-action="advance">Send to QA <ChevronRight size={16}/></button></div></>;
  if (o.status === 'Quality') return <><div className="inline-info"><Shield size={16}/><p>Awaiting a quality review. Review the operation notes and activity record before closing.</p></div><div className="task-actions"><button className="btn" data-action="tab" data-tab="record">Review record</button><button className="btn primary" data-action="review">Review & close <Check size={16}/></button></div></>;
  if (o.status === 'Closed') return o.inventory
    ? <div className="inline-info success"><Check size={16}/><div><p>Closed and stocked to inventory as <strong className="mono">{asText(o.inventory.lotNumber)}</strong> · NetSuite: {asText(o.inventory.netsuite.status)}.</p><button className="btn" data-action="tab" data-tab="inventory">View inventory record</button></div></div>
    : <div className="task-actions"><p>Closed by QA. Final step: move the finished units to inventory.</p><button className="btn primary" data-action="tab" data-tab="inventory">Move to inventory <ChevronRight size={16}/></button></div>;
  return null;
}

function OrderView({ state, MES, order, tab, selectedOp, skCan }) {
  const o = order;
  const stages = ['Draft', 'Kitting', 'Building', 'Quality', 'Closed'];
  const stage = stages.indexOf(o.status);
  const w = o.masterWI && MES.findWI(state, o.masterWI.id, o.masterWI.revision);
  const blocked = orderBlocked(MES, o);
  const next = handoff(MES, o, tab);
  const tabDefs = [
    ['materials', 'Kit', `${o.materials.filter(m => m.ready).length}/${o.materials.length}`],
    ['operations', 'Build', `${doneCount(o)}/${o.operations.length}`],
    ['quality', 'Quality', o.tickets.length + o.reports.length],
    ['inventory', 'Stock', o.inventory ? 'Stocked' : MES.isSerialized(o.partNumber) ? `${MES.orderSerials(state, o).length}/${o.quantity} S/N` : 'Lot'],
    ['record', 'Record', o.history.length]
  ];
  return <section className={MES.aogActive(o) ? 'aog-order' : ''} aria-labelledby="order-title">
    {aogBanner(MES, o)}
    <div className="page-heading">
      <div>
        <h1 id="order-title">{asText(o.id)} <Pill status={o.status}/>{w && w.drawingReleased === false ? <span className="pill unrel-pill" title="Built to a work instruction written against an unreleased drawing">Unreleased drawing</span> : null}{blocked ? <span className="pill high blocked-pill">Blocked</span> : null}{o.fai && o.fai.required ? <button type="button" className="pill fai-pill fai-link" data-action="goto-fair" title="Open the AS9102 FAIR on the Quality tab">FAI order · FAIR {o.fair ? asText(o.fair.status === 'Approved' ? 'approved' : o.fair.status) : 'not started'} <ChevronRight size={14}/></button> : null}{o.closedAs ? <span className={`pill closed-as closed-as-${asText(o.closedAs).toLowerCase()}`}>{asText(o.closedAs)}</span> : null}{' '}{o.priority === 'AOG' ? <Pill status="AOG"/> : null}</h1>
        <p>{asText(o.title)}</p>
        {o.masterWI ? <button className="wi-ref" data-action="wi-open" data-wi={asText(o.masterWI.id)} data-rev={asText(o.masterWI.revision)}><FileText size={16}/> Cloned from {asText(o.masterWI.id)} Rev {asText(o.masterWI.revision)}</button> : null}
        {o.sourceBuild ? <button className="wi-ref" data-action="open-inventory" data-order={asText(o.sourceBuild.orderId)}><Box size={16}/> Rework of {asText(o.sourceBuild.serial)} · lot {asText(o.sourceBuild.lotNumber)} · built on {asText(o.sourceBuild.orderId)}</button> : null}
        {splitChips(o)}
        {pedigreeChips(state, o, skCan)}
        {closureBanner(state, o, skCan)}
        {revStrip(MES, state, o)}
      </div>
      <div className="heading-actions">
        <details className="print-menu more-menu">
          <summary className="btn"><List size={16}/> More</summary>
          <div className="print-options">
            <p className="more-title">Record actions</p>
            {o.status !== 'Closed' ? <button className="btn" data-action="engineering-change">Engineering change</button> : null}
            {['Draft', 'Kitting'].includes(o.status) && o.quantity > 1 ? <button className="btn" data-action="split-order">Split quantity</button> : null}
            {['Draft', 'Kitting'].includes(o.status) && !o.pedigreeChange ? <button className="btn" data-action="pedigree-change">Change pedigree</button> : null}
            {o.status !== 'Closed' && !o.closureRequest && (skCan('adjust-wo') || skCan('approve-wo')) ? <button className="btn" data-action="closure-request">Close as obsolete or scrap</button> : null}
            <p className="more-title">Print</p>
            <button className="btn" data-action="print-traveler" data-order={asText(o.id)}>Print traveler</button>
            <button className="btn" data-action="label-placeholder" data-label="kit" data-order={asText(o.id)}>Print kit labels</button>
            <button className="btn" data-action="label-placeholder" data-label="container" data-order={asText(o.id)}>Print WO container label</button>
            <button className="btn" data-action="print-order" data-mode="external">Print · External (no messages)</button>
            <button className="btn" data-action="print-order" data-mode="internal">Print · Internal (with messages)</button>
          </div>
        </details>
        <button className="btn quiet" data-action="nav" data-view="orders">All work orders <ChevronRight size={16}/></button>
      </div>
    </div>
    {orderHolds(MES, state, o).some(h => h.sev === 'hold') ? null : qualityBanner(MES, o)}
    <details className="meta-disclosure">
      <summary>Record details <span className="mono">{asText(o.partNumber)} · Rev {asText(o.revision)} · {asText(o.quantity)} unit{o.quantity === 1 ? '' : 's'} · {asText(o.pedigree)}</span></summary>
      <dl className="record-meta">
        <div className="meta"><dt>Part number</dt><dd className="mono">{asText(o.partNumber)}</dd></div>
        <div className="meta"><dt>Serial number</dt><dd className="mono">{asText(o.serial)}</dd></div>
        <div className="meta"><dt>Intended aircraft</dt><dd className="mono">{asText(o.aircraft || 'Not assigned')}</dd></div>
        <div className="meta"><dt>Planned dates</dt><dd className="mono">{asText(o.start || '-')} → {asText(o.due)}</dd>{o.status !== 'Closed' ? <button className="btn quiet meta-edit" data-action="schedule">Edit dates</button> : null}</div>
        <div className="meta"><dt>Revision</dt><dd className="mono">{asText(o.revision)}{o.creationVersion ? <small className="revision-state">{asText(MES.revisionLabel(o))}</small> : null}</dd></div>
        <div className="meta"><dt>Quantity</dt><dd>{asText(o.quantity)} unit{o.quantity === 1 ? '' : 's'}</dd></div>
        <div className="meta"><dt>Pedigree / subcategory</dt><dd>{asText(o.pedigree)}{o.subcategory ? <small className="subcategory">{asText(o.subcategory)}</small> : null}</dd></div>
        <div className="meta"><dt>Site / assigned to</dt><dd>{asText(MES.orderSite(o))}<small className="subcategory">{asText(o.owner)} site</small></dd></div>
      </dl>
    </details>
    <div className="route-bar">
      <div className="route-stages" aria-label="Work order lifecycle">
        {stages.map((s, i) => <span key={s} className={`route-stage ${i === stage ? 'current' : i < stage ? 'finished' : ''}`} aria-current={i === stage ? 'step' : undefined}><span className="dot">{i < stage ? <Check size={14}/> : i + 1}</span>{asText(s)}{i < 4 ? <ChevronRight size={14}/> : null}</span>)}
      </div>
      <span className="record-frozen"><Lock size={16}/> {o.status === 'Draft' ? 'Proposed revision · Not yet issued' : 'Issued revision retained'}</span>
    </div>
    {tab !== 'operations' ? holdsSummary(MES, state, o, skCan) : null}
    <nav className="tabs" role="tablist" aria-label="Work order sections">
      {tabDefs.map(([key, label, count]) => <button key={key} role="tab" aria-selected={tab === key} data-action="tab" data-tab={key} aria-current={tab === key ? 'page' : undefined}>{label}<span className="badge">{count}</span></button>)}
    </nav>
    {next ? <div className="order-next-action">{next}</div> : null}
    {tab === 'operations' ? <ExecutionTab state={state} MES={MES} order={order} selectedOp={selectedOp} skCan={skCan}/> : tab === 'materials' ? <MaterialsTab state={state} MES={MES} order={order} skCan={skCan}/> : tab === 'quality' ? <QualityTab state={state} MES={MES} order={order} skCan={skCan}/> : tab === 'inventory' ? <InventoryTab state={state} MES={MES} order={order} skCan={skCan}/> : <RecordTab state={state} MES={MES} order={order} skCan={skCan}/>}
  </section>;
}

function historyDay(at) { try { return new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); } catch (e) { return ''; } }

function historyKind(a) { a = String(a || ''); return /\b(NC|IDR)-\d/.test(a) ? 'NC' : /ECR|engineering|re-release|Engineering edit/i.test(a) ? 'ECR / engineering change' : /[Cc]losure|closed/.test(a) ? 'Closure' : /[Ss]plit/.test(a) ? 'Split' : /[Pp]edigree/.test(a) ? 'Pedigree' : /Stage changed|issued to kitting/i.test(a) ? 'Stage change' : /operation recorded|[Ss]tep |Video/.test(a) ? 'Operation / buy-off' : /sequence|operation added|Operation Op|removed:/i.test(a) ? 'Sequence change' : /availability|[Ll]ot |Material/.test(a) ? 'Kitting' : /[Ss]erial|inventory|Stocked/.test(a) ? 'Serial / inventory' : /QA approval|release/i.test(a) ? 'QA release' : /note:/.test(a) ? 'Note' : /Priority|AOG|Planned dates/.test(a) ? 'Priority / schedule' : /[Aa]ssigned/.test(a) ? 'Assignment' : /cloned|created/i.test(a) ? 'Creation' : 'Other'; }


function orderCreatedOn(o) { const h = (Array.isArray(o.historyArchive) && o.historyArchive[0]) || (o.history || [])[0]; const r = (o.revisions || [])[0]; return String((h && h.at) || (r && r.at) || o.start || '').slice(0, 10); }

function recordLinks(text, orderId) {
  let html = escHtml(text);
  for (const [pattern, kind] of RECORD_PATTERNS) {
    html = html.replace(pattern, (match, id) => {
      const target = kind === 'order' ? id : (orderId || '');
      if (kind !== 'order' && kind !== 'serial' && !target) return match;
      return `<button type="button" class="record-link" data-action="record-link" data-kind="${kind}" data-order="${escHtml(target)}" data-record="${escHtml(id)}" title="Open ${escHtml(id)}">${escHtml(id)}</button>`;
    });
  }
  return html;
}

function recordFiles(files, { canAdd, key, orderId }) {
  const list = Array.isArray(files) ? files : [];
  return <section className="attachments record-files">
    <div className="linked-heading"><h3>Files and photos <span className="mono">{list.length}</span></h3></div>
    {list.length ? <ul className="att-list">{list.map((f, i) => <li key={f.id || i}>
      {f.dataUrl && String(f.type || '').startsWith('image/') ? <button type="button" className="att-thumb" data-action="rec-att-view" data-scope="kit" data-order={asText(orderId)} data-file={asText(f.id)} aria-label={`View ${asText(f.name)}`}><img src={asText(f.dataUrl)} alt="" loading="lazy"/></button> : <span className="att-icon"><FileText size={16}/></span>}
      <span className="att-meta"><strong>{asText(f.name)}</strong><small>{fileSizeLabel(f.size)} · {asText(f.addedBy?.name || '')} · {legacyDateTime(f.addedAt)}{f.storage === 'reference' ? ' · logged by name only' : null}</small></span>
      {canAdd ? <button className="btn quiet" data-action="rec-att-remove" data-scope="kit" data-order={asText(orderId)} data-file={asText(f.id)}>Remove</button> : null}
    </li>)}</ul> : <p className="small muted no-links">No files.</p>}
    {canAdd ? <div className="media-actions"><label className="btn att-btn" htmlFor={`rec-att-${asText(key)}`}><Upload size={16}/> Add files or photos</label><input className="sr-only" id={`rec-att-${asText(key)}`} type="file" multiple accept="image/*,.pdf,.txt,.csv" aria-label="Attach files" data-rec-attachment="" data-scope="kit" data-order={asText(orderId)}/></div> : null}
  </section>;
}

function lotSelect(state, MES, o, m) {
  const lots = MES.availableLotsFromLedger(state, m.partNumber, o.pedigree), current = m.lot || '', known = lots.some(l => l.lot === current);
  return <><select className="lot-input mono" id={`lot-${asText(m.id)}`} data-material-lot={asText(m.id)} aria-label={`Lot or serial number for ${asText(m.name)}`} defaultValue={current}>
    <option value="">Select lot from stock</option>
    {lots.map(l => <option key={l.lot} value={asText(l.lot)}>{asText(l.lot)} · {l.onHand} on hand · {asText(l.location)} · {asText(l.buildClass || 'Production')}</option>)}
    {current && !known ? <option value={asText(current)}>{asText(current)} · lot is not available for this build class</option> : null}
  </select>{lots.length ? null : <small className="muted">No {asText(o.pedigree)} stock on hand for this part.</small>}</>;
}

function stockedSummary(MES, o) {
  const inv = o.inventory, t = inv.trace;
  const facts = [
    ['Work order', o.id], ['Part / revision', `${t.partNumber} Rev ${t.revision}`], ['Master WI', t.masterWI ? `${t.masterWI.id} Rev ${t.masterWI.revision}` : '-'], ['Pedigree', `${t.pedigree} / ${t.subcategory || '-'}`],
    ['Serial numbers', t.serials.join(', ') || '-'], ['Kit lots / S/N', t.materials.map(m => `${m.partNumber}: ${m.lotOrSerial}`).join('; ')],
    ['Inspection points', t.operations.filter(op => op.inspectionPoint).map(op => `Op ${op.op} · ${op.boughtOffBy || 'legacy buy-off'}`).join('; ') || 'None'],
    ['Calibrated tools', t.calibratedTools.join('; ') || 'None logged'], ['NC', t.tickets.map(x => `${x.id} ${x.status}`).join('; ') || 'None'],
    ['Intended aircraft', t.aircraft || '-'], ['Reworked from', t.sourceBuild ? `${t.sourceBuild.serial} · lot ${t.sourceBuild.lotNumber} · ${t.sourceBuild.orderId}` : 'New build'],
    ['QA closure', t.qaClosure ? `${legacyDateTime(t.qaClosure.at)} · ${t.qaClosure.by}` : '-']
  ];
  return <div className="panel-body"><div className="lot-hero"><p className="small">Lot number</p><p className="lot-number mono">{asText(inv.lotNumber)}</p><p>{inv.quantity} unit{inv.quantity === 1 ? null : 's'} · {asText(inv.location)}{inv.bin ? ` · bin ${asText(inv.bin)}` : null} · {legacyDateTime(inv.stockedAt)} · {asText(inv.stockedBy.name)}</p></div>
    <h3 className="wi-subhead">Traceability record</h3><dl className="dialog-context trace-dl">{facts.map(([label, value], i) => <div key={i}><dt>{asText(label)}</dt><dd>{asText(value)}</dd></div>)}</dl>
    <details className="trace-details"><summary>Operation trace · {t.operations.length} operations</summary><div className="table-wrap" tabIndex="0" role="region" aria-label="Operation trace"><table className="data-table trace-table"><thead><tr><th scope="col">Op</th><th scope="col">Operation</th><th scope="col">Buy-off</th><th scope="col">Bought off by</th><th scope="col">Steps</th><th scope="col">Tools</th></tr></thead><tbody>{t.operations.map((op, i) => <tr key={i}><td className="mono">{asText(op.op)}</td><td>{asText(op.title)}{op.inspectionPoint ? <small>Inspection point</small> : null}{op.classification ? <small>{asText(op.classification)}</small> : null}</td><td>{asText(op.buyoffType || '-')}</td><td><small>{asText(op.boughtOffBy || 'Legacy record')}{op.stamp ? <><br/>{asText(op.stamp)}</> : null}{op.completedAt ? <><br/>{legacyDateTime(op.completedAt)}</> : null}</small></td><td className="mono">{op.stepsChecked}/{op.steps}</td><td><small>{asText(op.tools.join(', ') || '-')}{op.stepTorque && op.stepTorque.length ? <><br/>Step torque: {asText(op.stepTorque.join('; '))}</> : null}</small></td></tr>)}</tbody></table></div></details>
    <h3 className="wi-subhead">NetSuite</h3>
    {inv.netsuite.status === 'Posted' ? <div className="inline-info success"><Check size={14}/><p>Posted as <strong className="mono">{asText(inv.netsuite.postedRef)}</strong> · {legacyDateTime(inv.netsuite.postedAt)} · {asText(inv.netsuite.postedBy.name)}</p></div> : <p className="small muted">There’s no live NetSuite connection. Copy the payload or CSV into NetSuite, then record the transaction number here. The custbody field IDs are placeholders for your NetSuite admin to map.</p>}
    <div className="ns-block"><label htmlFor="ns-json">Assembly build payload · JSON</label><textarea id="ns-json" className="mono ns-code" readOnly rows="10" defaultValue={asText(JSON.stringify(inv.netsuite.payload, null, 2))}/><button className="btn" data-action="copy-text" data-target="ns-json">Copy JSON</button>
    <label htmlFor="ns-csv">CSV import lines</label><textarea id="ns-csv" className="mono ns-code" readOnly rows="4" defaultValue={asText(MES.netsuiteCsv(o))}/><button className="btn" data-action="copy-text" data-target="ns-csv">Copy CSV</button></div>
    {inv.netsuite.status === 'Posted' ? null : <><form id="netsuite-form" data-order={asText(o.id)} className="serial-form ns-post"><div className="field"><label htmlFor="ns-ref">NetSuite transaction no.</label><input id="ns-ref" name="ref" className="mono" maxLength="40" required placeholder="e.g. ASMB-004512"/></div><button className="btn primary" type="submit">Mark posted</button></form><p id="netsuite-error" className="form-error" role="alert"></p></>}
  </div>;
}

function issuedToBlock(state, o) {
  const used = state.orders.flatMap(p => p.materials.filter(m => m.source && m.source.orderId === o.id).map(m => ({ p, m })));
  const left = Math.max(0, (o.inventory.quantity || o.quantity) - used.reduce((n, x) => n + x.m.required, 0));
  return <div className="panel-body issued-to"><h3>Issued to work orders</h3>{used.length ? <ul className="task-list">{used.map(({ p, m }, i) => <li key={`${asText(p.id)}-${asText(m.id)}`}><span className="task-main"><strong><button className="order-link" data-action="open-order" data-order={asText(p.id)}>{asText(p.id)}</button> · {asText(p.partNumber)} · {asText(p.status)}</strong><small>{m.source.serials.length ? asText(m.source.serials.join(', ')) : `quantity ${m.required}`} · {asText(m.source.issuedBy.name)} · {legacyDateTime(m.source.issuedAt)}</small></span></li>)}</ul> : <p className="small muted">Not issued into another work order yet.</p>}<p className="small">{left} unit{left === 1 ? null : 's'} left in stock. <button className="order-link" data-action="trace-report" data-q={asText(o.inventory.lotNumber)}>Full traceability report for {asText(o.inventory.lotNumber)}</button></p></div>;
}

function engineeringSummary(MES, o) {
  const pending = MES.engineeringChange(o), last = o.engineeringChanges?.at(-1);
  if (!last) return null;
  return <section className="engineering-summary release-summary" aria-label="Engineering change control"><div><strong>{pending ? `Engineering hold · ${asText(pending.status)}` : 'Engineering change approved · Re-released'}</strong><p className="small muted">{asText(last.id)} · {asText(last.reason)}</p><p className="small muted">{pending ? 'The released configuration is unchanged. Execution is paused until review is complete.' : <>QA: {asText(last.qaApproval?.name)} · {asText(last.qaApproval?.credentialId)} · {legacyDateTime(last.qaApproval?.at)}</>}</p>{last.needsECR ? <p className="small muted">{asText(last.ecrId || 'ECR')} · {last.ecrApproval ? `Approved · ${asText(last.ecrApproval.name)}` : 'Submitted · Approval required before applying changes'}</p> : null}</div>{pending ? <button className="btn primary" data-action={pending.status === 'Awaiting ECR' ? 'review-ecr' : 'review-engineering'}>{pending.status === 'Awaiting ECR' ? 'Review submitted ECR' : 'Review and re-release'} <Shield size={16}/></button> : null}</section>;
}

function matReleaseSummary(MES, o) {
  if (!o.creationVersion && o.status !== 'Draft' && !o.sourceTicket) return null;
  const approval = MES.releaseApproval(o), required = MES.requiresReleaseQA(o);
  if (!required) return null;
  return <section className="release-summary" aria-label="Work order release"><div><strong>{required ? (approval ? 'QA release approved' : 'QA approval required before issue') : 'QA approval not required before issue'}</strong><p className="small muted">{approval ? <>{asText(approval.name)} · {asText(approval.role)} · {asText(approval.credentialId)} · {legacyDateTime(approval.at)}</> : required ? 'Approval covers this part, revision, quantity, pedigree, subcategory, site, and source ticket.' : 'Exempt under the selected pedigree and subcategory. Final review and quality holds still apply.'}</p></div>{o.sourceTicket ? <button className="btn" data-action="source-ticket" data-source-order={asText(o.sourceTicket.orderId)} data-source-ticket={asText(o.sourceTicket.ticketId)}>Linked {asText(o.sourceTicket.ticketId)} <ExternalLink size={16}/></button> : null}</section>;
}

function revisionPanel(state, MES, o) {
  const entries = MES.revisionEntries(o).slice().reverse();
  if (!entries.length) return null;
  if (!entries.some(e => e.rev === selectedRev)) selectedRev = entries[0].rev;
  const entry = entries.find(e => e.rev === selectedRev) || entries[0];
  const auth = MES.revisionAuthority(state, o, entry), approver = auth.approvedBy;
  return <section className="panel" aria-labelledby="rev-heading"><div className="panel-head"><h2 id="rev-heading">Revision history</h2><span className="mono">{asText(MES.woRevLabel(o.woRev || 'Baseline'))}</span></div>
    <div className="panel-body">
      <div className="field rev-select-field"><label htmlFor="rev-select">Select a revision</label><select id="rev-select" data-rev-select defaultValue={entry.rev}>{entries.map(e => <option key={e.rev} value={asText(e.rev)}>{asText(MES.woRevLabel(e.rev))} · {asText(legacyDateTime(e.at))}{e.rev === o.woRev ? ' · current' : ''}</option>)}</select></div>
      <dl className="dialog-context trace-dl rev-facts">
        <div><dt>Work order rev</dt><dd className="mono">{asText(MES.woRevLabel(entry.rev))}</dd></div>
        <div><dt>Drawing rev</dt><dd className="mono">{asText(entry.drawingRev || '-')}</dd></div>
        <div><dt>WI rev</dt><dd className="mono">{asText(entry.wiRev || '-')}</dd></div>
        <div><dt>Part revision</dt><dd className="mono">{asText(entry.partRevision || '-')}</dd></div>
        <div><dt>Planned quantity</dt><dd className="mono">{asText(String(entry.quantity ?? '-'))}</dd></div>
        <div><dt>Recorded</dt><dd>{asText(legacyDateTime(entry.at))}</dd></div>
        <div><dt>Change authority (ECO)</dt><dd>{auth.eco ? <><span className="mono">{asText(auth.eco)}</span><small className="muted" style={{ display: 'block' }}>{asText(auth.ecoNote)}</small></> : <span className="muted">{asText(auth.ecoNote)}</span>}</dd></div>
      </dl>
      <h3 className="wi-subhead">What changed</h3>
      <p className="small">{asText(entry.summary)}</p>
      <ul className="rev-changes">{(entry.changes || []).length ? (entry.changes || []).map((text, i) => <li key={i}>{asText(text)}</li>) : <li className="muted">No change detail recorded.</li>}</ul>
      <h3 className="wi-subhead">Approved by</h3>
      {approver ? <div className="evidence-stamp"><Shield size={16}/><div><strong>{asText(approver.name)}</strong><p>{asText(approver.role)} · <span className="mono">{asText(approver.credentialId)}</span>{approver.at ? ` · ${asText(legacyDateTime(approver.at))}` : null}</p><p className="small muted">{auth.source ? `${asText(auth.source)} · ` : null}Approval snapshot. Not an authenticated electronic signature.</p></div></div> : <p className="small muted">No approval recorded.</p>}
    </div></section>;
}

function signoffRegister(MES, o) {
  return <section className="panel signoff-panel" aria-labelledby="signoff-title"><div className="panel-head"><h2 id="signoff-title">Operation sequence & sign-off</h2><span className="mono">{doneCount(o)} / {o.operations.length}</span></div><div className="table-wrap" tabIndex="0" role="region" aria-label="Operation sign-off register"><table className="data-table signoff-table"><thead><tr><th scope="col">Op no.</th><th scope="col">Operation / instruction</th><th scope="col">Status</th><th scope="col">Stamp</th><th scope="col">Date</th></tr></thead><tbody>{o.operations.map((op, i) => { const b = op.buyoff; return <tr key={i}><th scope="row" className="mono">{sequence(i)}</th><td><strong>{asText(op.title)}</strong><small>{asText(op.description)}</small></td><td><span className={`report-result ${op.done ? 'pass' : ''}`}>{op.done ? 'Complete' : 'Open'}</span>{openTickets(o, op.id).length ? <small className="op-flag">NC open{MES.blockingTickets(o, op.id).length ? ' · Hold' : null}{opDispoStatus(o, op)}</small> : null}</td><td>{b ? <><strong>{asText(b.name)}</strong><small>{asText(b.role)}</small><small className="mono">{asText(b.credentialId)}</small>{b.override ? <small>Master Access override</small> : null}{Array.isArray(b.tools) ? <small className="mono">Tools: {b.tools.length ? b.tools.map(t => `${asText(t.tag)}${t.torque ? ` @ ${asText(t.torque.value)} ${asText(t.torque.unit)}` : ''}`).join(', ') : 'none logged'}</small> : null}</> : op.done ? <small>Not captured in earlier </small> : <span className="sr-only">Not yet bought off</span>}</td><td>{b ? <time dateTime={asText(b.at)}>{asText(buyoffDate(b.at))}</time> : <span className="sr-only">{op.done ? 'Not captured' : 'Not yet bought off'}</span>}</td></tr>; })}</tbody></table></div></section>;
}

function historyList(events) {
  const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const who = e => String(e.actor || '').split(' · ')[0].trim();
  const names = [...new Set(sorted.map(who).filter(Boolean))].sort();
  const kinds = [...new Set(sorted.map(e => historyKind(e.action)))].sort();
  const fid = 'hf-' + sorted.length + '-' + Math.random().toString(36).slice(2, 7);
  return <><div className="history-filter" data-hf-root><div className="hf-field"><label htmlFor={`${fid}-from`}>From</label><input type="date" id={`${fid}-from`} data-hf="from"/></div><div className="hf-field"><label htmlFor={`${fid}-to`}>To</label><input type="date" id={`${fid}-to`} data-hf="to"/></div><div className="hf-field"><label htmlFor={`${fid}-kind`}>Activity</label><select id={`${fid}-kind`} data-hf="kind"><option value="">All activity</option>{kinds.map(k => <option key={k}>{asText(k)}</option>)}</select></div><div className="hf-field"><label htmlFor={`${fid}-name`}>Name</label><select id={`${fid}-name`} data-hf="name"><option value="">Everyone</option>{names.map(n => <option key={n}>{asText(n)}</option>)}</select></div><div className="hf-field hf-grow"><label htmlFor={`${fid}-q`}>Contains</label><input type="search" id={`${fid}-q`} data-hf="q" placeholder="Search" autoComplete="off"/></div><div className="hf-meta"><span className="hf-count" aria-live="polite">{sorted.length} of {sorted.length}</span><button type="button" className="btn quiet hf-clear" data-hf-clear>Clear</button></div></div><ol className="timeline">{sorted.map((e, i) => <li key={i} data-hf-day={asText(historyDay(e.at))} data-hf-kind={asText(historyKind(e.action))} data-hf-name={asText(who(e))} data-hf-text={asText(String(e.action + ' ' + e.actor + ' ' + (e.orderId || '')).toLowerCase())}><time dateTime={asText(e.at)}>{legacyDateTime(e.at)}</time><div><strong dangerouslySetInnerHTML={{ __html: recordLinks(e.action, e.orderId) }}/><small><span className="hf-kind-tag">{asText(historyKind(e.action))}</span> · {asText(e.actor)}{e.orderId ? <span> · <span dangerouslySetInnerHTML={{ __html: recordLinks(e.orderId, e.orderId) }}/></span> : null}</small></div></li>)}</ol><p className="hf-empty" hidden>No activity matches these filters.</p></>;
}

function MaterialsTab({ state, MES, order, skCan }) {
  const o = order;
  const handoffBlock = handoff(MES, o, 'materials');
  return <>
    {o.status !== 'Draft' ? <section className="panel traveler-panel"><div className="panel-head"><h2>Shop traveler</h2><div className="fair-btns" style={{ margin: 0 }}><button className="btn" data-action="label-placeholder" data-label="kit" data-order={asText(o.id)}>Print kit labels</button><button className="btn" data-action="label-placeholder" data-label="container" data-order={asText(o.id)}>Print WO container label</button><button className="btn primary" data-action="print-traveler" data-order={asText(o.id)}>Print traveler</button></div></div><p className="small muted">Print it when the kit is pulled so it travels with the kit. Reprint after any sequence change; it shows the WO revision it was printed at.</p></section> : null}
    {o.status !== 'Draft' ? <section className="panel"><div className="panel-head"><h2>Kit list from NetSuite</h2><Pill status={(o.kitFiles || []).length ? 'Attached' : 'Required'}/></div><p className="small muted">A person issues the kit in NetSuite. Attach the kit list here as evidence; the build cannot start without it.</p>{recordFiles(o.kitFiles, { canAdd: ['Kitting', 'Building'].includes(o.status) && skCan('operate'), key: `k-${o.id}`, orderId: o.id })}</section> : null}
    <section className="panel"><div className="panel-head"><h2>Issued material kit</h2><Pill status={o.materials.every(m => m.ready) ? 'Ready' : 'Kitting'}/></div><div className="table-wrap" tabIndex="0" role="region" aria-label="Kit table"><table className="data-table material-table"><thead><tr><th scope="col">Ready</th><th scope="col">Material</th><th scope="col">Part number</th><th scope="col">Lot / serial no.</th><th scope="col">Required</th><th scope="col">Status</th></tr></thead><tbody>{o.materials.map(m => <tr key={m.id}><td><label className="check-label"><input className="material-check" type="checkbox" data-material={asText(m.id)} defaultChecked={!!m.ready} disabled={o.status !== 'Kitting' || !!MES.engineeringChange(o)} aria-label={`Verify ${asText(m.name)} in kit`}/></label></td><td><strong>{asText(m.name)}</strong><small>{m.source ? <>Sub-assembly from <button className="order-link" data-action="open-order" data-order={asText(m.source.orderId)}>{asText(m.source.orderId)}</button>{m.source.serials.length ? ` · ${m.source.serials.map(asText).join(', ')}` : null}{o.status === 'Kitting' && skCan('operate') ? <> · <button className="order-link" data-action="wo-issue-return" data-order={asText(o.id)} data-material={asText(m.id)}>Return</button></> : null}</> : 'material'}</small></td><td className="mono">{asText(m.partNumber)}</td><td>{o.status === 'Kitting' && !MES.engineeringChange(o) ? lotSelect(state, MES, o, m) : m.lot ? <span className="mono">{asText(m.lot)}</span> : <small>Not recorded</small>}</td><td>{asText(m.required)}</td><td><Pill status={m.ready ? 'Ready' : 'Missing'}/></td></tr>)}</tbody></table></div><div className="panel-body">{['Kitting', 'Building'].includes(o.status) && skCan('operate') ? <p className="small"><button className="btn" data-action="wo-issue" data-order={asText(o.id)}><Plus size={16}/> Issue a sub-assembly from a work order</button> <span className="muted">A stocked work order's lot and serials become a line on this kit.</span></p> : null}{handoffBlock ? handoffBlock : <p className="small muted">Kit locked.</p>}</div></section>
  </>;
}

function InventoryTab({ state, MES, order, skCan }) {
  const o = order;
  const readiness = MES.inventoryReadiness(state, o), serials = MES.orderSerials(state, o), inv = o.inventory;
  const log = (state.serialLog || []).filter(entry => entry.orderId === o.id);
  const serialized = MES.isSerialized(o.partNumber), canAssign = serialized && !inv && serials.length < o.quantity, next = MES.nextSerial(state, o.partNumber);
  return <div className="inventory-layout">
    <section className="panel" aria-labelledby="inv-heading"><div className="panel-head"><h2 id="inv-heading">{inv ? 'Stocked to inventory' : 'Move to inventory'}</h2>{inv ? <span className={`pill ${inv.netsuite.status === 'Posted' ? 'closed' : 'kitting'}`}>NetSuite · {asText(inv.netsuite.status)}</span> : <Pill status={readiness.ready ? 'Ready' : 'Missing'}/>}</div>
    {inv ? <>{stockedSummary(MES, o)}{issuedToBlock(state, o)}</> : <div className="panel-body"><ul className="trace-checks" aria-label="Traceability requirements">{readiness.checks.map((check, i) => <li key={i} className={check.ok ? 'ok' : 'open'}>{check.ok ? <Check size={14}/> : <Lock size={14}/>}<span>{asText(check.label)}</span></li>)}</ul>
      <form id="inventory-form" data-order={asText(o.id)} className="form-grid"><div className="field"><label htmlFor="inv-location">Location</label><select id="inv-location" name="location" defaultValue={o.site || 'HHR'}>{MES.SITES.map(site => <option key={site}>{asText(site)}</option>)}</select></div><div className="field"><label htmlFor="inv-bin">Bin <span className="muted">(optional)</span></label><input id="inv-bin" name="bin" maxLength="30" className="mono" placeholder="e.g. FG-A-03"/></div><div className="wide"><p id="inventory-error" className="form-error" role="alert"></p><button className="btn primary" type="submit" disabled={!readiness.ready}>Move to inventory & generate lot <ChevronRight size={16}/></button>{readiness.ready ? null : <p className="small muted inv-hint">Complete the open requirements above to enable this step.</p>}</div></form></div>}
    </section>
    <section className="panel" aria-labelledby="serial-heading"><div className="panel-head"><h2 id="serial-heading">Serial numbers</h2><span className="mono">{serialized ? `${serials.length} / ${o.quantity}` : 'Lot-tracked'}</span></div><div className="panel-body">{serialized ? null : <p className="small muted">{asText(o.partNumber)} is not a serialized part. Units are traced by the lot number generated at stocking.</p>}
      {canAssign ? <><form id="serial-form" data-order={asText(o.id)} className="serial-form"><div className="field"><label htmlFor="serial-input">Serial number</label><input id="serial-input" name="serial" className="mono" maxLength="40" autoComplete="off" spellCheck="false" placeholder={`Next: ${asText(next)}`}/></div><button className="btn" type="submit">Assign</button><button className="btn primary" type="button" data-action="serial-next" data-order={asText(o.id)}>Assign next · {asText(next)}</button></form><p className="small muted serial-help">Serials are auto-assigned when the work order is created. Use this only to replace a voided serial or fill a unit created before auto-assignment. Numbers are never reused.</p><p id="serial-error" className="form-error" role="alert"></p></> : <p className="small muted">{inv ? 'Serial numbers are locked after stocking.' : !serialized ? 'No serial numbers for lot-tracked parts.' : 'Every unit has a serial number.'}</p>}
      {log.length ? <div className="table-wrap" tabIndex="0" role="region" aria-label={`Serial numbers for ${asText(o.id)}`}><table className="data-table serial-table"><thead><tr><th scope="col">Unit</th><th scope="col">Serial</th><th scope="col">Status</th><th scope="col">Assigned</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{log.map((entry, i) => <tr key={entry.serial || i} className={entry.status === 'Voided' ? 'voided' : ''}><td className="mono">{entry.unit}</td><td className="mono"><strong>{asText(entry.serial)}</strong></td><td>{asText(entry.status)}{entry.voidReason ? <small>{asText(entry.voidReason)}</small> : null}{entry.lotNumber ? <small className="mono">{asText(entry.lotNumber)}</small> : null}{entry.reworkOrders && entry.reworkOrders.length ? <small>Rework: {entry.reworkOrders.map((id, j) => <span key={id}>{j > 0 ? ' ' : null}<button className="order-link" data-action="open-order" data-order={asText(id)}>{asText(id)}</button></span>)}</small> : null}</td><td><small>{legacyDateTime(entry.assignedAt)}<br/>{asText(entry.assignedBy.name)}</small></td><td>{!inv && entry.status === 'Assigned' ? <button className="btn quiet" data-action="serial-void" data-order={asText(o.id)} data-serial={asText(entry.serial)}>Void</button> : null}</td></tr>)}</tbody></table></div> : null}
    </div></section>
  </div>;
}

function RecordTab({ state, MES, order, skCan }) {
  const o = order;
  return <>
    {o.status === 'Draft' ? engineeringSummary(MES, o) : <>{matReleaseSummary(MES, o)}{engineeringSummary(MES, o)}</>}
    {revisionPanel(state, MES, o)}
    {signoffRegister(MES, o)}
    <section className="panel"><div className="panel-head"><h2>Work-order activity record</h2><button className="btn" data-action="export"><Download size={16}/> Export internal JSON</button></div>{historyList(o.history)}{o.status === 'Closed' ? null : <form className="note-form" id="record-note-form"><div className="field"><label htmlFor="record-note">Add a record note</label><textarea id="record-note" name="note" maxLength="500" minLength="3" required placeholder="Add a note"/></div><button className="btn" type="submit">Add note</button></form>}</section>
  </>;
}

function QualityTab({ state, MES, order, skCan }) {
  const o = order;
  const ticketLabel = t => t.status === 'Resolved' ? 'Resolved' : !t.dispo ? 'Pending ME disposition' : t.hold ? 'Open · Hold' : 'Open · Flag only';
  const confPages = (oo, p) => {
    const qa = skCan('approve-wo'), oid = asText(oo.id), sn = asText(p.serial), a = MES.confAuto(state, oo, p.serial), gaps = MES.confGaps(state, oo, p, 'aqi');
    const at = () => ({ 'data-order': oid, 'data-serial': sn });
    const ph = n => MES.CONF_PHASES[n - 1];
    const cnt = n => { const c = ph(n).checks.filter(k => k !== '5.2' || p.nc === 'Yes'); return c.length ? `${c.filter(k => p.checks[k] && p.checks[k].value !== 'No').length} / ${c.length}` : ''; };
    const cur = confCurrentPage(MES, p);
    const phase = (n, html) => ({ n, title: ph(n).title, count: cnt(n), html });
    const locked = p.form !== null, edit = qa && p.status !== 'Closed';
    const inp = (k, label, opt = {}) => <div className={`field${opt.wide ? ' wide' : ''}`}><label htmlFor={`cf-${k}-${sn}`}>{label}</label><input id={`cf-${k}-${sn}`} name={k} type={opt.type} maxLength={opt.max || 80} className={opt.mono ? 'mono' : ''} defaultValue={asText(p[k])} disabled={!edit || (locked && !opt.dar)}/></div>;
    const details = <form className="fair-form" data-form="conf-save" {...at()}><div className="form-grid">{inp('jira', 'Jira conformity tracker ticket', { mono: 1, dar: 1 })}{inp('rfc', 'RFC number (from Certification)', { mono: 1 })}{inp('mdlRev', 'MDL AA-CRT-0001 revision', { mono: 1 })}{inp('mdlReceived', 'Date MDL received from CM', { type: 'date' })}{inp('pdmPath', 'PDM conformity package folder', { wide: 1, max: 200, mono: 1 })}{inp('staging', 'Staging location', { dar: 1 })}</div>{edit ? <><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Save package details</button></div></> : null}</form>;
    const bom = <><div className="table-wrap"><table className="data-table conf-bom"><thead><tr><th scope="col">Level</th><th scope="col">Make / buy</th><th scope="col">Part number</th><th scope="col">Rev</th><th scope="col">Description</th><th scope="col">S/N or lot</th><th scope="col">Work order</th></tr></thead><tbody>{a.bom.map((b, i) => <tr key={i}><td className="mono">{b.level}</td><td>{b.make ? 'Make' : 'Buy'}</td><td className="mono" style={{ paddingLeft: 8 + b.level * 16 }}>{asText(b.pn)}</td><td className="mono">{asText(b.rev || '')}</td><td>{asText(b.name)}</td><td className="mono">{asText(b.ref || '')}</td><td>{b.orderId ? <><button className="order-link" data-action="open-order" data-order={asText(b.orderId)}>{asText(b.orderId)}</button>{' '}<Pill status={b.status}/></> : null}</td></tr>)}</tbody></table></div><p className="small"><button className="btn quiet" data-action="conf-bom-csv" {...at()}>Download As-Built BOM (CSV)</button></p></>;
    const p1 = phase(1, <><p className="small muted">Step 1.1: get the current MDL (AA-CRT-0001) from Configuration Management; a copy older than 30 days is not used. Step 1.2: the As-Built indented BOM below is built from this work order's genealogy (sub-assembly work orders, their serials and lots, and purchased parts with their lots).</p>{bom}{confCheckRow(oo, p, '1.2')}{confCheckRow(oo, p, '1.3', !p.mdlRev ? <small className="conf-warn">Record the MDL revision first.</small> : null)}{confCheckRow(oo, p, '1.4')}</>);
    const p2 = phase(2, <><p className="small muted">Everything below is already in the MES; save each to the PDM folder <span className="mono">{asText(p.pdmPath)}</span>.</p><h4>2.1 Work orders (make and assembly parts)</h4>{confList(a.bom.filter(b => b.make).map(b => `${b.orderId} · ${b.pn} Rev ${b.rev} · ${b.status}${b.wi ? ` · ${b.wi}` : ''}`), 'conf-notes')}{confList(a.wo, 'conf-gaps')}<h4>2.2 FAIRs (Skyryse design parts)</h4>{confList(a.fairNotes, 'conf-notes') || <p className="small muted">No FAIR in the MES for these work orders; pull them from PDM.</p>}<h4>2.3 Supplier data packages (buy parts)</h4>{confList(a.bom.filter(b => !b.make).map(b => `${b.pn} · ${b.name} · lot ${b.ref || 'not recorded'}`), 'conf-notes')}<p className="small muted">CoC, test reports and special-process and material certs come from NetSuite and the supplier.</p><h4>2.4 Test reports (make and assembly parts)</h4>{confList(a.testNotes, 'conf-notes') || <p className="small muted">No ATP, HIL, SIL or external test operations in these work orders.</p>}{confList(a.test, 'conf-gaps')}</>);
    const p3 = phase(3, <>{confCheckRow(oo, p, '3.1', <>{confList(a.wo, 'conf-gaps')}{confList(a.woNotes, 'conf-notes')}</>)}{confCheckRow(oo, p, '3.2', confList(a.fair, 'conf-gaps'))}{confCheckRow(oo, p, '3.3', confList(a.buy, 'conf-gaps'))}{confCheckRow(oo, p, '3.4', confList(a.test, 'conf-gaps'))}</>);
    const p4 = phase(4, <><p className="small muted">If FOD, damage or workmanship issues are found: stop, notify the Operations Manager and Quality Manager, raise an IDR and red-tag the LRU IAW SOP-870-001.</p>{['4.1a', '4.1b', '4.1c', '4.1d', '4.2'].map(k => <React.Fragment key={k}>{confCheckRow(oo, p, k, k === '4.2' && !p.staging ? <small className="conf-warn">Record the staging location in the package details.</small> : null)}</React.Fragment>)}</>);
    const p5 = phase(5, <>{a.deviations.length ? <p>Deviation dispositions in this LRU: <strong>{a.deviations.map(asText).join(', ')}</strong>. They are consolidated on a final conformity IDR.</p> : <p className="small muted">No deviation dispositions are recorded in this LRU.</p>}<form className="fair-form" data-form="conf-save" {...at()}><div className="form-grid"><div className="field"><label htmlFor={`cf-nc-${sn}`}>5.1 Any deviation to conformance?</label><select id={`cf-nc-${sn}`} name="nc" disabled={!edit || locked} defaultValue={asText(p.nc || '')}><option value="">Decide</option><option value="No">No</option><option value="Yes">Yes</option></select></div>{p.nc === 'Yes' ? inp('finalIdr', '5.2 Final conformity IDR', { mono: 1 }) : null}</div>{edit && !locked ? <div className="fair-btns"><button className="btn" type="submit">Save decision</button></div> : null}<p className="form-error" role="alert"/></form>{p.nc === 'Yes' ? confCheckRow(oo, p, '5.2') : null}</>);
    const sec = s => s === 'Aircraft' ? 'I · Aircraft (or parts thereof)' : s === 'Engine' ? 'II · Engine' : 'III · Propeller';
    const form = p.form;
    const p6 = phase(6, form ? (
      <><div className="conf-form-sum"><p><strong>8130-9 completed</strong> by {asText(form.prepared.by.name)}{form.prepared.by.override ? ' · Master Access override' : null}{form.prepared.by.stamp ? <> · stamp {asText(form.prepared.by.stamp.number)}</> : null} · {legacyDateTime(form.prepared.at)} · RFC <span className="mono">{asText(form.rfc)}</span></p><p>Section {asText(sec(form.section))} · {asText(form.make)} {asText(form.model)} · S/N {asText(form.serial)} · Item {asText(form.item)}{form.checkDate ? <> ({asText(form.checkDate)})</> : null}</p><p>{asText(form.basis)}</p><p><strong>Deviations:</strong> {asText(form.deviations)}</p></div>{confCheckRow(oo, p, '6.1')}
      <h4>6.2 AQI review of the conformity package</h4>{p.aqi ? <p className="conf-ok"><Check size={14}/> Signature of certifier: <strong>{asText(p.aqi.by.name)}</strong>, Authorized Quality Inspector{p.aqi.by.override ? ' · Master Access override' : null}{p.aqi.by.stamp ? <> · stamp {asText(p.aqi.by.stamp.number)}</> : null} · {legacyDateTime(p.aqi.at)}</p> : <><p className="small muted">A second qualified inspector holding the 8130-9 Authorized Inspector (AQI) stamp verifies the package, the As-Built BOM against the MDL, the 8130-9 against the RFC, every IDR's MRB disposition, and the visual inspection and packaging. Not the person who completed the form.</p>{confList(gaps, 'conf-gaps')}{qa && p.status === '8130-9 completed' ? <form data-form="conf-aqi" {...at()}>{fairPin('AQI stamp PIN')}<p className="form-error" role="alert"/><div className="fair-btns"><button className="btn primary" type="submit" disabled={gaps.length > 0} title={gaps.length ? 'Clear the items above first' : undefined}>AQI: accept package and sign 8130-9</button></div></form> : null}</>}
      {p.aqi ? <><h4>6.3 Tag and photograph</h4>{confCheckRow(oo, p, '6.3a')}{confCheckRow(oo, p, '6.3b')}</> : null}
      <div className="fair-btns"><button className="btn" data-action="conf-8130-print" {...at()}>Print 8130-9</button><button className="btn" data-action="conf-8130" {...at()}>Download 8130-9</button>{qa && !p.darApproval && p.status !== 'Closed' ? <button className="btn quiet" data-action="conf-void" {...at()}>Void and complete a new form</button> : null}</div></>
    ) : (
      <><p className="small muted">Step 6.1: enter the LRU exactly as on the As-Built BOM and MDL. No white-out or redlines: a correction voids the form and a new one is completed.{p.voided.length ? <> {p.voided.length} voided form{p.voided.length === 1 ? '' : 's'} on record.</> : null}</p>{confList(MES.confGaps(state, oo, p, 'prepare'), 'conf-gaps')}{qa && p.status === 'Open' ? <form className="fair-form" data-form="conf-8130" {...at()}><div className="form-grid"><div className="field"><label>Section</label><select name="section">{MES.SOC_SECTIONS.map(x => <option key={x} value={x}>{sec(x)}</option>)}</select></div><div className="field"><label>Section IV item</label><select name="item">{Object.keys(MES.SOC_ITEMS).map(k => <option key={k} value={k}>{k}</option>)}</select></div><div className="field"><label>Make</label><input name="make" maxLength={60} defaultValue="Skyryse"/></div><div className="field"><label>Model</label><input name="model" maxLength={60} defaultValue={asText(oo.aircraft || '')}/></div><div className="field"><label>Registration no. (aircraft only)</label><input name="registration" maxLength={20}/></div><div className="field"><label>Flight or final operational check date (items B, D)</label><input name="checkDate" type="date"/></div><div className="field wide"><label>I hereby certify that (certification basis and type design data)</label><textarea name="basis" rows={2} maxLength={300} defaultValue={`Parts are in conformity with Master Data List AA-CRT-0001 Rev ${p.mdlRev || '?'}: ${oo.partNumber} Rev ${oo.revision}, ${oo.title}, S/N ${p.serial}.`}/></div><div className="field wide"><label>Deviations</label><input defaultValue={asText(p.nc === 'Yes' ? `Final conformity IDR ${p.finalIdr}` : 'None')} disabled/></div>{fairPin('Your stamp PIN')}</div><p className="small muted">Item A: {asText(MES.SOC_ITEMS.A)} Items B to D: {'see the FAA Form 8130-9 instructions'}.</p><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn primary" type="submit">Complete 8130-9</button></div></form> : null}</>
    ));
    const findingRows = p.findings.map(f => <li key={f.id} className={f.status === 'Open' ? 'conf-open' : ''}><strong>{asText(f.id)}</strong>{' '}{asText(f.text)}{' '}<small>Owner {asText(f.owner)}{f.rcca ? <> · {asText(f.rcca)}</> : null} · {asText(f.status)}{f.resolution ? <> · {asText(f.resolution)}</> : null}</small>{f.status === 'Open' && qa ? <form className="fair-inline" data-form="conf-finding-accept" {...at()} data-fid={asText(f.id)}><input name="rcca" maxLength={40} className="mono" placeholder="RCCA Jira ticket" defaultValue={asText(f.rcca)} aria-label={`RCCA ticket for ${asText(f.id)}`}/><input name="resolution" maxLength={300} placeholder="Resolution" aria-label={`Resolution for ${asText(f.id)}`}/><label className="check-label"><input type="checkbox" name="dar"/><span>DAR accepted</span></label><button className="btn quiet" type="submit">Close finding</button><p className="form-error" role="alert"/></form> : null}</li>);
    const inDar = ['Ready for DAR review', 'DAR findings'].includes(p.status);
    const p7 = phase(7, <>
      {p.notified ? <p className="conf-ok"><Check size={14}/> Certification notified {legacyDateTime(p.notified.at)}: READY FOR DAR REVIEW.</p> : qa && p.status === 'AQI signed' ? <div className="fair-btns"><button className="btn primary" data-action="conf-notify" {...at()} disabled={!(p.checks['6.3a'] && p.checks['6.3a'].value !== 'No') || !(p.checks['6.3b'] && p.checks['6.3b'].value !== 'No')} title={(!(p.checks['6.3a'] && p.checks['6.3a'].value !== 'No') || !(p.checks['6.3b'] && p.checks['6.3b'].value !== 'No')) ? 'Confirm Step 6.3 first' : undefined}>7.1 Notify Certification: ready for DAR review</button></div> : <p className="small muted">Step 7.1 opens after the AQI signs and the LRU is tagged.</p>}
      {p.notified ? <><form className="fair-form" data-form="conf-save" {...at()}><div className="form-grid">{inp('darName', 'DAR name', { dar: 1 })}{inp('darDesignation', 'DAR designation no.', { dar: 1, mono: 1 })}{inp('darDate', 'DAR review date', { type: 'date', dar: 1 })}</div>{edit ? <><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Save DAR details</button></div></> : null}</form>{confCheckRow(oo, p, '7.2')}
      <h4>7.5 DAR findings</h4>{findingRows.length ? <ul className="conf-findings">{findingRows}</ul> : <p className="small muted">No findings recorded.</p>}{qa && inDar ? <form className="fair-inline" data-form="conf-finding" {...at()}><input name="text" maxLength={400} placeholder="Finding" aria-label="DAR finding"/><input name="owner" maxLength={80} placeholder="Owner" aria-label="Finding owner"/><input name="rcca" maxLength={40} className="mono" placeholder="RCCA Jira ticket" aria-label="RCCA ticket"/><button className="btn" type="submit">Add finding</button><p className="form-error" role="alert"/></form> : null}
      <h4>7.6 DAR approval</h4>{p.darApproval ? <p className="conf-ok"><Check size={14}/> <strong>CONFORMED</strong> · DAR {asText(p.darApproval.name)} ({asText(p.darApproval.designation)}) signed the 8130-9 on {asText(p.darApproval.date)}.</p> : qa && p.status === 'Ready for DAR review' ? <form className="fair-form" data-form="conf-dar" {...at()}><div className="form-grid"><div className="field"><label>DAR name</label><input name="name" maxLength={80} defaultValue={asText(p.darName)}/></div><div className="field"><label>DAR designation no.</label><input name="designation" maxLength={40} className="mono" defaultValue={asText(p.darDesignation)}/></div><div className="field"><label>Date the DAR signed the 8130-9</label><input name="date" type="date"/></div><label className="check-label wide"><input type="checkbox" name="aqiPresent"/><span>7.3 The AQI was with the DAR for the whole visit</span></label><label className="check-label wide"><input type="checkbox" name="fieldsSigned"/><span>7.6 The DAR signed and dated every required field on the 8130-9</span></label></div><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn primary" type="submit">Record DAR approval: CONFORMED</button></div></form> : <p className="small muted">Recorded once the DAR accepts the package and every finding is closed.</p>}
      {p.darApproval ? <>{confCheckRow(oo, p, '7.6')}{confCheckRow(oo, p, '7.7')}
      <h4>FAA Form 8130-3 (if one is issued)</h4>{p.faa8130_3 ? <p><FileText size={14}/> <strong>8130-3 {asText(p.faa8130_3.number)}</strong> · issued {asText(p.faa8130_3.date)} by {asText(p.faa8130_3.issuer)}{' '}{asText(p.faa8130_3.issuerName)} · block 11 {asText(p.faa8130_3.block11)}</p> : qa ? <><p className="small muted">The 8130-3 is issued by the DAR, FAA ASI or ODA-UM, not by the MES. Record it here so it is traceable from the unit.</p><form className="fair-form" data-form="conf-8130-3" {...at()}><div className="form-grid"><div className="field"><label>Form tracking no. (block 3)</label><input name="number" maxLength={40} className="mono"/></div><div className="field"><label>Issued by</label><select name="issuer">{MES.ISSUERS.map(x => <option key={x}>{x}</option>)}</select></div><div className="field"><label>Issuer name and designation no.</label><input name="issuerName" maxLength={80}/></div><div className="field"><label>Date issued</label><input name="date" type="date"/></div><div className="field"><label>Block 11 status</label><select name="block11"><option key="PROTOTYPE">PROTOTYPE</option><option key="NEW">NEW</option></select></div></div><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Record 8130-3</button></div></form></> : null}
      {qa && p.status === 'Conformed' ? <div className="fair-btns"><button className="btn primary" data-action="conf-close" {...at()} disabled={!(p.checks['7.6'] && p.checks['7.6'].value !== 'No') || !(p.checks['7.7'] && p.checks['7.7'].value !== 'No')} title={(!(p.checks['7.6'] && p.checks['7.6'].value !== 'No') || !(p.checks['7.7'] && p.checks['7.7'].value !== 'No')) ? 'Confirm Steps 7.6 and 7.7 first' : undefined}>7.7 Close out the package</button></div> : null}</> : null}
      </> : null}
    </>);
    return { cur, details, pages: [p1, p2, p3, p4, p5, p6, p7] };
  };
  const confPackage = (oo, p) => {
    const sn = asText(p.serial), oid = asText(oo.id), x = confPages(oo, p);
    return <article className="conf-pkg"><div className="conf-head"><div><h3>LRU {asText(oo.partNumber)} Rev {asText(oo.revision)} · S/N {sn}</h3><p className="small muted">{p.jira ? <>Jira <span className="mono">{asText(p.jira)}</span> · </> : null}{p.rfc ? <>RFC <span className="mono">{asText(p.rfc)}</span> · </> : null}PDM <span className="mono">{asText(p.pdmPath)}</span></p></div><span className={`pill ${p.status === 'Closed' || p.status === 'Conformed' ? 'closed' : p.status === 'DAR findings' || Object.values(p.checks).some(c => c.value === 'No') ? 'high' : 'kitting'}`}>{asText(p.status === 'Conformed' ? 'CONFORMED' : p.status)}</span></div>
      <ol className="conf-prog">{x.pages.map(pg => <li key={pg.n} className={pg.n < x.cur || x.cur === 0 ? 'done' : pg.n === x.cur ? 'cur' : ''}><span className="conf-n">{pg.n}</span>{asText(pg.title)}{pg.count ? <>{' '}<small>{pg.count}</small></> : null}</li>)}</ol>
      <div className="fair-btns"><button className="btn primary" data-action="conf-wizard" data-order={oid} data-serial={sn} data-page={x.cur || 7}>Open conformity checklist</button>{p.form ? <><button className="btn" data-action="conf-8130-print" data-order={oid} data-serial={sn}>Print 8130-9</button><button className="btn" data-action="conf-8130" data-order={oid} data-serial={sn}>Download 8130-9</button></> : null}<button className="btn quiet" data-action="conf-cover" data-order={oid} data-serial={sn}>Download package checklist</button></div></article>;
  };
  const confPanel = oo => {
    const list = oo.conformity || [];
    if (!['Quality', 'Closed'].includes(oo.status) && !list.length && !oo.operations.some(MES.isPartsConformityOperation)) return null;
    const serials = MES.confSerials(state, oo), free = serials.filter(s => !list.some(p => p.serial === s)), qa = skCan('approve-wo');
    return <section className="panel conf-panel"><div className="panel-head"><h2>LRU conformity package · FAA Form 8130-9</h2><span className={`pill ${list.length && list.every(p => ['Conformed', 'Closed'].includes(p.status)) ? 'closed' : 'kitting'}`}>{list.length ? `${list.filter(p => ['Conformed', 'Closed'].includes(p.status)).length} / ${list.length} conformed` : 'Not started'}</span></div><div className="panel-body">
      <p className="small muted">SOP-860-002. QA compiles the package per LRU serial, completes the 8130-9, the Authorized Quality Inspector (AQI) reviews it independently and signs, Certification schedules the DAR, and the DAR's acceptance makes the LRU CONFORMED.</p>
      {list.map(p => <React.Fragment key={p.serial}>{confPackage(oo, p)}</React.Fragment>)}
      {qa && free.length > 0 && (['Quality', 'Closed'].includes(oo.status) || MES.isPartsConformityOperation(oo.operations.find(op => !op.done))) ? <form className="fair-form fair-inline" data-form="conf-start" data-order={asText(oo.id)}><label>LRU serial <select name="serial">{free.map(s => <option key={s}>{asText(s)}</option>)}</select></label><input name="jira" maxLength={40} className="mono" placeholder="Jira conformity ticket" aria-label="Jira conformity tracker ticket"/><input name="rfc" maxLength={60} className="mono" placeholder="RFC number (if received)" aria-label="RFC number"/><button className="btn primary" type="submit">Start conformity package</button><p className="form-error" role="alert"/></form> : null}
    </div></section>;
  };
  const fairPanel = oo => {
    if (!(oo.fai && oo.fai.required) && !oo.fair) return null;
    const qa = skCan('approve-wo'), oid = asText(oo.id);
    if (!oo.fair) return <section className="panel fair-panel" id="fair-panel"><div className="panel-head"><h2>AS9102 First Article Inspection Report</h2><span className="pill kitting">Not started</span></div><div className="panel-body"><p>{asText(oo.id)} is an FAI order. The FAIR (Forms 1, 2 and 3) is prefilled from the kit, the sub-assembly FAIRs and the ATP operations. The order cannot close until Skyryse QA approves it.</p>{qa ? <div className="fair-btns"><button className="btn primary" data-action="fair-start" data-order={oid}>Start the FAIR</button></div> : null}</div></section>;
    const f = oo.fair, edit = qa && f.status === 'Open' && oo.status !== 'Closed', snap = MES.fairSnapshot(state, oo), F1 = snap.form1, gaps = MES.fairReview(state, oo);
    const done = f.chars.filter(c => c.ok !== null).length;
    const dl = rows => <dl className="fair-dl">{rows.map(([n, k, v]) => <div key={n}><dt><span className="blk">{n}</span>{' '}{asText(k)}</dt><dd>{asText(v === '' || v == null ? '-' : v)}</dd></div>)}</dl>;
    const f1 = <><h3>Form 1 · Part number accountability</h3>{dl([['1', 'Part number', F1.partNumber], ['2', 'Part name', F1.partName], ['3', 'Serial number(s)', F1.serials.join(', ') || 'Lot-tracked'], ['4', 'FAIR identifier (WO / Lot / PO)', F1.fairId], ['5', 'Part revision level', F1.partRevision], ['6', 'Drawing number', F1.drawingNumber], ['7', 'Drawing revision level', F1.drawingRevision], ['9', 'Manufacturing process reference', F1.processReference], ['10', 'Organization name', F1.organization], ['13', 'Detail or assembly FAI', F1.detailOrAssembly], ['19', 'Does the FAIR contain a documented nonconformance?', F1.nonconformance + (F1.ncNumbers.length ? ` (${F1.ncNumbers.join(', ')})` : '')]])}
      {edit ? <form className="fair-form" data-form="fair-header" data-order={oid}><div className="form-grid">
        <div className="field"><label><span className="blk">11</span>{' '}Supplier code (CAGE)</label><input name="supplierCode" maxLength={12} className="mono" defaultValue={asText(f.supplierCode)}/></div>
        <div className="field"><label><span className="blk">12</span>{' '}Purchase order number</label><input name="po" maxLength={40} className="mono" defaultValue={asText(f.po)} placeholder="Internal build: leave blank"/></div>
        <div className="field"><label>Sample size (block 3A)</label><input name="sampleSize" type="number" min="1" max={oo.quantity} defaultValue={f.sampleSize ?? ''}/></div>
        <div className="field wide"><label><span className="blk">8</span>{' '}Additional changes (ECO, MCR, SEP deviation tickets)</label><input name="additionalChanges" maxLength={400} defaultValue={asText(f.additionalChanges)}/></div>
        <fieldset className="field wide fair-reasons"><legend><span className="blk">14</span>{' '}FAI type and reason</legend><div className="fair-type-row">{MES.FAIR_TYPES.map(t => <label key={t} className="check-label"><input type="radio" name="type" value={t} defaultChecked={t === f.type}/><span>{t} FAI</span></label>)}</div><div className="fair-type-row">{MES.FAIR_REASONS.map(r => <label key={r} className="check-label"><input type="checkbox" name="reasons" value={r} defaultChecked={F1.reasons.includes(r)}/><span>{asText(r)}</span></label>)}</div></fieldset>
        <div className="field"><label>Baseline part number incl. revision (partial)</label><input name="baselinePart" maxLength={80} defaultValue={asText(f.baselinePart)}/></div>
        <div className="field"><label>Baseline FAIR identifier (partial)</label><input name="baselineFair" maxLength={60} defaultValue={asText(f.baselineFair)}/></div>
        <div className="field wide"><label>Reason for partial FAI</label><input name="reason" maxLength={300} defaultValue={asText(f.reason)}/></div>
        <div className="field wide"><label><span className="blk">26</span>{' '}Comments</label><textarea name="comments" rows={2} maxLength={1000} defaultValue={asText(f.comments)}/></div>
      </div><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Save Form 1</button></div></form>
      : dl([['11', 'Supplier code', f.supplierCode], ['12', 'PO number', f.po], ['8', 'Additional changes', f.additionalChanges || 'None'], ['14', 'FAI type and reason', `${f.type} · ${f.reasons.join(', ')}${f.type === 'Partial' ? ` · baseline ${f.baselinePart} / ${f.baselineFair} · ${f.reason}` : ''}`], ['26', 'Comments', f.comments]])}
      <h4>Index of part numbers or sub-assembly numbers (blocks 15 to 18)</h4>
      {edit ? <form data-form="fair-index" data-order={oid}><div className="table-wrap"><table className="data-table fair-table"><thead><tr><th scope="col">15 · Part number</th><th scope="col">16 · Part name</th><th scope="col">17 · Part type</th><th scope="col">18 · FAIR or lot identifier</th></tr></thead><tbody>{[...f.index, { pn: '', name: '', type: 'Detail', fairId: '' }].map((x, i) => <tr key={i} data-index-row=""><td><input name="pn" maxLength={50} className="mono" defaultValue={asText(x.pn)} aria-label={`Index ${i + 1} part number`}/></td><td><input name="name" maxLength={120} defaultValue={asText(x.name)} aria-label={`Index ${i + 1} part name`}/></td><td><select name="type" aria-label={`Index ${i + 1} type`} defaultValue={x.type}>{MES.INDEX_TYPES.map(t => <option key={t}>{t}</option>)}</select></td><td><input name="fairId" maxLength={60} className="mono" defaultValue={asText(x.fairId)} aria-label={`Index ${i + 1} FAIR or lot identifier`}/></td></tr>)}</tbody></table></div><p className="small muted">The last row is blank: fill it to add a line. Clear a part number to remove its line.</p><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Save index</button></div></form>
      : <div className="table-wrap"><table className="data-table fair-table"><thead><tr><th scope="col">15 · Part number</th><th scope="col">16 · Part name</th><th scope="col">17 · Type</th><th scope="col">18 · FAIR / lot</th></tr></thead><tbody>{f.index.length ? f.index.map((x, i) => <tr key={i}><td className="mono">{asText(x.pn)}</td><td>{asText(x.name)}</td><td>{asText(x.type)}</td><td className="mono">{asText(x.fairId)}</td></tr>) : <tr><td colSpan={4} className="muted">None</td></tr>}</tbody></table></div>}</>;
    const f2 = <><h3>Form 2 · Product accountability: materials, special processes and functional testing</h3>
      <div className="table-wrap"><table className="data-table fair-table"><thead><tr><th scope="col">Kind</th><th scope="col">5 · Material or process name</th><th scope="col">6 · Specification number</th><th scope="col">7 · Code</th><th scope="col">8 · Supplier (name and address)</th><th scope="col">9 · Customer approval verification</th><th scope="col">10 · CoC number</th>{edit ? <th scope="col"><span className="sr-only">Remove</span></th> : null}</tr></thead><tbody>{f.form2.length ? f.form2.map((x, i) => <tr key={i}><td>{asText(x.kind)}</td><td>{asText(x.name)}</td><td className="mono">{asText(x.spec)}</td><td className="mono">{asText(x.code)}</td><td>{asText(x.supplier)}</td><td>{asText(x.approval)}</td><td className="mono">{asText(x.coc)}</td>{edit ? <td><button className="btn quiet" data-action="fair-f2-remove" data-order={oid} data-i={i}>Remove</button></td> : null}</tr>) : <tr><td colSpan={edit ? 8 : 7} className="muted">No materials or special processes yet. Specification numbers are entered verbatim from the drawing (type, temper, spec).</td></tr>}</tbody></table></div>
      {edit ? <form className="fair-form" data-form="fair-f2" data-order={oid}><div className="form-grid"><div className="field"><label>Kind</label><select name="kind">{MES.F2_KINDS.map(k => <option key={k}>{k}</option>)}</select></div><div className="field"><label>5 · Name</label><input name="name" maxLength={120} placeholder="Aluminum 6061-T6"/></div><div className="field"><label>6 · Specification</label><input name="spec" maxLength={120} className="mono" placeholder="AMS-QQ-A-250/11"/></div><div className="field"><label>7 · Code</label><input name="code" maxLength={40} className="mono"/></div><div className="field wide"><label>8 · Supplier name and address</label><input name="supplier" maxLength={160}/></div><div className="field"><label>9 · Customer approval verification</label><select name="approval"><option key="Yes">Yes</option><option key="No">No</option><option key="N/A">N/A</option></select></div><div className="field"><label>10 · CoC number</label><input name="coc" maxLength={60} className="mono"/></div></div><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Add to Form 2</button></div></form> : null}
      <h4>Functional testing (blocks 11 and 12)</h4>
      <div className="table-wrap"><table className="data-table fair-table"><thead><tr><th scope="col">11 · Functional test procedure number</th><th scope="col">12 · Acceptance report number</th><th scope="col">Software revision</th>{edit ? <th scope="col"><span className="sr-only">Actions</span></th> : null}</tr></thead><tbody>{f.tests.length ? f.tests.map((t, i) => edit ? (
        <tr key={i}><td><form id={`fair-test-${i}`} data-form="fair-test" data-order={oid} data-i={i}/><input form={`fair-test-${i}`} name="procedure" maxLength={80} defaultValue={asText(t.procedure)} aria-label={`Test ${i + 1} procedure`}/></td><td><input form={`fair-test-${i}`} name="report" maxLength={80} className="mono" defaultValue={asText(t.report)} aria-label={`Test ${i + 1} acceptance report`}/></td><td><input form={`fair-test-${i}`} name="software" maxLength={40} className="mono" defaultValue={asText(t.software)} aria-label={`Test ${i + 1} software revision`}/></td><td className="fair-row-btns"><button className="btn quiet" type="submit" form={`fair-test-${i}`}>Save</button><button className="btn quiet" data-action="fair-test-remove" data-order={oid} data-i={i}>Remove</button></td></tr>
      ) : (
        <tr key={i}><td>{asText(t.procedure)}</td><td className="mono">{asText(t.report)}</td><td className="mono">{asText(t.software)}</td></tr>
      )) : <tr><td colSpan={edit ? 4 : 3} className="muted">No functional tests.</td></tr>}</tbody></table></div>
      {edit ? <form className="fair-form fair-inline" data-form="fair-test-add" data-order={oid}><input name="procedure" maxLength={80} placeholder="Test procedure number" aria-label="New test procedure number"/><input name="report" maxLength={80} className="mono" placeholder="Acceptance report number" aria-label="New acceptance report number"/><input name="software" maxLength={40} className="mono" placeholder="Software rev" aria-label="New software revision"/><button className="btn" type="submit">Add test</button><p className="form-error" role="alert"/></form> : null}</>;
    const tk = o.tickets.map(t => t.id);
    const row = c => edit ? (
      <tr><td className="mono">{asText(c.id.slice(2))}</td><td>{asText(c.ref)}</td><td>{asText(c.designator)}</td><td>{asText(c.requirement)}</td><td colSpan={5}><form className="fair-res" data-form="fair-res" data-order={oid} data-char={asText(c.id)}><input name="result" defaultValue={asText(c.result)} maxLength={200} placeholder="9 · Result (measured value)" aria-label={`Result for characteristic ${asText(c.id.slice(2))}`}/><select name="ok" aria-label={`Conformance for ${asText(c.id.slice(2))}`} defaultValue={c.ok === true ? 'yes' : c.ok === false ? 'no' : ''}><option value="">Accept?</option><option value="yes">Conforms</option><option value="no">Nonconforming</option></select><input name="tool" defaultValue={asText(c.tool)} maxLength={80} placeholder="M&TE / tool no." aria-label={`M&TE for ${asText(c.id.slice(2))}`}/><input name="designedTooling" defaultValue={asText(c.designedTooling || '')} maxLength={80} placeholder="10 · Designed tool ID or gauge value" aria-label={`Designed or qualified tooling for ${asText(c.id.slice(2))}`}/><select name="nc" aria-label={`NC for ${asText(c.id.slice(2))}`} defaultValue={asText(c.nc || '')}><option value="">11 · NC</option>{tk.map(t => <option key={t}>{asText(t)}</option>)}</select><input name="comments" defaultValue={asText(c.comments)} maxLength={200} placeholder="12 · Comments" aria-label={`Comments for ${asText(c.id.slice(2))}`}/><button className="btn quiet" type="submit">Save</button><button className="btn quiet" type="button" data-action="fair-remove" data-order={oid} data-char={asText(c.id)}>Remove</button></form>{c.inspector ? <small>9A {asText(c.inspector)} · 9B {asText(c.date)}</small> : null}</td></tr>
    ) : (
      <tr><td className="mono">{asText(c.id.slice(2))}</td><td>{asText(c.ref)}</td><td>{asText(c.designator)}</td><td>{asText(c.requirement)}</td><td>{asText(c.result)}{' '}{c.ok === true ? <span className="pill closed">Conforms</span> : c.ok === false ? <span className="pill high">NC</span> : null}</td><td>{asText(c.inspector)}<small>{asText(c.date)}</small></td><td className="mono">{asText(c.designedTooling || '')}</td><td className="mono">{asText(c.tool)}</td><td className="mono">{asText(c.nc)}</td><td>{asText(c.comments)}</td></tr>
    );
    const f3 = <><h3>Form 3 · Characteristic accountability, verification and compatibility evaluation</h3><p className="small muted">Boxes 1A, 3A, 3B, inspector, date and M&amp;TE are Skyryse supplemental data; they print in a separate section below the AS9102 grid.</p>{dl([['1', 'Part number', F1.partNumber], ['1A', 'Revision', F1.partRevision], ['2', 'Part name', F1.partName], ['4', 'FAIR identifier (Work Order / Lot / PO)', F1.fairId], ['3', 'Serial number(s)', F1.serials.join(', ') || 'Lot-tracked'], ['3A', 'Sample size', f.sampleSize ?? 'Set on Form 1'], ['3B', 'Quantity', oo.quantity]])}
      <div className="table-wrap"><table className="data-table fair-table fair-chars"><thead><tr><th scope="col">5 · Char no.</th><th scope="col">6 · Reference location</th><th scope="col">7 · Designator</th><th scope="col">8 · Requirement</th>{edit ? <th scope="col" colSpan={5}>9 to 12 · Result, tooling, M&TE, NC, comments</th> : <><th scope="col">9 · Results</th><th scope="col">Inspector, date (supplemental)</th><th scope="col">10 · Designed / qualified tooling</th><th scope="col">M&TE (supplemental)</th><th scope="col">11 · Nonconformance number</th><th scope="col">12 · Additional data / comments</th></>}</tr></thead><tbody>{f.chars.length ? f.chars.map(c => <React.Fragment key={c.id}>{row(c)}</React.Fragment>) : <tr><td colSpan={10} className="muted">No characteristics yet. Balloon the drawing and add every characteristic; the number matches the balloon.</td></tr>}</tbody></table></div>
      {edit ? <form className="fair-form" data-form="fair-add" data-order={oid}><div className="form-grid"><div className="field"><label>5 · Char no. (balloon)</label><input name="no" inputMode="numeric" maxLength={4} className="mono" placeholder="Next"/></div><div className="field"><label>6 · Reference location</label><input name="ref" maxLength={80} placeholder="Sheet 1, zone B3"/></div><div className="field"><label>7 · Designator</label><select name="designator">{MES.FAIR_DESIGNATORS.map(d => <option key={d} value={d}>{d || 'None'}</option>)}</select></div><div className="field wide"><label>8 · Requirement (verbatim from the drawing)</label><input name="requirement" maxLength={200} placeholder="0.250 ±0.005 in"/></div></div><p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Add characteristic</button></div></form> : null}</>;
    const review = <><h3>Review IAW TR-850-001</h3>{gaps.length ? <ul className="conf-gaps">{gaps.map((g, i) => <li key={i}>{asText(g)}</li>)}</ul> : <p className="conf-ok"><Check size={14}/> Every block is filled, all {f.chars.length} characteristics are accounted for, and no NC is open.</p>}</>;
    const sigs = <><h3>Signatures</h3><div className="fair-sigs"><div><p className="small muted">Blocks 20 and 21 · FAIR verified by</p>{f.verified ? <p><strong>{asText(f.verified.by.name)}</strong>{f.verified.by.override ? ' · Master Access override' : null}{f.verified.by.stamp ? <> · stamp {asText(f.verified.by.stamp.number)}</> : null}<br/><span className="mono">{asText(f.verified.at.slice(0, 10))}</span></p> : edit ? <form data-form="fair-verify" data-order={oid}>{fairPin('Your stamp PIN')}<p className="form-error" role="alert"/><div className="fair-btns"><button className="btn primary" type="submit" disabled={gaps.length > 0} title={gaps.length ? 'Clear the review items first' : undefined}>Verify FAIR</button></div></form> : <p className="muted">Not verified</p>}</div>
      <div><p className="small muted">Blocks 22 and 23 · FAIR reviewed / approved by (a second person)</p>{f.reviewed ? <p><strong>{asText(f.reviewed.by.name)}</strong>{f.reviewed.by.override ? ' · Master Access override' : null}{f.reviewed.by.stamp ? <> · stamp {asText(f.reviewed.by.stamp.number)}</> : null}<br/><span className="mono">{asText(f.reviewed.at.slice(0, 10))}</span></p> : f.status === 'Verified' && qa ? <form data-form="fair-review" data-order={oid}><p className="small muted">AS9102 Rev C: someone other than the verifier reviews and approves the FAIR here. The Skyryse QA approval waits for it.</p>{fairPin('Your stamp PIN')}<p className="form-error" role="alert"/><div className="fair-btns"><button className="btn" type="submit">Sign box 22</button></div></form> : <p className="muted">{f.status === 'Open' ? 'After verification' : f.status === 'Approved' ? 'Approved before box 22 was required; the verifier covers boxes 22 and 23' : 'Waiting for a second person'}</p>}</div>
      <div><p className="small muted">Skyryse QA approval (supplemental; boxes 24 and 25 are left for a customer)</p>{f.approved ? <p><strong>{asText(f.approved.by.name)}</strong>{f.approved.by.override ? ' · Master Access override' : null}{f.approved.by.stamp ? <> · stamp {asText(f.approved.by.stamp.number)}</> : null}<br/><span className="mono">{asText(f.approved.at.slice(0, 10))}</span></p> : f.status === 'Verified' && f.reviewed && qa ? <form data-form="fair-approve" data-order={oid}>{fairPin('Your stamp PIN')}<p className="form-error" role="alert"/><div className="fair-btns"><button className="btn primary" type="submit">Approve FAIR</button></div></form> : <p className="muted">{f.status === 'Verified' ? 'Waiting for box 22' : 'Waiting for verification'}</p>}</div></div></>;
    const actions = <div className="fair-btns"><button className="btn" data-action="fair-print" data-order={oid}>Print FAIR</button><button className="btn" data-action="fair-download" data-order={oid}>Download FAIR (Forms 1, 2, 3)</button>{qa && f.status !== 'Open' && oo.status !== 'Closed' ? <button className="btn quiet" data-action="fair-reopen" data-order={oid}>Reopen</button> : null}</div>;
    const pages = [['1', 'Form 1', f1], ['2', 'Form 2', f2], ['3', 'Form 3', f3], ['sign', 'Review and sign', <>{review}{sigs}</>]], cur = pages.some(x => x[0] === fairPage) ? fairPage : '1';
    return <section className="panel fair-panel" id="fair-panel"><div className="panel-head"><h2>AS9102 FAIR · {asText(F1.fairId)}</h2><span className={`pill ${f.status === 'Approved' ? 'closed' : f.status === 'Verified' ? 'quality' : 'kitting'}`}>{f.status === 'Open' ? `${done} / ${f.chars.length} results` : asText(f.status)}</span></div><div className="panel-body">
      <p className="small muted">AS9102 Rev C forms, one page each. Form 1 and the index are prefilled from the kit and sub-assembly FAIRs; Form 2 tests from the ATP operations. The work order cannot close until Skyryse QA approves the FAIR.</p>{actions}<div className="fair-pages" role="tablist" aria-label="FAIR forms">{pages.map(([k, label]) => <button key={k} type="button" role="tab" className={`btn ${k === cur ? '' : 'quiet'}`} data-fair-page={k} aria-selected={k === cur} aria-controls={`fair-page-${k}`} id={`fair-tab-${k}`}>{label}{k === 'sign' && gaps.length ? ` (${gaps.length})` : null}</button>)}</div>{pages.map(([k, , html]) => <div key={k} className="fair-page" role="tabpanel" id={`fair-page-${k}`} aria-labelledby={`fair-tab-${k}`} hidden={k !== cur}>{html}</div>)}</div></section>;
  };
  const ticketRow = (oo, t) => <button className="linked-row ticket-row" data-action="ticket" data-ticket={asText(t.id)}><Shield size={16}/><span><strong>{asText(t.id)} · {asText(t.title)}</strong><small>Operation {operationNumber(oo, t.operationId)} · {asText(ticketLabel(t))}</small></span><ChevronRight size={16}/></button>;
  const reportRow = (oo, r) => <button className="linked-row report-row" data-action="atp-report" data-report={asText(r.id)}><FileText size={16}/><span><strong>{asText(r.title)}</strong><small className="mono">{asText(r.id)} · Op {operationNumber(oo, r.operationId)} · Rev {asText(r.revision)}</small></span><span className={`report-result ${r.result === 'Pass' ? 'pass' : r.result === 'Fail' ? 'fail' : ''}`}>{asText(r.result)}</span><ExternalLink size={16}/></button>;
  return <div className="quality-records">
    {fairPanel(o)}
    {confPanel(o)}
    <section className="panel"><div className="panel-head"><h2>NC tickets</h2><span className="mono">{o.tickets.length} linked</span></div><div className="panel-body">{o.tickets.length ? o.tickets.map(t => <React.Fragment key={t.id}>{ticketRow(o, t)}</React.Fragment>) : <p className="muted small">No tickets.</p>}</div></section>
    <section className="panel"><div className="panel-head"><h2>ATP test reports</h2><span className="mono">{o.reports.length} linked</span></div><div className="panel-body">{o.reports.length ? o.reports.map(r => <React.Fragment key={r.id}>{reportRow(o, r)}</React.Fragment>) : <p className="small muted">No ATP reports linked to this work order.</p>}<p className="small muted" style={{ marginTop: 16 }}/></div></section>
  </div>;
}

const slackLogoSource = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTQiIGhlaWdodD0iNTQiIHZpZXdCb3g9IjAgMCA1NCA1NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzQxMjdfNzAxMDUpIj4KPHBhdGggZD0iTTExLjM3OSAzMy45OTkzQzExLjM3OSAzNy4xMzU4IDguODQ1MTIgMzkuNjUwNyA1LjcyNzYgMzkuNjUwN0MyLjYxMDA4IDM5LjY1MDcgMC4wNTcyMjA1IDM3LjExNjggMC4wNTcyMjA1IDMzLjk5OTNDMC4wNTcyMjA1IDMwLjg4MTcgMi41OTExIDI4LjM0NzkgNS43MDg2MiAyOC4zNDc5SDExLjM2VjMzLjk5OTNIMTEuMzc5WiIgZmlsbD0iI0UzMDY2QSIvPgo8cGF0aCBkPSJNMTQuMTk2MiAzMy45OTk3QzE0LjE5NjIgMzAuODYzMiAxNi43MzAxIDI4LjM0ODMgMTkuODQ3NiAyOC4zNDgzQzIyLjk2NTEgMjguMzQ4MyAyNS40OTkgMzAuODgyMiAyNS40OTkgMzMuOTk5N1Y0OC4xMzUzQzI1LjQ5OSA1MS4yNzE4IDIyLjk2NTEgNTMuNzg2NyAxOS44NDc2IDUzLjc4NjdDMTYuNzMwMSA1My43ODY3IDE0LjE5NjIgNTEuMjcxOCAxNC4xOTYyIDQ4LjEzNTNWMzMuOTk5N1oiIGZpbGw9IiNFMzA2NkEiLz4KPHBhdGggZD0iTTE5Ljg2NjIgMTEuMjY3M0MxNi43Mjk2IDExLjI2NzMgMTQuMjE0OCA4LjczMzQ3IDE0LjIxNDggNS42MTU5NEMxNC4yMTQ4IDIuNDk4NDIgMTYuNzQ4NiAtMC4wMzU0NTM4IDE5Ljg2NjIgLTAuMDM1NDUzOEMyMi45ODM3IC0wLjAzNTQ1MzggMjUuNTE3NSAyLjQ5ODQyIDI1LjUxNzUgNS42MTU5NFYxMS4yNjczSDE5Ljg2NjJaIiBmaWxsPSIjMDBCM0ZGIi8+CjxwYXRoIGQ9Ik0xOS44NjgyIDE0LjEzMzRDMjMuMDA0NyAxNC4xMzM0IDI1LjUxOTYgMTYuNjY3MyAyNS41MTk2IDE5Ljc4NDhDMjUuNTE5NiAyMi45MDIzIDIyLjk4NTcgMjUuNDM2MiAxOS44NjgyIDI1LjQzNjJINS42NzU2NkMyLjUzOTE2IDI1LjQzNjIgMC4wMjQyNjE1IDIyLjkwMjMgMC4wMjQyNjE1IDE5Ljc4NDhDMC4wMjQyNjE1IDE2LjY2NzMgMi41NTgxNCAxNC4xMzM0IDUuNjc1NjYgMTQuMTMzNEgxOS44NjgyWiIgZmlsbD0iIzAwQjNGRiIvPgo8cGF0aCBkPSJNNDIuNTMyMyAxOS43ODUzQzQyLjUzMjMgMTYuNjQ4OCA0NS4wNjYyIDE0LjEzMzkgNDguMTgzNyAxNC4xMzM5QzUxLjMwMTIgMTQuMTMzOSA1My44MzUxIDE2LjY2NzggNTMuODM1MSAxOS43ODUzQzUzLjgzNTEgMjIuOTAyOCA1MS4zMDEyIDI1LjQzNjcgNDguMTgzNyAyNS40MzY3SDQyLjUzMjNWMTkuNzg1M1oiIGZpbGw9IiM0MUI2NTgiLz4KPHBhdGggZD0iTTM5LjcxMjYgMTkuNzkzNEMzOS43MTI2IDIyLjkyOTkgMzcuMTc4NyAyNS40NDQ4IDM0LjA2MTIgMjUuNDQ0OEMzMC45NDM2IDI1LjQ0NDggMjguNDA5OCAyMi45MTEgMjguNDA5OCAxOS43OTM0VjUuNjE5ODZDMjguNDA5OCAyLjQ4MzM2IDMwLjk0MzYgLTAuMDMxNTM5OSAzNC4wNjEyIC0wLjAzMTUzOTlDMzcuMTc4NyAtMC4wMzE1Mzk5IDM5LjcxMjYgMi40ODMzNiAzOS43MTI2IDUuNjE5ODZWMTkuNzkzNFoiIGZpbGw9IiM0MUI2NTgiLz4KPHBhdGggZD0iTTM0LjAzNzYgNDIuNDgyQzM3LjE3NDEgNDIuNDgyIDM5LjY4OSA0NS4wMTU4IDM5LjY4OSA0OC4xMzM0QzM5LjY4OSA1MS4yNTA5IDM3LjE1NTIgNTMuNzg0OCAzNC4wMzc2IDUzLjc4NDhDMzAuOTIwMSA1My43ODQ4IDI4LjM4NjIgNTEuMjUwOSAyOC4zODYyIDQ4LjEzMzRWNDIuNDgySDM0LjAzNzZaIiBmaWxsPSIjRkNDMDAzIi8+CjxwYXRoIGQ9Ik0zNC4wMzgxIDM5LjY1MDdDMzAuOTAxNiAzOS42NTA3IDI4LjM4NjcgMzcuMTE2OCAyOC4zODY3IDMzLjk5OTNDMjguMzg2NyAzMC44ODE4IDMwLjkyMDYgMjguMzQ3OSAzNC4wMzgxIDI4LjM0NzlINDguMjMwNkM1MS4zNjcxIDI4LjM0NzkgNTMuODgyIDMwLjg4MTggNTMuODgyIDMzLjk5OTNDNTMuODgyIDM3LjExNjggNTEuMzQ4MiAzOS42NTA3IDQ4LjIzMDYgMzkuNjUwN0gzNC4wMzgxWiIgZmlsbD0iI0ZDQzAwMyIvPgo8L2c+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAwXzQxMjdfNzAxMDUiPgo8cmVjdCB3aWR0aD0iNTQiIGhlaWdodD0iNTQiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==';
const slackLogo = () => (<img className="slack-logo" src={slackLogoSource} width={32} height={32} alt="Slack" />);
const WrenchSvg = () => (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.6-.6-2.3 2.5-2.7Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>);
const calloutIcon = (c, size) => c === 'ESD' ? <Zap size={size}/> : c === 'FOD' ? <Ban size={size}/> : c === 'MSDS' ? <TriangleAlert size={size}/> : <FileText size={size}/>;
const stepsDone = op => { const steps = (op && op.steps) || []; if (!steps.length) return false; const checks = (op && op.stepChecks) || {}; return steps.every(s => checks[s.id]); };
const discussionKey = (orderId, opId) => `${orderId}/${opId}`;
const mediaSize = size => size < 1024 * 1024 ? Math.max(1, Math.round(size / 1024)) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB';
const messageAudienceLabel = audience => audience.type === 'person' ? `@${audience.label.replace(/^@/, '')}` : `#${audience.label.replace(/^#/, '')}`;
const accountActor = () => (typeof window !== 'undefined' && window.skAuth && typeof window.skAuth.actor === 'function') ? window.skAuth.actor() : null;

function ExecutionTab({ state, MES, order, selectedOp, skCan }) {
  const o = order;
  const next = currentIndex(o);
  const selOp = o.operations.some(op => op.id === selectedOp) ? selectedOp : o.operations[next].id;
  const op = o.operations.find(x => x.id === selOp);
  const index = o.operations.indexOf(op);
  const active = o.status === 'Building' && !op.done && index === next && !MES.engineeringChange(o) && !MES.pendingSequenceChange(o);
  const complete = doneCount(o);
  const gate = MES.inspectionGate(o, index);
  const mediaEditable = (ord, opp) => ord.status === 'Building' && !MES.engineeringChange(ord) && !opp.done && ord.operations.find(item => !item.done) === opp && !MES.blockingTickets(ord, opp.id).length;
  const messageTargets = (opp, type) => {
    if (type === 'person') return MES.MESSAGE_TARGETS.people;
    if (type !== 'thread') return [];
    return [...MES.MESSAGE_TARGETS.threads, ...(opp.slackThread && MES.slackThreadValid(opp.slackThread) ? [{ id: 'linked-thread', label: opp.slackThread.label }] : [])];
  };
  const stepCapturedTools = opp => { const checks = opp && opp.stepChecks && typeof opp.stepChecks === 'object' ? opp.stepChecks : {}; const steps = (opp && opp.steps) || []; const out = []; steps.forEach((step, i) => { const c = checks[step.id]; if (!c || !c.torque || !c.torque.tool) return; out.push({ tag: c.torque.tool, step: MES.stepLetter(i), torque: { value: c.torque.value, unit: c.torque.unit } }); }); return out; };
  const masterBuyoffNotice = () => {
    const a = MES.masterAccess();
    return a ? <div className="stamp-check ok"><Shield size={16}/><div><strong>Master Access override · {asText(a.name)}</strong><small>All buy-off types · {asText(a.credentialId)}. No stamp number or PIN required. Recorded as an administrative override, not an issued stamp.</small></div></div> : null;
  };
  const holdActionButtons = (ord, h) => {
    const me = skActorId(state);
    const out = [];
    if (/^Engineering change/.test(h.label)) { const ec = MES.engineeringChange(ord); if (skCan('approve-wo')) out.push(['ec-reject', 'Reject']); if (ec && ec.requestedBy?.credentialId === me) out.push(['ec-withdraw', 'Withdraw']); }
    if (/^Operation sequence change/.test(h.label)) { const sc = MES.pendingSequenceChange(ord); if (skCan('approve-wo')) out.push(['seq-reject', 'Reject']); if (sc && sc.entries.some(e => e.by?.credentialId === me)) out.push(['seq-withdraw', 'Withdraw']); }
    if (/^Pedigree change/.test(h.label)) { if (skCan('approve-pedigree')) out.push(['pedigree-reject', 'Reject']); if (ord.pedigreeChange?.requestedBy?.credentialId === me) out.push(['pedigree-withdraw', 'Withdraw']); }
    return out.map(([k, l]) => <button key={k} type="button" className="btn quiet hold-act" data-action="reject-item" data-kind={k}>{l}</button>);
  };
  const trainingFlag = (holder, opp) => {
    const need = MES.requiredTrainings(opp, state);
    if (!need.length) return null;
    const day = new Date().toISOString().slice(0, 10);
    const bad = need.map(k => ({ k, t: MES.trainingStatus(holder, k, day, state) })).filter(x => !x.t.ok);
    const label = k => { const d = MES.trainingDef(k, state); return d ? `${d.name} (${k})` : k; };
    return bad.length ? <div className="inline-info warning" role="status"><Lock size={16}/><p><strong>Training check at check-in</strong><br/>{bad.map((x, i) => <span key={x.k}>{i > 0 ? ' ' : null}{asText(label(x.k))} training for {asText(holder.name)} is {x.t.state === 'expired' ? <>expired ({asText(x.t.expires)})</> : x.t.state === 'retrain' ? <>from before {asText(x.t.qmsDoc)} Rev {asText(x.t.qmsRev)}, which requires retraining</> : 'not on record'}.</span>)}{bad.length ? ' The training record must be current before this operation is bought off.' : null}</p></div> : <p className="small muted">Training current: {need.map((k, i) => <span key={k}>{i > 0 ? ' · ' : null}{asText(k)} to {asText(MES.trainingStatus(holder, k, day, state).expires)}</span>)}</p>;
  };
  const calloutBadges = opp => Array.isArray(opp?.callouts) && opp.callouts.length ? <span className="callouts" role="list" aria-label="Operation callouts">{opp.callouts.map(c => <React.Fragment key={c}><span className={`callout callout-${c.toLowerCase()}`} role="listitem" title={c === 'FOD' && opp.fodLevel ? FOD_INFO[opp.fodLevel].label : (CALLOUT_TEXT[c] || c)}>{calloutIcon(c, 14)}<span>{c === 'FOD' && opp.fodLevel === 'critical' ? 'FOD critical' : c}</span><span className="sr-only"> · {c === 'FOD' && opp.fodLevel ? FOD_INFO[opp.fodLevel].label : (CALLOUT_TEXT[c] || c)}</span></span>{c === 'FOD' && opp.fodLevel === 'critical' ? <span className="callout callout-tool" role="listitem" title="Tool control required"><WrenchSvg/><span>Tool control</span></span> : null}</React.Fragment>)}</span> : null;
  const msdsLinkList = opp => {
    const links = [...(opp.msdsLinks || [])];
    const book = MES.msdsBook(state);
    if (book) links.push({ label: book.label, url: book.url, book: true });
    return links.length ? <ul className="msds-links">{links.map((l, i) => <li key={i}><a href={asText(l.url)} target="_blank" rel="noopener">{asText(l.label)}{l.book ? ' (master book)' : ''} <ExternalLink size={14}/></a></li>)}</ul> : null;
  };
  const fodChecklistBlock = opp => {
    const done = opp.fodChecklist || {};
    const locked = !order || order.status !== 'Building' || opp.done || !skCan('operate-steps');
    const checklist = MES.FOD_CHECKLIST;
    const n = checklist.filter(i => done[i.id]).length;
    return <div className="fod-checklist" data-order={asText(order ? order.id : '')} data-op={asText(opp.id)}><div className="fod-checklist-head"><strong>Digital FOD checklist</strong><span className="mono">{n} / {checklist.length}</span></div>{['Before start', 'Close-out'].map(ph => <React.Fragment key={ph}><p className="fod-phase">{ph}</p><ul className="fod-items">{checklist.filter(i => i.phase === ph).map(i => <li key={i.id}><label className="check-label"><input type="checkbox" data-fod-item={i.id} defaultChecked={!!done[i.id]} disabled={locked}/><span>{asText(i.text)}{done[i.id] ? <small className="muted"> · {asText(done[i.id].name || '')} · {legacyDateTime(done[i.id].at)}</small> : null}</span></label></li>)}</ul></React.Fragment>)}</div>;
  };
  const calloutReminders = opp => Array.isArray(opp?.callouts) && opp.callouts.length ? <>{opp.callouts.map(c => <React.Fragment key={c}><div className={`inline-info callout-reminder callout-reminder-${c.toLowerCase()}`} role="status">{calloutIcon(c, 16)}<p><strong>{asText(c)} operation{c === 'ESD' && opp.grounding ? <> · {asText(GROUNDING_LABEL[opp.grounding])}</> : null}{c === 'FOD' ? <> · {asText((FOD_INFO[opp.fodLevel] || FOD_INFO.awareness).label)}</> : null}</strong><br/>{asText((CALLOUT_REMINDER[c] || (() => ''))(opp))}{c === 'MSDS' ? msdsLinkList(opp) : null}</p></div>{c === 'FOD' && opp.fodLevel === 'critical' ? <><div className="inline-info callout-reminder callout-reminder-tool" role="status"><Wrench size={16}/><p><strong>Tool control · FOD Critical Area</strong><br/>{asText(TOOL_CONTROL)}</p></div>{fodChecklistBlock(opp)}</> : null}</React.Fragment>)}</> : null;
  const stdInspBanner = (opp, hidden) => {
    if (!MES.isInspectionOp(opp)) return null;
    return <div className="std-insp" role="note" hidden={hidden ? true : undefined}><Shield size={16}/><div><strong>{asText(MES.STD_INSPECTION.title)}</strong><p>{asText(MES.STD_INSPECTION.text)}</p></div></div>;
  };
  const linkedNcBlock = (ord, opp) => {
    if (!['Rework', 'Repair'].includes(opp.classification)) return null;
    const t = opp.ticketId ? ord.tickets.find(x => x.id === opp.ticketId) : ord.tickets.find(x => x.reworkPlan && x.reworkPlan.opId === opp.id);
    if (t) return <div className="linked-nc" role="note"><Link size={16}/><p><span>Linked {asText(t.type)}</span> <button type="button" className="order-link" data-action="ticket" data-ticket={asText(t.id)}>{asText(t.id)}</button> · {asText(t.title)} · {asText(t.status)}{t.dispo ? <> · {asText(t.dispo.decision)}</> : null}</p></div>;
    return !opp.done && skCan('adjust-wo') && ord.tickets.length ? <form className="linked-nc linked-nc-form" data-form="op-nc-link" data-order={asText(ord.id)} data-op={asText(opp.id)}><CircleAlert size={16}/><label htmlFor={`op-nc-${asText(opp.id)}`}>This {asText(opp.classification.toLowerCase())} operation is not linked to an NC</label><select id={`op-nc-${asText(opp.id)}`} name="ticketId">{ord.tickets.map(x => <option key={x.id} value={asText(x.id)}>{asText(x.id)} · {asText(x.title)}</option>)}</select><button className="btn" type="submit">Link</button></form> : null;
  };
  const renderSequenceTools = ord => {
    const pending = MES.pendingSequenceChange(ord);
    const editable = ['Draft', 'Kitting', 'Building'].includes(ord.status) && !MES.engineeringChange(ord);
    const selected = ord.operations.find(item => item.id === selOp);
    const editableOp = editable && selected && !selected.done && ord.operations.indexOf(selected) >= MES.firstInsertIndex(ord);
    const removable = editable && selected && !selected.done && ord.operations.indexOf(selected) >= MES.firstInsertIndex(ord) && ord.operations.length > 1;
    const canApprove = skCan('approve-wo') && pending && !pending.entries.some(e => e.by?.credentialId === skActorId(state));
    return <div className="sequence-tools">
      {pending ? <div className="seq-pending" role="status"><details className="seq-pending-detail"><summary className="seq-pending-title"><Lock size={16}/><strong>Sequence change awaiting QA release</strong><span className="seq-pending-count">{pending.entries.length}</span></summary><ul>{pending.entries.map((e, i) => <li key={i}><span className={`seq-change ${e.type}`}>{e.type === 'add' ? 'Added' : e.type === 'edit' ? 'Edited' : 'Removed'}</span> Op {asText(e.position)} · {asText(e.title)}{e.classification ? <span className="op-class">{asText(e.classification)}</span> : null}{e.changes && e.changes.length ? <small>Changed: {asText(e.changes.join(', '))}</small> : null}{e.reason ? <small>Reason: {asText(e.reason)}</small> : null}</li>)}</ul><p className="small">Changed by {asText(pending.requestedBy.name)}. Buy-offs and issue are held until QA releases the sequence.</p></details><div className="seq-actions"><button className="btn primary" data-action="seq-approve" disabled={!canApprove}>QA release sequence</button>{canApprove ? null : <p className="small seq-block" role="status">{pending.entries.some(e => e.by?.credentialId === skActorId(state)) ? 'You made this change, so you cannot release it. A different Quality Engineering or QA Manager account must release the sequence.' : 'Only a Quality Engineering or QA Manager account can release the sequence.'}</p>}</div></div> : null}
      {editable ? <div className="seq-edit"><button className="btn" data-action="seq-add"><Plus size={16}/> Add operation</button>{editableOp && !selected.fromStandardRework ? <button className="btn" data-action="seq-edit" data-op={asText(selected.id)}>Edit Op {operationNumber(ord, selected.id)}</button> : null}{editableOp && selected.fromStandardRework ? <span className="pill" title="Added from a QA-approved standard rework; locked as approved"><Lock size={16}/> {asText(selected.fromStandardRework)}{selected.standardRev ? <> Rev {asText(selected.standardRev)}</> : null} · locked</span> : null}{selected && ['Rework', 'Repair'].includes(selected.classification) && skCan('adjust-wo') ? <button className="btn quiet" data-action="std-rw-save-op" data-order={asText(ord.id)} data-op={asText(selected.id)} title="Save this operation and its inspection to the standard rework library as a Draft pair for QA approval">Save as standard rework</button> : null}{removable ? <button className="btn" data-action="seq-remove" data-op={asText(selected.id)}>Remove Op {operationNumber(ord, selected.id)}</button> : null}</div> : null}
    </div>;
  };
  const renderCompletedSteps = (ord, opp, steps) => {
    const checks = opp.stepChecks || {};
    const checked = steps.filter(step => checks[step.id]).length;
    return <section className="stepper done-steps" aria-label="Operation steps as completed"><div className="stepper-head"><h3>Operation steps · as completed</h3><span className="stepper-count mono">{checked} / {steps.length} checked</span></div>
      <ol className="wi-steps done-step-list">{steps.map(step => {
        const check = checks[step.id];
        return <li key={step.id} className={check ? 'checked' : ''}><strong>{asText(step.title)}</strong><p>{asText(step.instruction)}</p>{step.image ? <img className="step-thumb" src={asText(step.image.dataUrl)} alt={asText(step.image.caption || step.title)} loading="lazy"/> : null}{check ? <small>{asText(check.name)} · {asText(check.credentialId)} · {asText(buyoffDate(check.at))}{check.torque ? <> · torque {asText(check.torque.value)} {asText(check.torque.unit)} with {asText(check.torque.tool)}</> : null}</small> : <small className="muted">No step record was captured for this completion.</small>}</li>;
      })}</ol></section>;
  };
  const renderStepConsumables = (key, step) => {
    const draftKey = `${key}/${step.id}`, d = stepConsumableDrafts.get(draftKey) || {};
    return <div className="step-consumables" data-key={asText(draftKey)} role="group" aria-label="Consumables used"><p className="step-consumables-title">Consumables used · lot and shelf life</p>{step.consumables.map(name => <div key={name} className="consumable-row" data-name={asText(name)}><strong>{asText(name)}</strong><label><span>Lot #</span><input className="mono" data-field="lot" maxLength="40" autoComplete="off" spellCheck={false} defaultValue={asText(d[name]?.lot || '')} aria-label={`${asText(name)} lot number`}/></label><label><span>Shelf life expires</span><input type="date" data-field="expires" defaultValue={asText(d[name]?.expires || '')} aria-label={`${asText(name)} shelf-life expiration`}/></label></div>)}</div>;
  };
  const renderStepTorque = (key, step) => {
    const draftKey = `${key}/${step.id}`, d = stepTorqueDrafts.get(draftKey) || {};
    const tools = MES.calibratedToolChecks(state, new Date().toISOString()).filter(c => c.ok && MES.isTorqueTool(c.tool)).map(c => c.tool);
    return <div className="step-torque" data-key={asText(draftKey)} role="group" aria-label="Torque record"><div className="field"><label htmlFor="step-torque-tool">Torque tool · calibrated</label><input id="step-torque-tool" className="mono" list="step-torque-tools" autoComplete="off" spellCheck={false} maxLength="40" placeholder="Asset tag, e.g. SR0149" defaultValue={asText(d.tool || '')}/><datalist id="step-torque-tools">{tools.map(tool => <option key={tool.tag} value={asText(tool.tag)}>{asText(tool.description)} · cal due {asText(tool.expires)}</option>)}</datalist></div><div className="field"><label htmlFor="step-torque-value">Torque value</label><div className="torque-inputs"><input id="step-torque-value" inputMode="decimal" autoComplete="off" maxLength="10" placeholder="e.g. 25" defaultValue={asText(d.value || '')}/><select id="step-torque-unit" aria-label="Torque unit" defaultValue={d.unit || 'in-lb'}>{MES.TORQUE_UNITS.map(unit => <option key={unit}>{unit}</option>)}</select></div></div></div>;
  };
  const renderSteps = (ord, opp, isActive) => {
    const steps = Array.isArray(opp.steps) ? opp.steps : [];
    if (!steps.length) return null;
    if (opp.done) return renderCompletedSteps(ord, opp, steps);
    const checks = opp.stepChecks || {}, key = `${ord.id}/${opp.id}`;
    const checkedCount = steps.filter(s => checks[s.id]).length, firstOpen = steps.findIndex(s => !checks[s.id]);
    const i = Math.max(0, Math.min(steps.length - 1, stepIndex.has(key) ? stepIndex.get(key) : firstOpen < 0 ? steps.length - 1 : firstOpen));
    stepIndex.set(key, i);
    const step = steps[i], check = checks[step.id];
    const earlierOpen = !check && steps.slice(0, i).some(s => !checks[s.id]);
    const laterChecked = !!check && steps.slice(i + 1).some(s => checks[s.id]);
    const stepGate = MES.inspectionGate(ord, ord.operations.indexOf(opp));
    const canCheck = isActive && !opp.done && !stepGate && !MES.blockingTickets(ord, opp.id).length;
    const note = opp.done ? (checkedCount ? null : <p className="small muted">Bought off before step tracking was added.</p>) : stepGate ? <p className="step-locked"><Lock size={14}/> Locked behind inspection point Op {operationNumber(ord, stepGate.id)} · {asText(stepGate.title)}.</p> : null;
    return <section className={`stepper ${canCheck ? 'stepper-live' : ''} ${opp.done ? 'stepper-done' : ''}`} aria-labelledby={`stepper-title-${asText(opp.id)}`}>
      <div className="stepper-head"><h3 id={`stepper-title-${asText(opp.id)}`}>Operation steps</h3><span className="stepper-count mono">{checkedCount} / {steps.length} checked</span></div>
      <div className="stepper-progress" aria-hidden="true"><span style={{ width: `${Math.round(checkedCount / steps.length * 100)}%` }}/></div>
      <ol className="step-dots" aria-label="Jump to step">{steps.map((s, n) => <li key={s.id}><button type="button" className={`step-dot ${checks[s.id] ? 'done' : ''} ${n === i ? 'current' : ''}`} data-action="step-go" data-key={asText(key)} data-step={n} aria-label={`Step ${MES.stepLetter(n)}: ${asText(s.title)}${checks[s.id] ? ', checked off' : ''}`} aria-current={n === i ? 'step' : undefined}>{checks[s.id] ? <Check size={14}/> : MES.stepLetter(n)}</button></li>)}</ol>
      <article className={`step-card ${check ? 'checked' : ''} ${stepDir ? `enter-${stepDir}` : ''}`} tabIndex="-1" aria-live="polite">
        {step.recordsTorque || step.consumables?.length ? <p className="step-eyebrow mono">{[step.recordsTorque ? 'Torque record' : '', step.consumables?.length ? 'Consumables' : ''].filter(Boolean).join(' · ')}</p> : null}
        <h4>{asText(step.title)}</h4>
        <p className="step-text">{asText(step.instruction)}</p>
        {step.image ? <figure className="step-figure"><img src={asText(step.image.dataUrl)} alt={asText(step.image.caption || step.title)} loading="lazy"/>{step.image.caption ? <figcaption>{asText(step.image.caption)}</figcaption> : null}</figure> : null}
        {check ? <>{check.torque ? <p className="step-torque-result"><span className="mono">{asText(check.torque.value)} {asText(check.torque.unit)}</span> · {asText(check.torque.tool)}</p> : null}{(check.consumables || []).map(c => <p key={c.name} className="step-torque-result">{asText(c.name)} · lot <span className="mono">{asText(c.lot)}</span> · exp {asText(c.expires)}</p>)}</> : null}
        {canCheck && step.recordsTorque && !check ? renderStepTorque(key, step) : null}
        {canCheck && step.consumables?.length && !check ? renderStepConsumables(key, step) : null}
        {canCheck ? <label className="check-label step-check"><input type="checkbox" data-step-check={asText(step.id)} data-order={asText(ord.id)} data-op={asText(opp.id)} defaultChecked={!!check} disabled={earlierOpen || laterChecked}/><span>{check ? (laterChecked ? 'Step complete · uncheck later steps to change' : 'Step complete') : earlierOpen ? 'Check off the earlier steps first' : 'I completed this step'}{check ? <small className="step-checked-by">Checked by {asText(check.name || 'unknown')}{check.stamp ? <> · stamp <span className="mono">{asText(check.stamp)}</span></> : null}{check.credentialId ? <> · <span className="mono">{asText(check.credentialId)}</span></> : null}{check.at ? <> · {legacyDateTime(check.at)}</> : null}</small> : null}</span></label> : <>{note}{check ? <p className="small step-checked-by">Checked by {asText(check.name || 'unknown')}{check.stamp ? <> · stamp <span className="mono">{asText(check.stamp)}</span></> : null}{check.at ? <> · {legacyDateTime(check.at)}</> : null}</p> : null}</>}
      </article>
      <div className="stepper-nav"><button type="button" className="btn" data-action="step-go" data-dir="prev" data-key={asText(key)} data-step={i - 1} disabled={i === 0}><span className="flip"><ChevronRight size={16}/></span> Previous</button><span className="small muted stepper-hint">Swipe or use ← → keys</span><button type="button" className={`btn ${check && i < steps.length - 1 ? 'primary' : ''}`} data-action="step-go" data-dir="next" data-key={asText(key)} data-step={i + 1} disabled={i === steps.length - 1}>Next step <ChevronRight size={16}/></button></div>
    </section>;
  };
  const atpAssetBlock = (opp, draft) => {
    const rows = (draft.assets && draft.assets.length ? draft.assets : [{ asset: '', description: '', calDue: '', noCal: false }]).slice(0, 12);
    const usable = MES.calibratedToolChecks(state, new Date().toISOString()).filter(c => c.ok).map(c => c.tool);
    return <fieldset className="exec-block atp-assets"><legend>ATP test equipment / assets · required</legend><p className="small muted" id="atp-asset-help">List every test asset used for this acceptance test: test stand, power supply, meter, fixture. Assets in the Calibrated Tool Log are checked against it. Any other asset needs a description and its calibration due date, or mark it as not calibration-controlled.</p><datalist id="atp-asset-options">{usable.map(t => <option key={t.tag} value={asText(t.tag)}>{asText(t.description)} · cal due {asText(t.expires)}</option>)}</datalist><div className="atp-rows">{rows.map((r, i) => <div key={i} className="atp-row" data-asset-row={i}><input className="mono" name="assetId" list="atp-asset-options" maxLength="40" placeholder="Asset ID" aria-label={`Test asset ${i + 1} ID`} aria-describedby="atp-asset-help" defaultValue={asText(r.asset)}/><input name="assetDesc" maxLength="120" placeholder="Description" aria-label={`Test asset ${i + 1} description`} defaultValue={asText(r.description)}/><input name="assetCal" type="date" aria-label={`Test asset ${i + 1} calibration due`} defaultValue={asText(r.calDue)} disabled={r.noCal}/><label className="check-label"><input type="checkbox" name="assetNoCal" defaultChecked={r.noCal}/><span>Not cal-controlled</span></label></div>)}</div>{rows.length < 12 ? <button type="button" className="btn quiet" data-action="atp-asset-more">Add another asset</button> : null}</fieldset>;
  };
  const atpBlock = (ord, opp) => {
    if (opp.classification === MES.EXTERNAL_CLASS && !opp.externalPO) {
      return <section className="atp-block po-request-block" aria-label="Purchase order request"><div className="stamp-check blocked atp-warn"><Lock size={16}/><div><strong>PO requested · waiting for NetSuite PO</strong><small>{opp.poRequest ? <>{asText(opp.poRequest.vendor)} · {asText(opp.poRequest.process)}{opp.poRequest.needBy ? <> · need by {asText(opp.poRequest.needBy)}</> : null}{opp.poRequest.notes ? <> · {asText(opp.poRequest.notes)}</> : null}. Requested by {asText(opp.poRequest.requestedBy?.name || '')}.</> : 'No purchase order recorded.'} Buy-off is held until the PO is added.</small>{skCan('adjust-wo') && !opp.done ? <button type="button" className="btn primary" data-action="po-add" data-op={asText(opp.id)}>Add PO <ChevronRight size={16}/></button> : null}</div></div></section>;
    }
    const externalCenter = MES.WORK_CENTERS?.find(center => center.id === opp.workCenterId && center.external);
    if (externalCenter && MES.EXTERNAL_CLASSES.includes(opp.classification)) {
      const receipt = opp.externalReceipt;
      if (!opp.externalPO?.number) return <section className="atp-block po-request-block" aria-label="External receiving hold"><div className="stamp-check blocked atp-warn"><Lock size={16}/><div><strong>External operation held · NetSuite PO required</strong><small>{asText(externalCenter.name)} is flagged as offsite. Add the NetSuite PO before work can return to Flight.</small>{skCan('adjust-wo') && !opp.done ? <button type="button" className="btn primary" data-action="po-add" data-op={asText(opp.id)}>Add PO <ChevronRight size={16}/></button> : null}</div></div></section>;
      if (receipt?.status === 'Accepted') return <section className="atp-block" aria-label="External receiving accepted"><div className="stamp-check ok"><Check size={16}/><div><strong>External receiving accepted · {asText(receipt.level)} inspection</strong><small>ERP receipt {asText(receipt.erpReceipt)} · supplier lot {asText(receipt.supplierInspectionLot)} · {asText(receipt.by.name)} · {asText(buyoffDate(receipt.at))}</small></div></div></section>;
      return <section className="atp-block po-request-block" aria-label="External receiving hold"><div className="stamp-check blocked atp-warn"><Lock size={16}/><div><strong>External work is offsite · receiving hold</strong><small>Record the ERP receipt, supplier inspection lot and {ord.pedigree === 'Production' ? 'full receiving inspection' : 'simplified receipt confirmation'} before completing this operation.</small>{skCan('approve-nc') && !opp.done ? <button type="button" className="btn primary" data-action="external-receive" data-op={asText(opp.id)}>Record receiving</button> : null}</div></div></section>;
    }
    if (opp.atpLinkDeferred) return <section className="atp-block atp-deferred" aria-label="ATP software not linked"><div className="stamp-check atp-warn"><Info size={16}/><div><strong>ATP software link required</strong><small>This legacy operation has no repository, version or commit. Link software before buy-off.</small>{skCan('adjust-wo') && !opp.done ? <button type="button" className="btn" data-action="atp-link" data-op={asText(opp.id)}>Link software now <ChevronRight size={16}/></button> : null}</div></div></section>;
    if (!opp.atp) return null;
    const a = opp.atp, pend = MES.atpPending(opp), repoPath = a.repo.replace(/^https:\/\/[^/]+\//, '');
    const commit = sha => <a className="mono atp-sha" href={`${asText(a.repo)}/commit/${asText(sha)}`} target="_blank" rel="noopener noreferrer">{asText(sha.slice(0, 7))}</a>;
    const canAccept = skCan('accept-software'), canPush = skCan('push-software') && !opp.done && ord.status !== 'Closed';
    const rows = [...a.pushes].reverse().slice(0, 6).map(p => <li key={p.id} className={`atp-push atp-${p.status.toLowerCase()}`}><div><strong>{asText(p.version)}</strong> {commit(p.sha)}{p.message ? <span className="muted">· {asText(p.message)}</span> : null}<small>Pushed by {asText(p.by?.name || 'GitHub')} · {asText(buyoffDate(p.at))}{p.reviewedBy ? <> · {p.status} by {asText(p.reviewedBy.name)}{p.reviewNote ? <> (“{asText(p.reviewNote)}”)</> : null}</> : null}</small></div><span className={`pill ${p.status === 'Pending' ? 'missing' : p.status === 'Accepted' ? 'ready' : 'hold'}`}>{asText(p.status)}</span>{p.status === 'Pending' && canAccept && !opp.done ? <button type="button" className="btn" data-action="atp-review" data-op={asText(opp.id)} data-push={asText(p.id)}>Review</button> : null}</li>);
    return <section className="atp-block" aria-labelledby={`atp-${asText(opp.id)}`}>
      <div className="atp-head"><h3 id={`atp-${asText(opp.id)}`}>ATP software</h3><a className="atp-repo-link mono" href={asText(a.repo)} target="_blank" rel="noopener noreferrer">{asText(repoPath)} <ExternalLink size={14}/></a></div>
      <dl className="atp-baseline"><div><dt>Approved version</dt><dd>{asText(a.baseline.version)}</dd></div><div><dt>Commit</dt><dd>{commit(a.baseline.sha)}</dd></div>{a.baseline.acceptedBy ? <div><dt>Accepted by</dt><dd>{asText(a.baseline.acceptedBy.name)} · {asText(buyoffDate(a.baseline.acceptedAt))}</dd></div> : <div><dt>Source</dt><dd>Set when the operation was added</dd></div>}</dl>
      {pend.length && !opp.done ? <div className="stamp-check blocked atp-gate"><Lock size={16}/><div><strong>Software push awaiting Software Engineering</strong><small>{asText(pend[0].version)} · {asText(pend[0].sha.slice(0, 7))} was pushed to this operation. Buy-off is held until a Software Engineering account accepts or rejects it.</small>{canAccept ? <button type="button" className="btn primary" data-action="atp-review" data-op={asText(opp.id)} data-push={asText(pend[0].id)}>Review software push <ChevronRight size={16}/></button> : null}</div></div> : <p className="atp-clear"><Check size={16}/> {opp.done ? <>Bought off on {asText(a.baseline.version)}.</> : 'No pending software changes. Software Engineering sign-off is not required.'}</p>}
      {rows.length ? <ol className="atp-pushes">{rows}</ol> : null}
      {canPush ? <button type="button" className="btn quiet" data-action="atp-push" data-op={asText(opp.id)}><Upload size={16}/> Record a software push</button> : null}
    </section>;
  };
  const renderTaskForm = (ord, opp, opIndex) => {
    const key = `${ord.id}/${opp.id}`, draft = { instruction: false, evidence: false, note: '', tools: [], noTools: false, stampNumber: '', torque: {}, ...(drafts.get(key) || {}) };
    const stepTools = stepCapturedTools(opp), stepTags = new Set(stepTools.map(t => t.tag.toUpperCase()));
    const checks = draft.tools.filter(tag => !stepTags.has(String(tag).trim().toUpperCase())).map(tag => MES.toolCheck(tag, new Date().toISOString(), state));
    const needType = opp.buyoffType || 'Technician', stamp = MES.buyoffCredential(state.profile, needType);
    const usable = MES.calibratedToolChecks(state, new Date().toISOString()).filter(c => c.ok).map(c => c.tool);
    const canBuyoff = stamp.ok && !MES.atpPending(opp).length && !(opp.classification === MES.EXTERNAL_CLASS && !opp.externalPO) && !(MES.WORK_CENTERS?.some(c => c.id === opp.workCenterId && c.external) && opp.externalReceipt?.status !== 'Accepted');
    const signoffLine = stamp.override ? (() => { const ma = MES.masterAccess() || (window.skAuth && window.skAuth.actor && window.skAuth.actor()) || {}; return <>Master Access override · <strong>{asText(ma.name || 'Master Access')}</strong><br/>{asText(ma.credentialId || '')}</>; })() : (() => { const a = window.skAuth && window.skAuth.actor && window.skAuth.actor(); return <>{a && a.name && a.name !== state.profile.name ? <>Signed in as <strong>{asText(a.name)}</strong> · stamping as </> : 'Buy-off as '}<strong>{asText(state.profile.name)}</strong><br/><span className="mono">{asText(state.profile.credentialId)}</span> · Not a real signature</>; })();
    return <form id="operation-form" data-order={asText(ord.id)} data-op={asText(opp.id)}>
      {(opp.steps || []).length ? null : <><h3>Completion evidence</h3><label className="check-label"><input type="checkbox" name="instruction" defaultChecked={draft.instruction} required/><span> instruction reviewed</span></label><label className="check-label"><input type="checkbox" name="evidence" defaultChecked={draft.evidence} required/><span> completion evidence recorded</span></label></>}
      {opp.requiresTooling ? <fieldset className="exec-block"><legend>Calibrated tools used · required</legend><p className="small muted" id="tools-help">Scan or type the asset tag of every calibrated tool you used. Only tools that are In Calibration in the Calibrated Tool Log can be added. Log read {asText(MES.CAL_SNAPSHOT)} PT.</p><div className="tool-entry"><input id="tool-tag" className="mono" list="cal-tool-options" autoComplete="off" spellCheck={false} maxLength="40" placeholder="Asset tag, e.g. SR0149" aria-label="Tool asset tag" aria-describedby="tools-help tool-error" disabled={draft.noTools}/><button type="button" className="btn" data-action="add-tool" disabled={draft.noTools}>Add tool</button></div><datalist id="cal-tool-options">{usable.map(t => <option key={t.tag} value={asText(t.tag)}>{asText(t.description)} · cal due {asText(t.expires)}</option>)}</datalist><p className="field-error" id="tool-error" role="alert"></p>
        {stepTools.length ? <ul className="tool-list tool-list-steps" aria-label="Tools captured on steps">{stepTools.map(t => { const c = MES.toolCheck(t.tag, new Date().toISOString(), state), tool = c.tool; return <li key={t.tag} className={`tool-row step-tool ${!c.ok ? 'blocked' : c.dueSoon ? 'due' : ''}`}><span className="mono tool-tag">{asText(t.tag)}</span><span className="tool-desc">{asText(tool ? tool.description : 'Not in Calibrated Tool Log')}{tool ? <small>S/N {asText(tool.serial)} · cal due {asText(tool.expires || '-')}</small> : null}<small className="tool-from-step">Captured on step {asText(t.step)}{t.torque ? <> · {asText(t.torque.value)} {asText(t.torque.unit)}</> : null}</small></span><span className="tool-status">{!c.ok ? 'Blocked' : 'Recorded'}</span></li>; })}</ul> : null}
        {checks.length ? <ul className="tool-list" aria-label="Tools logged for this operation">{checks.map((c, i) => { const t = c.tool, tag = t ? t.tag : draft.tools[i], cls = !c.ok ? 'blocked' : c.dueSoon ? 'due' : ''; return <li key={tag} className={`tool-row ${cls}`}><span className="mono tool-tag">{asText(tag)}</span><span className="tool-desc">{asText(t ? t.description : 'Not in Calibrated Tool Log')}{t ? <small>S/N {asText(t.serial)} · {asText(t.location)} · cal due {asText(t.expires || '-')}</small> : null}{!c.ok ? <small className="tool-block">{asText(c.message)}</small> : null}{t && c.ok && MES.isTorqueTool(t) ? <span className="torque-field"><label htmlFor={`torque-${asText(t.tag)}`}>Torque applied · required</label><span className="torque-inputs"><input id={`torque-${asText(t.tag)}`} data-torque-tag={asText(t.tag)} inputMode="decimal" autoComplete="off" maxLength="10" required placeholder="e.g. 25" defaultValue={asText((draft.torque || {})[t.tag]?.value || '')}/><select data-torque-unit={asText(t.tag)} aria-label={`Torque unit for ${asText(t.tag)}`} defaultValue={(draft.torque || {})[t.tag]?.unit || 'in-lb'}>{MES.TORQUE_UNITS.map(u => <option key={u}>{u}</option>)}</select></span></span> : null}</span><span className="tool-status">{!c.ok ? 'Blocked' : c.dueSoon ? `Due in ${c.daysLeft} d` : 'In cal'}</span><button type="button" className="btn quiet" data-action="remove-tool" data-tag={asText(tag)} aria-label={`Remove ${asText(tag)}`}>Remove</button></li>; })}</ul> : null}
      </fieldset> : null}
      {MES.isInspectionOp(opp) ? <fieldset className="exec-block std-insp-ack"><legend>Standard inspection · required</legend><label className="check-label"><input type="checkbox" name="stdInspection" defaultChecked={draft.stdInspection}/><span>{asText(MES.STD_INSPECTION.text)}</span></label><p className="small">Not acceptable? <button type="button" className="btn danger" data-action="insp-reject" data-op={asText(opp.id)}>Reject</button> and raise the NC instead of buying off.</p></fieldset> : null}
      {MES.isTestOperation(opp) ? atpAssetBlock(opp, draft) : null}
      {(opp.steps || []).length ? null : confOpBlock(ord, opp)}
      <div className="field"><label htmlFor="completion-note">Operation note <span className="muted">(optional)</span></label><textarea id="completion-note" name="note" maxLength="500" placeholder="Add a note" defaultValue={asText(draft.note)}/><small> text only. Do not enter real production or personal data.</small></div>
      <fieldset className="exec-block buyoff-inline" hidden={(opp.steps || []).length ? true : undefined}><legend>Buy-off · {asText(needType)}{opp.inspectionPoint ? (opp.buyoffType === 'Conformity Inspector' ? ' · Conformity hold point' : ' · Inspection point') : ''}</legend>
        {stamp.override ? masterBuyoffNotice() : stamp.ok ? <><div className="stamp-check ok"><Shield size={16}/><div><strong>{asText(stamp.holder.name)} · {asText(stamp.holder.type)} stamp {asText(stamp.holder.number)}</strong><small>{asText(stamp.holder.department)} · held since {asText(stamp.holder.since)} · matched in the Stamp Control Log</small></div></div><div className="stamp-identity"><div className="field"><label htmlFor="stamp-number">Enter your stamp no. to buy off</label><input id="stamp-number" name="stampNumber" className="mono" autoComplete="off" maxLength="8" required defaultValue={asText(draft.stampNumber)}/></div><div className="field"><label htmlFor="stamp-pin">Stamp PIN</label><input id="stamp-pin" name="pin" type="password" inputMode="numeric" className="mono" autoComplete="off" maxLength="8" required aria-describedby="stamp-pin-help"/><small id="stamp-pin-help" className="muted">{stamp.holder.pin ? 'Your second factor for this buy-off. MFA replaces it when IT connects Okta.' : 'No PIN set yet. Set it in Your credentials.'}</small></div></div>{trainingFlag(stamp.holder, opp)}</> : <div className="stamp-check blocked"><Lock size={16}/><div><strong>Buy-off blocked: no valid stamp</strong><small>{asText(stamp.message)}</small><button type="button" className="btn primary" data-action="profile">Switch credentials <ChevronRight size={16}/></button></div></div>}
      </fieldset>
      <div className="form-error" id="operation-error" role="alert"></div>
      {(opp.steps || []).length && !stepsDone(opp) ? null : <div className="task-actions"><p>{signoffLine}</p>
        {(opp.steps || []).length ? <><button className="btn primary" type="button" data-action="buyoff-now" data-order={asText(ord.id)} data-op={asText(opp.id)} disabled={!canBuyoff}>Complete operation <Check size={16}/></button><button type="submit" hidden tabIndex="-1" aria-hidden="true"></button></> : <button className="btn primary" type="submit" disabled={!canBuyoff}>Complete operation <Check size={16}/></button>}
      </div>}
    </form>;
  };
  const confOpBlock = (ord, opp) => {
    if (!MES.isPartsConformityOperation(opp)) return null;
    const qa = skCan('approve-wo'), serials = MES.confSerials(state, ord), list = ord.conformity || [];
    return <section className="conf-op"><h4>Part conformity review · SOP-860-002</h4><p className="small muted">Work the checklist for each LRU serial. Buy-off needs Phases 1 to 6: package reviewed, 8130-9 completed and signed by the AQI, LRU tagged and photographed. Phase 7 (Certification and the DAR) continues from the Quality tab.</p><ul className="conf-op-list">{serials.map(s => { const p = list.find(x => x.serial === s); return <li key={s}><span className="mono">S/N {asText(s)}</span> {p ? <><span className={`pill ${['AQI signed', 'Ready for DAR review', 'DAR findings', 'Conformed', 'Closed'].includes(p.status) ? 'closed' : 'kitting'}`}>{asText(p.status)}</span> <button className="btn" data-action="conf-wizard" data-order={asText(ord.id)} data-serial={asText(s)} data-page={confCurrentPage(MES, p) || 7}>Open checklist</button></> : qa ? <button className="btn primary" data-action="conf-op-start" data-order={asText(ord.id)} data-serial={asText(s)}>Start conformity package</button> : <span className="muted">Not started</span>}</li>; })}</ul></section>;
  };
  const stepsCompleteBanner = (ord, opp, isActive) => {
    if (!isActive || opp.done || !stepsDone(opp) || MES.blockingTickets(ord, opp.id).length) return null;
    const needType = opp.buyoffType || 'Technician', stamp = MES.buyoffCredential(state.profile, needType);
    if (stamp.override) return <div className="steps-complete is-ready">{masterBuyoffNotice()}<button type="button" className="btn primary" data-action="buyoff-now" data-order={asText(ord.id)} data-op={asText(opp.id)}>Buy off <Check size={16}/></button></div>;
    const matched = stamp.ok;
    return <div className={`steps-complete ${matched ? 'is-ready' : 'is-blocked'}`}>{matched ? <Shield size={16}/> : <Lock size={16}/>}<div><strong>{matched ? <>{asText(stamp.holder.name)} · {asText(stamp.holder.type)} stamp {asText(stamp.holder.number)}</> : <>Buy-off blocked: {asText(needType)} stamp required</>}</strong><small>{matched ? <>All {(opp.steps || []).length} steps checked. {asText(stamp.holder.department)} · matched in the Stamp Control Log.</> : asText(stamp.ok ? `${stamp.holder.name} holds a ${stamp.holder.buyoffType} credential.` : stamp.message)}</small></div>{matched ? <button type="button" className="btn primary" data-action="buyoff-now" data-order={asText(ord.id)} data-op={asText(opp.id)}>Buy off <Check size={16}/></button> : <button type="button" className="btn" data-action="profile">Switch credentials <ChevronRight size={16}/></button>}</div>;
  };
  const buyoffStamp = opp => {
    const b = opp.buyoff;
    if (!b) return <div className="evidence-stamp"><Check size={16}/><div><strong>Legacy operations recorded</strong><p>No credential snapshot was captured for this earlier completion.</p></div></div>;
    return <section className="buyoff-stamp" aria-label="Buy-off credentials"><div className="stamp-title"><Shield size={16}/><strong>Buy-off recorded</strong><span className="pill closed"></span></div><dl className="stamp-grid"><div><dt>Name</dt><dd>{asText(b.name)}</dd></div><div><dt>Role</dt><dd>{asText(b.role)}</dd></div><div><dt>Credential ID</dt><dd className="mono">{asText(b.credentialId)}</dd></div><div><dt>Recorded at</dt><dd><time dateTime={asText(b.at)}>{asText(buyoffDate(b.at))}</time></dd></div></dl>{b.override ? <p><strong>Master Access override</strong> · {asText(b.override.account)} · {asText(b.override.requiredTypes.join(', '))}. Stamp and qualification checks bypassed.</p> : null}{b.stamp ? <p><strong>Stamp:</strong> {asText(b.stamp.type)} stamp {asText(b.stamp.number)}{b.stamp.buyoffType ? <> · {asText(b.stamp.buyoffType)} buy-off</> : null} · verified against the credential list</p> : null}{Array.isArray(b.tools) ? (b.tools.length ? <div className="stamp-tools"><strong>Calibrated tools used</strong><ul>{b.tools.map(t => <li key={t.tag}><span className="mono">{asText(t.tag)}</span> {asText(t.description)}{t.torque ? <> · <strong>{asText(t.torque.value)} {asText(t.torque.unit)}</strong></> : null} · S/N {asText(t.serial)} · cal due {asText(t.expires)}</li>)}</ul></div> : <p>No calibrated tools logged.</p>) : null}{b.evidenceIds?.length ? <p>Evidence included in this buy-off: {b.evidenceIds.length} reviewed recording(s).</p> : null}<p>Unverified identity. Not an authenticated electronic signature. Credential details are captured at buy-off.</p></section>;
  };
  const operationHold = (ord, opp) => <div className="inline-info warning"><Lock size={16}/><div><p><strong>Operation {operationNumber(ord, opp.id)} is on hold{typeof opDispoStatus === 'function' ? opDispoStatus(ord, opp) : ''}.</strong> A quality disposition is required before buy-off. Prior completed steps remain unchanged.</p>{MES.blockingTickets(ord, opp.id).map(t => <button key={t.id} className="btn" data-action="ticket" data-ticket={asText(t.id)}>Review {asText(t.id)} <ChevronRight size={16}/></button>)}</div></div>;
  const operationActions = (ord, opp) => {
    const canAdd = ord.status !== 'Closed', canTicket = ['Kitting', 'Building', 'Quality'].includes(ord.status);
    return <>{canAdd ? <><label className="btn att-btn" htmlFor="att-input"><Upload size={16}/> Upload files</label><input className="sr-only" id="att-input" type="file" multiple aria-label={`Attach files to operation ${asText(opp.id)}`} data-attachment data-order={asText(ord.id)} data-op={asText(opp.id)}/></> : null}<button className="btn" data-action="create-ticket" data-op={asText(opp.id)} disabled={!canTicket}><Plus size={16}/> Create NC</button>{MES.isInspectionOp(opp) && !opp.done && ord.status === 'Building' && skCan('raise-nc') ? <button className="btn danger" data-action="insp-reject" data-op={asText(opp.id)}>Reject inspection</button> : null}{opp.classification === MES.SOURCE_INSPECTION_CLASS && !opp.done && !opp.sourceInspection && ord.status === 'Building' && skCan('inspect-steps') ? <button className="btn" data-action="source-inspection-record" data-op={asText(opp.id)}>Record source inspection</button> : null}</>;
  };
  const operationLinks = (ord, opp) => {
    const tickets = ord.tickets.filter(t => t.operationId === opp.id), reports = ord.reports.filter(r => r.operationId === opp.id);
    return <section className="operation-links" aria-label="Linked operation records"><div className="linked-heading"><h3>Linked quality records</h3></div>{tickets.map(t => <React.Fragment key={t.id}>{ticketRow(ord, t)}</React.Fragment>)}{reports.map(r => <React.Fragment key={r.id}>{reportRow(ord, r)}</React.Fragment>)}{!tickets.length && !reports.length ? <p className="small muted no-links">Nothing linked.</p> : null}</section>;
  };
  const renderMediaEvidence = (ord, opp) => {
    if (ord.subcategory !== 'Installation' && !opp.evidence?.length) return null;
    const clips = opp.evidence || [], editable = mediaEditable(ord, opp), reviewed = clips.filter(e => e.reviewedAt);
    return <section className="installation-evidence" aria-labelledby="media-heading"><div className="linked-heading"><h3 id="media-heading">Installation evidence</h3><span className={`report-result ${reviewed.length ? 'pass' : ''}`}>{reviewed.length ? <>{reviewed.length}Reviewed</> : opp.requiresRecording ? 'Recording required' : 'Optional recording'}</span></div>
      {clips.map(e => <article key={e.id} className="media-item"><div className="media-item-heading"><Video size={16}/><div><strong>{asText(e.fileName)}</strong><small>{asText(e.source === 'recording' ? 'Recorded here' : 'Uploaded recording')} · {mediaSize(e.size)} · {legacyDateTime(e.addedAt)}</small></div><span className={`report-result ${e.rejectedAt ? 'fail' : e.reviewedAt ? 'pass' : ''}`}>{e.rejectedAt ? 'Rejected' : e.reviewedAt ? 'Reviewed' : 'Awaiting review'}</span></div><p>{asText(e.description)}</p><p className="media-credit">Linked by {asText(e.capturedBy.name)} · {asText(e.capturedBy.credentialId)}{e.reviewedAt ? <><br/>Reviewed by {asText(e.reviewedBy.name)} · {legacyDateTime(e.reviewedAt)}</> : null}{e.rejectedAt ? <><br/>Rejected by {asText(e.rejectedBy.name)} · {legacyDateTime(e.rejectedAt)}</> : null}</p>{e.rejectedAt ? <div className="inline-info warning" role="status"><Lock size={16}/><div><p><strong>Rejected: {asText(e.rejectReason)}</strong></p><p className="small">Remove this clip and attach a replacement before buy-off.</p></div></div> : null}<div className="media-actions">{e.rejectedAt ? null : <button className="btn" data-action="review-media" data-op={asText(opp.id)} data-evidence={asText(e.id)}>Review recording</button>}{!e.reviewedAt && !e.rejectedAt && editable ? <button className="btn quiet" data-action="reject-media" data-op={asText(opp.id)} data-evidence={asText(e.id)}>Reject recording</button> : null}<button className="btn quiet" data-action="download-media" data-op={asText(opp.id)} data-evidence={asText(e.id)}><Download size={16}/> Download</button>{editable ? <button className="btn quiet" data-action="remove-media" data-op={asText(opp.id)} data-evidence={asText(e.id)}>Remove</button> : null}</div></article>)}
      {!clips.length ? <div className="media-empty"><Video size={16}/><div><strong>No recording linked yet</strong><p>Your video and description become the supporting evidence for this step.</p></div></div> : null}
      {editable && clips.length < 3 ? <div className="media-actions"><button className="btn primary" data-action="record-media" data-op={asText(opp.id)}><Video size={16}/> Record video</button><button className="btn" data-action="upload-media" data-op={asText(opp.id)}><Upload size={16}/> Upload recording</button><input id="evidence-file" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" data-op={asText(opp.id)} hidden/></div> : null}
      <p className="media-footnote">{window.skServer && window.skServer.active ? 'Stored on the shared evidence server with a browser offline cache.' : 'Local browser storage only, not a controlled evidence archive.'} Download a backup. Up to 3 clips, 100 MB each. {opp.done ? 'Evidence is locked after buy-off.' : clips.some(e => e.rejectedAt) ? 'A rejected recording is attached. Remove it and attach a replacement before buy-off.' : opp.requiresRecording && !reviewed.length ? 'Buy-off needs at least one saved, reviewed recording.' : ''}</p></section>;
  };
  const renderAttachments = (ord, opp) => {
    const files = Array.isArray(opp.attachments) ? opp.attachments : [];
    const canAdd = ord.status !== 'Closed';
    return <section className="attachments" aria-labelledby={`att-${asText(opp.id)}`}><div className="linked-heading"><h3 id={`att-${asText(opp.id)}`}>Attachments <span className="mono">{files.length}</span></h3></div>
      {files.length ? <ul className="att-list">{files.map(file => <li key={file.id}>{file.dataUrl && file.type.startsWith('image/') ? <button type="button" className="att-thumb" data-action="att-view" data-order={asText(ord.id)} data-op={asText(opp.id)} data-file={asText(file.id)} aria-label={`View ${asText(file.name)}`}><img src={asText(file.dataUrl)} alt="" loading="lazy"/></button> : <span className="att-icon"><FileText size={16}/></span>}<span className="att-meta"><strong>{asText(file.name)}</strong><small>{fileSizeLabel(file.size)} · {asText(file.addedBy.name)} · {legacyDateTime(file.addedAt)}{file.storage === 'reference' ? ' · logged by name only' : ''}</small></span>{!opp.done && canAdd ? <button className="btn quiet" data-action="att-remove" data-order={asText(ord.id)} data-op={asText(opp.id)} data-file={asText(file.id)}>Remove</button> : null}</li>)}</ul> : <p className="small muted no-links">No files.</p>}
    </section>;
  };
  const renderSendTo = (ord, opp, link, draft) => {
    const key = discussionKey(ord.id, opp.id), linking = draft.type === 'link';
    const value = linking ? 'link:new' : `${draft.type}:${draft.id}`;
    const option = (type, target) => <option key={`${type}:${target.id}`} value={`${type}:${asText(target.id)}`}>{type === 'person' ? `@${asText(target.label)}` : target.id === 'linked-thread' ? `${asText(target.label)} (linked)` : asText(target.label)}</option>;
    const slackDraft = slackDrafts.get(key) || link || { label: '', url: '' };
    return <><div className="send-to">{slackLogo()}<div className="field send-to-field"><label htmlFor="message-target">Send to</label><select id="message-target" name="target" form="message-form" data-order={asText(ord.id)} data-op={asText(opp.id)} aria-describedby="message-target-help" defaultValue={value}><optgroup label="Slack threads">{messageTargets(opp, 'thread').map(target => option('thread', target))}</optgroup><optgroup label="People">{messageTargets(opp, 'person').map(target => option('person', target))}</optgroup><optgroup label="Slack link"><option value="link:new">{link ? 'Edit linked Slack thread…' : 'Link a Slack thread…'}</option></optgroup></select></div>{link && value === 'thread:linked-thread' ? <a className="btn" href={asText(link.url)} target="_blank" rel="noopener noreferrer">Open in Slack <ExternalLink size={14}/></a> : null}</div><p className="small muted" id="message-target-help"></p>{linking ? <form id="slack-link-form" className="slack-link-inline" data-order={asText(ord.id)} data-op={asText(opp.id)}><p className="small muted">In Slack, choose Copy link on the thread’s first message, then paste it here. This saves a shortcut only; no token or workspace connection is needed.</p><div className="field"><label htmlFor="slack-thread-label">Thread label</label><input id="slack-thread-label" name="label" maxLength="80" required placeholder={`#assembly · operation ${operationNumber(ord, opp.id)}`} defaultValue={asText(slackDraft.label)}/></div><div className="field"><label htmlFor="slack-thread-url">Slack message link</label><input type="url" id="slack-thread-url" name="url" maxLength="500" required placeholder="https://your-workspace.slack.com/archives/…" defaultValue={asText(slackDraft.url)} aria-describedby="slack-link-help"/><small id="slack-link-help">Use an https://workspace.slack.com/archives/… message link. Access is controlled by Slack.</small></div><p className="form-error" id="slack-link-error" role="alert" tabIndex="-1"></p><div className="media-actions"><button className="btn" type="submit">Save thread link</button><button className="btn quiet" type="button" data-action="cancel-slack-link" data-order={asText(ord.id)} data-op={asText(opp.id)}>Cancel</button>{link ? <button className="btn quiet" type="button" data-action="unlink-slack" data-order={asText(ord.id)} data-op={asText(opp.id)}>Remove link</button> : null}</div></form> : null}</>;
  };
  const renderDiscussion = (ord, opp) => {
    const messages = opp.messages || [], thread = opp.slackThread || null, closed = ord.status === 'Closed';
    const draft = discussionDrafts.get(discussionKey(ord.id, opp.id)) || '';
    const link = thread && MES.slackThreadValid(thread) ? thread : null;
    const slackDraft = slackDrafts.get(discussionKey(ord.id, opp.id)) || link || { label: '', url: '' };
    const destinationDraft = messageTargetDrafts.get(discussionKey(ord.id, opp.id)) || { type: 'thread', id: MES.MESSAGE_TARGETS.threads[0].id };
    const destination = messageTargets(opp, destinationDraft.type).find(target => target.id === destinationDraft.id) || messageTargets(opp, 'thread')[0];
    return <section className="operation-discussion" id="operation-discussion" aria-labelledby="discussion-heading">
      <div className="discussion-heading"><h3 id="discussion-heading" tabIndex="-1">Team discussion <span className="discussion-count">{messages.length}</span></h3><span className="small muted">Internal only</span></div>
      <ol className="discussion-messages" aria-label="Local messages">{messages.map((message, mi) => <li key={message.id || mi}><article><div className="message-byline"><strong>{asText(message.author.name)}</strong><span>{asText(message.author.role)}</span><time dateTime={asText(message.at)}>{legacyDateTime(message.at)}</time></div>{message.audience ? <p className="message-audience">{message.audience.type === 'person' ? 'Tagged' : 'Thread'} <strong>{asText(messageAudienceLabel(message.audience))}</strong></p> : null}<p className="message-text">{asText(message.text)}</p></article></li>)}</ol>
      {!messages.length ? <p className="discussion-empty muted">No messages.</p> : null}
      {closed ? <p className="small muted">This work order is closed. Its discussion and Slack link are read-only.{link ? <> <a href={asText(link.url)} target="_blank" rel="noopener noreferrer">Open linked Slack thread</a></> : null}</p> : <>{renderSendTo(ord, opp, link, destinationDraft)}<form id="message-form" data-order={asText(ord.id)} data-op={asText(opp.id)}><div className="field"><label htmlFor="message-text">Message to the team</label><textarea id="message-text" name="text" minLength="1" maxLength="2000" required placeholder="Message" aria-describedby="message-help" defaultValue={asText(draft)}/><small id="message-help">Posting as {asText(state.profile.name)} · Unverified identity. To try another teammate, change your profile.</small></div><p className="form-error" id="message-error" role="alert" tabIndex="-1"></p><div className="discussion-compose-actions"><span className="small muted"><span id="message-length">{draft.length}</span> / 2,000</span><button className="btn primary" type="submit" disabled={messages.length >= 100}>Post message <ChevronRight size={16}/></button></div>{messages.length >= 100 ? <p className="small muted">This operation has reached the 100-message limit.</p> : null}</form></>}
      <p className="discussion-print-note"><Lock size={14}/>{' '}</p>
    </section>;
  };
  const renderLatest = ord => {
    const latest = ord.history[ord.history.length - 1];
    if (!latest) return null;
    return <div className="mini-activity"><Clock size={16}/><div><p>{asText(latest.action)}</p><small>{asText(latest.actor)} · {legacyDateTime(latest.at)}</small></div><button className="btn quiet" style={{ marginLeft: 'auto' }} data-action="tab" data-tab="record">View record <ChevronRight size={16}/></button></div>;
  };
  const assignee = (() => {
    const a = MES.opAssignee(state, o.id, op.id);
    if (a) return <p className="op-assignee"><User size={14}/> Assigned to {asText(a.name)}{skCan('assign-work') && !op.done ? <> · <button type="button" className="link-btn" data-action="op-assign" data-op={asText(op.id)}>Change</button></> : null}</p>;
    if (skCan('assign-work') && !op.done && o.status !== 'Closed') return <p className="op-assignee op-assignee-empty"><User size={14}/> <button type="button" className="link-btn" data-action="op-assign" data-op={asText(op.id)}>Assign technician</button></p>;
    return null;
  })();
  return <>
    <div className="execution-layout">
      <section className="sequence-panel" aria-labelledby="sequence-heading">
        <div className="panel-head"><h2 id="sequence-heading">Operation sequence</h2><button className="btn quiet" data-action="tab" data-tab="record">Sign-offs</button></div>
        <div className="sequence-progress"><progress max={o.operations.length} value={complete} aria-label="Completed operations"/><span>{complete} of {o.operations.length} complete</span></div>
        <ol className="sequence-list">{o.operations.map((item, i) => {
          const tickets = openTickets(o, item.id);
          const blocking = MES.blockingTickets(o, item.id);
          return <li key={item.id}><button className={`operation-btn ${item.done ? 'done' : i === next && o.status === 'Building' ? 'current' : ''}`} data-action="operation" data-op={asText(item.id)} aria-pressed={item.id === selOp} aria-label={`Operation ${sequence(i)}: ${asText(item.title)}. ${item.done ? 'Complete' : i === next && o.status === 'Building' ? 'Current step' : 'Pending'}`}><span className="op-number">{sequence(i)}</span><span><span className="op-label">{asText(item.title)}</span>{calloutBadges(item)}{tickets.length ? <span className="op-flag">{asText(tickets.map(t => t.type).join(' / '))} open{blocking.length ? ' · Hold' : ''}</span> : null}{o.reports.some(r => r.operationId === item.id) ? <span className="op-report">ATP report linked</span> : null}{item.inspectionPoint ? <span className="op-inspection">Inspection point</span> : null}{item.requiresTooling ? <span className="op-tooling">Cal tooling</span> : null}{item.classification ? <span className="op-class">{asText(item.classification)}</span> : null}{!item.done && MES.inspectionGate(o, i) ? <span className="op-locked">Locked behind inspection</span> : null}<span className="op-sub">{item.done ? 'Complete' : i === next && o.status === 'Building' ? 'Current step' : o.status === 'Draft' ? 'Awaiting issue' : o.status === 'Kitting' ? 'Awaiting kit' : 'Pending'}</span></span>{item.done ? <Check size={16}/> : <ChevronRight size={16}/>}</button></li>;
        })}</ol>
        {renderSequenceTools(o)}
      </section>
      <section className="task-panel" id="operation-detail" aria-labelledby="task-title">
        <header className="task-heading"><span className="task-number">{sequence(index)}</span><div>{assignee}<h2 id="task-title">{asText(op.title)}{calloutBadges(op)}</h2>{op.description && op.description !== op.title ? <p>{asText(op.description)}</p> : null}</div></header>
        <div className="task-content">
          {stdInspBanner(op)}
          {linkedNcBlock(o, op)}
          {calloutReminders(op)}
          <dl className="task-info">
            <div><dt>Work center</dt><dd>{asText(MES.WORK_CENTERS?.find(center => center.id === op.workCenterId)?.name || 'Unassigned')}</dd></div>
            {op.standardHours !== undefined ? <div><dt>Standard hours</dt><dd>{op.standardHours} per unit · {Math.round(MES.laborMinutes(op) / 60 * 100) / 100} actual h</dd></div> : null}
            <div><dt>Sequence rule</dt><dd>Complete in order</dd></div>
            <div><dt>Buy-off type</dt><dd>{asText(op.buyoffType || 'Technician')}{op.inspectionPoint ? ' · Inspection point' : ''}</dd></div>
            {!op.externalPO && op.poRequest ? <div><dt>Purchase order</dt><dd>Requested · {asText(op.poRequest.vendor)}</dd></div> : null}
            {op.externalPO ? <div><dt>Purchase order</dt><dd>{op.externalPO.url ? <a className="po-link" href={asText(op.externalPO.url)} target="_blank" rel="noopener noreferrer">{asText(op.externalPO.number)} <ExternalLink size={14}/></a> : <><span className="mono">{asText(op.externalPO.number)}</span> · no NetSuite link</>}</dd></div> : null}
            <div><dt>Calibrated tooling</dt><dd>{op.requiresTooling ? 'Required' : 'Not used'}</dd></div>
          </dl>
          {active && skCan(MES.isInspectionOp(op) ? 'inspect-steps' : 'operate-steps') ? <div className="labor-clock-control" aria-label="Operation labor clock">{op.clock ? <><span>Clocked on by {asText(op.clock.person.name)} · {legacyDateTime(op.clock.startedAt)}</span>{op.clock.person.credentialId === window.skAuth?.actor?.()?.credentialId ? <button className="btn quiet" data-action="labor-clock" data-order={asText(o.id)} data-op={asText(op.id)}>Clock off</button> : <span>Only the person who started this timer can stop it.</span>}</> : <><span>No active labor clock on this operation.</span><button className="btn quiet" data-action="labor-clock" data-order={asText(o.id)} data-op={asText(op.id)}>Clock on</button></>}</div> : null}
          {(op.steps || []).some(st => st.image) ? <button className="doc-link" data-action="instruction" data-index={index}><FileText size={16}/><span><strong>Step photos · all steps</strong><small className="mono">{(op.steps || []).filter(st => st.image).length} of {(op.steps || []).length} steps have a photo</small></span><ExternalLink size={16}/></button> : null}
          {op.done ? null : confOpBlock(o, op)}
          {op.done ? null : stepsCompleteBanner(o, op, active)}
          {op.done ? null : renderSteps(o, op, active)}
          {op.done ? null : atpBlock(o, op)}
          {op.done ? <>{buyoffStamp(op)}<h3 style={{ marginBottom: '12px' }}>Completion note</h3><div className="record-note">{asText(op.note || 'Evidence retained in the work order record.')}</div>{(op.steps || []).length ? <details className="done-steps"><summary>Operation steps <span className="muted">· {Object.keys(op.stepChecks || {}).length} of {(op.steps || []).length} checked</span></summary>{renderSteps(o, op, active)}</details> : null}{atpBlock(o, op)}{confOpBlock(o, op)}</> : active ? (MES.blockingTickets(o, op.id).length ? operationHold(o, op) : renderTaskForm(o, op, index)) : <div className={`inline-info ${o.status === 'Kitting' ? 'warning' : ''}`}><Lock size={16}/><p>{o.status === 'Kitting' ? 'The material kit must be complete before operations can begin.' : o.status === 'Draft' ? 'Issue this work order to kitting before starting operations.' : gate ? <>Locked behind inspection point Op {operationNumber(o, gate.id)} · {asText(gate.title)}. It must be bought off before work can move past it.</> : MES.pendingSequenceChange(o) ? 'QA must release the updated operation sequence before work continues.' : `Operation ${sequence(next)} must be completed before this step can be recorded.`}</p></div>}
          <div className="task-records" aria-label="Operation files and quality records"><div className="task-record-actions">{operationActions(o, op)}</div>{renderMediaEvidence(o, op)}{renderAttachments(o, op)}{operationLinks(o, op)}</div>
          {renderDiscussion(o, op)}
        </div>
      </section>
    </div>
    <div className="context-footer"><span><Lock size={14}/> Operation changes need QA release before work continues.</span><button className="btn quiet" data-action="profile"><User size={14}/> {asText(state.profile.name)} · {asText(state.profile.credentialId)}</button></div>
    {renderLatest(o)}
  </>;
}

let root = null;
let rootElement = null;
window.FlightReact = {
  renderHangar(element, state, MES, onOpen) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<Hangar state={state} MES={MES} onOpen={onOpen}/>));
  },
  renderOrders(element, state, MES, props, onOpen) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<WorkOrderQueue state={state} MES={MES} rows={props.rows} initial={props.initial} callbacks={props.callbacks} onOpen={onOpen}/>));
  },
  renderPlan(element, state, MES, FlightPlan, onMutation, initialQuery = '', initialStatus = 'All') {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<PlanBoard state={state} MES={MES} FlightPlan={FlightPlan} onMutation={onMutation} initialQuery={initialQuery} initialStatus={initialStatus}/>));
  },
  renderPlanKanban(element, state, MES, FlightPlan) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<PlanKanban state={state} MES={MES} FlightPlan={FlightPlan}/>));
  },
  renderPlanForecast(element, state, MES, FlightPlan) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<PlanForecast state={state} MES={MES} FlightPlan={FlightPlan}/>));
  },
  renderManeuver(element, state, FM, view, onOpen) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<ManeuverHangar state={state} FM={FM} view={view} onOpen={onOpen}/>));
  },
  renderSerials(element, state, onTrace, onOpen) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<SerialRegister state={state} onTrace={onTrace} onOpen={onOpen}/>));
  },
  renderTraceSearch(element, state, MES, initialQuery, onSearch, onReport, onRoute) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<TraceSearch state={state} MES={MES} initialQuery={initialQuery} onSearch={onSearch} onReport={onReport} onRoute={onRoute}/>));
  },
  renderActivity(element, events, onOpenOrder) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<ActivityLog events={events} onOpenOrder={onOpenOrder}/>));
  },
  renderManeuverDetail(element, state, MES, FM, sel, skCan, helpers, view) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<ManeuverDetail state={state} MES={MES} FM={FM} sel={sel} skCan={skCan} helpers={helpers} view={view}/>));
  },
  renderWILibrary(element, state, MES, props) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<WILibrary state={state} MES={MES} {...props}/>));
  },
  renderWIDetail(element, state, MES, props) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<WIDetail state={state} MES={MES} {...props}/>));
  },
  renderTraceReport(element, state, MES, props) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<TraceReport state={state} MES={MES} {...props}/>));
  },
  renderSupportLog(element, state, MES, props) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<SupportLog state={state} MES={MES} {...props}/>));
  },
  renderPlanHome(element, state, MES, FlightPlan, skCan) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<PlanHome state={state} MES={MES} FlightPlan={FlightPlan} skCan={skCan}/>));
  },
  renderQmsConfig(element, state, MES, skCan) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<QmsConfig state={state} MES={MES} skCan={skCan}/>));
  },
  renderQmsRecords(element, state, MES) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<QmsRecords state={state} MES={MES}/>));
  },
  renderOrder(element, state, MES, order, tab, selectedOp, skCan, revision) {
    // The page owns the selected work-order revision ([data-rev-select] updates it); mirror it before rendering.
    if (revision) selectedRev = revision;
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<OrderView state={state} MES={MES} order={order} tab={tab} selectedOp={selectedOp} skCan={skCan}/>));
  },  unmount() { if (root) { root.unmount(); root = null; rootElement = null; } }
};
