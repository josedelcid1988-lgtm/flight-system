// The FAIR binds the work order revision and locks the work order (QA Manager decision on #238).
//  - Verification signs the work order revision (woRev) inside the FAIR subject; the screen and the print say
//    "FAIR signed at WO Rev X", and "work order is now Rev Y" once a QA Manager rolls it.
//  - Once the FAIR is Verified or Approved, every configuration change to the work order is refused for every role but
//    QA Manager, Master Access included: engineering change submit, ECR approval and QA re-release, adding and removing
//    operations (rework and standard rework included), operation instruction edits, sequence release, serial assign and
//    void, and reopening the FAIR. A role that holds the capability is not refused for the FAIR on an unsigned FAIR.
//  - A QA Manager still cannot approve their own engineering change or release their own sequence change.
//  - Closure (closeOrder and decideOrderClosure) is refused while the FAIR's revision differs from the work order's,
//    until a QA Manager signs a FAIR impact assessment at the current revision (three statements, rationale, stamp, PIN).
//  - The impact assessment manifest binds the verification hash, both revisions, the rev-roll change list and the drawing
//    revision; verifyManifests and MES.validate refuse any edit to it.
// Runs the production build, with the curated sample workspace from the demo fixture as the data.
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);
const signIn=async(user)=>{await run(u=>{const un=document.querySelector('#sk-boot input[name=username]');if(!un)return;const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,u);set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.requestSubmit();},user);await p.waitForTimeout(2600);};

// The curated sample workspace, read from the demo fixture.
await p.goto('file://'+FIXTURES+'demo_publish.html');await p.waitForTimeout(900);
await signIn('master');
const sample=await run(()=>JSON.stringify(state));
await run(()=>sessionStorage.clear());

// The production build, with one account per role and a second QA Manager.
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1';
await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(900);
await signIn('jdoe');
const ROLES=['admin','qm','qs','qe','me','swe','operator','ops','technician','safety','cert','general'];
const userFor=r=>`u${r}`;
await run(async([AUTH,ROLES])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  ROLES.forEach(r=>add(`u${r}`,`Test ${r}`,r));add('qmb','Second QA Manager','qm');localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH,ROLES]);
const as=u=>run(([S,u])=>sessionStorage.setItem(S,u),[SESSION,u]);
const PIN='4826';

// Working copy: Active Quality stamps for the two QA Managers and the Quality Engineer, each with its PIN.
await as('jdoe');
const setup=await run(([json])=>{const S=JSON.parse(json);window.__S=S;const q=(S.stamps||[]).filter(s=>s.status==='Active'&&s.buyoffType==='Quality');if(q.length<3)return {error:'fewer than three active Quality stamps'};[['uqm',q[0]],['qmb',q[1]],['uqe',q[2]]].forEach(([u,s])=>{s.account=u;});window.__STAMPS={uqm:q[0].id,qmb:q[1].id,uqe:q[2].id};return {ok:true};},[sample]);
ok('setup: three active Quality stamps to assign',setup.ok===true,JSON.stringify(setup));
for(const u of ['uqm','qmb','uqe']){await as(u);const r=await run(([u,pin])=>MES.setStampPin(window.__S,window.__STAMPS[u],pin,pin),[u,PIN]);ok(`setup: ${u} sets the PIN on their own stamp`,r.ok,JSON.stringify(r));}

// Bring the sample FAI order WO-10004 to an approved FAIR: the QA Manager records the two open results, the Quality
// Engineer verifies, a second QA Manager signs box 22, the first gives the Skyryse QA approval.
const ID='WO-10004';
await as('uqm');
let r=await run(([id])=>{const S=window.__S;const a=MES.updateFairChar(S,id,'C-2',{result:'2.751',ok:'yes',tool:'CAL-0101'});const c=MES.updateFairChar(S,id,'C-3',{result:'0.008 break',ok:'yes',tool:'CAL-0102'});return {a,c,gaps:MES.fairReview(S,S.orders.find(o=>o.id===id))};},[ID]);
ok('setup: every FAIR result recorded',r.a.ok&&r.c.ok&&r.gaps.length===0,JSON.stringify(r));
await as('uqe');
r=await run(([id,pin])=>{const S=window.__S,o=S.orders.find(x=>x.id===id);const v=MES.verifyFair(S,id,{pin});return {v,woRev:o.woRev,rec:o.fair.verified&&o.fair.verified.woRev,sub:o.fair.verified&&o.fair.verified.manifest.subject.woRev,valid:MES.validate(S),mv:MES.verifyManifests(S).ok};},[ID,PIN]);
ok('the FAIR verification binds the work order revision inside the signed subject',r.v.ok&&r.rec==='Baseline'&&r.sub==='Baseline'&&r.woRev==='Baseline'&&r.valid&&r.mv,JSON.stringify(r));
await as('qmb');
r=await run(([id,pin])=>MES.reviewFair(window.__S,id,{pin}),[ID,PIN]);ok('setup: a second person signs box 22',r.ok,JSON.stringify(r));
await as('uqm');
r=await run(([id,pin])=>{const S=window.__S;const a=MES.approveFair(S,id,{pin});return {a,st:S.orders.find(o=>o.id===id).fair.status,valid:MES.validate(S),mv:MES.verifyManifests(S)};},[ID,PIN]);
ok('setup: the FAIR is approved and the workspace verifies',r.a.ok&&r.st==='Approved'&&r.valid&&r.mv.ok,JSON.stringify(r));

