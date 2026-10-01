// The PFMEA Safety Team buy-off: who may give it and what its signature binds.
// Nobody whose work the buy-off accepts may give it: a failure-mode author, a no-risk reviewer, an action closer
// or the person who completed the analysis (a QA Manager holds edit-wi and safety-buyoff, so this matters).
// The signature manifest binds the analysis content and the Safety Team rationale, and verifyManifests recomputes
// it from the stored PFMEA, so an edit after signing fails verification. Older buy-offs keep verifying.
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
  add('kqe','Kai Quality','qe');add('tme','Taylor Engineer','me');add('pqm','Parker Manager','qm');add('lqm','Lee Manager','qm');add('ssafe','Sky Safety','safety');
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// A critical safety WI with its PFMEA in analysis. The QA review is Lee's, the PFMEA was opened by Kai.
await as('jdoe');
const fx=await run(()=>{const wi=state.masterWIs.find(w=>w.status==='Draft'&&w.operations.length>=3);const ago=d=>new Date(Date.now()-d*86400000).toISOString();const me={name:'Taylor Engineer',role:'Manufacturing Engineer',credentialId:'ACCT-tme',account:'tme'};const qa={name:'Lee Manager',role:'Quality Manager',credentialId:'ACCT-lqm',account:'lqm'};
  wi.criticalSafety=true;wi.eco='ECO-2301';wi.peerReview={name:me.name,role:me.role,credentialId:me.credentialId,at:ago(3),virtual:true};wi.qaReview={name:qa.name,role:qa.role,credentialId:qa.credentialId,at:ago(2),virtual:true};
  if(!Array.isArray(state.maneuver.pfmeas))state.maneuver.pfmeas=[];
  state.maneuver.pfmeas.push({id:'PFM-301',wiId:wi.id,wiRevision:wi.revision,partNumber:wi.partNumber,title:wi.title,status:'Analysis',scope:{team:'T. Engineer (ME), L. Manager (QA), Safety Team representative',boundaries:'Every operation of this revision.',by:me,at:ago(2)},rows:[{id:'FM-1',opId:wi.operations[0].id,mode:'Wrong kit issued',effect:'Non-conforming part',cause:'Label not checked',controls:'Kit list',s:4,o:3,d:4,rpn:48,action:'',owner:'',due:null,done:null,by:me,at:ago(2)}],reviewed:Object.fromEntries(wi.operations.slice(2).map(op=>[op.id,{by:me,at:ago(2),note:'No credible failure mode.'}])),analysisDone:null,actionsDone:null,safety:null,returns:[],openedBy:{name:'Kai Quality',role:'Quality Engineer',credentialId:'ACCT-kqe',account:'kqe'},openedAt:ago(2),attachments:[],history:[]});
  return {saved:save(),valid:MES.validate(state),op:wi.operations[1].id};});
ok('fixture: a critical safety PFMEA in analysis with one operation left to review',fx.saved&&fx.valid,JSON.stringify(fx));

// ---- a QA Manager who marks an operation no-risk cannot then give the Safety Team buy-off ----
// Parker (QA Manager) reviews the open operation as no-risk, Taylor completes the analysis.
await as('pqm');
let r=await run(([op])=>{const r=FlightManeuver.markOpNoRisk(state,'PFM-301',op,'Fastener torque is verified by the next inspection.');if(r.ok)save();return r;},[fx.op]);
ok('a QA Manager holds edit-wi and may record a no-risk review',r.ok===true,JSON.stringify(r));
await as('tme');
r=await run(()=>{const r=FlightManeuver.completePfmeaAnalysis(state,'PFM-301');if(r.ok)save();return {ok:r.ok,message:r.message,status:FlightManeuver.get(state,'pfmeas','PFM-301').status};});
ok('analysis completed and sent to the Safety Team',r.ok===true&&r.status==='Safety review',JSON.stringify(r));
const buyoff=(note='Controls adequate for every failure mode.')=>run(([note])=>{const s=structuredClone(state);const res=FlightManeuver.pfmeaSafetyBuyoff(s,'PFM-301',{decision:'Approve',note});const t=s.maneuver.pfmeas.find(x=>x.id==='PFM-301');return {ok:res.ok,message:res.message,status:t.status,safety:t.safety,changed:JSON.stringify(s)!==JSON.stringify(state)};},[note]);
await as('pqm');r=await buyoff();
ok('the QA Manager who recorded a no-risk review is refused the Safety Team buy-off',r.ok===false&&/you recorded part of this analysis/.test(r.message),JSON.stringify(r));
ok('the refused buy-off changes nothing',r.changed===false&&r.status==='Safety review'&&r.safety===null,JSON.stringify(r));
await as('tme');r=await buyoff();
ok('the person who completed the analysis has no safety-buyoff and is refused',r.ok===false,JSON.stringify(r));

