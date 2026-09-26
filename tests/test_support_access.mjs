// Item 3: no username bypass in production; Support Access granted only through Master Access,
// every override needs a reason and is logged; separation of duties is never overridable.
import {chromium} from 'playwright';
import fs from 'fs';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);

// First account (Master Access on a new device) through the real setup form, then the other accounts written the way the app writes them.
await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  add('mhale','Morgan Hale','admin');add('rsupport','Robin Support','technician');add('demo','Demo Account','qm');add('kqe','Kai Quality','qe');add('pqm','Parker Manager','qm');add('tme','Taylor Engineer','me');
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);
const as=u=>run(([S,u])=>{sessionStorage.setItem(S,u);},[SESSION,u]);

// ---- 1. A saved workspace with an account named demo loads unchanged; one notice is written ----
const before=await run(()=>({orders:state.orders.length,valid:MES.validate(state)}));
await as('demo');await run(()=>window.dispatchEvent(new Event('sk-auth')));await p.waitForTimeout(400);
const notice=await run(()=>({n:(state.supportLog||[]).filter(e=>e.kind==='notice'&&e.recordId==='demo').length,valid:MES.validate(state),orders:state.orders.length,role:skAuth.role(),text:((state.supportLog||[]).find(e=>e.kind==='notice')||{}).reason||''}));
ok('workspace with a demo account loads unchanged and validates',notice.valid&&notice.orders===before.orders,JSON.stringify(notice));
ok('the demo account keeps its real role (QA Manager)',notice.role==='qm',notice.role);
ok('one activity entry notes the bypass was removed',notice.n===1&&/bypass removed/.test(notice.text),JSON.stringify(notice));
await p.reload();await p.waitForTimeout(1200);await as('demo');await run(()=>window.dispatchEvent(new Event('sk-auth')));await p.waitForTimeout(400);
ok('the notice is written once, not on every sign-in',await run(()=>(state.supportLog||[]).filter(e=>e.kind==='notice'&&e.recordId==='demo').length)===1);
{const src=fs.readFileSync(TESTS+'../index.html','utf8');const lines=src.split('\n').filter(l=>/['"]demo['"]/.test(l));
ok('production source compares no username to demo outside the one-time notice',lines.every(l=>l.includes('function noteDemoAccount')),lines.map(l=>l.slice(0,120)).join(' | '));}

// Seed two Building orders as the QA Manager.
await as('jdoe');
const [W1,W2]=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const mk=()=>{const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});if(!r.ok)throw new Error(r.message);const o=MES.getOrder(state,r.id);let a=MES.advance(state,r.id);if(!a.ok)throw new Error(a.message);o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,r.id,m.id,l?l.lot:'L1');MES.setMaterial(state,r.id,m.id,true);});MES.addKitFile(state,r.id,{name:'kit.pdf',type:'application/pdf',size:10,dataUrl:null});a=MES.advance(state,r.id);if(!a.ok)throw new Error(a.message);return r.id;};const ids=[mk(),mk()];save();return ids;});

// ---- 2. The demo account is an ordinary account now ----
await as('demo');
const demoRules=await run(([W2])=>{const c=structuredClone(state);const o=MES.getOrder(c,W2);const op=o.operations[0];
  (op.steps||[]).forEach(st=>MES.setStepCheck(c,W2,op.id,st.id,true,{}));
  const buy=MES.completeOperation(c,W2,op.id,'note',{tools:[],noTools:true,standardInspection:true});
  const t=MES.createTicket(c,W2,op.id,{type:'NC',title:'Scratch on face',description:'Light scratch found at bench.',hold:true});const tid=MES.getOrder(c,W2).tickets.slice(-1)[0].id;
  const d=MES.dispositionTicket(c,W2,tid,{decision:'Rework',note:'Blend and refinish at the bench.'});
  const self=MES.resolveTicket(c,W2,tid,'Approving my own disposition.',{});
  return {buy:buy.ok,buyMsg:buy.message,t:t.ok,d:d.ok,dMsg:d.message,self:self.ok,selfMsg:self.message};},[W2]);
ok('demo account cannot buy off without a stamp',demoRules.buy===false,demoRules.buyMsg);
ok('demo account cannot approve its own NC disposition',demoRules.t&&demoRules.d&&demoRules.self===false&&/Separation of duties/.test(demoRules.selfMsg||''),JSON.stringify(demoRules));

