// Who may do what, and on what record. Covers the stamp register (placeholders SKY-0000 onward, issue, fill,
// import, export), the training requirements list (each change cites a QMS document and revision, retraining
// by revision), person training records, several stamps per person (each additional stamp cites a current
// training and pauses when it lapses), stamp-gated inspection and role-based MRB seats, conformity and AQI (a
// training record, never to oneself, eligible roles only, paused on lapse), extra roles (same), and stamp PINs
// stored with scrypt. Every rule is checked together with the refusal it exists to make.
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
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
  add('pqm','Parker Manager','qm');add('kqe','Kai Quality','qe');add('sqs','Sam Supervisor','qs');add('ttech','Toni Tech','technician');add('priv','Pat Rivera','qe');localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

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
const malformed=await run(()=>{const copy=structuredClone(state);delete copy.stamps;const res=MES.importStamps(copy,'name,buyoffType,expires\n"Unclosed,Quality,2030-01-01');return {res,hasStamps:Object.hasOwn(copy,'stamps')};});
ok('an unclosed CSV quote is refused before initializing or changing the stamp register',!malformed.res.ok&&!malformed.hasStamps&&/quote/.test(malformed.res.message),JSON.stringify(malformed));
const duplicateHeader=await run(f=>MES.importStamps(structuredClone(state),`name,buyoffType,expires,Buyoff Type\nGood Row,Quality,${f},Quality`),future());
ok('normalized duplicate CSV headers are refused',!duplicateHeader.ok&&/duplicate column/.test(duplicateHeader.message),JSON.stringify(duplicateHeader));
const surplusCell=await run(f=>MES.importStamps(structuredClone(state),`name,buyoffType,expires\nGood Row,Quality,${f},unexpected`),future());
ok('a CSV row with surplus cells is refused instead of silently dropping data',!surplusCell.ok&&/cells/.test(surplusCell.message),JSON.stringify(surplusCell));
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
const rec=await run(f=>MES.recordTraining(state,{account:'priv',code:'TORQUE',expires:f,note:'LMS certificate'}),future(1));
ok('the QA Manager records a training for a person',rec.ok&&await run(()=>MES.trainingCurrentFor(state,'priv','TORQUE').ok),JSON.stringify(rec));
const certBytes=Buffer.from('%PDF-1.4\nTraining record certificate\n%%EOF\n'), certificate={name:'torque-certificate.pdf',type:'application/pdf',size:certBytes.length,base64:certBytes.toString('base64'),sha256:createHash('sha256').update(certBytes).digest('hex')};
const certRec=await run(x=>{const result=MES.recordTraining(state,{account:'priv',code:'TORQUE',expires:x.expires,note:'Signed completion with certificate',certificate:x.certificate}),record=state.trainingRecords.at(-1);return {result,record,valid:MES.validate(state),manifests:MES.verifyManifests(state)};},{expires:future(1),certificate});
ok('a trainer signature binds the stored certificate name, size, type and SHA-256',certRec.result.ok&&certRec.record.certificate.name===certificate.name&&certRec.record.trainerSignature.manifest.meaning==='Training completion recorded'&&certRec.record.trainerSignature.manifest.subject.certificate.sha256===certificate.sha256&&certRec.valid&&certRec.manifests.ok,JSON.stringify({result:certRec.result,valid:certRec.valid,manifests:certRec.manifests}));
const tamperedCert=await run(()=>{const copy=structuredClone(state),record=copy.trainingRecords.at(-1);record.certificate.base64='AAAA';return {valid:MES.validate(copy),manifests:MES.verifyManifests(copy),file:MES.trainingCertificateValid(record.certificate)};});
ok('a changed certificate copy fails workspace validation and manifest verification',!tamperedCert.valid&&!tamperedCert.manifests.ok&&!tamperedCert.file,JSON.stringify(tamperedCert));

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