// An action closer and the analysis completer are refused the same way.
const variant=(fn)=>run(([fn])=>{const s=structuredClone(state),t=s.maneuver.pfmeas.find(x=>x.id==='PFM-301'),pqm={name:'Parker Manager',role:'Quality Manager',credentialId:'ACCT-pqm',account:'pqm'};
  delete t.reviewed[Object.keys(t.reviewed).find(k=>t.reviewed[k].by.credentialId==='ACCT-pqm')];t.rows.push({id:'FM-2',opId:s.masterWIs.find(w=>w.id===t.wiId&&w.revision===t.wiRevision).operations[1].id,mode:'Fastener under-torqued',effect:'Loose joint',cause:'Wrong setting',controls:'Torque audit',s:9,o:2,d:3,rpn:54,action:'Add a torque-limiting driver',owner:'T. Engineer',due:'2026-11-01',done:null,by:{name:'Taylor Engineer',role:'Manufacturing Engineer',credentialId:'ACCT-tme',account:'tme'},at:new Date().toISOString()});
  if(fn==='closer')t.rows[1].done={evidence:'Driver issued and verified.',s:9,o:1,d:2,rpn:18,by:pqm,at:new Date().toISOString()};
  if(fn==='scoper')t.scope={...t.scope,by:pqm};
  if(fn==='actions')t.actionsDone={by:pqm,at:new Date().toISOString()};
  if(fn==='completer'){t.rows[1].done={evidence:'Driver issued and verified.',s:9,o:1,d:2,rpn:18,by:{name:'Taylor Engineer',role:'Manufacturing Engineer',credentialId:'ACCT-tme',account:'tme'},at:new Date().toISOString()};t.analysisDone={by:pqm,at:new Date().toISOString()};}
  const res=FlightManeuver.pfmeaSafetyBuyoff(s,'PFM-301',{decision:'Approve',note:'Controls adequate.'});return {ok:res.ok,message:res.message,valid:MES.validate(s)};},[fn]);
await as('pqm');
r=await variant('closer');ok('the QA Manager who closed a PFMEA action is refused the Safety Team buy-off',r.ok===false&&/you recorded part of this analysis/.test(r.message),JSON.stringify(r));
r=await variant('completer');ok('the QA Manager who completed the analysis is refused the Safety Team buy-off',r.ok===false&&/you recorded part of this analysis/.test(r.message),JSON.stringify(r));
r=await variant('scoper');ok('the QA Manager who recorded the scope and team is refused the Safety Team buy-off',r.ok===false&&/you recorded part of this analysis/.test(r.message),JSON.stringify(r));
r=await variant('actions');ok('the QA Manager who completed the action step is refused the Safety Team buy-off',r.ok===false&&/you recorded part of this analysis/.test(r.message),JSON.stringify(r));
r=await variant('none');ok('with none of that work, the same QA Manager gives the buy-off',r.ok===true,JSON.stringify(r));

