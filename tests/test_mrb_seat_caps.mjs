// Item 6: MRB seats are capabilities (mrb-quality, mrb-me, mrb-eng, mrb-cert) and a vote checks the
// seat's capability; the QA Manager holds safety-buyoff and the PFMEA Safety Team buy-off checks it.
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);
const as=u=>run(([S,u])=>sessionStorage.setItem(S,u),[SESSION,u]);

await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  add('kqe','Kai Quality','qe');add('tme','Taylor Engineer','me');add('sswe','Sam Software','swe');add('ccert','Cam Cert','cert');add('pqm','Parker Manager','qm');add('lqm','Lee Manager','qm');add('ssafe','Sky Safety','safety');add('ttech','Toni Tech','technician');
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// ---- roles hold seats through capabilities ----
const seats=await run(()=>Object.fromEntries(['qe','me','swe','cert','qm','admin','technician','safety','general'].map(r=>[r,FlightManeuver.seatsForRole(r)])));
ok('Quality holds the Quality seat only',JSON.stringify(seats.qe)==='["Quality"]',JSON.stringify(seats.qe));
ok('Manufacturing Engineering holds its seat only',JSON.stringify(seats.me)==='["Manufacturing Engineering"]',JSON.stringify(seats.me));
ok('Engineering holds its seat only',JSON.stringify(seats.swe)==='["Engineering"]',JSON.stringify(seats.swe));
ok('Certification holds the Certification seat only',JSON.stringify(seats.cert)==='["Certification"]',JSON.stringify(seats.cert));
ok('QA Manager holds Quality, Manufacturing Engineering and Engineering, not Certification',JSON.stringify(seats.qm)==='["Quality","Manufacturing Engineering","Engineering"]',JSON.stringify(seats.qm));
ok('Master Access holds all four seats',seats.admin.length===4,JSON.stringify(seats.admin));
ok('Technician, Safety and General hold no seat',[seats.technician,seats.safety,seats.general].every(x=>x.length===0));
ok('each seat maps to its own capability',await run(()=>JSON.stringify(FlightManeuver.SEAT_CAPS)===JSON.stringify({'Quality':'mrb-quality','Manufacturing Engineering':'mrb-me','Engineering':'mrb-eng','Certification':'mrb-cert'})));

// A Production Mfg. order convenes a four-seat board (Certification sits on it).
await as('jdoe');
const board=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});const o=MES.getOrder(state,r.id);MES.advance(state,r.id);o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,r.id,m.id,l?l.lot:'L1');MES.setMaterial(state,r.id,m.id,true);});MES.addKitFile(state,r.id,{name:'kit.pdf',type:'application/pdf',size:10,dataUrl:null});MES.advance(state,r.id);
  const op=o.operations[0];MES.createTicket(state,r.id,op.id,{type:'NC',title:'Cosmetic scratch on bracket face',description:'Light surface scratch, no structural effect.',hold:true});const tid=MES.getOrder(state,r.id).tickets.slice(-1)[0].id;MES.dispositionTicket(state,r.id,tid,{decision:'Use as is',note:'Cosmetic only.'});const m=FlightManeuver.openMRB(state,r.id,tid,'Cosmetic scratch, justification attached.');save();return m.ok?{id:m.id,seats:FlightManeuver.get(state,'mrb',m.id).seats}:m.message;});
ok('the board has four seats',board&&board.seats&&board.seats.length===4,JSON.stringify(board));
const vote=(u,seat)=>run(([id,seat])=>FlightManeuver.voteMRB(structuredClone(state),id,seat,'Approve','Acceptable.'),[board.id,seat]);

// ---- votes check the seat's capability ----
await as('kqe');
let r=await vote('kqe','Certification');
ok('a Quality account cannot take the Certification seat (mrb-cert is checked)',r.ok===false&&/does not hold the Certification seat/.test(r.message),JSON.stringify(r));
r=await vote('kqe','Quality');ok('a Quality account votes the Quality seat',r.ok===true,JSON.stringify(r));
await as('ccert');
r=await vote('ccert','Certification');ok('a Certification account votes the Certification seat',r.ok===true,JSON.stringify(r));
r=await vote('ccert','Quality');ok('a Certification account cannot take the Quality seat',r.ok===false,JSON.stringify(r));
await as('pqm');
r=await vote('pqm','Certification');ok('a QA Manager cannot take the Certification seat',r.ok===false&&/Certification/.test(r.message),JSON.stringify(r));
r=await vote('pqm','Engineering');ok('a QA Manager votes the Engineering seat',r.ok===true,JSON.stringify(r));
await as('ttech');
r=await vote('ttech','Quality');ok('a Technician holds no seat',r.ok===false&&/Ask the QA Manager/.test(r.message),JSON.stringify(r));

// The check is the capability, not the role name: take mrb-cert away from a Certification account.
await as('ccert');
r=await run(([id])=>{const real=skAuth.can;skAuth.can=c=>c==='mrb-cert'?false:real.call(skAuth,c);try{return FlightManeuver.voteMRB(structuredClone(state),id,'Certification','Approve','x');}finally{skAuth.can=real;}},[board.id]);
ok('without the mrb-cert capability the Certification role is refused the seat',r.ok===false,JSON.stringify(r));
await as('kqe');
r=await run(([id])=>{const real=skAuth.can;skAuth.can=c=>c==='mrb-cert'?true:real.call(skAuth,c);try{return FlightManeuver.voteMRB(structuredClone(state),id,'Certification','Approve','x');}finally{skAuth.can=real;}},[board.id]);
ok('with the mrb-cert capability any account may take the Certification seat',r.ok===true,JSON.stringify(r));

