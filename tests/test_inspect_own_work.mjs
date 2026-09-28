// Item 5: nobody inspects their own work. The Quality role and an assigned Quality stamp provide inspection;
// trained extra role for the Support Access account. Anyone who performed a build operation
// an inspection covers is refused that inspection: no role is exempt and no override lifts it, Master Access
// and Support Access included. Development NFF orders are the one exception, and it is recorded.
import {chromium} from 'playwright';
import {assignTestRoles} from './lib/roles.mjs';
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
  const add=(username,displayName,role,extra)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe',...(extra||{})});};
  add('mhale','Morgan Hale','admin');add('rsup','Robin Support','technician',{supportAccess:true});add('qinsp','Quinn Inspector','qe');add('qbuild','Pat Manager','qm');
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// Quality stamp for the independent inspector, issued by Master Access.
await as('jdoe');
const assigned=await assignTestRoles(p,{rsup:['qe']});
ok('setup: the Support Access account also holds the Quality role after training',assigned===true,String(assigned));
const stamp=await run(()=>{const r=MES.issueStamp(state,{number:'QI-77',name:'Quinn Inspector',department:'Quality',buyoffType:'Quality',account:'qinsp',expires:'2029-01-01'});if(!r.ok)return r.message;const st=state.stamps.find(s=>s.number==='QI-77');st.account='qinsp';const pin=MES.setStampPin(state,st.id,'2468','2468');if(!pin.ok)return pin.message;save();return true;});
ok('an independent Quality inspector holds a Quality stamp with a PIN',stamp===true,String(stamp));
const additionalStamps=await run(()=>['jdoe','mhale','rsup','qbuild'].map(username=>MES.issueStamp(state,{name:({jdoe:'Jordan Doe',mhale:'Morgan Hale',rsup:'Robin Support',qbuild:'Pat Manager'})[username],buyoffType:'Quality',account:username,expires:'2029-01-01'}).ok));
ok('Master Access and Support Access also require an assigned inspection stamp',additionalStamps.every(Boolean),JSON.stringify(additionalStamps));

// Two Building orders from the same WI: three build operations, then three inspection operations.
const [W1,W2]=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const mk=()=>{const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});if(!r.ok)throw new Error(r.message);const o=MES.getOrder(state,r.id);let a=MES.advance(state,r.id);if(!a.ok)throw new Error(a.message);o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,r.id,m.id,l?l.lot:'L1');MES.setMaterial(state,r.id,m.id,true);});MES.addKitFile(state,r.id,{name:'kit.pdf',type:'application/pdf',size:10,dataUrl:null});a=MES.advance(state,r.id);if(!a.ok)throw new Error(a.message);return r.id;};const ids=[mk(),mk()];save();return ids;});
const layout=await run(([W1])=>{const o=MES.getOrder(state,W1);return o.operations.map(op=>MES.isInspectionOp(op));},[W1]);
ok('fixture: three build operations, one inspection operation, then two Quality buy-offs',JSON.stringify(layout)==='[false,false,false,true,false,false]',JSON.stringify(layout));

// Build one operation as the signed-in account (steps, torque and consumables filled; tools logged).
const build=(W,support,stampNo,pin)=>run(([W,support,stampNo,pin])=>{const o=MES.getOrder(state,W);const op=o.operations.find(x=>!x.done);const today=d=>new Date(Date.now()+d*86400000).toISOString().slice(0,10);
  for(const s of op.steps||[]){if(op.stepChecks&&op.stepChecks[s.id])continue;const pl={};if(s.recordsTorque){const t=MES.CAL_TOOLS.find(t=>MES.isTorqueTool(t)&&MES.toolCheck(t.tag).ok);Object.assign(pl,{value:45,unit:MES.TORQUE_UNITS[0],tool:t?t.tag:''});}if(Array.isArray(s.consumables)&&s.consumables.length)pl.consumables=s.consumables.map(c=>({name:c,lot:'LOT-CONS-0042',expires:today(200)}));const r=MES.setStepCheck(state,W,op.id,s.id,true,pl);if(!r.ok)return 'step: '+r.message;}
  const tools=op.requiresTooling?[MES.CAL_TOOLS.find(t=>MES.toolCheck(t.tag).ok&&!MES.isTorqueTool(t)).tag]:[];
  const r=MES.completeOperation(state,W,op.id,'Built to the work instruction.',{tools,noTools:!tools.length,toolControlAck:true,...(stampNo?{stampNumber:stampNo,pin}:{}),...(support?{supportReason:'Stamp register not yet loaded for this account; lead confirmed.'}:{})});save();return r.ok?op.id:'buy-off: '+r.message;},[W,support,stampNo,pin]);