// Tampering with the bound revision.
r=await run(([id])=>{const t=f=>{const s=structuredClone(window.__S);f(s.orders.find(o=>o.id===id));const v=MES.verifyManifests(s);return {ok:v.ok,why:v.failures.filter(x=>x.where.includes('FAIR verification')).map(x=>x.reason)};};return {changed:t(o=>{o.fair.verified.woRev='A';}),removed:t(o=>{delete o.fair.verified.woRev;}),unknown:t(o=>{o.fair.verified.woRev='Q';o.fair.verified.manifest.subject.woRev='Q';})};},[ID]);
ok('changing or removing the recorded FAIR work order revision fails verification',!r.changed.ok&&r.changed.why.some(w=>/work order revision/.test(w))&&!r.removed.ok&&r.removed.why.some(w=>/work order revision/.test(w)),JSON.stringify(r));
ok('a FAIR bound to a revision that is not in the work order revision log fails verification',!r.unknown.ok&&r.unknown.why.some(w=>/not in the work order revision log/.test(w)),JSON.stringify(r));

r=await run(([id])=>{const s=structuredClone(window.__S),o=s.orders.find(x=>x.id===id);o.fair.reviewed.manifest.meaning='AS9102 FAIR review declined';const v=MES.verifyManifests(s);return {ok:v.ok,where:v.failures.map(f=>f.where)};},[ID]);
ok('relabeling the box 22 signature meaning fails verification (Codex r4161912783)',!r.ok&&r.where.some(w=>/FAIR box 22/.test(w)),JSON.stringify(r));

