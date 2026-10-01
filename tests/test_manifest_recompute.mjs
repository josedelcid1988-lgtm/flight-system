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
const confJson=await run(()=>JSON.stringify(state));
const pkg=`const p=s.orders.find(o=>o.id==='${conf.id}').conformity.find(p=>p.serial==='${conf.serial}');`;
await expectFail('editing the 8130-9 certification basis after signing fails',pkg+"p.form.basis='Edited after signing';",'8130-9');
await expectFail('editing the 8130-9 deviations after signing fails',pkg+"p.form.deviations='None, edited';",'8130-9');
await expectFail('marking the AQI signature self-signed after signing fails',pkg+"p.aqi.selfSigned=true;",'8130-9 AQI signature');
await expectFail('editing the DAR designation after signing fails',pkg+"p.darApproval.designation='DAR-0000';",'DAR acceptance');
await expectFail('editing the DAR date after signing fails',pkg+"p.darApproval.date='2020-01-01';",'DAR acceptance');
await expectFail('removing the 8130-9 signature manifest fails',pkg+"delete p.form.prepared.manifest;",'8130-9');
await expectFail('removing the AQI signature manifest fails',pkg+"delete p.aqi.manifest;",'8130-9 AQI signature');
await expectFail('removing the DAR acceptance manifest fails',pkg+"delete p.darApproval.manifest;",'DAR acceptance');
await expectFail('changing the recorded 8130-9 preparer away from the form signer fails',pkg+"p.form.prepared.by={...p.form.prepared.by,credentialId:'ACCT-other'};",'8130-9');
await expectFail('changing the recorded AQI signer away from the AQI signature fails',pkg+"p.aqi.by={...p.aqi.by,credentialId:'ACCT-other'};",'8130-9 AQI signature');
await expectFail('removing the completed 8130-9 from a conformed package fails rather than skipping its AQI and DAR checks',pkg+"p.form=null;",'8130-9');
await expectFail('removing the AQI signature from a conformed package fails',pkg+"p.aqi=null;",'8130-9 AQI signature');
await expectFail('removing who recorded the DAR acceptance fails',pkg+"delete p.darApproval.by;",'DAR acceptance');
await expectFail('changing when the DAR acceptance was recorded fails',pkg+"p.darApproval.at='2026-01-01T00:00:00.000Z';",'DAR acceptance');
await expectFail('removing the DAR acceptance from a conformed package fails',pkg+"p.darApproval=null;",'DAR acceptance');
await expectFail('removing the AQI signature from a package marked AQI signed fails',pkg+"p.status='AQI signed';p.darApproval=null;p.aqi=null;",'8130-9 AQI signature');
await expectFail('removing the DAR acceptance from a closed package fails',pkg+"p.status='Closed';p.darApproval=null;",'DAR acceptance');

