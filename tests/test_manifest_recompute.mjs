// verifyManifests recomputes every signature kind from the stored record, not only from the subject the manifest
// stored: the 8130-9 completion, the AQI signature and the DAR acceptance; the MRB board decision; the CAR closure;
// the stock NC disposition approval; and the FAIR box 22 review, which the Skyryse QA approval now binds.
// An edit to any signed field after signing fails verification. Box 22 is also validated as a record.
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);
async function open(file,user){await p.evaluate(()=>{try{sessionStorage.removeItem('skyryse-mes-session-v1');}catch(e){}}).catch(()=>{});
  await p.goto('file://'+FIXTURES+file);await p.waitForTimeout(900);
  await run(u=>{const un=document.querySelector('#sk-boot input[name=username]');if(!un)return;const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,u);set(f.querySelector('input[type=password]'),'demo1234');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},user);
  await p.waitForTimeout(2600);}
// Applies an edit to a copy of the workspace and returns what verifyManifests says about it.
const tamper=(edit)=>run(src=>{const s=structuredClone(state);(new Function('s',src))(s);const v=MES.verifyManifests(s);return {ok:v.ok,where:v.failures.map(f=>f.where)};},edit);
const expectFail=async(label,edit,where)=>{const r=await tamper(edit);ok(label,r.ok===false&&r.where.some(w=>w.includes(where)),JSON.stringify(r));};

await open('demo_publish.html','master');
let r=await run(()=>{const v=MES.verifyManifests(state);return {ok:v.ok,failures:v.failures};});
ok('the curated demo workspace verifies',r.ok===true,JSON.stringify(r.failures));
const conf=await run(()=>{const o=state.orders.find(o=>(o.conformity||[]).some(p=>p.form&&p.aqi&&p.darApproval));return o?{id:o.id,serial:o.conformity.find(p=>p.form&&p.aqi&&p.darApproval).serial}:null;});
ok('fixture: a conformed package with a signed 8130-9, AQI signature and DAR acceptance',!!conf,JSON.stringify(conf));
const pkg=`const p=s.orders.find(o=>o.id==='${conf.id}').conformity.find(p=>p.serial==='${conf.serial}');`;
await expectFail('editing the 8130-9 certification basis after signing fails',pkg+"p.form.basis='Edited after signing';",'8130-9');
await expectFail('editing the 8130-9 deviations after signing fails',pkg+"p.form.deviations='None, edited';",'8130-9');
await expectFail('marking the AQI signature self-signed after signing fails',pkg+"p.aqi.selfSigned=true;",'8130-9 AQI signature');
await expectFail('editing the DAR designation after signing fails',pkg+"p.darApproval.designation='DAR-0000';",'DAR acceptance');
await expectFail('editing the DAR date after signing fails',pkg+"p.darApproval.date='2020-01-01';",'DAR acceptance');

const mrb=await run(()=>{const m=(state.maneuver.mrb||[]).find(m=>m.decision&&m.decision.manifest);return m&&m.id;});
ok('fixture: a decided MRB board',!!mrb,String(mrb));
const board=`const m=s.maneuver.mrb.find(m=>m.id==='${mrb}');`;
await expectFail('editing the MRB decision rationale after signing fails',board+"m.decision.note='Edited after the decision.';",`${mrb} board decision`);
await expectFail('changing a recorded MRB vote after the decision fails',board+"m.votes[0].vote=m.votes[0].vote==='Approve'?'Reject':'Approve';",`${mrb} board decision`);
await expectFail('changing who voted a seat after the decision fails',board+"m.votes[0].by={...m.votes[0].by,credentialId:'ACCT-someone'};",`${mrb} board decision`);
await expectFail('changing the MRB serials after the decision fails',board+"m.serials=[...(m.serials||[]),'SN-EXTRA'];",`${mrb} board decision`);

const nc=await run(()=>{const t=(state.maneuver.ncs||[]).find(t=>t.resolution&&t.resolution.manifest);return t&&t.id;});
ok('fixture: a stock NC with an approved disposition',!!nc,String(nc));
const stock=`const t=s.maneuver.ncs.find(t=>t.id==='${nc}');`;
await expectFail('changing the stock NC disposition after approval fails',stock+"t.dispo.decision=t.dispo.decision==='Scrap'?'Use as is':'Scrap';",`${nc} disposition approval`);
await expectFail('changing the affected quantity after approval fails',stock+"t.affected.quantity=t.affected.quantity+1;",`${nc} disposition approval`);
await expectFail('changing the defect code after approval fails',stock+"t.affected.defectCode='ZZ';",`${nc} disposition approval`);
await expectFail('changing the approval note after approval fails',stock+"t.resolution.note='Edited.';",`${nc} disposition approval`);

