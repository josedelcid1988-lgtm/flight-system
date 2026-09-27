// Who may do what, and on what record. Covers the stamp register (placeholders SKY-0000 onward, issue, fill,
// import, export), the training requirements list (each change cites a QMS document and revision, retraining
// by revision), person training records, several stamps per person (each additional stamp cites a current
// training and pauses when it lapses), QA Manager grants of inspection, MRB seats, conformity and AQI (a
// training record, never to oneself, eligible roles only, paused on lapse), extra roles (same), and stamp PINs
// stored with scrypt. Every rule is checked together with the refusal it exists to make.
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
const future=(y=2)=>new Date(Date.now()+y*365*86400000).toISOString().slice(0,10);

await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.requestSubmit();});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  add('pqm','Parker Manager','qm');add('kqe','Kai Quality','qe');add('ttech','Toni Tech','technician');add('priv','Pat Rivera','qe');localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// ---------------- stamp register ----------------
const fresh=await run(()=>state.stamps.map(s=>({n:s.number,name:s.name,status:s.status,account:s.account,ph:MES.isPlaceholderStamp(s)})));
ok('the register ships with SKY-0000 to SKY-0006 as open placeholders, no people',fresh.slice(0,7).every((s,i)=>s.n===`SKY-000${i}`&&s.name===`Unassigned SKY-000${i}`&&s.ph&&!s.account),JSON.stringify(fresh.slice(0,7)));
ok('SKY-0007 onward are the generic role credentials, retired',fresh.slice(7).length===6&&fresh.slice(7).every((s,i)=>s.n===`SKY-${String(7+i).padStart(4,'0')}`&&s.status==='Retired'),JSON.stringify(fresh.slice(7)));
await as('pqm');
const first=await run(f=>MES.issueStamp(state,{name:'Pat Rivera',buyoffType:'Quality',account:'priv',expires:f}),future());
ok('a blank number takes the first open placeholder, SKY-0000',first.ok&&first.number==='SKY-0000'&&await run(()=>state.stamps.find(s=>s.number==='SKY-0000').name==='Pat Rivera'),JSON.stringify(first));
const dup=await run(f=>MES.issueStamp(structuredClone(state),{number:'SKY-0000',name:'Sam Lee',buyoffType:'Quality',expires:f}),future());
ok('an issued number cannot be issued again',!dup.ok&&/already issued/.test(dup.message),JSON.stringify(dup));
const retired=await run(f=>MES.issueStamp(structuredClone(state),{number:'SKY-0008',name:'Sam Lee',buyoffType:'Quality',expires:f}),future());
ok('a retired number is never reissued',!retired.ok&&/retired and is not reissued/.test(retired.message),JSON.stringify(retired));
const renamed=await run(()=>{const s=state.stamps.find(x=>x.number==='SKY-0001');const r=MES.updateStamp(state,s.id,{name:'Toni Tech',account:'ttech'});return {r,ph:MES.isPlaceholderStamp(s)};});
ok('the QA Manager fills a placeholder in place',renamed.r.ok&&!renamed.ph,JSON.stringify(renamed));
const csv=`name,buyoffType,account,expires\n"Morgan, Lee",quality,,${future()}\nAlex Kim,Technician,,${future()}`;
const imp=await run(c=>MES.importStamps(state,c),csv);
ok('an import fills the next placeholders in order',imp.ok&&JSON.stringify(imp.issued)==='["SKY-0002","SKY-0003"]',JSON.stringify(imp));
const before=await run(()=>JSON.stringify(state.stamps));
const bad=await run(f=>MES.importStamps(state,`name,buyoffType,expires\nGood Row,Quality,${f}\nBad Row,Welding,${f}`),future());
ok('one bad import row imports nothing and names the row',!bad.ok&&/Row 3/.test(bad.message)&&await run(b=>JSON.stringify(state.stamps)===b,before),JSON.stringify(bad));
const out=await run(()=>MES.stampRegisterCsv(state));
ok('the register downloads as CSV with a column per training',out.startsWith('number,name,buyoffType,account,department,expires,esd,fod,status')&&out.includes('"Morgan, Lee"'),out.slice(0,200));

