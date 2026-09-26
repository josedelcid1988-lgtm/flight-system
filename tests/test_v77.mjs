import {mkdirSync as __mkdirTests} from 'fs';const TESTS=decodeURI(new URL('.',import.meta.url).pathname);__mkdirTests(TESTS+'shots',{recursive:true}); // fixtures, shots and results resolve from this folder
import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const fails=[]; const step=(w,r)=>{const ok=r&&r.ok!==false;console.log((ok?'  ok   ':'  FAIL ')+w+(ok?'':' -> '+(r&&r.message)));if(!ok)fails.push(w);};
const no=(w,r)=>step(w,{ok:!(r&&r.ok),message:r&&r.message||'was allowed'});
async function signIn(u){await p.evaluate(()=>{try{sessionStorage.removeItem('skyryse-mes-session-v1');}catch(e){}}).catch(()=>{});await p.goto('file://'+TESTS+'fixtures/demo_qa150_publish.html'); await p.waitForTimeout(900);
await p.evaluate(x=>{const un=document.querySelector('#sk-boot input[name=username]');if(!un)return;const pw=document.querySelector('#sk-boot input[type=password]');un.value=x;un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},u);
await p.waitForTimeout(2800);}
await signIn('master');
const run=(fn,a)=>p.evaluate(fn,a);
const S=(fn,a)=>run(new Function('a',`const r=(${fn})(a);if(r&&r.ok)save();return r&&{ok:r.ok,message:r.message,id:r.id};`),a);
step('certification account exists',{ok:await run(()=>skAuth.users().some(u=>u.username==='certification'&&u.role==='cert')),message:'no account'});
// Production Mfg. order: NC Use as is -> board with Certification
const fx=await run(()=>{const o=state.orders.find(o=>o.status==='Building'&&o.pedigree==='Production'&&o.subcategory==='Mfg.'&&!MES.blockingTickets(o).length);return o&&{o:o.id,op:o.operations.find(x=>!x.done).id};});
console.log('   fixture',JSON.stringify(fx));
const tk=await S(a=>MES.createTicket(state,a.o,a.op,{type:'NC',title:'Scratch on face',description:'Scratch 0.5 in on the mounting face.',hold:true}),fx);step('NC raised',tk);
step('dispo Use as is',await S(a=>MES.dispositionTicket(state,a.o,a.t,{decision:'Use as is',note:'Cosmetic, outside functional surfaces.'}),{...fx,t:tk.id}));
const mb=await S(a=>FlightManeuver.openMRB(state,a.o,a.t,'Cosmetic scratch; no fit, form or function impact.'),{...fx,t:tk.id});step('board convened',mb);
step('board seats include Certification',{ok:await run(id=>{const m=FlightManeuver.get(state,'mrb',id);return m.seats.includes('Certification')&&m.seats.length===4;},mb.id),message:'no cert seat'});
for(const [acct,seat] of [['quality','Quality'],['mfgeng','Manufacturing Engineering'],['engineering','Engineering']]){await signIn(acct);step('vote '+seat+' as '+acct,await S(a=>FlightManeuver.voteMRB(state,a.m,a.s,'Approve','ok'),{m:mb.id,s:seat}));}
await signIn('quality');
no('quality account cannot take the Certification seat',await run(id=>FlightManeuver.voteMRB(structuredClone(state),id,'Certification','Approve','x'),mb.id));
no('decision refused without Certification vote',await run(id=>FlightManeuver.decideMRB(structuredClone(state),id,'Approved'),mb.id));
await signIn('certification');
step('Certification votes as certification',await S(a=>FlightManeuver.voteMRB(state,a.m,'Certification','Approve','Conformity impact reviewed; acceptable.'),{m:mb.id}));
await signIn('master');
step('board decision recorded automatically on the Certification vote',{ok:await run(id=>FlightManeuver.get(state,'mrb',id).status==='Approved',mb.id),message:'not approved'});
step('valid after board',{ok:await run(()=>MES.validate(state)),message:'invalid'});
// Development order: no Certification seat
const dv=await run(()=>{const o=state.orders.find(o=>o.status==='Building'&&o.pedigree!=='Production'&&!MES.blockingTickets(o).length);return o&&{o:o.id,op:o.operations.find(x=>!x.done).id,ped:o.pedigree};});
step('certRequired false for non-Production',{ok:await run(a=>!FlightManeuver.certRequired(MES.getOrder(state,a.o)),dv),message:'required'});
// Use for Dev on a Production order
const ud=await run(()=>{const o=state.orders.find(o=>o.status==='Building'&&o.pedigree==='Production'&&!MES.blockingTickets(o).length&&o.quantity===1);return o&&{o:o.id,op:o.operations.find(x=>!x.done).id};});
console.log('   use-for-dev fixture',JSON.stringify(ud));
const t2=await S(a=>MES.createTicket(state,a.o,a.op,{type:'NC',title:'Bore oversize',description:'Bore measured 0.503 in, max 0.501 in.',hold:true}),ud);step('NC 2',t2);
step('dispo Use for Dev',await S(a=>MES.dispositionTicket(state,a.o,a.t,{decision:'Use for Dev',note:'Unit fit for development testing only.'}),{...ud,t:t2.id}));
step('no board needed for Use for Dev',{ok:await run(a=>!FlightManeuver.needsMRB(MES.getOrder(state,a.o),MES.getOrder(state,a.o).tickets.find(t=>t.id===a.t)),{...ud,t:t2.id}),message:'board required'});
const c=await run(()=>MES.DEFECT_CODES[0]);
const ap=await S(a=>MES.resolveTicket(state,a.o,a.t,'Approved for development use only.',{defectCode:a.c.code,subCode:a.c.subs[0].code}),{...ud,t:t2.id,c});step('QA approval (demo lifts the QA Manager gate)',ap);
step('WO pedigree downgraded to Development',{ok:await run(a=>MES.getOrder(state,a.o).pedigree==='Development'&&MES.validate(state),ud),message:await run(a=>MES.getOrder(state,a.o).pedigree+' valid '+MES.validate(state),ud)});
// Stock NC source
const base={type:'NC',title:'Damaged connector',description:'Bent pin on J2.',partNumber:'SR-2401',quantity:1,foundAt:'Receiving inspection',pedigree:'Production'};
no('stock NC without source refused',await run(b=>FlightManeuver.raiseNC(structuredClone(state),{...b}),base));
no('PO line without line refused',await run(b=>FlightManeuver.raiseNC(structuredClone(state),{...b,sourceType:'PO line',sourcePo:'PO4411'}),base));
no('unknown WO refused',await run(b=>FlightManeuver.raiseNC(structuredClone(state),{...b,sourceType:'Work order',sourceOrder:'WO-99999'}),base));
step('PO line source',await S(b=>FlightManeuver.raiseNC(state,{...b,sourceType:'PO line',sourcePo:'PO4411',sourceLine:'3'}),base));
step('WO source',await S(a=>FlightManeuver.raiseNC(state,{...a.b,sourceType:'Work order',sourceOrder:a.o}),{b:base,o:fx.o}));
step('Serial source',await S(b=>FlightManeuver.raiseNC(state,{...b,sourceType:'Serial number',serial:'SN-777'}),base));
step('valid at end',{ok:await run(()=>MES.validate(state)),message:'invalid'});
await run(()=>{view='mnv-intake';render();});await p.waitForTimeout(300);
await run(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Raise NC|NC \/ IDR outside/i.test(x.textContent));b&&b.click();});await p.waitForTimeout(400);
step('stock NC form has the source picker',{ok:await run(()=>!!document.querySelector('#mnv-nc-form .mnv-nc-source input[name=sourceType]')),message:'no picker'});
await p.screenshot({path:TESTS+'shots/v77_nc_source.png'});
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