await as('mhale');const b1=await build(W1);                 // Op 010 by Master Access
await as('rsup');const b2=await build(W1,true);             // Op 020 by a Support Access account under an override
await as('mhale');const b3=await build(W1);                 // Op 030 by Master Access
ok('build operations recorded (Master Access, Support Access override, Master Access)',[b1,b2,b3].every(x=>/^op-/.test(x)),JSON.stringify([b1,b2,b3]));
ok('buy-offs and step checks now record the account that performed them',await run(([W1])=>{const o=MES.getOrder(state,W1);return o.operations.slice(0,3).every(op=>op.buyoff.account&&Object.values(op.stepChecks).every(c=>c.account));},[W1]));

const tryInspect=(W,opts={})=>run(([W,opts])=>{const c=structuredClone(state);const o=MES.getOrder(c,W);const op=o.operations.find(x=>!x.done);const s=op.steps[0];const step=MES.setStepCheck(c,W,op.id,s.id,true,opts.support?{supportReason:'Inspector out today, lead asked me to cover.'}:{});
  const c2=structuredClone(state);const o2=MES.getOrder(c2,W);const op2=o2.operations.find(x=>!x.done);op2.stepChecks=Object.fromEntries(op2.steps.map(x=>[x.id,{name:'Quinn Inspector',role:'Quality stamp holder',credentialId:'QI-77',account:'qinsp',at:new Date().toISOString()}]));
  const buy=MES.completeOperation(c2,W,op2.id,'Inspected.',{tools:op2.requiresTooling?[MES.CAL_TOOLS.find(t=>MES.toolCheck(t.tag).ok&&!MES.isTorqueTool(t)).tag]:[],noTools:!op2.requiresTooling,standardInspection:true,toolControlAck:true,...(opts.support?{supportReason:'Inspector out today, lead asked me to cover.'}:{})});
  return {op:op.id,step:step.ok,stepMsg:step.message,buy:buy.ok,buyMsg:buy.message};},[W,opts]);

// ---- refusals: Master Access, Support Access (even with a reason), and a QA Manager ----
await as('mhale');
let r=await tryInspect(W1);
ok('Master Access cannot check off an inspection step on work it performed',r.step===false&&/Nobody inspects their own work/.test(r.stepMsg),JSON.stringify(r));
ok('Master Access cannot buy off an inspection covering work it performed',r.buy===false&&/Nobody inspects their own work/.test(r.buyMsg),JSON.stringify(r));
ok('the refusal names the operation performed and the next step',/Op 010|Op 030/.test(r.stepMsg)&&/different inspector/.test(r.stepMsg),r.stepMsg);
await as('rsup');
r=await tryInspect(W1,{support:true});
ok('Support Access cannot inspect its own work, even with an override reason',r.step===false&&r.buy===false&&/Nobody inspects their own work/.test(r.stepMsg+r.buyMsg),JSON.stringify(r));
ok('no Support Access rule exists for inspecting own work',await run(()=>!Object.keys(MES.SUPPORT_RULES).some(k=>/inspect|own/.test(k))));

