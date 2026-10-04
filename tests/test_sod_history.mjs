// Separation-of-duties history that must not be lost, and an access change that must not outrun its audit entry.
// 1. Unchecking a step keeps the record that this person performed it, so they still cannot inspect that work.
// 2. A WI keeps every author, however many people edit it, so an early author cannot age out and release it.
// 3. Standalone, a Support Access grant is applied only after its Support Overrides log entry is saved; if the
//    entry cannot be written or saved, the account is unchanged and the workspace keeps no partial entry.
//    A Master Access account cannot grant Support Access to itself (the server already refuses this).
import {chromium} from 'playwright';
import {loadSampleInPage} from './lib/production-sample.mjs';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);
const as=async u=>{await run(([S,u])=>{sessionStorage.setItem(S,u);window.dispatchEvent(new Event('sk-auth'));},[SESSION,u]);await p.waitForTimeout(150);};

await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  add('ttech','Toni Tech','technician');add('vtech','Val Tech','technician');add('mhale','Morgan Hale','admin');add('rsupport','Robin Support','technician');
  for(let i=0;i<42;i++)add('me'+i,'Engineer '+i,'me');
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// ---- 1. a step performer stays on the operation after the step is unchecked ----
await as('jdoe');
// Production ships no WIs (issue #247): load the sample WIs as this suite's data.
await loadSampleInPage(p);
const W=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});const o=MES.getOrder(state,r.id);MES.advance(state,r.id);o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,r.id,m.id,l?l.lot:'L1');MES.setMaterial(state,r.id,m.id,true);});MES.addKitFile(state,r.id,{name:'kit.pdf',type:'application/pdf',size:10,dataUrl:null});MES.advance(state,r.id);save();
  const op=o.operations[0],insp=o.operations.find(x=>x.inspectionPoint);return {id:r.id,status:o.status,op:op.id,step:op.steps[0].id,insp:insp&&insp.id,inspIsLater:!!insp&&o.operations.indexOf(insp)>0&&!op.inspectionPoint};});
ok('fixture: a Building order with a build operation and a later inspection operation',W.status==='Building'&&W.inspIsLater,JSON.stringify(W));
const step=(checked)=>run(([W,checked])=>{const r=MES.setStepCheck(state,W.id,W.op,W.step,checked,{});if(r.ok)save();return r;},[W,checked]);
await as('ttech');let r=await step(true);ok('Toni checks off the first step',r.ok===true,JSON.stringify(r));
r=await step(false);ok('Toni unchecks it',r.ok===true,JSON.stringify(r));
await as('vtech');r=await step(true);ok('Val checks the same step off',r.ok===true,JSON.stringify(r));
r=await run(([W])=>{const o=MES.getOrder(state,W.id),op=o.operations.find(x=>x.id===W.op);return {check:op.stepChecks[W.step]&&op.stepChecks[W.step].account,performers:(op.stepPerformers||[]).map(p=>p.account)};},[W]);
ok('the step now shows Val, and the operation still records Toni and Val as performers',r.check==='vtech'&&r.performers.includes('ttech')&&r.performers.includes('vtech'),JSON.stringify(r));
const refusal=u=>run(([W])=>{const o=MES.getOrder(state,W.id),insp=o.operations.find(x=>x.id===W.insp);const r=MES.ownWorkRefusal(state,o,insp);return r?{ok:r.ok,message:r.message}:null;},[W]);
await as('ttech');r=await refusal();ok('Toni, who unchecked the step, still cannot inspect that work',r&&r.ok===false&&/Nobody inspects their own work/.test(r.message),JSON.stringify(r));
await as('vtech');r=await refusal();ok('Val, who holds the check now, cannot inspect it either',r&&r.ok===false,JSON.stringify(r));
await as('rsupport');r=await refusal();ok('someone who never performed the work is not refused by the own-work rule',r===null,JSON.stringify(r));
r=await run(([W])=>{const bad=edit=>{const s=structuredClone(state),op=MES.getOrder(s,W.id).operations.find(x=>x.id===W.op);edit(op);return MES.validate(s);};return {notArray:bad(op=>{op.stepPerformers='ACCT-ttech';}),noCred:bad(op=>{op.stepPerformers=[{credentialId:'',account:null,at:new Date().toISOString()}];}),noTime:bad(op=>{op.stepPerformers=[{credentialId:'ACCT-ttech',account:'ttech',at:'never'}];}),ok:MES.validate(state)};},[W]);
ok('validation refuses a malformed performer list',r.notArray===false&&r.noCred===false&&r.noTime===false&&r.ok===true,JSON.stringify(r));

