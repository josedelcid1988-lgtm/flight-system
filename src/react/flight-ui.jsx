import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ArrowUpRight, Boxes, CalendarClock, Check, ChevronRight, CircleAlert, FileText, Plus, Search, SlidersHorizontal, X } from 'lucide-react';

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
    {milestoneRisks.length > 0 && <section className="fr-milestone-watch" aria-label="Project milestones at risk"><div className="fr-section-heading"><h2>Project milestones at risk</h2><span className="fr-count">{String(milestoneRisks.length).padStart(2, '0')}</span></div>{milestoneRisks.map(item => <div className="fr-milestone-watch-row" key={item.id}><div><strong>{item.id} · {item.title}</strong><span>{item.risk} · due {new Date(`${item.dueDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}{item.workOrderId ? ` · ${item.workOrderId}` : ''}</span></div>{item.workOrderId && <button className="fr-record-link" onClick={() => { const workOrder = state.orders.find(order => order.id === item.workOrderId); if (workOrder) onOpen(workOrder); }}>Open work order</button>}</div>)}</section>}
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
          <form onSubmit={event => submit(event, data => MES.addEquipmentUnit(state, { ...data, tag: data.tag || undefined }))}><h3>Add work unit</h3><label>Unit name<input name="name" maxLength="80" required/></label><label>Unit tag<input name="tag" maxLength="60" placeholder="Assigned when added"/></label><label>Work center<select name="workCenterId">{MES.WORK_CENTERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Area<select name="areaId"><option value="">No area</option>{(state.resources?.areas || []).map(area => <option key={area.id} value={area.id}>{area.id} · {area.name}</option>)}</select></label><label>Calibrated tool<select name="toolTag"><option value="">No linked tool</option>{MES.CAL_TOOLS.map(tool => <option key={tool.tag} value={tool.tag}>{tool.tag} · {tool.description}</option>)}</select></label><button type="submit">Add unit</button></form>
          <form onSubmit={event => submit(event, data => MES.recordMaintenance(state, data))}><h3>Open maintenance</h3><label>Asset<select name="assetTag">{MES.equipmentUnitsFor(state).map(unit => <option key={unit.tag} value={unit.tag}>{unit.tag} · {unit.name}</option>)}{MES.CAL_TOOLS.map(tool => <option key={tool.tag} value={tool.tag}>{tool.tag} · {tool.description}</option>)}</select></label><label>Maintenance type<select name="type">{MES.MAINTENANCE_TYPES.map(type => <option key={type}>{type}</option>)}</select></label><label>Description<input name="description" maxLength="300" required/></label><button type="submit">Take out of service</button></form>
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
  const hasRows = result && ['orders', 'tickets', 'mrb', 'sprs', 'cars', 'changes', 'wis'].some(key => Array.isArray(result[key]) && result[key].length > 0);
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
  unmount() { if (root) { root.unmount(); root = null; rootElement = null; } }
};