// ---- 3. Only Master Access grants Support Access ----
await as('pqm');
const qmGrant=await run(()=>skAuth.setSupportAccess('rsupport',true,'Needs to clear a stuck buy-off.'));
ok('a QA Manager cannot grant Support Access',qmGrant.ok===false&&/Master Access/.test(qmGrant.message),JSON.stringify(qmGrant));
await as('mhale');
const shortReason=await run(()=>skAuth.setSupportAccess('rsupport',true,'short'));
ok('a grant without a reason is refused',shortReason.ok===false,JSON.stringify(shortReason));
const grant=await run(()=>skAuth.setSupportAccess('rsupport',true,'Floor support lead for the pilot line.'));await p.waitForTimeout(200);
const grantLog=await run(()=>(state.supportLog||[]).find(e=>e.kind==='grant'&&e.recordId==='rsupport'));
ok('Master Access grants Support Access and the grant is logged with the granter',grant.ok&&!!grantLog&&grantLog.credentialId==='ACCT-mhale'&&grantLog.reason.includes('pilot line'),JSON.stringify({grant,grantLog}));

// ---- 4. Stamp binding override: refused without a reason, logged with one ----
await as('rsupport');
const buy=await run(([W1])=>{const o=MES.getOrder(state,W1);const op=o.operations[0];(op.steps||[]).forEach(st=>MES.setStepCheck(state,W1,op.id,st.id,true,{}));
  const x={tools:[],noTools:true,standardInspection:true};
  const noReason=MES.completeOperation(structuredClone(state),W1,op.id,'Built to the WI.',x);
  const tooShort=MES.completeOperation(structuredClone(state),W1,op.id,'Built to the WI.',{...x,supportReason:'short'});
  const withReason=MES.completeOperation(state,W1,op.id,'Built to the WI.',{...x,supportReason:'Stamp register not loaded yet; lead confirmed the build.'});
  save();const done=MES.getOrder(state,W1).operations[0];const e=(state.supportLog||[]).find(y=>y.kind==='override');
  return {noReason:noReason.ok,noMsg:noReason.message,tooShort:tooShort.ok,withReason:withReason.ok,wMsg:withReason.message,kind:done.buyoff&&done.buyoff.override&&done.buyoff.override.kind,entry:e,hist:MES.getOrder(state,W1).history.slice(-1)[0].action,verify:MES.verifyManifests(state).ok,valid:MES.validate(state),opId:op.id};},[W1]);
ok('Support Access buy-off without a reason is refused and says the override exists',buy.noReason===false&&/Support Access can override/.test(buy.noMsg||''),buy.noMsg);
ok('Support Access buy-off with a reason under 10 characters is refused',buy.tooShort===false);
ok('Support Access buy-off with a reason succeeds and is recorded as a Support Access override',buy.withReason&&buy.kind==='Support Access override',JSON.stringify(buy).slice(0,300));
ok('override entry names person, credential, time, rule lifted and record affected',!!buy.entry&&buy.entry.person==='Robin Support'&&buy.entry.credentialId==='ACCT-rsupport'&&!!Date.parse(buy.entry.at)&&buy.entry.rule==='stamp-binding'&&buy.entry.recordId===`${W1} ${buy.opId}`&&buy.entry.reason.includes('register'),JSON.stringify(buy.entry));
ok('the order history points at the override log entry',!!buy.entry&&buy.hist.includes(buy.entry.id),buy.hist);
ok('manifests still verify and the workspace validates after an override',buy.verify&&buy.valid);

// ---- 5. Without Support Access the reason does nothing ----
await as('tme');
const noSupport=await run(([W2])=>{const c=structuredClone(state);const o=MES.getOrder(c,W2);const op=o.operations[0];(op.steps||[]).forEach(st=>MES.setStepCheck(c,W2,op.id,st.id,true,{}));return MES.completeOperation(c,W2,op.id,'x',{tools:[],noTools:true,standardInspection:true,supportReason:'I would like to skip the stamp please.'});},[W2]);
ok('an account without Support Access cannot use an override reason',noSupport.ok===false&&/not granted/.test(noSupport.message||''),JSON.stringify(noSupport));