// A check made before stepPerformers existed is recorded when it is unchecked.
r=await run(([W])=>{const s=structuredClone(state),o=MES.getOrder(s,W.id),op=o.operations.find(x=>x.id===W.op),st=op.steps[0].id;op.stepChecks={[st]:{name:'Pat Legacy',role:'Technician',credentialId:'ACCT-plegacy',account:'plegacy',at:new Date().toISOString()}};delete op.stepPerformers;const u=MES.setStepCheck(s,W.id,W.op,st,false,{});return {ok:u.ok,message:u.message,performers:(op.stepPerformers||[]).map(p=>p.account),valid:MES.validate(s)};},[W]);
ok('unchecking a step checked before performers were recorded keeps that performer',r.ok===true&&r.performers.includes('plegacy')&&r.valid===true,JSON.stringify(r));
// The performer list is never trimmed: a new performer past the limit is refused and nothing changes.
r=await run(([W])=>{const s=structuredClone(state),o=MES.getOrder(s,W.id),op=o.operations.find(x=>x.id===W.op),st=op.steps[0].id;delete op.stepChecks[st];op.stepPerformers=Array.from({length:200},(_,i)=>({credentialId:'ACCT-p'+i,account:'p'+i,at:new Date().toISOString()}));const before=JSON.stringify(op);const res=MES.setStepCheck(s,W.id,W.op,st,true,{});return {ok:res.ok,message:res.message,unchanged:JSON.stringify(op)===before,valid:MES.validate(s)};},[W]);
ok('a new performer past the 200-performer limit is refused and nothing changes',r.ok===false&&/200 different step performers/.test(r.message)&&r.unchanged&&r.valid,JSON.stringify(r));
await as('vtech');
r=await run(([W])=>{const s=structuredClone(state),o=MES.getOrder(s,W.id),op=o.operations.find(x=>x.id===W.op),st=op.steps[0].id;delete op.stepChecks[st];op.stepPerformers=[...Array.from({length:199},(_,i)=>({credentialId:'ACCT-p'+i,account:'p'+i,at:new Date().toISOString()})),{credentialId:'ACCT-vtech',account:'vtech',at:new Date().toISOString()}];const res=MES.setStepCheck(s,W.id,W.op,st,true,{});return {ok:res.ok,message:res.message,count:op.stepPerformers.length};},[W]);
ok('a performer already on a full list may still check off a step',r.ok===true&&r.count===200,JSON.stringify(r));

// ---- 2. a WI keeps every author ----
await as('jdoe');
const WI=await run(()=>{const wi=state.masterWIs.find(w=>w.status==='Draft');return wi?{id:wi.id,rev:wi.revision}:null;});
ok('fixture: a draft WI',!!WI,JSON.stringify(WI));
// Engineer 0 edits once; forty-one others edit after; then enough further edits to roll the 200-entry history past Engineer 0.
r=await run(([WI])=>{const out=[];for(let i=0;i<42;i++){sessionStorage.setItem('skyryse-mes-session-v1','me'+i);const res=MES.updateMasterWI(state,WI.id,WI.rev,{title:'Author list check '+i});if(!res.ok)out.push(res.message);}for(let k=0;k<210;k++){const res=MES.updateMasterWI(state,WI.id,WI.rev,{title:'Author list check rev '+k});if(!res.ok){out.push(res.message);break;}}save();const wi=state.masterWIs.find(w=>w.id===WI.id&&w.revision===WI.rev);return {errors:out,authors:(wi.authors||[]).length,historyHasFirst:(wi.history||[]).some(h=>/ACCT-me0$/.test(h.actor)),firstIsAuthor:MES.wiAuthors(wi).has('ACCT-me0')};},[WI]);
ok('42 engineers edited the WI and its history no longer names the first one',r.errors.length===0&&r.historyHasFirst===false,JSON.stringify(r));
ok('the WI still lists all 42 authors (and its earlier authors, back-filled from the history)',r.authors>=42&&r.firstIsAuthor===true,JSON.stringify(r));
// An author known only from the history (an older revision, or one dropped by the old 40-author limit) is moved to the
// author list before the history can age the entry out.
await as('jdoe');
r=await run(([WI])=>{const s=structuredClone(state),wi=s.masterWIs.find(w=>w.id===WI.id&&w.revision===WI.rev);wi.authors=(wi.authors||[]).filter(c=>c!=='ACCT-hist');wi.history=[...(wi.history||[]),{at:new Date().toISOString(),action:'Title updated.',actor:'Hal Story · ACCT-hist'}];sessionStorage.setItem('skyryse-mes-session-v1','me41');for(let k=0;k<210;k++)MES.updateMasterWI(s,WI.id,WI.rev,{title:'History author check '+k});sessionStorage.setItem('skyryse-mes-session-v1','jdoe');const w2=s.masterWIs.find(w=>w.id===WI.id&&w.revision===WI.rev);return {historyHas:(w2.history||[]).some(h=>/ACCT-hist$/.test(h.actor)),listed:(w2.authors||[]).includes('ACCT-hist'),author:MES.wiAuthors(w2).has('ACCT-hist')};},[WI]);
ok('a history-only author is kept after 210 more edits roll the history past them',r.historyHas===false&&r.listed===true&&r.author===true,JSON.stringify(r));
await as('me0');
r=await run(([WI])=>{const wi=state.masterWIs.find(w=>w.id===WI.id&&w.revision===WI.rev);const a=MES.wiPeerReviewRefusal(state,wi),b=MES.wiAuthorRefusal(state,wi);return {peer:a&&a.message,release:b&&b.message};},[WI]);
ok('the first author still cannot peer-review the WI',/you edited .* so you cannot peer-review it/.test(r.peer||''),JSON.stringify(r));
ok('the first author still cannot release the WI',/you edited .* so you cannot release it/.test(r.release||''),JSON.stringify(r));
await as('rsupport');
r=await run(([WI])=>{const wi=state.masterWIs.find(w=>w.id===WI.id&&w.revision===WI.rev);return MES.wiAuthorRefusal(state,wi);},[WI]);
ok('someone who never edited the WI is not refused as an author',r===null,JSON.stringify(r));