// ---------------- role capabilities and named grants ----------------
await as('pqm');
const seatRoles=await run(()=>({qualityEligible:skAuth.roleCan('qe','mrb-quality'),engineeringEligible:skAuth.roleCan('qe','mrb-eng'),inspectionEligible:skAuth.roleCan('qe','inspect-steps'),inspectionActive:skAuth.can('inspect-steps'),seatActive:skAuth.can('mrb-quality'),granted:skAuth.GRANTED.slice()}));
ok('Quality role is eligible for inspection and the Quality MRB seat, but inspection needs a stamp',seatRoles.qualityEligible&&!seatRoles.engineeringEligible&&seatRoles.inspectionEligible&&!seatRoles.inspectionActive&&seatRoles.seatActive&&!seatRoles.granted.includes('mrb-quality'),JSON.stringify(seatRoles));
const qualityStamp=await run(f=>MES.issueStamp(state,{name:'Kai Quality',buyoffType:'Quality',account:'kqe',expires:f}),future());
await as('kqe');
const activeInspection=await run(()=>({valid:MES.hasValidInspectionStamp(state,'kqe'),active:skAuth.can('inspect-steps')}));
ok('an active Quality stamp assigned to the account activates inspection authority',qualityStamp.ok&&activeInspection.valid&&activeInspection.active,JSON.stringify({qualityStamp,activeInspection}));
await as('pqm');
const invalidStamp=await run(()=>{const expired=structuredClone(state),wrongHolder=structuredClone(state),suspended=structuredClone(state);expired.stamps.find(s=>s.account==='kqe').expires='2000-01-01';wrongHolder.stamps.find(s=>s.account==='kqe').account='another-account';suspended.stamps.find(s=>s.account==='kqe').status='Suspended';return {expired:MES.hasValidInspectionStamp(expired,'kqe'),wrongHolder:MES.hasValidInspectionStamp(wrongHolder,'kqe'),suspended:MES.hasValidInspectionStamp(suspended,'kqe')};});
ok('expired, unassigned, and suspended Quality stamps do not activate inspection authority',!invalidStamp.expired&&!invalidStamp.wrongHolder&&!invalidStamp.suspended,JSON.stringify(invalidStamp));
const inspectionGrant=await run(()=>skAuth.setGrant('kqe','inspect-steps',true,'Qualified inspector per QP-7.2.','ESD'));
ok('inspection cannot be converted into an individual grant',!inspectionGrant.ok&&/not granted individually/.test(inspectionGrant.message),JSON.stringify(inspectionGrant));
const noTraining=await run(()=>skAuth.setGrant('kqe','conformity',true,'Qualified for conformity work.','ESD'));
ok('a grant without a current training record is refused',!noTraining.ok&&/no current ESD training/.test(noTraining.message),JSON.stringify(noTraining));
await run(f=>{MES.recordTraining(state,{account:'kqe',code:'ESD',expires:f});save();},future(1));
const grant=await run(()=>skAuth.setGrant('kqe','conformity',true,'Qualified for conformity work.','ESD'));
const selfGrant=await run(()=>skAuth.setGrant('pqm','aqi-sign',true,'I would like to sign my own AQI record.','ESD'));
const inelig=await run(()=>skAuth.setGrant('ttech','aqi-sign',true,'Technician should sign the AQI.','ESD'));
ok('a QA Manager grants conformity to a person with current training',grant.ok,JSON.stringify(grant));
ok('nobody grants their own authority',!selfGrant.ok&&/Nobody grants or revokes their own/.test(selfGrant.message),JSON.stringify(selfGrant));
ok('an authority outside the person\'s roles is refused',!inelig.ok&&/holds no role/.test(inelig.message),JSON.stringify(inelig));
await as('kqe');
ok('the Quality role and its active stamp carry inspection authority without an individual grant',await run(()=>skAuth.can('inspect-steps')&&skAuth.can('mrb-quality')));
ok('the QA Manager granted person holds trained conformity authority',await run(()=>skAuth.can('conformity')));
const qeGrant=await run(()=>skAuth.setGrant('priv','conformity',true,'Peer grant attempt.','TORQUE'));
ok('a Quality engineer cannot grant authorities',!qeGrant.ok,JSON.stringify(qeGrant));
await as('pqm');
await run(()=>{MES.saveTraining(state,{code:'ESD',qmsDoc:'QP-6.4',qmsRev:'B',reason:'ESD procedure revised; retraining required.',retrain:true});save();});
await as('kqe');
ok('only conformity pauses when its grant training needs renewal',await run(()=>!skAuth.can('conformity')&&skAuth.can('inspect-steps')&&skAuth.can('mrb-quality')));
await as('pqm');
await run(f=>{MES.recordTraining(state,{account:'kqe',code:'ESD',expires:f});save();},future(1));
await as('kqe');
ok('conformity resumes when its grant training is renewed',await run(()=>skAuth.can('conformity')&&skAuth.can('inspect-steps')&&skAuth.can('mrb-quality')));
await as('pqm');
const revoke=await run(()=>skAuth.setGrant('kqe','conformity',false,'Moved to supplier quality.'));
await as('kqe');
ok('a QA Manager revokes conformity authority while role capabilities remain active',revoke.ok&&await run(()=>!skAuth.can('conformity')&&skAuth.can('inspect-steps')&&skAuth.can('mrb-quality'))&&await run(()=>JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.find(u=>u.username==='kqe').grantHistory.filter(x=>x.authority==='conformity').length===2),JSON.stringify(revoke));
ok('Master Access receives MRB role capabilities, while inspection still requires an assigned stamp',await run(()=>{sessionStorage.setItem('skyryse-mes-session-v1','jdoe');return !skAuth.can('inspect-steps')&&['mrb-quality','mrb-me','mrb-eng','mrb-cert'].every(c=>skAuth.can(c))&&!skAuth.can('conformity')&&!skAuth.can('aqi-sign');}));