const mrb=await run(()=>{const m=(state.maneuver.mrb||[]).find(m=>m.decision&&m.decision.manifest);return m&&m.id;});
ok('fixture: a decided MRB board',!!mrb,String(mrb));
const board=`const m=s.maneuver.mrb.find(m=>m.id==='${mrb}');`;
await expectFail('editing the MRB decision rationale after signing fails',board+"m.decision.note='Edited after the decision.';",`${mrb} board decision`);
await expectFail('changing a recorded MRB vote after the decision fails',board+"m.votes[0].vote=m.votes[0].vote==='Approve'?'Reject':'Approve';",`${mrb} board decision`);
await expectFail('changing who voted a seat after the decision fails',board+"m.votes[0].by={...m.votes[0].by,credentialId:'ACCT-someone'};",`${mrb} board decision`);
await expectFail('changing the MRB serials after the decision fails',board+"m.serials=[...(m.serials||[]),'SN-EXTRA'];",`${mrb} board decision`);
await expectFail('changing who recorded the MRB decision fails',board+"m.decision.by={...m.decision.by,credentialId:'ACCT-other',name:'Someone Else'};",`${mrb} board decision`);
await expectFail('changing when the MRB decision was recorded fails',board+"m.decision.at='2026-01-01T00:00:00.000Z';",`${mrb} board decision`);
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
// A migrated escape: resolved with no disposition or affected record, an escape record, a closure with no manifest,
// and the system migration entry. Any other resolved NC without a manifest fails, including one that only adds the entry.
const migrated=`const t=s.maneuver.ncs.find(t=>t.id==='${nc}');delete t.resolution.manifest;t.dispo=null;t.affected=null;t.mrbId=null;t.escape={from:'Final inspection',detectedAt:'Customer'};t.history=[...(t.history||[]),{at:new Date().toISOString(),action:'Migrated from escape ESC-0001.',actor:'system'}];`;
r=await run(src=>{const s=structuredClone(state);(new Function('s',src))(s);const v=MES.verifyManifests(s);return {ok:v.ok,where:v.failures.map(f=>f.where),valid:MES.validate(s)};},migrated);
ok('a stock NC migrated from a closed escape keeps its unsigned closure without a verification failure',!r.where.some(w=>w.includes(`${nc} disposition approval`))&&r.valid===true,JSON.stringify(r));
await expectFail('a signed NC that only gains a migration history entry still fails when its manifest is removed',stock+"delete t.resolution.manifest;t.history=[...(t.history||[]),{at:new Date().toISOString(),action:'Migrated from escape ESC-0001.',actor:'system'}];",`${nc} disposition approval`);
await expectFail('a migration entry written by a person, not the system, does not grandfather the closure',migrated+"t.history[t.history.length-1].actor='Someone · ACCT-x';",`${nc} disposition approval`);
await expectFail('a migrated NC that keeps a disposition record does not grandfather the closure',migrated+"t.dispo={decision:'Scrap'};",`${nc} disposition approval`);
await expectFail('a migration entry dated before the closure does not grandfather it',migrated+"t.history[t.history.length-1].at='2000-01-01T00:00:00.000Z';",`${nc} disposition approval`);
await expectFail('changing who approved the stock NC disposition fails',stock+"t.resolution.by={...t.resolution.by,credentialId:'ACCT-other',name:'Someone Else'};",`${nc} disposition approval`);
await expectFail('changing when the stock NC disposition was approved fails',stock+"t.resolution.at='2026-01-01T00:00:00.000Z';",`${nc} disposition approval`);

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
await expectFail('removing the Skyryse QA approval from an Approved FAIR fails',F+"f.approved=null;",'FAIR approval');
await expectFail('removing the verification from a Verified or Approved FAIR fails',F+"f.verified=null;",'FAIR verification');
await expectFail('changing when the FAIR was verified fails',F+"f.verified.at='2026-01-01T00:00:00.000Z';",'FAIR verification');
await expectFail('deleting the signed content of a current FAIR verification fails rather than skipping the content check',F+"delete f.verified.manifest.subject;f.chars=[];",'FAIR verification');
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;const at='2026-09-22T10:00:00.000Z';f.verified={...f.verified,at,manifest:{...f.verified.manifest,at}};delete f.verified.manifest.subject;delete f.verified.manifest.build;const v=MES.verifyManifests(s);return v.failures.filter(x=>/FAIR verification/.test(x.where)).map(x=>x.reason);},[fair.id]);
ok('a FAIR verified before manifests stored their subject (no subject, verified before 2026-09-27) is not failed for the missing subject',!r.some(x=>/lost its signed FAIR content/.test(x)),JSON.stringify(r));
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;const at='2026-09-22T10:00:00.000Z';f.verified={...f.verified,at,manifest:{...f.verified.manifest,at,build:f.verified.manifest.build||MES.buildStamp()}};delete f.verified.manifest.subject;const v=MES.verifyManifests(s);return v.failures.filter(x=>/FAIR verification/.test(x.where)).map(x=>x.reason);},[fair.id]);
ok('a subjectless FAIR verification that carries a build stamp fails even when backdated (build stamps and stored subjects arrived together)',r.some(x=>/lost its signed FAIR content/.test(x)),JSON.stringify(r));
await expectFail('changing who gave the Skyryse QA approval fails',F+"f.approved.by={...f.approved.by,credentialId:'ACCT-other',name:'Someone Else'};",'FAIR approval');
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;f.approved=null;return {valid:MES.validate(s)};},[fair.id]);
ok('MES.validate refuses an Approved FAIR with no approval record',r.valid===false,JSON.stringify(r));
r=await run(([id])=>{const mk=at=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;const sub={fair:f.approved.manifest.subject.fair,verified:f.verified.manifest.hash};f.approved={...f.approved,at,manifest:MES.signManifest(s,'AS9102 FAIR Skyryse QA approval',sub,at)};f.reviewed=null;const v=MES.verifyManifests(s);return v.failures.filter(x=>/FAIR approval/.test(x.where)).length;};return {before:mk('2026-09-20T10:00:00.000Z'),after:mk('2026-09-28T10:00:00.000Z')};},[fair.id]);
ok('an approval from before box 22 was mandatory may lack box 22; one recorded after cannot',r.before===0&&r.after>0,JSON.stringify(r));
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;const at='2026-09-28T10:00:00.000Z',sub={fair:f.approved.manifest.subject.fair,verified:f.verified.manifest.hash};f.approved={...f.approved,at,manifest:MES.signManifest(s,'AS9102 FAIR Skyryse QA approval',sub,'2026-09-20T10:00:00.000Z')};f.reviewed=null;const v=MES.verifyManifests(s);return v.failures.filter(x=>/FAIR approval/.test(x.where)).map(x=>x.reason);},[fair.id]);
ok('backdating only the approval manifest time does not let a post-cutoff approval drop box 22',r.some(x=>/box 22 is missing/.test(x))&&r.some(x=>/does not match the approval signature/.test(x)),JSON.stringify(r));
await expectFail('removing the FAIR verification manifest fails',F+"delete f.verified.manifest;",'FAIR verification');
await expectFail('removing the Skyryse QA approval manifest fails',F+"delete f.approved.manifest;",'FAIR approval');
await expectFail('removing the box 22 manifest fails',F+"delete f.reviewed.manifest;",'FAIR box 22');
await expectFail('changing the recorded FAIR verifier away from the verification signer fails',F+"f.verified.by={...f.verified.by,credentialId:'ACCT-other'};",'FAIR verification');
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;const old=MES.signManifest(s,'AS9102 FAIR reviewed and approved (blocks 22 and 23)',{fair:f.reviewed.manifest.subject.fair,verified:f.verified.manifest.hash},f.reviewed.at);delete old.subject;f.reviewed={...f.reviewed,manifest:old};f.approved=null;f.status='Verified';const v=MES.verifyManifests(s);return {ok:v.ok,failures:v.failures.filter(x=>/FAIR/.test(x.where))};},[fair.id]);
ok('a box 22 signed before manifest subjects were stored (old form, no subject) still verifies',r.failures.length===0,JSON.stringify(r));
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
r=await run(([id])=>{const s=structuredClone(state),f=s.orders.find(o=>o.id===id).fair;f.status='Verified';f.approved=null;f.reviewed=null;return {valid:MES.validate(s)};},[fair.id]);
ok('a Verified FAIR with box 22 cleared (null) still validates as a record',r.valid===true,JSON.stringify(r));
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
await expectFail('changing who closed the CAR fails',C+"c.closure.by={...c.closure.by,credentialId:'ACCT-other',name:'Someone Else'};",`${car} closure`);
await expectFail('changing when the CAR was closed fails',C+"c.closure.at='2026-01-01T00:00:00.000Z';",`${car} closure`);
await expectFail('removing the CAR closure manifest fails',C+"delete c.closure.manifest;",`${car} closure`);