// ---- the lock: every locked action, every role ----
// Each case runs on a fresh copy (window.__C). prepare() puts the copy in the state the action needs, as the QA Manager.
const CASES=[
  {name:'engineering change submit',cap:'submit-ecr',act:"MES.submitEngineeringChange(c,id,{quantity:3,reason:'More units'})"},
  {name:'ECR approval',cap:'approve-wo',prepEc:true,act:'MES.approveECR(c,id)'},
  {name:'engineering change QA re-release',cap:'approve-wo',prepEc:true,ecrDone:true,act:'MES.approveEngineeringChange(c,id)'},
  {name:'add an operation',cap:'adjust-wo',act:"MES.addOrderOperation(c,id,{classification:'Manufacturing',title:'Added after FAIR',description:'Added.',buyoffType:'Technician',stepList:[{title:'Step',instruction:'Do it.'}],position:1})"},
  {name:'add a rework operation',cap:'adjust-wo',act:"MES.addOrderOperation(c,id,{classification:'Rework',title:'Rework after FAIR',description:'Rework.',buyoffType:'Technician',stepList:[{title:'Step',instruction:'Rework it.'}],position:1})"},
  {name:'add a standard rework',cap:'adjust-wo',act:"MES.addStandardRework(c,id,{templateId:(MES.reworkLibrary(c).find(t=>t.status==='Approved')||{id:'none'}).id,position:1})"},
  {name:'remove an operation',cap:'adjust-wo',act:"MES.removeOrderOperation(c,id,o.operations[0].id,'Not needed')"},
  {name:'edit an operation instruction',cap:'adjust-wo',act:"MES.editOrderOperation(c,id,o.operations[0].id,{description:'Edited after the FAIR.'})"},
  {name:'release a sequence change',cap:'approve-wo',prepSeq:true,act:'MES.approveSequenceChange(c,id)'},
  {name:'reject a sequence change',cap:'approve-wo',prepSeq:true,act:"MES.rejectSequenceChange(c,id,'Not needed','reject')"},
  {name:'link an operation to an NC',cap:'adjust-wo',act:"MES.linkOpToTicket(c,id,o.operations[0].id,(o.tickets[0]||{id:'NC-0000'}).id)"},
  {name:'assign a serial number',cap:'operate',prepVoid:true,act:'MES.assignSerial(c,id)'},
  {name:'void a serial number',cap:'operate',act:"MES.voidSerial(c,id,MES.orderSerials(c,o)[0].serial,'Damaged tag')"},
  {name:'reopen the FAIR',cap:'approve-wo',act:"MES.reopenFair(c,id,'Delta FAI needed')",lockText:'This FAIR is signed. Only a QA Manager can reopen it.'},
];
const LOCK=await run(()=>MES.FAIR_LOCK_MESSAGE);
ok('the lock refusal says what blocks and who can change it',LOCK==="This work order's FAIR is signed. Only a QA Manager can change it.",LOCK);
const prepare=async(c,signed=true)=>{await as('uqm');const r=await run(([id,c,signed])=>{const C=structuredClone(window.__S),o=C.orders.find(x=>x.id===id);window.__C=C;
    if(!signed){o.fair.status='Open';o.fair.verified=null;o.fair.approved=null;delete o.fair.reviewed;}
    // WO-10004 waits in QA review, where main's QA freeze (#542) refuses every change first. The lock is about an order
    // Quality has sent back to Building, so every case starts there.
    o.status='Building';
    if(c.prepEc){o.operations.push({...structuredClone(o.operations[o.operations.length-1]),id:'op-900',title:'Open op',done:false,buyoff:null,evidence:[],stepChecks:{},stepPerformers:[]});const s=MES.submitEngineeringChange(C,id,{instructions:[{operationId:'op-900',description:'Changed open op.'}],reason:'Clarify'});if(!s.ok)return s;}
    if(c.prepSeq){const s=MES.addOrderOperation(C,id,{classification:'Manufacturing',title:'Seq',description:'Seq.',buyoffType:'Technician',stepList:[{title:'S',instruction:'Do.'}],position:o.operations.length});if(!s.ok)return s;}
    if(c.prepVoid){const s=MES.voidSerial(C,id,MES.orderSerials(C,o)[0].serial,'Prep');if(!s.ok)return s;}
    return {ok:true};},[ID,c,signed]);
  if(r.ok&&c.ecrDone){await as('qmb');const e=await run(([id])=>{const ch=window.__C.orders.find(x=>x.id===id).engineeringChanges.at(-1);return ch.status==='Awaiting ECR'?MES.approveECR(window.__C,id):{ok:true};},[ID]);if(!e.ok)return e;}
  return r;};
const act=c=>run(([id,src])=>{const c0=window.__C,o=c0.orders.find(x=>x.id===id);return (new Function('c','id','o','MES',`return ${src};`))(c0,id,o,MES);},[ID,c.act]);
const capOf=cap=>run(cap=>window.skAuth.can(cap),cap);
const CAP_HOLDER={'operate':'technician','adjust-wo':'me','submit-ecr':'technician','approve-wo':'qe'};
for(const c of CASES){
  const want=c.lockText||LOCK;
  for(const role of ROLES.filter(x=>x!=='qm')){
    const pr=await prepare(c);if(!pr.ok){ok(`setup for ${c.name} as ${role}`,false,JSON.stringify(pr));continue;}
    await as(userFor(role));const has=await capOf(c.cap);const out=await act(c);
    ok(`${c.name}: refused for ${role}${has?' (holds the capability; refused for the FAIR)':' (refused by role)'}`,!out.ok&&(!has||out.message===want),JSON.stringify(out));
  }
  // The control: a role that holds the capability is not refused for the FAIR when the FAIR is not signed.
  const pr=await prepare(c,false);await as(userFor(CAP_HOLDER[c.cap]));const free=pr.ok?await act(c):pr;
  ok(`${c.name}: not refused for the FAIR when the FAIR is not signed`,free.message!==want&&free.message!==LOCK,JSON.stringify(free));
  // The QA Manager is not refused for the FAIR (the second one where the first prepared a change to approve).
  const pq=await prepare(c);await as(c.prepEc||c.prepSeq?'qmb':'uqm');const q=pq.ok?await act(c):pq;
  ok(`${c.name}: the QA Manager is not refused for the FAIR`,q.message!==want&&q.message!==LOCK,JSON.stringify(q));
}