// ---- box 22 is signed, validated and bound into the Skyryse QA approval ----
const fair=await run(()=>{const o=state.orders.find(o=>o.fair&&o.fair.status==='Approved');if(!o)return null;const s=structuredClone(state),x=s.orders.find(y=>y.id===o.id);x.fair.status='Verified';x.fair.approved=null;delete x.fair.reviewed;
  const rv=MES.reviewFair(s,o.id,{pin:''});const ap=rv.ok?MES.approveFair(s,o.id,{pin:''}):null;if(rv.ok&&ap&&ap.ok)state=s;return {id:o.id,rv,ap,valid:MES.validate(s),subject:x.fair.approved&&x.fair.approved.manifest.subject,reviewedHash:x.fair.reviewed&&x.fair.reviewed.manifest.hash};});
ok('box 22 signed and the FAIR approved',fair&&fair.rv.ok&&fair.ap&&fair.ap.ok&&fair.valid,JSON.stringify(fair));
ok('the Skyryse QA approval signs the box 22 review hash',fair&&fair.subject&&fair.subject.reviewed===fair.reviewedHash,JSON.stringify(fair&&fair.subject));
r=await run(()=>{const v=MES.verifyManifests(state);return {ok:v.ok,failures:v.failures};});
ok('the approved FAIR verifies',r.ok===true,JSON.stringify(r.failures));
const F=`const f=s.orders.find(o=>o.id==='${fair.id}').fair;`;
await expectFail('removing box 22 after the approval fails',F+"delete f.reviewed;",'FAIR approval');
await expectFail('replacing the box 22 signature after the approval fails',F+"f.reviewed.manifest={...f.reviewed.manifest,hash:'0'.repeat(64)};",'FAIR');
await expectFail('a box 22 that does not chain to the verified FAIR fails',F+"f.reviewed.manifest=MES.signManifest(s,'AS9102 FAIR reviewed and approved (blocks 22 and 23)',{fair:'FAIR-OTHER',verified:f.verified.manifest.hash},f.reviewed.at);",'FAIR box 22');
r=await run(([id])=>{const bad=edit=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;edit(f);return MES.validate(s);};return {noManifest:bad(f=>{delete f.reviewed.manifest;}),noSigner:bad(f=>{f.reviewed.by=null;}),badTime:bad(f=>{f.reviewed.at='yesterday';}),onOpen:bad(f=>{f.status='Open';f.verified=null;f.approved=null;}),ok:MES.validate(state)};},[fair.id]);
ok('box 22 without its signature manifest is refused by validation',r.noManifest===false,JSON.stringify(r));
ok('box 22 without a named signer is refused by validation',r.noSigner===false,JSON.stringify(r));
ok('box 22 without a valid time is refused by validation',r.badTime===false,JSON.stringify(r));
ok('box 22 on a FAIR that is not verified is refused by validation',r.onOpen===false,JSON.stringify(r));
ok('the signed workspace itself validates',r.ok===true,JSON.stringify(r));
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;f.reviewed=null;return {valid:MES.validate(s)};},[fair.id]);
ok('a FAIR with box 22 cleared (null) still validates as a record',r.valid===true,JSON.stringify(r));

// ---- the CAR closure, from the 150-order regression set ----
await open('demo_qa150_publish.html','master');
r=await run(()=>{const v=MES.verifyManifests(state);return {ok:v.ok,failures:v.failures};});
ok('the 150-order regression workspace verifies',r.ok===true,JSON.stringify(r.failures));
const car=await run(()=>{const c=(state.maneuver.cars||[]).find(c=>c.closure&&c.closure.manifest);return c&&c.id;});
ok('fixture: a closed CAR',!!car,String(car));
const C=`const c=s.maneuver.cars.find(c=>c.id==='${car}');`;
await expectFail('editing the CAR root cause after closure fails',C+"c.rootCause.statement='Edited after closure.';",`${car} closure`);
await expectFail('editing a CAR action after closure fails',C+"c.actions[0].description='Edited after closure.';",`${car} closure`);
await expectFail('editing the CAR effectiveness result after closure fails',C+"c.effectiveness.result='Not effective';",`${car} closure`);
await expectFail('editing the CAR closure statement after closure fails',C+"c.closure.note='Edited.';",`${car} closure`);

// ---- a manifest signed under an older subject form keeps verifying as it was signed ----
r=await run(([car])=>{const s=structuredClone(state),c=s.maneuver.cars.find(c=>c.id===car);c.closure.manifest=MES.signManifest(s,'Corrective action closure',{id:c.id,note:c.closure.note},c.closure.at);c.title='Edited title';const v=MES.verifyManifests(s);return {ok:v.ok,failures:v.failures};},[car]);
ok('a CAR closure signed under an older subject form verifies against what it stored',r.ok===true,JSON.stringify(r));

ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