const F0="const f=s.orders.find(o=>o.fair&&o.fair.status==='Approved'&&o.fair.approved).fair;";
// Standalone and offline saves run MES.validate, not verifyManifests: a missing signed record or signature is refused there too.
r=await run(([json,src])=>{const base=JSON.parse(json),out={};for(const [k,e] of Object.entries(src)){const s=structuredClone(k==='partialCar'?state:base);try{(new Function('s',e))(s);out[k]=MES.validate(s);}catch(x){out[k]='err '+x.message;}}const s=structuredClone(base);(new Function('s',src.aqi))(s);out.diagnose=(MES.diagnose(s)||{}).detail||'';out.clean=MES.validate(structuredClone(base));return out;},[confJson,{aqi:pkg+"p.aqi=null;",dar:pkg+"delete p.darApproval.manifest;",form:pkg+"delete p.form.prepared.manifest;",mrb:board+"delete m.decision.manifest;",nc:stock+"delete t.resolution.manifest;",emptyAqi:pkg+"p.aqi.manifest={};",emptyMrb:board+"m.decision.manifest={};",partialCar:C+"delete c.closure.manifest.hash;",emptyFair:F0+"f.approved.manifest={};",emptyNc:stock+"t.resolution.manifest={};"}]);
ok('MES.validate (standalone load and save) refuses a removed AQI signature, DAR manifest, 8130-9 manifest, MRB manifest or NC approval manifest',r.clean===true&&['aqi','dar','form','mrb','nc'].every(k=>r[k]===false),JSON.stringify(r));
ok('MES.validate refuses an empty or partial manifest object in place of a signature (AQI, MRB, CAR, FAIR approval, NC approval)',['emptyAqi','emptyMrb','partialCar','emptyFair','emptyNc'].every(k=>r[k]===false),JSON.stringify(r));
ok('the validation diagnosis names the incomplete signed record',/A signed record is incomplete at .*AQI signature/.test(r.diagnose),JSON.stringify(r.diagnose));