// ---------------- training requirements ----------------
ok('the training list starts with ESD and FOD',JSON.stringify(await run(()=>MES.trainingCatalog(state).map(t=>t.code)))==='["ESD","FOD"]');
const noRef=await run(()=>MES.saveTraining(structuredClone(state),{code:'TORQUE',name:'Torque application',validityMonths:24,reason:'Adds torque training.'}));
ok('a training change without a QMS document and revision is refused',!noRef.ok&&/QMS document/.test(noRef.message),JSON.stringify(noRef));
const add=await run(()=>MES.saveTraining(state,{code:'TORQUE',name:'Torque application',validityMonths:24,lmsCourse:'TRQ-101',qmsDoc:'QP-7.2',qmsRev:'C',reason:'QP-7.2 Rev C adds torque training.'}));
const torque=await run(()=>MES.trainingDef('TORQUE',state));
ok('the QA Manager adds a training, citing the QMS document and revision',add.ok&&torque&&torque.qmsDoc==='QP-7.2'&&torque.qmsRev==='C'&&torque.history[0].reason.includes('Rev C')&&await run(()=>MES.validate(state)),JSON.stringify({add,torque}));
await as('kqe');
const qeAdd=await run(()=>MES.saveTraining(structuredClone(state),{code:'WIRE',name:'Wire harness',validityMonths:24,qmsDoc:'QP-7.2',qmsRev:'C',reason:'Adds wire harness training.'}));
ok('only a QA Manager or Master Access changes the training list',!qeAdd.ok,JSON.stringify(qeAdd));
await as('pqm');
const req=await run(()=>MES.requiredTrainings({callouts:['ESD'],training:['TORQUE']},state));
ok('an operation requires its callout trainings and any ticked training',JSON.stringify(req)==='["ESD","TORQUE"]',JSON.stringify(req));

// ---------------- training records ----------------
const past=await run(()=>MES.recordTraining(structuredClone(state),{account:'priv',code:'TORQUE',expires:'2020-01-01'}));
ok('an expired training record is refused',!past.ok&&/future/.test(past.message),JSON.stringify(past));
const selfTraining=await run(f=>MES.recordTraining(structuredClone(state),{account:'pqm',code:'TORQUE',expires:f}),future(1));
ok('a QA Manager cannot record their own training',!selfTraining.ok&&selfTraining.message==='Nobody records their own training. Another QA Manager or Master Access account must do it.',JSON.stringify(selfTraining));
const rec=await run(f=>MES.recordTraining(state,{account:'priv',code:'TORQUE',expires:f,note:'LMS certificate'}),future(1));
ok('the QA Manager records a training for a person',rec.ok&&await run(()=>MES.trainingCurrentFor(state,'priv','TORQUE').ok),JSON.stringify(rec));