// ---- one person one seat still holds ----
await as('pqm');
const one=await run(([id])=>{const c=structuredClone(state);const a=FlightManeuver.voteMRB(c,id,'Quality','Approve','ok');const b2=FlightManeuver.voteMRB(c,id,'Engineering','Approve','ok');return {a:a.ok,b:b2.ok,msg:b2.message};},[board.id]);
ok('a QA Manager holding three seat capabilities still votes only one seat per board',one.a===true&&one.b===false&&/one seat/.test(one.msg||''),JSON.stringify(one));

// ---- the board decision through real votes ----
const votes=[['kqe','Quality'],['tme','Manufacturing Engineering'],['sswe','Engineering'],['ccert','Certification']];
let last;for(const [u,seat] of votes){await as(u);last=await run(([id,seat])=>{const r=FlightManeuver.voteMRB(state,id,seat,'Approve','Acceptable.');save();return r;},[board.id,seat]);if(!last.ok)break;}
ok('four seat holders decide the board',last.ok===true&&/decision is recorded/.test(last.message),JSON.stringify(last));

// ---- PFMEA Safety Team buy-off checks safety-buyoff; the QA Manager holds it ----
ok('QA Manager and Safety hold safety-buyoff; Quality and ME do not',await run(()=>skAuth.roleCan('qm','safety-buyoff')&&skAuth.roleCan('safety','safety-buyoff')&&!skAuth.roleCan('qe','safety-buyoff')&&!skAuth.roleCan('me','safety-buyoff')));
await as('jdoe');
const pf=await run(()=>{const wi=state.masterWIs.find(w=>w.status==='Draft'&&w.operations.length>=2);const ago=d=>new Date(Date.now()-d*86400000).toISOString();const me={name:'Taylor Engineer',role:'Manufacturing Engineer',credentialId:'ACCT-tme',account:'tme'};const qa={name:'Lee Manager',role:'Quality Manager',credentialId:'ACCT-lqm',account:'lqm'};
  wi.criticalSafety=true;wi.eco='ECO-2201';wi.peerReview={name:me.name,role:me.role,credentialId:me.credentialId,at:ago(3),virtual:true};wi.qaReview={name:qa.name,role:qa.role,credentialId:qa.credentialId,at:ago(2),virtual:true};
  if(!Array.isArray(state.maneuver.pfmeas))state.maneuver.pfmeas=[];
  state.maneuver.pfmeas.push({id:'PFM-201',wiId:wi.id,wiRevision:wi.revision,partNumber:wi.partNumber,title:wi.title,status:'Safety review',scope:{team:'T. Engineer (ME), L. Manager (QA), Safety Team representative',boundaries:'Every operation of this revision.',by:me,at:ago(2)},rows:[{id:'FM-1',opId:wi.operations[0].id,mode:'Wrong kit issued',effect:'Non-conforming part',cause:'Label not checked',controls:'Kit list',s:4,o:3,d:4,rpn:48,action:'',owner:'',due:null,done:null,by:me,at:ago(2)}],reviewed:Object.fromEntries(wi.operations.slice(1).map(op=>[op.id,{by:me,at:ago(2),note:'No credible failure mode.'}])),analysisDone:{by:me,at:ago(1)},actionsDone:{by:me,at:ago(1)},safety:null,returns:[],openedBy:{name:'Kai Quality',role:'Quality Engineer',credentialId:'ACCT-kqe',account:'kqe'},openedAt:ago(2),attachments:[],history:[]});
  const saved=save();return {saved,valid:MES.validate(state),wi:wi.id};});
ok('fixture: a PFMEA waiting for the Safety Team on a critical safety WI',pf.saved&&pf.valid,JSON.stringify(pf));
const safety=()=>run(()=>FlightManeuver.pfmeaSafetyBuyoff(structuredClone(state),'PFM-201',{decision:'Approve',note:'Controls adequate for every failure mode.'}));
await as('kqe');r=await safety();ok('Quality cannot give the Safety Team buy-off (no capability)',r.ok===false&&/cannot give the Safety Team buy-off/.test(r.message),JSON.stringify(r));
await as('tme');r=await safety();ok('Manufacturing Engineering cannot give it either',r.ok===false,JSON.stringify(r));
await as('lqm');r=await safety();ok('the QA Manager who recorded the QA review cannot also accept it',r.ok===false&&/QA reviewer cannot also give/.test(r.message),JSON.stringify(r));
await as('pqm');r=await safety();ok('a different QA Manager gives the Safety Team buy-off',r.ok===true,JSON.stringify(r));
await as('ssafe');r=await safety();ok('the Safety Team role gives the buy-off',r.ok===true,JSON.stringify(r));
await as('pqm');r=await run(()=>{const real=skAuth.can;skAuth.can=c=>c==='safety-buyoff'?false:real.call(skAuth,c);try{return FlightManeuver.pfmeaSafetyBuyoff(structuredClone(state),'PFM-201',{decision:'Approve',note:'x'});}finally{skAuth.can=real;}});
ok('the check is the capability: a QA Manager without safety-buyoff is refused',r.ok===false,JSON.stringify(r));

ok('state valid at end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