// ---- verification fails closed: a manifest whose stored subject was signed by this build is recomputed even when
// the live record adds or drops a key ----
r=await run(([car])=>{const s=structuredClone(state),c=s.maneuver.cars.find(c=>c.id===car);const subject={id:c.id,title:c.title,severity:c.severity,rootCause:c.rootCause.statement,actions:c.actions.map(a=>({id:a.id,description:a.description,completedAt:a.completedAt})),verification:c.verification.at,effectiveness:c.effectiveness.result,note:c.closure.note};c.closure.manifest=MES.signManifest(s,'Corrective action closure',subject,c.closure.at);const sg=c.closure.manifest.signer;c.closure.by={name:sg.name,role:sg.role,credentialId:sg.credentialId};const ok0=MES.verifyManifests(s).ok;c.rootCause=null;const v=MES.verifyManifests(s);return {before:ok0,ok:v.ok,where:v.failures.map(f=>f.where)};},[car]);
ok('a freshly signed CAR closure verifies, and removing its root cause afterwards fails',r.before===true&&r.ok===false&&r.where.some(w=>w.includes(`${car} closure`)),JSON.stringify(r));

// ---- production validation refuses a box 22 signed by the verifier (the demo lifts this rule, D-33) ----
await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(1200);
r=await run(([json,id])=>{const base=JSON.parse(json),f=base.orders.find(o=>o.id===id).fair;const other={...f.reviewed.by,credentialId:'ACCT-second',name:'Second Reviewer'};const mk=by=>{const s=structuredClone(base),g=s.orders.find(o=>o.id===id).fair;g.reviewed={...g.reviewed,by,manifest:{...g.reviewed.manifest,signer:{...g.reviewed.manifest.signer,credentialId:by.credentialId}}};return s;};const self=mk({...f.verified.by});const second=mk(other);const fv=s=>MES.validate(s);const moved=mk({...f.verified.by});moved.orders.find(o=>o.id===id).fair.verified.by={...f.verified.by,credentialId:'ACCT-moved'};return {sameCred:f.verified.by.credentialId,second:fv(second),self:fv(self),moved:fv(moved)};},[fairJson,fair.id]);
ok('in production, validation accepts a box 22 signed by a second person and refuses one signed by the verifier',r.second===true&&r.self===false,JSON.stringify(r));
ok('in production, validation refuses a box 22 signed by the verification signer even when the recorded verifier was changed',r.moved===false,JSON.stringify(r));
// ---- production: the AQI self-signature flag must match who completed the 8130-9 (the demo lifts this, see DEMO_DEVIATIONS) ----
await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(1200);
r=await run(([json,c])=>{const base=JSON.parse(json);const mk=f=>{const s=structuredClone(base),p=s.orders.find(o=>o.id===c.id).conformity.find(x=>x.serial===c.serial);f(p);const v=MES.verifyManifests(s);return v.failures.filter(x=>/AQI signature/.test(x.where)).map(x=>x.reason);};return {clean:mk(()=>{}),samePerson:mk(p=>{p.form.prepared.by={...p.aqi.by};p.form.prepared.manifest={...p.form.prepared.manifest,signer:{...p.form.prepared.manifest.signer,credentialId:p.aqi.by.credentialId}};})};},[confJson,conf]);
ok('in production, an 8130-9 completed and AQI-signed by the same person without the self-signature record fails verification',r.clean.length===0&&r.samePerson.some(x=>/self-signature/.test(x)),JSON.stringify(r));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