// The floor keeps working on a FAIR-locked order: an NC, a note and a closure request are not refused for the FAIR.
for(const role of ['technician','operator','me']){
  await prepare({});await as(userFor(role));
  const floor=await run(([id])=>{const C=window.__C,o=C.orders.find(x=>x.id===id);const nc=MES.createTicket(C,id,{type:'NC',title:'Scratch on cover',description:'Found at final.',operationId:o.operations[0].id});const note=MES.addNote(C,id,'Checked the cover.');return {nc,note};},[ID]);
  ok(`${role}: raising an NC and adding a note are not refused for the FAIR`,floor.nc.message!==LOCK&&floor.note.message!==LOCK,JSON.stringify(floor));
}
await prepare({});await as('ume');
r=await run(([id])=>MES.requestOrderClosure(window.__C,id,{reason:'Obsolete',note:'Superseded.'}),[ID]);
ok('a closure request is still open to the floor on a FAIR-locked order',r.ok,JSON.stringify(r));

// ---- separation of duties still applies to a QA Manager ----
await prepare({prepEc:true});
r=await run(([id])=>{const C=window.__C,ch=C.orders.find(x=>x.id===id).engineeringChanges.at(-1);return {needsECR:ch.status==='Awaiting ECR',ecr:ch.status==='Awaiting ECR'?MES.approveECR(C,id):null,qa:MES.approveEngineeringChange(C,id)};},[ID]);
ok('a QA Manager cannot approve their own engineering change on a FAIR-locked order',(r.needsECR?!r.ecr.ok&&/cannot approve their own engineering change/.test(r.ecr.message):true)&&!r.qa.ok,JSON.stringify(r));
await prepare({prepSeq:true});
r=await run(([id])=>MES.approveSequenceChange(window.__C,id),[ID]);
ok('a QA Manager cannot release their own sequence change on a FAIR-locked order',!r.ok&&/can’t release it/.test(r.message),JSON.stringify(r));

// ---- Jose's decision: an approved engineering change on a signed FAIR reopens it automatically ----
await prepare({prepEc:true});
await as('qmb');
r=await run(([id])=>{const C=window.__C,o=C.orders.find(x=>x.id===id),ch=o.engineeringChanges.at(-1);const ecr=ch.status==='Awaiting ECR'?MES.approveECR(C,id):{ok:true};const a=MES.approveEngineeringChange(C,id);const log=(o.history||o.activity||[]).map(e=>typeof e==='string'?e:(e.action||'')).join('\n');return {ecr,a,st:o.fair.status,verified:o.fair.verified,approved:o.fair.approved,reviewed:o.fair.reviewed===undefined,ia:o.fair.impactAssessments===undefined,woRev:o.woRev,gap:MES.fairRevisionGap(o),kept:o.fair.superseded,logged:/FAIR .* reopened automatically: engineering change .* applied after the FAIR was signed at WO Rev Baseline\. The superseded signatures are kept with the FAIR\. A new FAI is signed against WO Rev A\./.test(log)||JSON.stringify(o).includes('reopened automatically'),valid:MES.validate(C),mv:MES.verifyManifests(C).ok,msg:a.message};},[ID]);
ok('an approved engineering change on a signed FAIR reopens the FAIR automatically, with a recorded reason',r.ecr.ok&&r.a.ok&&r.st==='Open'&&r.verified===null&&r.approved===null&&r.reviewed&&r.ia&&r.woRev==='A'&&r.logged&&/The FAIR was reopened/.test(r.msg),JSON.stringify(r));
ok('after the automatic reopen the order is unlocked, nothing is left to assess, and the workspace validates and verifies',r.gap===null&&r.valid&&r.mv,JSON.stringify(r));
// Codex P1 on 24200f1 (AGENTS.md rule 2): the reopen keeps every signature it supersedes, with when and why.
{const k=r.kept&&r.kept[0];
ok('the automatic reopen keeps the superseded verification, box 22 and approval with their manifests',Array.isArray(r.kept)&&r.kept.length===1&&k.status==='Approved'&&/^Engineering change .+ applied after the FAIR was signed at WO Rev Baseline\.$/.test(k.reason)&&!!k.reopenedAt&&/^[0-9a-f]{64}$/.test(k.verified.manifest.hash)&&k.verified.woRev==='Baseline'&&/^[0-9a-f]{64}$/.test(k.reviewed.manifest.hash)&&/^[0-9a-f]{64}$/.test(k.approved.manifest.hash),JSON.stringify(r.kept));}
r=await run(([id])=>{const t=f=>{const s=structuredClone(window.__C),o=s.orders.find(x=>x.id===id);f(o.fair.superseded[0],o);const v=MES.verifyManifests(s);return {ok:v.ok,valid:MES.validate(s),why:v.failures.map(x=>x.where+': '+x.reason)};};
  return {verified:t(k=>{k.verified.manifest.subject.woRev='A';}),approved:t(k=>{k.approved.manifest.hash='0'.repeat(64);}),reviewed:t(k=>{k.reviewed.manifest.algorithm='MD5';}),reason:t(k=>{k.reason='';}),gone:t((k,o)=>{o.fair.superseded=[{...k,reopenedAt:'not a time'}];})};},[ID]);