// ---- 6. MRB seat eligibility override; one person one seat still holds ----
await as('jdoe');
const board=await run(([W2])=>{const o=MES.getOrder(state,W2);const op=o.operations.find(x=>!x.done);MES.createTicket(state,W2,op.id,{type:'NC',title:'Cosmetic scratch on bracket face',description:'Light surface scratch, no structural effect.',hold:true});const tid=MES.getOrder(state,W2).tickets.slice(-1)[0].id;MES.dispositionTicket(state,W2,tid,{decision:'Use as is',note:'Cosmetic only.'});const m=FlightManeuver.openMRB(state,W2,tid,'Cosmetic scratch, justification attached.');save();return m.ok?m.id:m.message;},[W2]);
await as('rsupport');
const seat=await run(([id])=>{const none=FlightManeuver.voteMRB(structuredClone(state),id,'Quality','Approve','ok');const withR=FlightManeuver.voteMRB(state,id,'Quality','Approve','Acceptable cosmetic.',{supportReason:'Quality seat holder out today; QA Manager asked me to sit.'});const second=FlightManeuver.voteMRB(structuredClone(state),id,'Engineering','Approve','also',{supportReason:'Engineering holder out as well today.'});save();const e=(state.supportLog||[]).find(x=>x.kind==='override'&&x.rule==='mrb-seat');return {none:none.ok,noneMsg:none.message,withR:withR.ok,wMsg:withR.message,second:second.ok,secondMsg:second.message,entry:e,valid:MES.validate(state)};},[board]);
ok('a seat the role does not hold is refused without a reason',seat.none===false&&/Support Access can override/.test(seat.noneMsg||''),seat.noneMsg);
ok('Support Access takes the seat with a reason and the override is logged against the board',seat.withR&&!!seat.entry&&seat.entry.recordId===`${board} Quality`,JSON.stringify(seat).slice(0,300));
ok('one person one seat is not overridable, even with Support Access and a reason',seat.second===false&&/one seat/.test(seat.secondMsg||''),seat.secondMsg);

// ---- 7. Separation of duties is never overridable ----
const rules=await run(()=>Object.keys(MES.SUPPORT_RULES));
ok('only the stamp binding and MRB seat eligibility can be overridden',rules.length===2&&rules.includes('stamp-binding')&&rules.includes('mrb-seat'),rules.join(','));
await as('rsupport');
const sod=await run(([W2])=>{const c=structuredClone(state);const o=MES.getOrder(c,W2);const t=o.tickets.find(t=>t.status==='Open'&&t.dispo);return t?MES.resolveTicket(c,W2,t.id,'Closing it myself.',{supportReason:'Please let me close this one.'}):{ok:false,message:'no ticket'};},[W2]);
ok('a Support Access account cannot use a reason to approve an NC it may not approve',sod.ok===false,JSON.stringify(sod));

// ---- 8. The log is visible and filterable ----
await as('kqe');
const shown=await run(()=>{view='support-log';render();const all=document.querySelectorAll('table.support-log tbody tr').length;const f=document.getElementById('support-filter-form');f.elements.rule.value='mrb-seat';f.elements.rule.dispatchEvent(new Event('change',{bubbles:true}));const filtered=document.querySelectorAll('table.support-log tbody tr').length;const f2=document.getElementById('support-filter-form');f2.elements.rule.value='All';f2.elements.kind.value='notice';f2.elements.kind.dispatchEvent(new Event('change',{bubbles:true}));const notices=document.querySelectorAll('table.support-log tbody tr').length;return {all,filtered,notices,heading:document.querySelector('#main h1')?.textContent};});
ok('Support overrides view lists every entry',shown.heading==='Support overrides'&&shown.all>=4,JSON.stringify(shown));
ok('filter by rule narrows to the MRB seat override',shown.filtered===1,JSON.stringify(shown));
ok('filter by kind shows the one notice',shown.notices===1,JSON.stringify(shown));

// ---- 9. A tampered log entry is caught by validation ----
ok('a malformed log entry fails validation and diagnose names it',await run(()=>{const c=structuredClone(state);c.supportLog[0].person='';return !MES.validate(c)&&MES.diagnose(c).where==='supportLog';}));
ok('state valid at end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