// ---- 3. Support Access is applied only after its log entry is saved ----
await as('mhale');
const acct=u=>run(([AUTH,u])=>{const x=JSON.parse(localStorage.getItem(AUTH)).users.find(y=>y.username===u);return x&&x.supportAccess===true;},[AUTH,u]);
const grants=()=>run(()=>(state.supportLog||[]).filter(e=>e.kind==='grant'&&e.recordId==='rsupport').length);
r=await run(()=>skAuth.setSupportAccess('mhale',true,'Granting myself support access.'));
ok('a Master Access account cannot grant Support Access to itself',r.ok===false&&/cannot grant Support Access to itself/.test(r.message),JSON.stringify(r));
ok('the self-grant changed nothing',(await acct('mhale'))===false,'');
// The log entry cannot be written: the account is unchanged.
r=await run(()=>{const real=MES.recordSupportAccess;MES.recordSupportAccess=()=>{throw new Error('log unavailable');};try{return skAuth.setSupportAccess('rsupport',true,'Floor support lead for the pilot line.');}finally{MES.recordSupportAccess=real;}});
ok('a grant whose log entry cannot be written is refused',r.ok===false&&/Support Overrides log/.test(r.message),JSON.stringify(r));
ok('the account was not granted Support Access',(await acct('rsupport'))===false,'');
ok('no grant entry was left in the workspace',(await grants())===0,'');
// The log entry is written but the workspace cannot be saved: the account is unchanged and the entry is rolled back.
const KEY=await run(()=>Object.keys(localStorage).find(k=>/^skyryse-mes-work-order-/.test(k)));
r=await run(([KEY])=>{const real=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===KEY)throw new DOMException('quota','QuotaExceededError');return real.call(this,k,v);};try{return skAuth.setSupportAccess('rsupport',true,'Floor support lead for the pilot line.');}finally{Storage.prototype.setItem=real;}},[KEY]);
ok('a grant whose log entry cannot be saved is refused',r.ok===false&&/Support Overrides log/.test(r.message),JSON.stringify(r));
ok('the account was not granted Support Access after the failed save',(await acct('rsupport'))===false,'');
ok('the unsaved grant entry was rolled back',(await grants())===0&&!(JSON.parse(await run(([KEY])=>localStorage.getItem(KEY),[KEY])).supportLog||[]).some(e=>e.kind==='grant'&&e.recordId==='rsupport'),'');
// A normal grant writes the entry, saves it, then grants. (Fresh page: the failed save above blocks storage for this page.)
await p.reload();await p.waitForTimeout(1500);await as('mhale');
r=await run(()=>skAuth.setSupportAccess('rsupport',true,'Floor support lead for the pilot line.'));
ok('a normal grant succeeds',r.ok===true,JSON.stringify(r));
ok('the account holds Support Access',(await acct('rsupport'))===true,'');
ok('one grant entry is saved in the workspace',(await grants())===1&&(JSON.parse(await run(([KEY])=>localStorage.getItem(KEY),[KEY])).supportLog||[]).filter(e=>e.kind==='grant'&&e.recordId==='rsupport').length===1,'');

ok('state valid at end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