ok('editing a kept verification subject fails verification',!r.verified.ok&&r.verified.why.some(w=>/superseded signature 1 \(verification\): hash does not match/.test(w)),JSON.stringify(r.verified));
ok('a forged kept approval hash fails verification',!r.approved.ok&&r.approved.why.some(w=>/superseded signature 1 \(Skyryse QA approval\)/.test(w)),JSON.stringify(r.approved));
ok('a malformed kept box 22 manifest fails verification',!r.reviewed.ok&&r.reviewed.why.some(w=>/superseded signature 1 \(box 22\): the kept manifest is malformed/.test(w)),JSON.stringify(r.reviewed));
ok('a kept entry with no reason or a bad time fails validation',!r.reason.valid&&!r.gone.valid,JSON.stringify({reason:r.reason.valid,gone:r.gone.valid}));
r=await run(([id])=>{const C=structuredClone(window.__S),o=C.orders.find(x=>x.id===id);o.status='Building';o.fair.superseded=Array.from({length:50},()=>({reopenedAt:'2026-09-01T00:00:00.000Z',reason:'Earlier reopen.',status:'Approved',verified:null,reviewed:null,approved:null,impactAssessments:[]}));const before=JSON.stringify(C);const x=MES.reopenFair(C,id,'Another delta FAI');return {x,same:JSON.stringify(C)===before,valid:MES.validate(structuredClone(window.__S))};},[ID]);
ok('a FAIR whose superseded list is full refuses another reopen and changes nothing',!r.x.ok&&/reopened 50 times and keeps every superseded signature/.test(r.x.message)&&r.same,JSON.stringify(r));
await as('ume');
r=await run(([id])=>MES.addOrderOperation(structuredClone(window.__C),id,{classification:'Manufacturing',title:'After reopen',description:'Added.',buyoffType:'Technician',stepList:[{title:'S',instruction:'Do.'}],position:window.__C.orders.find(x=>x.id===id).operations.length}),[ID]);
ok('a reopened FAIR no longer locks the order for the floor',r.message!==LOCK,JSON.stringify(r));

// ---- a second QA Manager rolls the revision; closure waits for the impact assessment ----
await prepare({prepSeq:true});
await as('qmb');
r=await run(([id])=>{const C=window.__C,o=C.orders.find(x=>x.id===id);const a=MES.approveSequenceChange(C,id);return {a,woRev:o.woRev,signedAt:MES.fairWoRev(o),gap:MES.fairRevisionGap(o),valid:MES.validate(C)};},[ID]);
ok('a second QA Manager releases the sequence change and the work order rolls to Rev A',r.a.ok&&r.woRev==='A'&&r.signedAt==='Baseline'&&r.valid,JSON.stringify(r));
ok('the FAIR reports the revision mismatch with what to do next',/FAIR was signed at WO Rev Baseline and the work order is now Rev A\. A QA Manager signs a FAIR impact assessment at Rev A or reopens the FAIR/.test(r.gap||''),String(r.gap));
// Codex r4170271751: a QA Manager's serial change on a signed FAIR rolls the work order revision, so the FAIR no longer
// matches the order and closure needs an impact assessment or a new FAI.
await prepare({});await as('uqm');
r=await run(([id])=>{const C=window.__C,o=C.orders.find(x=>x.id===id);const sn=MES.orderSerials(C,o)[0].serial;const v=MES.voidSerial(C,id,sn,'Damaged tag');return {v,woRev:o.woRev,signedAt:MES.fairWoRev(o),gap:MES.fairRevisionGap(o),last:o.revisions.at(-1),valid:MES.validate(C),mv:MES.verifyManifests(C).ok};},[ID]);
ok('a QA Manager voiding a serial on a signed FAIR rolls the work order to Rev A',r.v.ok&&r.woRev==='A'&&r.signedAt==='Baseline'&&r.last.changes.some(c=>/^Voided serial /.test(c))&&r.valid&&r.mv,JSON.stringify(r));
ok('the void opens the FAIR revision gap and says what is needed before closure',/now Rev A/.test(r.gap||'')&&/impact assessment or a new FAI before closure/.test(r.v.message),JSON.stringify(r));
r=await run(([id])=>{const C=window.__C,o=C.orders.find(x=>x.id===id);const a=MES.assignSerial(C,id);return {a,woRev:o.woRev,gap:MES.fairRevisionGap(o),last:o.revisions.at(-1),valid:MES.validate(C),mv:MES.verifyManifests(C).ok};},[ID]);
ok('a QA Manager assigning a serial on a signed FAIR rolls the work order again',r.a.ok&&r.woRev==='B'&&/now Rev B/.test(r.gap||'')&&r.last.changes.some(c=>/^Assigned serial /.test(c))&&r.valid&&r.mv,JSON.stringify(r));
await prepare({},false);await as('uqm');
r=await run(([id])=>{const C=window.__C,o=C.orders.find(x=>x.id===id);const v=MES.voidSerial(C,id,MES.orderSerials(C,o)[0].serial,'Damaged tag');return {v,woRev:o.woRev};},[ID]);
ok('a serial change with no signed FAIR does not roll the work order revision',r.v.ok&&r.woRev==='Baseline',JSON.stringify(r));