// ---------------- several stamps per person ----------------
const second=await run(f=>MES.issueStamp(structuredClone(state),{name:'Pat Rivera',buyoffType:'Technician',account:'priv',expires:f}),future());
ok('an additional stamp without a qualifying training is refused',!second.ok&&/expands their authority/.test(second.message),JSON.stringify(second));
const sameType=await run(f=>MES.issueStamp(structuredClone(state),{name:'Pat Rivera',buyoffType:'Quality',account:'priv',expires:f,trainingCode:'TORQUE'}),future());
ok('one stamp per buy-off type per person',!sameType.ok&&/already holds an active Quality stamp/.test(sameType.message),JSON.stringify(sameType));
const extra=await run(f=>{const r=MES.issueStamp(state,{name:'Pat Rivera',buyoffType:'Technician',account:'priv',expires:f,trainingCode:'TORQUE'});return {r,st:state.stamps.find(s=>s.number===r.number)};},future());
ok('a person holds a second stamp on a current training record',extra.r.ok&&extra.st.expansionTraining==='TORQUE'&&await run(()=>state.stamps.filter(s=>s.account==='priv'&&s.status==='Active').length)===2,JSON.stringify(extra.r));
const retrain=await run(()=>MES.saveTraining(state,{code:'TORQUE',qmsDoc:'QP-7.2',qmsRev:'D',reason:'Rev D changes the torque sequence; retrain everyone.',retrain:true}));
ok('a QMS revision can require retraining',retrain.ok&&await run(()=>MES.trainingCurrentFor(state,'priv','TORQUE').state)==='retrain',JSON.stringify(retrain));
await as('priv');
const paused=await run(n=>{const st=state.stamps.find(s=>s.number===n);return MES.stampCheck({name:st.name,credentialId:MES.stampCredential(st)});},extra.r.number);
ok('the additional stamp pauses while its training needs renewal',!paused.ok&&/pauses until the training is current/.test(paused.message),JSON.stringify(paused));
await as('pqm');
await run(f=>MES.recordTraining(state,{account:'priv',code:'TORQUE',expires:f,note:'Retrained on Rev D'}),future(1));
await as('priv');
const resumed=await run(n=>{const st=state.stamps.find(s=>s.number===n);return MES.stampCheck({name:st.name,credentialId:MES.stampCredential(st)});},extra.r.number);
ok('it resumes once the retraining is recorded, without reissuing',resumed.ok,JSON.stringify(resumed));

// ---------------- grants ----------------
await as('pqm');
const noTraining=await run(()=>skAuth.setGrant('kqe','inspect-steps',true,'Qualified inspector per QP-7.2.','ESD'));
ok('a grant without a current training record is refused',!noTraining.ok&&/no current ESD training/.test(noTraining.message),JSON.stringify(noTraining));
await run(f=>{MES.recordTraining(state,{account:'kqe',code:'ESD',expires:f});save();},future(1));
const grant=await run(()=>skAuth.setGrant('kqe','inspect-steps',true,'Qualified inspector per QP-7.2.','ESD'));
const selfGrant=await run(()=>skAuth.setGrant('pqm','mrb-quality',true,'I would like the seat.','ESD'));
const inelig=await run(()=>skAuth.setGrant('kqe','mrb-eng',true,'Engineering seat for Quality.','ESD'));
ok('a QA Manager grants inspection to a person on a current training record',grant.ok,JSON.stringify(grant));
ok('nobody grants their own authority',!selfGrant.ok&&/Nobody grants or revokes their own/.test(selfGrant.message),JSON.stringify(selfGrant));
ok('an authority outside the person\'s roles is refused',!inelig.ok&&/holds no role/.test(inelig.message),JSON.stringify(inelig));
await as('kqe');
ok('the granted person holds the authority',await run(()=>skAuth.can('inspect-steps')));
const qeGrant=await run(()=>skAuth.setGrant('priv','inspect-steps',true,'Peer grant attempt.','TORQUE'));
ok('a Quality engineer cannot grant authorities',!qeGrant.ok,JSON.stringify(qeGrant));
await as('pqm');
await run(()=>{MES.saveTraining(state,{code:'ESD',qmsDoc:'QP-6.4',qmsRev:'B',reason:'ESD procedure revised; retraining required.',retrain:true});save();});
await as('kqe');
ok('a grant pauses when its training needs renewal',await run(()=>!skAuth.can('inspect-steps')));
await as('pqm');
await run(f=>{MES.recordTraining(state,{account:'kqe',code:'ESD',expires:f});save();},future(1));
await as('kqe');
ok('the grant resumes when the training is renewed',await run(()=>skAuth.can('inspect-steps')));
await as('pqm');
const revoke=await run(()=>skAuth.setGrant('kqe','inspect-steps',false,'Moved to supplier quality.'));
await as('kqe');
ok('a QA Manager revokes a grant, and it is kept in the history',revoke.ok&&await run(()=>!skAuth.can('inspect-steps'))&&await run(()=>JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.find(u=>u.username==='kqe').grantHistory.length===2),JSON.stringify(revoke));
ok('Master Access holds no granted authority until granted',await run(()=>{sessionStorage.setItem('skyryse-mes-session-v1','jdoe');const r=skAuth.GRANTED.every(c=>!skAuth.can(c));return r;}));

