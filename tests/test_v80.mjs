import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));const fails=[];const ok=(w,c,m)=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
async function signIn(u){await p.evaluate(()=>{try{sessionStorage.removeItem('skyryse-mes-session-v1');}catch(e){}}).catch(()=>{});await p.goto('file:///Users/josedelcid/projects/flight-system/tests/fixtures/'+FILE);await p.waitForTimeout(900);
 await p.evaluate(x=>{const un=document.querySelector('#sk-boot input[name=username]');if(!un)return;const pw=document.querySelector('#sk-boot input[type=password]');un.value=x;un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},u);await p.waitForTimeout(2800);}
const R=(fn,a)=>p.evaluate(fn,a);
let FILE='demo_qa150_publish.html';import fs from 'fs';
// ---- production build: separation of duties on approval ----
await signIn('demo');
ok('library migrated to pairs (rework then inspection), all Draft',await R(()=>MES.reworkLibrary(state).every(t=>t.ops.length===2&&['Rework','Repair'].includes(t.ops[0].classification)&&t.ops[1].classification==='Inspection'&&t.status==='Draft')),'shape');
ok('single operation (no inspection) refused',!(await R(()=>MES.saveReworkTemplate(structuredClone(state),{ops:[{classification:'Rework',title:'x',buyoffType:'Technician',steps:[{title:'a',instruction:'b'}]}]}))).ok,'allowed');
ok('pair in wrong order refused',!(await R(()=>MES.saveReworkTemplate(structuredClone(state),{ops:[{classification:'Inspection',title:'i',buyoffType:'Quality',steps:[{title:'a',instruction:'b'}]},{classification:'Rework',title:'x',buyoffType:'Technician',steps:[{title:'a',instruction:'b'}]}]}))).ok,'allowed');
ok('inspection with Technician buy-off refused',!(await R(()=>MES.saveReworkTemplate(structuredClone(state),{ops:[{classification:'Rework',title:'x',buyoffType:'Technician',steps:[{title:'a',instruction:'b'}]},{classification:'Inspection',title:'i',buyoffType:'Technician',steps:[{title:'a',instruction:'b'}]}]}))).ok,'allowed');
const nid=await R(()=>{const r=MES.saveReworkTemplate(state,{title:'Replace damaged grommet',classification:'Rework',buyoffType:'Technician',steps:'Remove grommet: Remove the damaged grommet.\nInstall grommet: Install a new grommet per the drawing.'});return r.id||r.message;});
ok('new pair saved as Draft',/^SRW-/.test(nid),nid);
{const prod=fs.readFileSync('/Users/josedelcid/projects/flight-system/tests/fixtures/publish.html','utf8');ok('production keeps the author-cannot-approve guard (demo lifts it)',/author\.credentialId && author\.credentialId === actor\(state\)\.credentialId\) return fail\('The person who wrote or last edited this standard rework/.test(prod),'guard missing');}
ok('seed pair (no author) can be approved by QA',await R(()=>{const t=MES.reworkLibrary(state)[0];const r=MES.approveReworkTemplate(state,t.id);return r.ok&&t.status==='Approved'&&t.rev===1;}),'not approved');
ok('any content edit returns an approved pair to Draft',await R(()=>{const t=MES.reworkLibrary(state)[0];MES.saveReworkTemplate(state,{id:t.id,title:t.title+' rev',classification:t.classification,buyoffType:t.buyoffType,steps:t.ops[0].steps});return t.status==='Draft';}),'still approved');
// ---- demo build: add to a WO ----
FILE='demo_qa150_publish.html';await signIn('demo');
const fx=await R(()=>{MES.reworkLibrary(state).filter(t=>t.status!=='Approved').forEach(t=>MES.approveReworkTemplate(state,t.id));const o=state.orders.find(o=>o.status==='Building'&&!MES.blockingTickets(o).length&&!MES.engineeringChange(o)&&!MES.pendingSequenceChange(o)&&o.operations.length<=14);const op=o.operations.find(x=>!x.done);const t=MES.createTicket(state,o.id,op.id,{type:'NC',title:'Loose fastener',description:'Fastener loose at J2.',hold:true});MES.dispositionTicket(state,o.id,t.id,{decision:'Rework',note:'Re-torque.'});const c=MES.DEFECT_CODES[0];MES.resolveTicket(state,o.id,t.id,'Rework approved.',{defectCode:c.code,subCode:c.subs[0].code,quantity:1,serials:[]});save();return {o:o.id,t:t.id,n:o.operations.length};});
ok('Draft template cannot be added',!(await R(a=>{const x=structuredClone(state);const t=MES.reworkLibrary(x)[0];t.status='Draft';return MES.addStandardRework(x,a.o,{templateId:t.id,ticketId:a.t,position:MES.firstInsertIndex(MES.getOrder(x,a.o))});},fx)).ok,'allowed');
ok('adjusted content refused (title override)',!(await R(a=>{const x=structuredClone(state);const t=MES.reworkLibrary(x)[0];return MES.addStandardRework(x,a.o,{templateId:t.id,ticketId:a.t,position:MES.firstInsertIndex(MES.getOrder(x,a.o)),title:'Changed'});},fx)).ok,'allowed');
ok('stale content hash refused',!(await R(a=>{const x=structuredClone(state);const t=MES.reworkLibrary(x)[0];return MES.addStandardRework(x,a.o,{templateId:t.id,ticketId:a.t,position:MES.firstInsertIndex(MES.getOrder(x,a.o)),contentHash:'bogus'});},fx)).ok,'allowed');
ok('addOrderOperation with a standardRework id refused (must use the pair)',!(await R(a=>{const x=structuredClone(state);const t=MES.reworkLibrary(x)[0];return MES.addOrderOperation(x,a.o,{classification:'Rework',title:t.title,buyoffType:'Technician',stepList:t.ops[0].steps,position:MES.firstInsertIndex(MES.getOrder(x,a.o)),ticketId:a.t,standardRework:t.id});},fx)).ok,'allowed');
// UI: pick the template in the add-op dialog: fields locked, preview shown, submit adds the pair
await R(a=>{selectedId=a.o;view='order';tab='operations';render();sequenceAddDialog();},fx);await p.waitForTimeout(300);
await R(()=>{const c=document.getElementById('seq-class');c.value='Rework';c.dispatchEvent(new Event('change',{bubbles:true}));});await p.waitForTimeout(150);
const optCount=await R(()=>[...document.querySelectorAll('#seq-std-rw-select option')].filter(o=>o.value&&!o.hidden).length);ok('picker lists approved Rework pairs only',optCount>=1,optCount);
await R(()=>{const s=document.getElementById('seq-std-rw-select');s.value=[...s.options].find(o=>o.value&&!o.hidden).value;s.dispatchEvent(new Event('change',{bubbles:true}));});await p.waitForTimeout(250);
const ui=await R(()=>({locked:document.getElementById('seq-title').disabled&&document.getElementById('seq-buyoff').disabled,preview:!document.getElementById('seq-std-preview').hidden&&document.querySelectorAll('#seq-std-preview .std-rw-op').length,btn:(document.querySelector('#wiz-actions button[type=submit]')||{}).textContent}));
ok('fields locked and pair preview shown',ui.locked&&ui.preview===2&&/standard rework pair/.test(ui.btn||''),JSON.stringify(ui));
await p.screenshot({path:'/Users/josedelcid/projects/flight-system/tests/shots/v80_std_pick.png'});
await R(()=>document.querySelector('#wiz-actions button[type=submit]').click());await p.waitForTimeout(400);
const after=await R(a=>{const o=MES.getOrder(state,a.o);const ops=o.operations.filter(x=>x.fromStandardRework);const t=o.tickets.find(x=>x.id===a.t);return {n:ops.length,cls:ops.map(x=>x.classification),linked:ops[0]&&ops[0].ticketId===a.t,insp:ops[1]&&ops[1].reworkInspectionFor===ops[0].id,stage:t.reworkPlan&&t.reworkPlan.stage,err:(document.getElementById('seq-add-error')||{}).textContent,ids:ops.map(x=>x.id)};},fx);
ok('pair added: rework linked to the NC, inspection tied to it',after.n===2&&after.cls[0]==='Rework'&&after.cls[1]==='Inspection'&&after.linked&&after.insp&&after.stage==='Awaiting QA release',JSON.stringify(after));
ok('pair operation cannot be edited',!(await R(a=>MES.editOrderOperation(structuredClone(state),a.o,a.id,{title:'x'}),{o:fx.o,id:after.ids[0]})).ok,'allowed');
const rm=await R(a=>{const x=structuredClone(state);const r=MES.removeOrderOperation(x,a.o,a.id,'Wrong rework selected.');return {ok:r.ok,left:MES.getOrder(x,a.o).operations.filter(q=>q.fromStandardRework).length,m:r.message};},{o:fx.o,id:after.ids[1]});
ok('removing one removes its partner',rm.ok&&rm.left===0,JSON.stringify(rm));
ok('QE releases the sequence and the NC closes',await R(a=>{const r=MES.approveSequenceChange(state,a.o);save();const t=MES.getOrder(state,a.o).tickets.find(x=>x.id===a.t);return r.ok&&t.status!=='Open';},fx),'not released');
ok('workspace valid',await R(()=>MES.validate(state)),'invalid');
// library panel buttons
await R(()=>{view='wis';render();});await p.waitForTimeout(300);
ok('library panel shows status and Approve/Edit',await R(()=>!!document.querySelector('.std-rw-panel')&&/approved/.test(document.querySelector('.std-rw-panel .panel-head').textContent)),'no panel');
// Running aircraft order in the subcategory list
await R(()=>{adhocDialog();});await p.waitForTimeout(300);
const ac=await R(()=>({opt:!!document.querySelector('#adhoc-subcategory option[value="__aircraft"]'),cb:!!document.getElementById('adhoc-aircraft-order'),label:document.querySelector('label[for=adhoc-subcategory]').textContent}));
ok('Running aircraft order is a Work order subcategory option, checkbox gone',ac.opt&&!ac.cb&&/Work order subcategory/.test(ac.label),JSON.stringify(ac));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