// Codex r4170271755: with the revision log full, a change on a signed FAIR is refused before anything moves, so the FAIR
// can never be left matching a work order that changed.
const fullLog=`const o=C.orders.find(x=>x.id===id);while(o.revisions.length<200)o.revisions.push({...o.revisions.at(-1)});`;
for(const [name,prep,user,src] of [
  ['releasing a sequence change',{prepSeq:true},'qmb','MES.approveSequenceChange(C,id)'],
  ['voiding a serial',{},'uqm',"MES.voidSerial(C,id,MES.orderSerials(C,C.orders.find(x=>x.id===id))[0].serial,'Damaged tag')"],
  ['assigning a serial',{prepVoid:true},'uqm','MES.assignSerial(C,id)'],
]){
  await prepare(prep);await as(user);
  r=await run(([id,fill,src])=>{const C=window.__C;(new Function('C','id',fill))(C,id);const before=JSON.stringify(C);const out=(new Function('C','id','MES',`return ${src};`))(C,id,MES);return {out,same:JSON.stringify(C)===before};},[ID,fullLog,src]);
  ok(`${name} on a signed FAIR is refused when the revision log is full, and nothing changes`,!r.out.ok&&/revision log is full \(200 revisions\).+Reopen the FAIR first/.test(r.out.message)&&r.same,JSON.stringify(r.out));
}

// The closure path: the complete order (every operation bought off, in Quality) rolls to Rev A through the engine's revision
// roll, the same record a QA-approved engineering or sequence change writes.
r=await run(([id])=>{const C=structuredClone(window.__S),o=C.orders.find(x=>x.id===id);const e=MES.rollWorkOrderRevision(C,o,'Engineering change applied.',['Instruction updated on Op 30'],{name:'Second QA Manager',role:'Quality Manager',credentialId:'ACCT-qmb'});window.__R=C;return {rev:e&&e.rev,status:o.status,valid:MES.validate(C),mv:MES.verifyManifests(C).ok};},[ID]);
ok('setup: the complete FAI order rolls to Rev A and still validates',r.rev==='A'&&r.status==='Quality'&&r.valid&&r.mv,JSON.stringify(r));
r=await run(([id])=>MES.closeOrder(structuredClone(window.__R),id),[ID]);
ok('closeOrder is refused on a FAIR revision mismatch',!r.ok&&/FAIR was signed at WO Rev Baseline/.test(r.message),JSON.stringify(r));
await as('ume');
r=await run(([id])=>MES.requestOrderClosure(window.__R,id,{reason:'Obsolete',note:'Superseded by the next build.'}),[ID]);
ok('setup: closure requested as Obsolete',r.ok,JSON.stringify(r));
await as('uqm');
r=await run(([id])=>MES.decideOrderClosure(structuredClone(window.__R),id,true,''),[ID]);
ok('decideOrderClosure is refused on a FAIR revision mismatch',!r.ok&&/FAIR was signed at WO Rev Baseline/.test(r.message),JSON.stringify(r));