// ---- Quality: narrow capability, independent inspection allowed ----
await as('qinsp');
const narrow=await run(([W2])=>{const c=structuredClone(state);const o=MES.getOrder(c,W2);const op=o.operations[0];return MES.setStepCheck(c,W2,op.id,op.steps[0].id,true,{});},[W2]);
ok('Quality cannot check off steps on a build operation',narrow.ok===false&&/outside an inspection operation/.test(narrow.message),JSON.stringify(narrow));
const narrowBuy=await run(([W2])=>{const c=structuredClone(state);const o=MES.getOrder(c,W2);const op=o.operations[0];return MES.completeOperation(c,W2,op.id,'x',{tools:[],noTools:true});},[W2]);
ok('Quality cannot buy off a build operation',narrowBuy.ok===false&&/cannot buy off/.test(narrowBuy.message),JSON.stringify(narrowBuy));
ok('Quality holds inspect-steps and not operate-steps',await run(()=>skAuth.can('inspect-steps')&&!skAuth.can('operate-steps')));
const inspected=await run(([W1])=>{const opts=MES.profileOptions(state);const mine=opts.find(o=>o.buyoffType==='Quality'&&/QI-77/.test(o.label||''));if(!mine)return 'no Quality credential offered';const sel=MES.selectProfile(state,mine.id);if(!sel.ok)return sel.message;
  const o=MES.getOrder(state,W1);const op=o.operations.find(x=>!x.done);for(const s of op.steps){const r=MES.setStepCheck(state,W1,op.id,s.id,true,{});if(!r.ok)return 'step: '+r.message;}
  const tools=op.requiresTooling?[MES.CAL_TOOLS.find(t=>MES.toolCheck(t.tag).ok&&!MES.isTorqueTool(t)).tag]:[];
  const r=MES.completeOperation(state,W1,op.id,'Inspected against the drawing.',{tools,noTools:!tools.length,standardInspection:true,toolControlAck:true,stampNumber:'QI-77',pin:'2468'});save();return r.ok?true:'buy-off: '+r.message;},[W1]);
ok('an independent Quality inspector checks off and buys off the inspection',inspected===true,String(inspected));

// ---- scope: an inspection covers only the build operations since the previous inspection ----
const scope=await run(([W1])=>{const o=MES.getOrder(state,W1);const ops=o.operations;const first=MES.coveredBuildOps(o,ops[3]).map(x=>x.id);const later={...ops[5],inspectionPoint:true};const oo={...o,operations:[...ops.slice(0,5),later]};return {first,later:MES.coveredBuildOps(oo,later).map(x=>x.id),ids:ops.map(x=>x.id)};},[W1]);
ok('the inspection covers exactly the build operations before it',JSON.stringify(scope.first)===JSON.stringify(scope.ids.slice(0,3)),JSON.stringify(scope));
ok('a later inspection covers only the operations after the previous inspection',JSON.stringify(scope.later)===JSON.stringify([scope.ids[4]]),JSON.stringify(scope));

// ---- records made before this build carry no account: the credential still identifies the performer ----
await as('mhale');
const legacy=await run(([W1])=>{const c=structuredClone(state);const o=MES.getOrder(c,W1);o.operations.slice(0,3).forEach(op=>{delete op.buyoff.account;Object.values(op.stepChecks).forEach(x=>delete x.account);});const insp=o.operations[3];insp.done=false;insp.buyoff=null;insp.stepChecks={};o.operations.slice(4).forEach(x=>{x.done=false;x.buyoff=null;x.stepChecks={};});return MES.setStepCheck(c,W1,insp.id,insp.steps[0].id,true,{});},[W1]);
ok('a record without an account is matched by credential and still refused',legacy.ok===false&&/Nobody inspects their own work/.test(legacy.message),JSON.stringify(legacy));

