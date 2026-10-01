// verifyManifests recomputes every signature kind from the stored record, not only from the subject the manifest
// stored: the 8130-9 completion, the AQI signature and the DAR acceptance; the MRB board decision; the CAR closure;
// the stock NC disposition approval; the FAIR verification content; and the FAIR box 22 review, which the Skyryse QA approval now binds.
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
await expectFail('removing the 8130-9 signature manifest fails',pkg+"delete p.form.prepared.manifest;",'8130-9');
await expectFail('removing the AQI signature manifest fails',pkg+"delete p.aqi.manifest;",'8130-9 AQI signature');
await expectFail('removing the DAR acceptance manifest fails',pkg+"delete p.darApproval.manifest;",'DAR acceptance');

const mrb=await run(()=>{const m=(state.maneuver.mrb||[]).find(m=>m.decision&&m.decision.manifest);return m&&m.id;});
ok('fixture: a decided MRB board',!!mrb,String(mrb));
const board=`const m=s.maneuver.mrb.find(m=>m.id==='${mrb}');`;
await expectFail('editing the MRB decision rationale after signing fails',board+"m.decision.note='Edited after the decision.';",`${mrb} board decision`);
await expectFail('changing a recorded MRB vote after the decision fails',board+"m.votes[0].vote=m.votes[0].vote==='Approve'?'Reject':'Approve';",`${mrb} board decision`);
await expectFail('changing who voted a seat after the decision fails',board+"m.votes[0].by={...m.votes[0].by,credentialId:'ACCT-someone'};",`${mrb} board decision`);
await expectFail('changing the MRB serials after the decision fails',board+"m.serials=[...(m.serials||[]),'SN-EXTRA'];",`${mrb} board decision`);
await expectFail('removing the MRB decision manifest fails',board+"delete m.decision.manifest;",`${mrb} board decision`);

const nc=await run(()=>{const t=(state.maneuver.ncs||[]).find(t=>t.resolution&&t.resolution.manifest);return t&&t.id;});
ok('fixture: a stock NC with an approved disposition',!!nc,String(nc));
const stock=`const t=s.maneuver.ncs.find(t=>t.id==='${nc}');`;
await expectFail('changing the stock NC disposition after approval fails',stock+"t.dispo.decision=t.dispo.decision==='Scrap'?'Use as is':'Scrap';",`${nc} disposition approval`);
await expectFail('changing the affected quantity after approval fails',stock+"t.affected.quantity=t.affected.quantity+1;",`${nc} disposition approval`);
await expectFail('changing the defect code after approval fails',stock+"t.affected.defectCode='ZZ';",`${nc} disposition approval`);
await expectFail('changing the approval note after approval fails',stock+"t.resolution.note='Edited.';",`${nc} disposition approval`);
await expectFail('removing the stock NC approval manifest fails',stock+"delete t.resolution.manifest;",`${nc} disposition approval`);
r=await run(()=>{const s=structuredClone(state),t=(s.maneuver.ncs||[]).find(t=>t.resolution&&t.resolution.manifest);if(!t)return {none:true};delete t.affected;const v=MES.verifyManifests(s);return {id:t.id,ok:v.ok,where:v.failures.map(f=>f.where)};});
ok('removing the affected record from an approved stock NC fails rather than skipping the check',r.ok===false&&r.where.some(w=>w.includes(`${r.id} disposition approval`)),JSON.stringify(r));

// ---- box 22 is signed, validated and bound into the Skyryse QA approval ----
const fair=await run(()=>{const o=state.orders.find(o=>o.fair&&o.fair.status==='Approved');if(!o)return null;const s=structuredClone(state),x=s.orders.find(y=>y.id===o.id);x.fair.status='Open';x.fair.verified=null;x.fair.approved=null;delete x.fair.reviewed;
  const vf=MES.verifyFair(s,o.id,{pin:''});if(!vf.ok)return {id:o.id,vf};const rv=MES.reviewFair(s,o.id,{pin:''});const ap=rv.ok?MES.approveFair(s,o.id,{pin:''}):null;if(rv.ok&&ap&&ap.ok)state=s;return {id:o.id,rv,ap,valid:MES.validate(s),subject:x.fair.approved&&x.fair.approved.manifest.subject,reviewedHash:x.fair.reviewed&&x.fair.reviewed.manifest.hash};});