// The screen and the print say which revision the FAIR was signed at, and that the order moved on.
r=await run(([id])=>{state=structuredClone(window.__R);const o=state.orders.find(x=>x.id===id);return {line:fairRevText(o),panel:fairPanel(o),print:fairHtml(o)};},[ID]);
ok('the screen and the print show the FAIR revision and the current revision',/^FAIR signed at WO Rev Baseline \(.+\)\. Signed at WO Rev Baseline; work order is now Rev A\.$/.test(r.line)&&r.panel.includes('Signed at WO Rev Baseline; work order is now Rev A')&&r.print.includes('Signed at WO Rev Baseline; work order is now Rev A'),r.line);
ok('the QA Manager sees the impact assessment form',/data-form="fair-impact"/.test(r.panel));
await as('uqe');
r=await run(([id])=>fairPanel(state.orders.find(x=>x.id===id)),[ID]);
ok('a Quality Engineer sees what blocks closure, not the form',!/data-form="fair-impact"/.test(r)&&/A QA Manager signs a FAIR impact assessment/.test(r));
// Codex r4170271759: the drawing in the impact form is escaped as a whole, so a markup-bearing part number stays text.
await as('uqm');
r=await run(([id])=>{state=structuredClone(window.__R);const o=state.orders.find(x=>x.id===id);o.partNumber='<IMG SRC=X ONERROR=&#97;LERT(1)>';return fairPanel(o);},[ID]);
ok('the impact form escapes the drawing part number',/data-form="fair-impact"/.test(r)&&!r.includes('<IMG')&&r.includes('&lt;IMG SRC=X ONERROR=&amp;#97;LERT(1)&gt;'),r.slice(0,400));

// ---- the impact assessment ----
const IA={fairValid:true,noOperationImpact:true,noDrawingDeviation:true,rationale:'Added a sequence-only build operation; no characteristic or completed buy-off is affected.'};
for(const role of ROLES.filter(x=>x!=='qm')){await as(userFor(role));const out=await run(([id,a,pin])=>MES.signFairImpactAssessment(structuredClone(window.__R),id,a,{pin}),[ID,IA,PIN]);ok(`the impact assessment is refused for ${role}`,!out.ok,JSON.stringify(out));}
await as('uqm');
r=await run(([id,a,pin])=>{const t=(x,e)=>MES.signFairImpactAssessment(structuredClone(window.__R),id,{...a,...x},e||{pin});return {two:t({noDrawingDeviation:false}),none:t({fairValid:false,noOperationImpact:false}),empty:t({rationale:'  '}),long:t({rationale:'x'.repeat(301)}),pin:t({},{pin:'1357'}),nopin:t({},{})};},[ID,IA,PIN]);
ok('all three statements are required',!r.two.ok&&!r.none.ok&&/Confirm all three statements/.test(r.two.message),JSON.stringify(r));
ok('a rationale of 1 to 300 characters is required',!r.empty.ok&&!r.long.ok&&/1 to 300 characters/.test(r.empty.message),JSON.stringify(r));
ok('the impact assessment needs the signer stamp PIN',!r.pin.ok&&!r.nopin.ok,JSON.stringify(r));
r=await run(([id,a,pin])=>{const C=window.__R,o=C.orders.find(x=>x.id===id);const s=MES.signFairImpactAssessment(C,id,a,{pin});const x=o.fair.impactAssessments&&o.fair.impactAssessments[0];return {s,x,gap:MES.fairRevisionGap(o),valid:MES.validate(C),mv:MES.verifyManifests(C),again:MES.signFairImpactAssessment(structuredClone(C),id,a,{pin})};},[ID,IA,PIN]);
const sub=r.x&&r.x.manifest&&r.x.manifest.subject;
ok('a QA Manager signs the impact assessment with stamp and PIN',r.s.ok&&!!(r.x&&r.x.by.stamp&&r.x.by.stamp.number)&&r.valid&&r.mv.ok,JSON.stringify({s:r.s,mv:r.mv.failures}));
ok('the assessment manifest binds the verification hash, both revisions, the change list and the drawing revision',!!sub&&/^[0-9a-f]{64}$/.test(sub.verified)&&sub.fromWoRev==='Baseline'&&sub.toWoRev==='A'&&Array.isArray(sub.changes)&&sub.changes.length===1&&sub.changes[0].rev==='A'&&!!sub.drawing&&!!sub.drawing.partNumber&&!!sub.drawing.revision&&sub.statements.length===3&&sub.rationale===IA.rationale&&!!sub.signer&&sub.signedAt===r.x.at,JSON.stringify(sub));
ok('with the assessment at the current revision, closure is no longer blocked by the FAIR',r.gap===null,String(r.gap));
ok('a second assessment at the same revision is refused',!r.again.ok&&/already signed at WO Rev A/.test(r.again.message),JSON.stringify(r.again));
r=await run(([id])=>{const C=structuredClone(window.__R);const d=MES.decideOrderClosure(C,id,true,'');return {d,status:C.orders.find(x=>x.id===id).status,valid:MES.validate(C),mv:MES.verifyManifests(C).ok};},[ID]);
ok('decideOrderClosure closes the order once the assessment covers the current revision',r.d.ok&&r.status==='Closed'&&r.valid&&r.mv,JSON.stringify(r));
r=await run(([id])=>{const C=structuredClone(window.__R),o=C.orders.find(x=>x.id===id);delete o.closureRequest;return MES.closeOrder(C,id);},[ID]);
ok('closeOrder is no longer refused for the FAIR once the assessment covers the current revision',r.ok||!/FAIR was signed at WO Rev/.test(r.message),JSON.stringify(r));
r=await run(([id])=>{state=structuredClone(window.__R);const o=state.orders.find(x=>x.id===id);return {panel:fairPanel(o),print:fairHtml(o)};},[ID]);
ok('the screen and the print list the signed impact assessment',/FIA-1: WO Rev Baseline to Rev A/.test(r.panel)&&/FIA-1: WO Rev Baseline to Rev A/.test(r.print));