// ---------------- extra roles ----------------
await as('pqm');
await as('sqs');
const qsAccess=await run(()=>{const wrap=document.createElement('div');wrap.innerHTML=skAuth.accessHtml();const panel=wrap.querySelector('.access-panel'),row=name=>[...panel.querySelectorAll('tbody tr')].find(tr=>tr.querySelector('small')?.textContent.trim()===name);const admin=row('jdoe'),manager=row('pqm'),quality=row('kqe'),add=panel.querySelector('[data-access-add]');return {panel:!!panel,adminLocked:admin&&!admin.querySelector('[data-role-user],[data-roles-user],[data-grant-user],[data-account-password]'),managerLocked:manager&&!manager.querySelector('[data-role-user],[data-roles-user],[data-grant-user],[data-account-password]'),qualityEditable:!!quality?.querySelector('[data-role-user="kqe"]'),addRoles:[...add.elements.role.options].map(x=>x.value),masterSetup:!!panel.querySelector('[data-master-setup]')};});
ok('Quality Supervisor account UI locks QA Manager and Master Access, allows standard accounts, and hides elevated assignment',qsAccess.panel&&qsAccess.adminLocked&&qsAccess.managerLocked&&qsAccess.qualityEditable&&!qsAccess.addRoles.includes('admin')&&!qsAccess.addRoles.includes('qm')&&!qsAccess.masterSetup,JSON.stringify(qsAccess));
await as('pqm');
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
ok('the QA Manager sees training requirements, certificate uploads and the stamp import',ui.train&&ui.rec&&ui.imp&&await p.locator('#training-record-form [name=certificate]').count()===1,JSON.stringify(ui));
await p.locator('#training-record-form [name=account]').selectOption('priv');
await p.locator('#training-record-form [name=code]').selectOption('TORQUE');
await p.locator('#training-record-form [name=expires]').fill(future(1));
await p.locator('#training-record-form [name=certificate]').setInputFiles({name:'ui-certificate.pdf',mimeType:'application/pdf',buffer:certBytes});
const uploadRow=p.waitForFunction(()=>[...document.querySelectorAll('.training-records tbody tr')].some(row=>row.textContent.includes('ui-certificate.pdf')),{timeout:10000});
await p.locator('#training-record-form button[type=submit]').click(); await uploadRow;
const uiCertId=await run(()=>state.trainingRecords.at(-1).id);
await p.locator(`[data-training-certificate="${uiCertId}"]`).click();
const certificateDialog=p.locator('dialog.training-certificate-dialog[open]');
ok('the training screen opens its stored PDF certificate after verifying its SHA-256',await certificateDialog.count()===1&&(await certificateDialog.locator('iframe').getAttribute('src')).startsWith('blob:')&&await p.evaluate(id=>MES.trainingCertificateValid(state.trainingRecords.find(r=>r.id===id).certificate),uiCertId));
await p.keyboard.press('Escape'); await certificateDialog.waitFor({state:'detached'});
ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));

await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