ok('box 22 signed and the FAIR approved',fair&&fair.rv.ok&&fair.ap&&fair.ap.ok&&fair.valid,JSON.stringify(fair));
ok('the Skyryse QA approval signs the box 22 review hash',fair&&fair.subject&&fair.subject.reviewed===fair.reviewedHash,JSON.stringify(fair&&fair.subject));
r=await run(([id])=>{const f=state.orders.find(o=>o.id===id).fair;return {reviewer:f.reviewed.manifest.subject.reviewer,by:f.reviewed.by.credentialId,at:f.reviewed.manifest.subject.reviewedAt===f.reviewed.at};},[fair.id]);
ok('box 22 signs the reviewer credential and time',r.reviewer===r.by&&r.at===true,JSON.stringify(r));
r=await run(()=>{const v=MES.verifyManifests(state);return {ok:v.ok,failures:v.failures};});
ok('the approved FAIR verifies',r.ok===true,JSON.stringify(r.failures));
const F=`const f=s.orders.find(o=>o.id==='${fair.id}').fair;`;
await expectFail('changing a FAIR characteristic result after verification fails',F+"f.chars[0].result='Edited after verification';",'FAIR verification');
await expectFail('adding a Form 2 line after verification fails',F+"f.form2=[...f.form2,{kind:'Material',name:'Added later',spec:'X',code:'',supplier:'Y',approval:'Yes',coc:'Z'}];",'FAIR verification');
await expectFail('replacing the box 22 reviewer after the approval fails',F+"f.reviewed.by={...f.reviewed.by,credentialId:'ACCT-intruder',name:'Someone Else'};",'FAIR');
await expectFail('re-signing box 22 as someone else after the approval fails',F+"f.reviewed={...f.reviewed,by:{...f.reviewed.by,credentialId:'ACCT-other'},manifest:MES.signManifest(s,'AS9102 FAIR reviewed and approved (blocks 22 and 23)',{fair:f.reviewed.manifest.subject.fair,verified:f.verified.manifest.hash,reviewer:'ACCT-other',reviewedAt:f.reviewed.at},f.reviewed.at)};",'FAIR approval');
await expectFail('changing the FAI reasons after verification fails',F+"f.reasons=[f.reasons[0]==='Mfg. process change'?'New part (first production)':'Mfg. process change'];",'FAIR verification');
await expectFail('removing box 22 after the approval fails',F+"delete f.reviewed;",'FAIR approval');
await expectFail('replacing the box 22 signature after the approval fails',F+"f.reviewed.manifest={...f.reviewed.manifest,hash:'0'.repeat(64)};",'FAIR');
await expectFail('a box 22 that does not chain to the verified FAIR fails',F+"f.reviewed.manifest=MES.signManifest(s,'AS9102 FAIR reviewed and approved (blocks 22 and 23)',{fair:'FAIR-OTHER',verified:f.verified.manifest.hash},f.reviewed.at);",'FAIR box 22');
r=await run(([id])=>{const bad=edit=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;edit(f);return MES.validate(s);};return {emptySigner:bad(f=>{f.reviewed.manifest={...f.reviewed.manifest,signer:{}};}),otherSigner:bad(f=>{f.reviewed.manifest={...f.reviewed.manifest,signer:{...f.reviewed.manifest.signer,credentialId:'ACCT-other'}};}),otherTime:bad(f=>{f.reviewed.manifest={...f.reviewed.manifest,at:'2020-01-01T00:00:00.000Z'};}),emptyManifest:bad(f=>{f.reviewed.manifest={};}),noManifest:bad(f=>{delete f.reviewed.manifest;}),noSigner:bad(f=>{f.reviewed.by=null;}),badTime:bad(f=>{f.reviewed.at='yesterday';}),onOpen:bad(f=>{f.status='Open';f.verified=null;f.approved=null;}),ok:MES.validate(state)};},[fair.id]);
ok('box 22 without its signature manifest is refused by validation',r.noManifest===false,JSON.stringify(r));
ok('box 22 with an empty or malformed manifest is refused by validation',r.emptyManifest===false,JSON.stringify(r));
ok('box 22 whose manifest signer is empty or another person, or whose manifest time differs, is refused by validation',r.emptySigner===false&&r.otherSigner===false&&r.otherTime===false,JSON.stringify(r));
ok('box 22 without a named signer is refused by validation',r.noSigner===false,JSON.stringify(r));
ok('box 22 without a valid time is refused by validation',r.badTime===false,JSON.stringify(r));
ok('box 22 on a FAIR that is not verified is refused by validation',r.onOpen===false,JSON.stringify(r));
ok('the signed workspace itself validates',r.ok===true,JSON.stringify(r));
r=await run(([id])=>{const s=structuredClone(state),o=s.orders.find(o=>o.id===id),f=o.fair;f.fai=undefined;o.fai={...(o.fai||{}),required:true,reason:'First work order from MWI-0001 Rev A.',wi:(o.fai&&o.fai.wi)||'MWI-0001|A',at:(o.fai&&o.fai.at)||new Date().toISOString(),by:(o.fai&&o.fai.by)||f.verified.by};f.reasons=['Mfg. process change'];const sub={...f.verified.manifest.subject,form1:{...f.verified.manifest.subject.form1,reasons:['Mfg. process change']}};f.verified={...f.verified,manifest:MES.signManifest(s,f.verified.manifest.meaning,sub,f.verified.at)};f.status='Verified';f.reviewed=null;f.approved=null;const v=MES.verifyManifests(s);return {ok:v.ok,failures:v.failures.filter(x=>/FAIR/.test(x.where))};},[fair.id]);
ok('a FAIR verified before reason normalization (raw reasons signed) still verifies',r.ok===true||r.failures.length===0,JSON.stringify(r));
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;f.reviewed=null;return {valid:MES.validate(s)};},[fair.id]);
ok('a FAIR with box 22 cleared (null) still validates as a record',r.valid===true,JSON.stringify(r));
const fairJson=await run(()=>JSON.stringify(state));