// ---- the Safety Team role gives it, and the manifest binds the analysis content ----
await as('ssafe');
r=await run(()=>{const res=FlightManeuver.pfmeaSafetyBuyoff(state,'PFM-301',{decision:'Approve',note:'Controls adequate for every failure mode.'});if(res.ok)save();const t=FlightManeuver.get(state,'pfmeas','PFM-301');return {ok:res.ok,message:res.message,subject:t.safety&&t.safety.manifest&&t.safety.manifest.subject,verify:MES.verifyManifests(state)};});
ok('the Safety Team gives the buy-off',r.ok===true,JSON.stringify(r));
const sub=r.subject||{};
ok('the signed subject carries the Safety Team rationale',sub.note==='Controls adequate for every failure mode.',JSON.stringify(sub));
ok('the signed subject carries each failure mode, effect, cause, controls and scores',Array.isArray(sub.rows)&&sub.rows[0].mode==='Wrong kit issued'&&sub.rows[0].effect==='Non-conforming part'&&sub.rows[0].cause==='Label not checked'&&sub.rows[0].controls==='Kit list'&&sub.rows[0].s===4&&sub.rows[0].by==='ACCT-tme',JSON.stringify(sub.rows));
ok('the signed subject carries every no-risk rationale and who recorded it',Array.isArray(sub.reviewed)&&sub.reviewed.some(v=>v.opId===fx.op&&/next inspection/.test(v.note)&&v.by==='ACCT-pqm'),JSON.stringify(sub.reviewed));
ok('the signed subject carries the scope and team',sub.scope&&/Safety Team representative/.test(sub.scope.team),JSON.stringify(sub.scope));
ok('every manifest verifies after the buy-off',r.verify.ok===true,JSON.stringify(r.verify.failures));

// ---- an edit after signing fails verification ----
const tamper=fn=>run(([fn])=>{const s=structuredClone(state),t=s.maneuver.pfmeas.find(x=>x.id==='PFM-301');
  if(fn==='note')t.safety.note='Rubber stamp.';if(fn==='cause')t.rows[0].cause='Not recorded';if(fn==='controls')t.rows[0].controls='';if(fn==='reviewed')t.reviewed[Object.keys(t.reviewed)[0]].note='Edited after the buy-off.';if(fn==='scope')t.scope.team='Nobody';if(fn==='analysisBy')t.analysisDone.by={...t.analysisDone.by,credentialId:'ACCT-someone'};if(fn==='actionsAt')t.actionsDone.at='2020-01-01T00:00:00.000Z';
  const v=MES.verifyManifests(s);return {ok:v.ok,failures:v.failures};},[fn]);
for(const [fn,what] of [['note','the Safety Team rationale'],['cause','a failure-mode cause'],['controls','the current controls'],['reviewed','a no-risk rationale'],['scope','the scope and team'],['analysisBy','who completed the analysis'],['actionsAt','when the action step was completed']]){
  r=await tamper(fn);ok(`editing ${what} after the buy-off fails verification`,r.ok===false&&r.failures.some(f=>/PFM-301 Safety Team buy-off/.test(f.where)),JSON.stringify(r));
}

// ---- a buy-off signed before this rule keeps verifying against what it stored ----
r=await run(()=>{const s=structuredClone(state),t=s.maneuver.pfmeas.find(x=>x.id==='PFM-301');const legacy={pfmea:t.id,wi:`${t.wiId} Rev ${t.wiRevision}`,rows:t.rows.map(r=>({id:r.id,opId:r.opId,rpn:r.rpn,revised:r.done?r.done.rpn:null}))};t.safety.manifest=MES.signManifest(s,'PFMEA Safety Team buy-off',legacy,t.safety.at);t.rows[0].cause='Edited later';const v=MES.verifyManifests(s);return {ok:v.ok,failures:v.failures,valid:MES.validate(s)};});
ok('an older buy-off manifest (ids and RPNs only) still verifies and the workspace still loads',r.ok===true&&r.valid===true,JSON.stringify(r));
r=await run(()=>{const s=structuredClone(state),t=s.maneuver.pfmeas.find(x=>x.id==='PFM-301');const legacy={pfmea:t.id,wi:`${t.wiId} Rev ${t.wiRevision}`,rows:t.rows.map(r=>({id:r.id,opId:r.opId,rpn:r.rpn,revised:r.done?r.done.rpn:null}))};t.safety.manifest=MES.signManifest(s,'PFMEA Safety Team buy-off',legacy,t.safety.at);const edit=f=>{const c=structuredClone(s),x=c.maneuver.pfmeas.find(y=>y.id==='PFM-301');f(x);const v=MES.verifyManifests(c);return v.failures.some(e=>/PFM-301 Safety Team buy-off/.test(e.where));};return {opId:edit(x=>{x.rows[0].opId='op-999';}),rpn:edit(x=>{x.rows[0].s=5;x.rows[0].rpn=60;}),rowId:edit(x=>{x.rows[0].id='FM-9';})};});
ok('an older buy-off is still recomputed from the live rows: an operation, RPN or row id edit fails',r.opId&&r.rpn&&r.rowId,JSON.stringify(r));

ok('state valid at end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