// Tampering with the impact assessment.
const tamper=src=>run(([id,src])=>{const s=structuredClone(window.__R),o=s.orders.find(x=>x.id===id),a=o.fair.impactAssessments[0];(new Function('s','o','a',src))(s,o,a);const v=MES.verifyManifests(s);return {ok:v.ok,valid:MES.validate(s),where:v.failures.map(f=>f.where+': '+f.reason)};},[ID,src]);
const TAMPER=[
  ['editing the rationale','a.rationale="Edited later.";'],
  ['dropping a statement','a.statements=a.statements.slice(0,2);'],
  ['editing a statement','a.statements[2]=a.statements[2].replace(/Rev \\S+\\.$/,"Rev Z.");'],
  ['changing the assessed revision','a.toWoRev="B";'],
  ['changing the FAIR revision it starts from','a.fromWoRev="A";'],
  ['changing the drawing revision on the assessment','a.drawing={...a.drawing,revision:"Z"};'],
  ['editing the rev-roll change list in the revision log','o.revisions[o.revisions.length-1].changes=["Something else"];'],
  ['editing the drawing revision in the revision log','o.revisions[o.revisions.length-1].drawingRev="Z";'],
  ['renaming the signer','a.by={...a.by,name:"Someone Else"};'],
  ['changing the signer credential','a.by={...a.by,credentialId:"ACCT-other"};'],
  ['changing the signing time','a.at="2026-01-01T00:00:00.000Z";'],
  ['changing the signer stamp','a.by={...a.by,stamp:{number:"Q-999",type:"Quality"}};'],
  ['removing the manifest','delete a.manifest;'],
  ['removing the signed subject','delete a.manifest.subject;'],
  ['changing the signature meaning','a.manifest.meaning="Something";'],
  ['a new FAIR verification under it','o.fair.verified.manifest.hash="0".repeat(64);'],
  ['moving it to a FAIR that is not signed','o.fair.status="Open";o.fair.verified=null;o.fair.approved=null;delete o.fair.reviewed;'],
];
for(const [label,src] of TAMPER){const t=await tamper(src);ok(`impact assessment tamper: ${label} fails verifyManifests and MES.validate`,!t.ok&&t.valid===false&&t.where.some(w=>/FAIR impact assessment/.test(w)),JSON.stringify(t));}

// Reopening the FAIR is the alternative: QA Manager only, and it clears the assessments and the lock.
await as('uqm');
r=await run(([id])=>{const C=structuredClone(window.__R),o=C.orders.find(x=>x.id===id);const x=MES.reopenFair(C,id,'Delta FAI for the new operation');const k=(o.fair.superseded||[]).at(-1);return {x,st:o.fair.status,ia:o.fair.impactAssessments===undefined,kept:!!k&&k.reason==='Delta FAI for the new operation'&&k.impactAssessments.length===1&&/^[0-9a-f]{64}$/.test(k.impactAssessments[0].manifest.hash)&&!!k.verified&&!!k.approved,gap:MES.fairRevisionGap(o),valid:MES.validate(C),mv:MES.verifyManifests(C).ok};},[ID]);
ok('a QA Manager reopens the FAIR, which clears the assessments and the lock',r.x.ok&&r.st==='Open'&&r.ia&&r.gap===null&&r.valid&&r.mv,JSON.stringify(r));
ok('the reopen keeps the superseded signatures and the signed impact assessment, with the reason',r.kept,JSON.stringify(r));

// A FAIR verified before the revision was bound takes the revision in force at its verification time.
r=await run(()=>{const S=window.__S,o=S.orders.find(x=>x.id==='WO-10002');return {rev:MES.fairWoRev(o),cur:o.woRev,gap:MES.fairRevisionGap(o),bound:o.fair.verified.woRev};});
ok('a FAIR verified before the binding reads its revision from the revision log',r.bound===undefined&&r.rev===r.cur&&r.gap===null,JSON.stringify(r));

ok('no page errors',errs.length===0,JSON.stringify(errs));
await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