// ---------------- extra roles ----------------
await as('pqm');
const selfRoles=await run(()=>skAuth.setRoles('pqm',['qm','qe'],'Covers incoming inspection on nights.','TORQUE'));
ok('a QA Manager cannot change their own roles',!selfRoles.ok&&selfRoles.message==='Nobody changes their own roles. Another QA Manager or Master Access account must do it.',JSON.stringify(selfRoles));
const noRoleTraining=await run(()=>skAuth.setRoles('ttech',['technician','qe'],'Covers incoming inspection on nights.',''));
ok('adding a role without a qualifying training is refused',!noRoleTraining.ok&&/expands/.test(noRoleTraining.message),JSON.stringify(noRoleTraining));
await run(f=>{MES.recordTraining(state,{account:'ttech',code:'TORQUE',expires:f});save();},future(1));
const roles=await run(()=>skAuth.setRoles('ttech',['technician','qe'],'Covers incoming inspection on nights.','TORQUE'));
await as('ttech');
const withRole=await run(()=>({roles:skAuth.rolesOf('ttech'),approve:skAuth.can('approve-nc'),operate:skAuth.can('operate-steps')}));
ok('a person holds two roles and the abilities of both',roles.ok&&JSON.stringify(withRole.roles)==='["technician","qe"]'&&withRole.approve&&withRole.operate,JSON.stringify({roles,withRole}));
await as('pqm');
await run(()=>{MES.saveTraining(state,{code:'TORQUE',qmsDoc:'QP-7.2',qmsRev:'E',reason:'Rev E; retraining required.',retrain:true});save();});
await as('ttech');
ok('an extra role pauses when its training needs renewal',await run(()=>!skAuth.can('approve-nc')&&skAuth.can('operate-steps')&&skAuth.rolesOf('ttech',true).includes('qe')));

// ---------------- stamp PINs with scrypt ----------------
ok('scrypt matches the RFC 7914 test vector',await run(()=>MES.scryptHex('password','NaCl',1024,8,16,64)==='fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640'));
await as('pqm');
const pin=await run(()=>{const st=state.stamps.find(s=>s.number==='SKY-0000');const r=MES.setStampPin(state,st.id,'482913','482913');return {r,alg:st.pin.alg,N:st.pin.N,good:MES.identityStepUp({number:st.number,pin:st.pin},{pin:'482913'}).ok,wrong:MES.identityStepUp({number:st.number,pin:st.pin},{pin:'482914'}).ok,plain:JSON.stringify(st.pin).includes('482913')};});
ok('a stamp PIN is stored with scrypt and checked at buy-off',pin.r.ok&&pin.alg==='scrypt'&&pin.N===16384&&pin.good&&!pin.wrong&&!pin.plain,JSON.stringify(pin));
const legacy=await run(()=>{const salt='abcd1234';const hash=MES.sha256(`${salt}:246810`);return MES.identityStepUp({number:'X',pin:{salt,hash}},{pin:'246810'}).ok;});
ok('a PIN set before scrypt still verifies',legacy);

// ---------------- screens ----------------
const ui=await run(()=>{profileDialog();const body=document.getElementById('dialog-body');return {train:!!body.querySelector('#training-form'),rec:!!body.querySelector('#training-record-form'),imp:!!body.querySelector('#stamp-import-form')};});
ok('the QA Manager sees training requirements, training records and the stamp import',ui.train&&ui.rec&&ui.imp,JSON.stringify(ui));
ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));

await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