// ---- the CAR closure, from the 150-order regression set ----
await open('demo_qa150_publish.html','master');
r=await run(()=>{const v=MES.verifyManifests(state);return {ok:v.ok,failures:v.failures};});
ok('the 150-order regression workspace verifies',r.ok===true,JSON.stringify(r.failures));
const rel=await run(()=>{const o=state.orders.find(o=>o.releaseApproval&&o.releaseApproval.manifest&&['Kitting','Building'].includes(o.status)&&o.operations.some(op=>!op.done&&!op.fromStandardRework));return o?{id:o.id,op:o.operations.filter(op=>!op.done&&!op.fromStandardRework).pop().id}:null;});
ok('fixture: a pre-release-approved order in Kitting or Building',!!rel,String(rel));
r=await run(([rel])=>{const s=structuredClone(state),o=s.orders.find(x=>x.id===rel.id),op=o.operations.find(x=>x.id===rel.op);const e=MES.editOrderOperation(s,rel.id,rel.op,{title:op.title+' (revised)',description:op.description,buyoffType:op.buyoffType,requiresTooling:!!op.requiresTooling,steps:(op.steps||[]).map(x=>x.title).join('\n')||'Step one',reason:'Clarify the operation title.'});const v=MES.verifyManifests(s);return {edit:e.ok,message:e.message,verify:v.ok,failures:v.failures};},[rel]);
ok('an authorized operation edit on a pre-release-approved order still verifies (the sequence change goes to QA, not to verification)',r.edit===true&&r.verify===true,JSON.stringify(r));
const car=await run(()=>{const c=(state.maneuver.cars||[]).find(c=>c.closure&&c.closure.manifest);return c&&c.id;});
ok('fixture: a closed CAR',!!car,String(car));
const C=`const c=s.maneuver.cars.find(c=>c.id==='${car}');`;
await expectFail('editing the CAR root cause after closure fails',C+"c.rootCause.statement='Edited after closure.';",`${car} closure`);
await expectFail('editing a CAR action after closure fails',C+"c.actions[0].description='Edited after closure.';",`${car} closure`);
await expectFail('editing the CAR effectiveness result after closure fails',C+"c.effectiveness.result='Not effective';",`${car} closure`);
await expectFail('editing the CAR closure statement after closure fails',C+"c.closure.note='Edited.';",`${car} closure`);
await expectFail('removing the CAR closure manifest fails',C+"delete c.closure.manifest;",`${car} closure`);

// ---- verification fails closed: a manifest whose stored subject was signed by this build is recomputed even when
// the live record adds or drops a key ----
r=await run(([car])=>{const s=structuredClone(state),c=s.maneuver.cars.find(c=>c.id===car);const subject={id:c.id,title:c.title,severity:c.severity,rootCause:c.rootCause.statement,actions:c.actions.map(a=>({id:a.id,description:a.description,completedAt:a.completedAt})),verification:c.verification.at,effectiveness:c.effectiveness.result,note:c.closure.note};c.closure.manifest=MES.signManifest(s,'Corrective action closure',subject,c.closure.at);const ok0=MES.verifyManifests(s).ok;c.rootCause=null;const v=MES.verifyManifests(s);return {before:ok0,ok:v.ok,where:v.failures.map(f=>f.where)};},[car]);
ok('a freshly signed CAR closure verifies, and removing its root cause afterwards fails',r.before===true&&r.ok===false&&r.where.some(w=>w.includes(`${car} closure`)),JSON.stringify(r));

// ---- production validation refuses a box 22 signed by the verifier (the demo lifts this rule, D-33) ----
await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(1200);
r=await run(([json,id])=>{const base=JSON.parse(json),f=base.orders.find(o=>o.id===id).fair;const other={...f.reviewed.by,credentialId:'ACCT-second',name:'Second Reviewer'};const mk=by=>{const s=structuredClone(base),g=s.orders.find(o=>o.id===id).fair;g.reviewed={...g.reviewed,by,manifest:{...g.reviewed.manifest,signer:{...g.reviewed.manifest.signer,credentialId:by.credentialId}}};return s;};const self=mk({...f.verified.by});const second=mk(other);const fv=s=>MES.validate(s);return {sameCred:f.verified.by.credentialId,second:fv(second),self:fv(self)};},[fairJson,fair.id]);
ok('in production, validation accepts a box 22 signed by a second person and refuses one signed by the verifier',r.second===true&&r.self===false,JSON.stringify(r));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