// ---- a QA Manager who ran a build operation on their own stamp is refused too ----
await as('jdoe');
const qmStamp=await run(()=>{const training=MES.recordTraining(state,{account:'qbuild',code:'ESD',expires:'2029-01-01',note:'Additional Technician stamp qualification.'});if(!training.ok)return training.message;const r=MES.issueStamp(state,{number:'TE-78',name:'Pat Manager',department:'Assembly',buyoffType:'Technician',account:'qbuild',trainingCode:'ESD',expires:'2029-01-01'});if(!r.ok)return r.message;const st=state.stamps.find(s=>s.number==='TE-78');st.account='qbuild';const pin=MES.setStampPin(state,st.id,'1357','1357');save();return pin.ok?true:pin.message;});
await as('qbuild');
const sel=await run(()=>{const o=MES.profileOptions(state).find(x=>/TE-78/.test(x.label||''));return o?MES.selectProfile(state,o.id).ok:false;});
const q1=await build(W2,false,'TE-78','1357');
await as('mhale');const q2=await build(W2);const q3=await build(W2);
ok('a QA Manager builds Op 010 on a Technician stamp',qmStamp===true&&sel===true&&/^op-/.test(q1)&&/^op-/.test(q2)&&/^op-/.test(q3),JSON.stringify({qmStamp,sel,q1,q2,q3}));
await as('qbuild');
const qm=await tryInspect(W2);
ok('the QA Manager who performed a covered build operation is refused the inspection',qm.step===false&&qm.buy===false&&/Nobody inspects their own work/.test(qm.stepMsg),JSON.stringify(qm));

// ---- Development NFF: the one exception, and it is recorded ----
await as('jdoe');
const W3=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Development NFF',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});if(!r.ok)throw new Error(r.message);const o=MES.getOrder(state,r.id);let a=MES.advance(state,r.id);if(!a.ok)throw new Error(a.message);o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,r.id,m.id,l?l.lot:'L1');MES.setMaterial(state,r.id,m.id,true);});MES.addKitFile(state,r.id,{name:'kit.pdf',type:'application/pdf',size:10,dataUrl:null});a=MES.advance(state,r.id);if(!a.ok)throw new Error(a.message);save();return r.id;});
await as('mhale');const n1=await build(W3);const n2=await build(W3);const n3=await build(W3);
ok('fixture: Master Access builds the three operations of a Development NFF order',[n1,n2,n3].every(x=>/^op-/.test(x)),JSON.stringify([n1,n2,n3]));
const nff=await run(([W])=>{const o=MES.getOrder(state,W);const op=o.operations.find(x=>!x.done);const refusal=MES.ownWorkHit(state,o,op);const steps=op.steps.map(s=>MES.setStepCheck(state,W,op.id,s.id,true));const buy=MES.completeOperation(state,W,op.id,'Inspected on a development build.',{tools:op.requiresTooling?[MES.CAL_TOOLS.find(t=>MES.toolCheck(t.tag).ok&&!MES.isTorqueTool(t)).tag]:[],noTools:!op.requiresTooling,standardInspection:true,toolControlAck:true});return {hit:!!refusal,steps:steps.every(x=>x.ok),stepMsg:(steps.find(x=>!x.ok)||{}).message||'',buy:buy.ok,buyMsg:buy.message,note:o.history.some(h=>/own-work exception/.test(h.action))};},[W3]);
ok('on a Development NFF order the builder may inspect their own work',nff.hit&&nff.steps&&nff.buy,JSON.stringify(nff));
ok('the order history records that the own-work exception was used',nff.note,JSON.stringify(nff));
ok('the exception is Development NFF only: production still refuses',await run(()=>MES.OWN_WORK_EXEMPT_PEDIGREES.length===1&&MES.OWN_WORK_EXEMPT_PEDIGREES[0]==='Development NFF'));

ok('state valid at end',await run(()=>MES.validate(state)));
ok('manifests verify at end',await run(()=>MES.verifyManifests(state).ok));
ok('no page errors',errs.length===0,errs.join(' | '));
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
process.exit(fails.length?1:0);
