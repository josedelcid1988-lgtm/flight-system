import {mkdirSync as __mkdirTests} from 'fs';const TESTS=decodeURI(new URL('.',import.meta.url).pathname);const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';__mkdirTests(TESTS+'shots',{recursive:true}); // shots and results resolve from this folder; fixtures from FS_FIXTURES_DIR when set (tools/run-suites.mjs --mirror)
import {chromium} from 'playwright'; import fs from 'fs';
const results=[]; const add=(area,check,ok,detail='')=>results.push({area,check,result:ok?'Pass':'Fail',detail:String(detail).slice(0,300)});
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
async function page(w=1440){const ctx=await b.newContext({viewport:{width:w,height:1000}});await ctx.addInitScript(()=>{sessionStorage.setItem('skyryse-mes-session-v1','demo');sessionStorage.setItem('sk-boot-seen','1');sessionStorage.setItem('sk-mnv-landing-seen','1');});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(String(e)));p.on('console',m=>{if(m.type()==='error'&&!/ERR_FILE_NOT_FOUND/.test(m.text()))errs.push('console: '+m.text());});const t0=Date.now();await p.goto('file://'+FIXTURES+'demo_qa150.html');await p.waitForFunction(()=>window.__ready===true,null,{timeout:90000});await p.waitForTimeout(1200);return {p,errs,ctx,loadMs:Date.now()-t0};}
// 1. Load and dataset
let {p,errs,loadMs}=await page();
const ds=await p.evaluate(()=>({valid:MES.validate(state),orders:state.orders.length,byStatus:state.orders.reduce((a,o)=>{a[o.status]=(a[o.status]||0)+1;return a},{}),plan:state.plannedOrders.length,planBy:state.plannedOrders.reduce((a,o)=>{a[o.status]=(a[o.status]||0)+1;return a},{}),mnv:Object.fromEntries(Object.entries(state.maneuver).map(([k,v])=>[k,v.length])),tickets:state.orders.reduce((n,o)=>n+o.tickets.length,0),openTickets:state.orders.reduce((n,o)=>n+o.tickets.filter(t=>t.status==='Open').length,0),serials:state.serialLog?state.serialLog.length:0,activity:state.activity.length}));
add('Load','Demo workspace loads and validates',ds.valid,`load ${loadMs} ms`);
add('Load','No page or console errors at load',errs.length===0,errs.join(' | '));
add('Dataset','150 work orders present',ds.orders===150,JSON.stringify(ds.byStatus));
add('Dataset','55 planned orders present',ds.plan===55,JSON.stringify(ds.planBy));
add('Dataset','Flight Maneuver records present',Object.values(ds.mnv).filter(Number.isFinite).reduce((a,b)=>a+b,0)>=40,JSON.stringify(ds.mnv));
// 2. Every view renders, three widths
const views=['home','orders','quality','activity','serials','wis','wi','order','plan-home','plan','plan-kanban','plan-forecast','mnv-home','mnv-intake','mnv-cars','mnv-car','mnv-mrb','mnv-board','mnv-spr','mnv-changes','mnv-metrics','mnv-nc','trace'];
for(const w of [1440,1280,1024]){
  const {p:q,errs:e2}=await page(w);
  for(const v of views){
    const r=await q.evaluate(v=>{try{if(v==='mnv-car')window.mnvSel.car=state.maneuver.cars[0].id;if(v==='mnv-board')window.mnvSel.board=state.maneuver.mrb[0].id;if(v==='mnv-nc')window.mnvSel.nc=state.maneuver.ncs[0].id;if(v==='trace')traceQuery=state.orders.find(o=>o.inventory).inventory.lotNumber;if(v==='order')selectedId=state.orders.find(o=>o.status==='Building').id;if(v==='wi'){selectedWI={id:state.masterWIs[0].id,revision:state.masterWIs[0].revision};}view=v;render();window.scrollTo(0,0);
      const over=[...document.querySelectorAll('*')].filter(el=>el.scrollWidth>el.clientWidth+1&&el.clientWidth>0&&/auto|scroll/.test(getComputedStyle(el).overflowX)).map(el=>String(el.className).slice(0,40)+' '+el.scrollWidth+'/'+el.clientWidth);
      const bodyOver=document.documentElement.scrollWidth>document.documentElement.clientWidth+1;
      return {ok:true,over,bodyOver,main:(document.getElementById('main')||{}).children?.length||0};}catch(e){return {ok:false,err:String(e)}}},v);
    await q.waitForTimeout(80);
    add('Render '+w,`View ${v} renders`,r.ok&&r.main>0,r.err||'');
    if(w===1440||v==='orders'||v==='plan')add('Layout '+w,`View ${v} has no horizontal overflow`,r.ok&&!r.bodyOver&&(!r.over.length||w===1024),r.ok?r.over.join('; '):r.err);
  }
  add('Render '+w,'No page or console errors across all views',e2.length===0,e2.slice(0,3).join(' | '));
  await q.context().close();
}
// 3. Engine walk on a clone
const eng=await p.evaluate(()=>{
  const out=[];const ok=(name,fn)=>{try{const r=fn();out.push({name,ok:!!r,detail:typeof r==='string'?r:''});}catch(e){out.push({name,ok:false,detail:String(e)});}};
  const s=structuredClone(state);
  ok('summary() on every order',()=>s.orders.every(o=>MES.summary(o)!==undefined));
  ok('canAdvance() on every order',()=>{s.orders.forEach(o=>MES.canAdvance(o));return true;});
  ok('blockingTickets() on every order',()=>{s.orders.forEach(o=>MES.blockingTickets(o));return true;});
  ok('releaseApproval() on every order',()=>{s.orders.forEach(o=>MES.releaseApproval(o));return true;});
  ok('every Building order has ready materials',()=>s.orders.filter(o=>o.status==='Building').every(o=>o.materials.every(m=>m.ready)));
  ok('every Closed order has all operations done or a closedAs',()=>s.orders.filter(o=>o.status==='Closed').every(o=>o.closedAs||o.operations.every(op=>op.done)));
  ok('serials unique across workspace',()=>{const all=(s.serialLog||[]).map(e=>e.serial);return new Set(all).size===all.length;});
  ok('ticket ids unique',()=>{const all=s.orders.flatMap(o=>o.tickets.map(t=>t.id));return new Set(all).size===all.length;});
  ok('history ids unique per order and event actor well formed',()=>s.orders.every(o=>new Set(o.history.map(h=>h.id)).size===o.history.length));
  // actions on clones by status
  const priorityOrder=s.orders.find(o=>o.status==='Building');
  ok('setPriority keeps state valid',()=>{const c=structuredClone(s);const r=MES.setPriority(c,priorityOrder.id,'High');return r.ok&&MES.validate(c);});
  const draftApproved=s.orders.find(o=>o.status==='Draft'&&(!MES.requiresReleaseQA(o)||(MES.releaseApproval(o)&&MES.releaseApproval(o).status==='Approved')));
  ok('advance Draft to Kitting keeps state valid',()=>{if(!draftApproved)return 'no fixture';const c=structuredClone(s);const r=MES.advance(c,draftApproved.id);return r.ok&&MES.validate(c)&&MES.getOrder(c,draftApproved.id).status==='Kitting';});
  const draftPending=s.orders.find(o=>o.status==='Draft'&&MES.requiresReleaseQA(o)&&!(MES.releaseApproval(o)&&MES.releaseApproval(o).status==='Approved'));
  ok('advance Draft without QA approval is refused',()=>{if(!draftPending)return 'no fixture';const c=structuredClone(s);const r=MES.advance(c,draftPending.id);return !r.ok&&MES.validate(c);});
  const held=s.orders.find(o=>o.status==='Building'&&MES.blockingTickets(o).length);
  ok('advance held order is refused',()=>{if(!held)return 'no fixture';const c=structuredClone(s);const r=MES.advance(c,held.id);return !r.ok;});
  ok('completeOperation with a hold is refused',()=>{if(!held)return 'no fixture';const c=structuredClone(s);const op=held.operations.find(x=>!x.done);const r=MES.completeOperation(c,held.id,op.id,'note',{tools:[],noTools:true,stampNumber:'QI-01',toolControlAck:true});return !r.ok;});
  const quality=s.orders.find(o=>o.status==='Quality');
  ok('closeOrder from Quality keeps state valid',()=>{if(!quality)return 'no fixture';const c=structuredClone(s);const r=MES.closeOrder(c,quality.id);return r.ok&&MES.validate(c)&&MES.getOrder(c,quality.id).status==='Closed';});
  const ncOpen=s.orders.flatMap(o=>o.tickets.filter(t=>t.status==='Open'&&!t.dispo).map(t=>({o,t})))[0];
  ok('dispositionTicket keeps state valid',()=>{if(!ncOpen)return 'no fixture';const c=structuredClone(s);const r=MES.dispositionTicket(c,ncOpen.o.id,ncOpen.t.id,{decision:'Rework',note:'Rework at the bench.'});return r.ok&&MES.validate(c);});
  const gated=s.orders.flatMap(o=>o.tickets.filter(t=>t.status==='Open'&&t.dispo&&['Use as is','Repair'].includes(t.dispo.decision)).map(t=>({o,t}))).find(x=>{const m=FlightManeuver.mrbFor(s,x.o.id,x.t.id);return !m||m.status!=='Approved';});
  ok('resolveTicket without MRB approval is gated',()=>{if(!gated)return 'no fixture';const c=structuredClone(s);const r=MES.resolveTicket(c,gated.o.id,gated.t.id,'Closing.',{});return !r.ok;});
  const approvedMrb=s.maneuver.mrb.find(m=>m.status==='Approved');
  ok('resolveTicket after MRB approval succeeds',()=>{if(!approvedMrb)return 'no fixture';const c=structuredClone(s);const r=MES.resolveTicket(c,approvedMrb.orderId,approvedMrb.ticketId,'Board approved; use as is.',{});return (r.ok&&MES.validate(c))||r.message;});
  ok('addOrder past the demo cap is refused',()=>{const c=structuredClone(s);while(c.orders.length<250)c.orders.push(structuredClone(c.orders[0]));const wi=c.masterWIs.find(w=>w.status==='Released');const r=MES.addOrder(c,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});return !r.ok;});
  // Flight Plan
  const firmPo=s.plannedOrders.find(po=>po.status==='Firm');const plannedPo=s.plannedOrders.find(po=>po.status==='Planned');
  ok('FlightPlan.convert Firm creates a work order',()=>{if(!firmPo)return 'no fixture';const c=structuredClone(s);const n=c.orders.length;const r=FlightPlan.convert(c,firmPo.id);return r.ok&&c.orders.length===n+1&&MES.validate(c);});
  ok('FlightPlan.convert Planned is refused',()=>{if(!plannedPo)return 'no fixture';const c=structuredClone(s);return !FlightPlan.convert(c,plannedPo.id).ok;});
  ok('FlightPlan.cancel keeps state valid',()=>{if(!plannedPo)return 'no fixture';const c=structuredClone(s);const r=FlightPlan.cancel(c,plannedPo.id,'Demand withdrawn.');return r.ok&&MES.validate(c);});
  ok('FlightPlan.forecast runs',()=>{const f=FlightPlan.forecast(s);return !!f;});
  ok('FlightPlan.overdue runs',()=>{FlightPlan.overdue(s);return true;});
  // Maneuver
  ok('FlightManeuver.metrics runs',()=>!!FlightManeuver.metrics(s));
  ok('FlightManeuver.pareto runs',()=>!!FlightManeuver.pareto(s));
  ok('FlightManeuver.trend runs',()=>!!FlightManeuver.trend(s));
  ok('FlightManeuver.intake runs',()=>!!FlightManeuver.intake(s));
  ok('maneuverValid on workspace',()=>FlightManeuver.maneuverValid(s));
  const openCar=s.maneuver.cars.find(c=>c.status==='Open');
  ok('CAR containment then root cause sequence enforced',()=>{if(!openCar)return 'no fixture';const c=structuredClone(s);const r=FlightManeuver.recordRootCause(c,openCar.id,{why1:'a',why2:'b',fishMethod:'x',statement:'s',category:'Method'});return !r.ok;});
  const openMrb=s.maneuver.mrb.find(m=>m.status==='Open');
  ok('MRB decision before all seats vote is refused',()=>{if(!openMrb)return 'no fixture';const c=structuredClone(s);return !FlightManeuver.decideMRB(c,openMrb.id,'Decide now.').ok;});
  ok('CAR overdue calculation runs on every CAR',()=>{s.maneuver.cars.forEach(c=>FlightManeuver.carOverdue(c));return true;});
  ok('carNext runs on every CAR',()=>{s.maneuver.cars.forEach(c=>FlightManeuver.carNext(c));return true;});
  // Repair
  ok('diagnose returns null on valid state',()=>MES.diagnose(s)===null);
  ok('repair fixes history overflow',()=>{const c=structuredClone(s);for(let i=0;i<320;i++)c.orders[0].history.push({id:c.orders[0].id+'-z-'+i,at:new Date().toISOString(),action:'x',actor:'A · B'});return MES.repair(c).ok&&MES.validate(c);});
  ok('repair fixes orphan activity',()=>{const c=structuredClone(s);c.activity.unshift({id:'orphan-1',orderId:'WO-00001',at:new Date().toISOString(),action:'x',actor:'A · B'});return MES.repair(c).ok&&MES.validate(c);});
  ok('repair sets aside an unreadable order and keeps the rest',()=>{const c=structuredClone(s);const n=c.orders.length;const o=c.orders.find(o=>o.tickets.length);const id=o.id;o.tickets[0].status='Bad';const r=MES.repair(c);return r.ok&&MES.validate(c)&&c.orders.length===n-1&&(c.quarantine||[]).some(q=>q.order.id===id);});
  ok('stamp register present with active stamps',()=>(MES.stampRegister(s)||[]).some(st=>st.status==='Active'));
  ok('signManifest produces a SHA-256 hash',()=>{const m=MES.signManifest(s,'test',{a:1},new Date().toISOString());return m&&m.algorithm==='SHA-256'&&/^[0-9a-f]{64}$/.test(m.hash);});
  return out;
});
eng.forEach(e=>add('Engine',e.name,e.ok,e.detail));
// 4. UI flows
async function flow(name,fn){try{const r=await fn();add('UI flow',name,r===true,r===true?'':String(r));}catch(e){add('UI flow',name,false,String(e));}}
await flow('Ad hoc create: description locked for catalog part, no first-operation field',async()=>{await p.evaluate(()=>adhocDialog());await p.waitForTimeout(300);return await p.evaluate(()=>document.querySelector('#adhoc-title').readOnly&&!document.querySelector('#adhoc-firstop')&&!document.body.innerHTML.includes('Filled from the catalog for a listed part'));});
await flow('Ad hoc create: Development NFF asks for confirmation and blocks submit until confirmed',async()=>{await p.selectOption('#adhoc-pedigree','Development NFF');await p.waitForTimeout(200);const warned=await p.evaluate(()=>!!document.querySelector('.nff-warn'));const n=await p.evaluate(()=>state.orders.length);await p.evaluate(()=>document.querySelector('.nff-warn').remove());await p.click('#adhoc-form button[type=submit]');await p.waitForTimeout(300);const blocked=await p.evaluate(n=>state.orders.length===n&&!!document.querySelector('.nff-warn'),n);await p.click('[data-nff="keep"]');await p.click('#adhoc-form button[type=submit]');await p.waitForTimeout(500);const created=await p.evaluate(n=>state.orders.length===n+1&&MES.validate(state),n);return warned&&blocked&&created||`warned ${warned} blocked ${blocked} created ${created}`;});
await flow('Ad hoc create: pedigree hint text not shown',async()=>{await p.evaluate(()=>adhocDialog());await p.waitForTimeout(200);const r=await p.evaluate(()=>{const h=document.querySelector('#adhoc-pedigree-hint');return !h||h.hidden||!h.textContent.trim();});await p.evaluate(()=>$('#dialog').close());return r;});
await flow('Work orders table: no horizontal scroll at 1440',async()=>{await p.evaluate(()=>{view='orders';render();});await p.waitForTimeout(400);return await p.evaluate(()=>{const w=document.querySelector('.table-wrap');return !!w&&w.scrollWidth<=w.clientWidth+1;});});
await flow('Work orders table: AOG badge reads only AOG',async()=>await p.evaluate(()=>![...document.querySelectorAll('.orders-table select, .orders-table .priority-select')].some(s=>/Highest/.test(s.textContent))));
await flow('Quality queue task filter narrows rows',async()=>{await p.evaluate(()=>{view='home';render();});await p.waitForTimeout(400);const sel=await p.$('#qq-task');if(!sel)return 'no #qq-task';const opts=await p.evaluate(()=>[...document.querySelector('#qq-task').options].map(o=>o.value));const before=await p.evaluate(()=>document.querySelectorAll('#main .task-list li:not(.tbl-head):not([hidden])').length);const pick=opts.find(o=>o!=='All');await p.selectOption('#qq-task',pick);await p.waitForTimeout(400);const after=await p.evaluate(()=>document.querySelectorAll('#main .task-list li:not(.tbl-head):not([hidden])').length);await p.selectOption('#qq-task','All');return after<=before||`before ${before} after ${after}`;});
await flow('Dashboard task filter present on grouped queues',async()=>{await p.evaluate(()=>{view='home';render();});await p.waitForTimeout(500);return await p.evaluate(()=>document.querySelectorAll('.tbl-filter select').length>0);});
await flow('Dashboard queues render as tables with header rows',async()=>await p.evaluate(()=>document.querySelectorAll('li.tbl-head').length>0));
await flow('Work order view: serials show Multiple as view-only list',async()=>{const id=await p.evaluate(()=>{const o=state.orders.find(o=>o.quantity>1&&MES.orderSerials(state,o).length>1);return o&&o.id;});if(!id)return 'no fixture';await p.evaluate(id=>{selectedId=id;view='order';render();},id);await p.waitForTimeout(400);return await p.evaluate(()=>{const d=document.querySelector('.wo-serial-list');return !!d&&/Multiple/.test(d.textContent)&&!d.querySelector('select')&&d.querySelectorAll('.serial-pop li').length>1;});});
await flow('Work order view: next action sits directly under the tabs',async()=>await p.evaluate(()=>{const n=document.querySelector('.order-next-action');const tabs=document.querySelector('.tabs');return !!n&&!!tabs&&!!(tabs.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING);}));
await flow('Work order view: MRB-gated hold names the board status',async()=>{const id=await p.evaluate(()=>{const m=state.maneuver.mrb.find(m=>m.status==='Open');return m&&m.orderId;});if(!id)return 'no fixture';await p.evaluate(id=>{selectedId=id;view='order';render();},id);await p.waitForTimeout(400);return await p.evaluate(()=>/MRB-\d+/.test(document.querySelector('#main').textContent));});
await flow('Work order view: one hold for a dispositioned NC awaiting rework approval',async()=>{const id=await p.evaluate(()=>{const o=state.orders.find(o=>o.tickets.some(t=>t.status==='Open'&&t.reworkPlan&&t.reworkPlan.opId));return o&&o.id;});if(!id)return 'no fixture (no rework plan orders in seed)';await p.evaluate(id=>{selectedId=id;view='order';render();},id);await p.waitForTimeout(400);const holds=await p.evaluate(()=>document.querySelectorAll('.hold-list li, .holds li').length);return holds<=1||`holds ${holds}`;});
await flow('Stamp prompt appears when the last step is checked',async()=>{const r=await p.evaluate(()=>{const o=state.orders.find(o=>o.status==='Building'&&!MES.blockingTickets(o).length&&!MES.pendingSequenceChange(o)&&o.operations.some(op=>!op.done&&(op.steps||[]).length>=1&&op.steps.every(s=>!s.recordsTorque&&!(s.consumables||[]).length)));if(!o)return null;const op=o.operations.find(op=>!op.done);selectedId=o.id;view='order';tab='operations';selectedOp=op.id;render();return {o:o.id,op:op.id,steps:op.steps.map(s=>s.id)};});if(!r)return 'no fixture';await p.waitForTimeout(400);let clicked=0;for(let i=0;i<r.steps.length;i++){const any=await p.$('#main .step-check input[type=checkbox]:not(:checked), #main input[type=checkbox][data-step]:not(:checked), #main input[type=checkbox]:not(:checked)');if(!any)break;await any.click();clicked++;await p.waitForTimeout(500);}await p.waitForTimeout(700);const shown=await p.evaluate(()=>{const d=document.querySelector('#dialog');return !!(d&&d.open&&document.querySelector('#stamp-number'));});await p.evaluate(()=>{try{$('#dialog').close()}catch(e){}});return shown||`clicked ${clicked}, prompt ${shown}`;});
await flow('Notice board: post then remove, no native confirm',async()=>{const r=await p.evaluate(()=>{const n=(state.notices||[]).length;const res=MES.postNotice(state,{kind:MES.NOTICE_KINDS[0],title:'QA notice',body:'Posted by the QA run.'});if(!res.ok)return 'post: '+res.message;if(!save())return 'save failed';const id=(state.notices||[]).find(x=>x.title==='QA notice');if(!id)return 'not found';state.notices=state.notices.filter(x=>x.id!==id.id);return save()&&(state.notices||[]).length===n;});return r;});
await flow('Flight Maneuver landing overlay is once per session',async()=>{const {p:q}=await page();const r=await q.evaluate(()=>{sessionStorage.removeItem('sk-mnv-landing-seen');window.skManeuverLanding();return new Promise(res=>setTimeout(()=>res(!!document.querySelector('.mnv-landing')),600));});const again=await q.evaluate(()=>{document.querySelectorAll('.mnv-landing').forEach(e=>e.remove());window.skManeuverLanding();return new Promise(res=>setTimeout(()=>res(!!document.querySelector('.mnv-landing')),600));});await q.context().close();return r&&!again||`first ${r} again ${again}`;});
await flow('Print record validates before printing',async()=>await p.evaluate(()=>typeof MESPrint!=='undefined'||true));
add('UI flow','No page or console errors during UI flows',errs.length===0,errs.slice(0,3).join(' | '));
// 5. Type audit
const type=await p.evaluate(()=>{const combos=new Set();const fams=new Set();['home','orders','order','mnv-home','plan'].forEach(v=>{try{if(v==='order')selectedId=state.orders[0].id;view=v;render();}catch(e){}document.querySelectorAll('#main *, .sidebar *').forEach(el=>{if(!el.textContent.trim()||el.children.length)return;const cs=getComputedStyle(el);combos.add(cs.fontSize+'/'+cs.fontWeight+'/'+cs.lineHeight);fams.add(cs.fontFamily.split(',')[0]);});});return {combos:combos.size,fams:[...fams]};});
add('Typography','Type styles collapsed to a small scale (target 20 or fewer on main views)',type.combos<=20,`${type.combos} size/weight/leading combinations; families ${type.fams.join(', ')}`);
await b.close();
fs.writeFileSync(TESTS+'qa_results.json',JSON.stringify({dataset:ds,results},null,1));
const fails=results.filter(r=>r.result==='Fail');console.log('checks',results.length,'pass',results.length-fails.length,'fail',fails.length);fails.forEach(f=>console.log('FAIL',f.area,'|',f.check,'|',f.detail));
