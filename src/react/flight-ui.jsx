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

function PlanBoard({ state, MES, FlightPlan, onMutation }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
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
      <button className="fr-primary" onClick={() => { onOpen(record); close(); }}>Open full record <ArrowUpRight size={17}/></button>
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
  renderPlan(element, state, MES, FlightPlan, onMutation) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<PlanBoard state={state} MES={MES} FlightPlan={FlightPlan} onMutation={onMutation}/>));
  },
  renderManeuver(element, state, FM, view, onOpen) {
    if (!root || rootElement !== element) {
      if (root) root.unmount();
      root = createRoot(element);
      rootElement = element;
    }
    flushSync(() => root.render(<ManeuverHangar state={state} FM={FM} view={view} onOpen={onOpen}/>));
  },
  unmount() { if (root) { root.unmount(); root = null; rootElement = null; } }
};
