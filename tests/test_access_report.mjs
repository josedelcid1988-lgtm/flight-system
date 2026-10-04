// The access review report and the plain reasons for blocked permissions (production build, then the demo).
// Covers: the report lists every account with primary and extra roles (a paused extra role with its
// reason), the individually granted authorities (Active, Paused with the reason, Not active for a tampered
// or self-made grant record, Not granted), each stamp with status, type, dates and whether it is valid now
// (an expired and a suspended stamp), Support Access, the sign-in lockout and the effective capabilities,
// which match the capabilities the app enforces; generation time, who generated it and the build id. Only a
// QA Manager or Master Access account opens it: a Quality Supervisor and a technician get no button and a
// plain refusal, also from a forged action. Building and printing it changes neither the workspace nor the
// accounts. The production print carries no DEMO mark; the demo print carries DEMO, NOT FOR ACCEPTANCE.
// The why-blocked sentences appear on the Admin page and in Your credentials, one per reason, no em dash.
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html',DEMO='file://'+FIXTURES+'demo_publish.html';
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1',LOCK='skyryse-mes-lockout-v1';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ctx=await b.newContext({viewport:{width:1440,height:900}});
const p=await ctx.newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);
const future=(y=2)=>new Date(Date.now()+y*365*86400000).toISOString().slice(0,10);
const as=async u=>{await run(([S,u])=>{const d=document.getElementById('dialog');if(d&&d.open)d.close();sessionStorage.setItem(S,u);window.dispatchEvent(new Event('sk-auth'));},[SESSION,u]);await p.waitForTimeout(250);};
const toast=()=>run(()=>document.querySelector('#toast p')?.textContent||'');
const clearToast=()=>run(()=>{const t=document.querySelector('#toast p');if(t)t.textContent='';});
const EM=/—/;
// The report opens in a new window through printRecord; read that window's document.
const printReport=async page=>{const [w]=await Promise.all([page.context().waitForEvent('page',{timeout:8000}),page.evaluate(()=>{const x=document.querySelector('[data-action="access-report"]');x.click();})]);await w.waitForLoadState();const html=await w.content();await w.close();return html;};

await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jo Doe');f.requestSubmit();});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role,extra)=>{if(!a.users.some(u=>u.username===username))a.users.push(Object.assign({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'},extra||{}));};
  add('pqm','Parker Manager','qm');add('qsup','Quinn Supervisor','qs');add('kqe','Kai Quality','qe');add('ttech','Toni Tech','technician',{supportAccess:true});
  add('xtra','Xan Extra','technician',{extraRoles:['qe'],roleTraining:{qe:{code:'FOD',at:new Date().toISOString(),by:'pqm'}}});
  add('tamp','Tam Tampered','qe');add('selfg','Sol Self','qe');add('paus','Pau Paused','qe');
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// ---------------- fixture accounts, one per status ----------------
await as('jdoe');
const setup=await run(([f])=>{const out={};
  const k=MES.issueStamp(state,{name:'Kai Quality',buyoffType:'Quality',account:'kqe',expires:f});out.k=k;
  const ks=state.stamps.find(s=>s.number===k.number);out.kExp=MES.updateStamp(state,ks.id,{expires:'2026-01-01'});
  const t=MES.issueStamp(state,{name:'Tam Tampered',buyoffType:'Quality',account:'tamp',expires:f});out.t=t;
  const ts=state.stamps.find(s=>s.number===t.number);out.tSus=MES.updateStamp(state,ts.id,{status:'Suspended'});
  const q=MES.issueStamp(state,{name:'Pau Paused',buyoffType:'Quality',account:'paus',expires:f});out.q=q;
  out.saved=save();return {out,kNumber:k.number,tNumber:t.number,qNumber:q.number};},[future()]);
ok('setup: stamps issued (kqe expired, tamp suspended, paus in force)',setup.out.k.ok&&setup.out.kExp.ok&&setup.out.t.ok&&setup.out.tSus.ok&&setup.out.q.ok,JSON.stringify(setup));
// Grant records written the way setGrant writes them: one valid but citing training the person lacks, one
// self-made, one whose hash no longer matches.
await run(([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const at=new Date().toISOString();
  const grant=(username,cap,byAccount,byName,code,tamper)=>{const by={name:byName,credentialId:'ACCT-'+byAccount,account:byAccount};const reason='Qualified for this authority per QP-7.2.';const rec={account:username,authority:cap,action:'granted',by,at,reason,trainingCode:code};const u=a.users.find(x=>x.username===username);u.grants=u.grants||{};u.grants[cap]={by,at,reason,trainingCode:code,hash:tamper?'a'.repeat(64):MES.sha256(MES.canonical(rec))};};
  grant('paus','conformity','pqm','Parker Manager','TORQUE',false);
  grant('selfg','aqi-sign','selfg','Sol Self','ESD',false);
  grant('tamp','conformity','pqm','Parker Manager','ESD',true);
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);
await run(([LOCK])=>{localStorage.setItem(LOCK,JSON.stringify({ttech:{fails:0,until:Date.now()+3*60000-5000},kqe:{fails:2,until:0}}));},[LOCK]);

// ---------------- who may open it ----------------
for (const user of ['qsup','ttech']) {
  await as(user);
  const r=await run(()=>skAuth.accessReport());
  ok(`${user}: the report is refused with a plain message`,r.ok===false&&r.message==='Only a QA Manager or Master Access account opens the access review report. Ask one of them for a copy.'&&!('accounts' in r),JSON.stringify(r));
  await run(()=>{view='admin';render();});
  ok(`${user}: no Access review report button on the Admin page`,await run(()=>!document.querySelector('[data-action="access-report"]')));
  await clearToast();
  const opened=[];const onPage=pg=>opened.push(pg);ctx.on('page',onPage);
  await run(()=>{const x=document.createElement('button');x.dataset.action='access-report';document.body.appendChild(x);x.click();x.remove();});
  await p.waitForTimeout(400);ctx.off('page',onPage);
  ok(`${user}: a forged report action opens nothing and says why`,opened.length===0&&/Only a QA Manager or Master Access account opens the access review report/.test(await toast()),await toast());
  // A Quality Supervisor manages accounts and sees the Accounts table, so it sees the reasons there too;
  // an ordinary account sees only its own.
  const others=(await run(()=>skAuth.blockedReasons('kqe'))).length;
  ok(user==='qsup'?'qsup: a Quality Supervisor, who manages accounts, reads the reasons for other accounts':'ttech: the reasons for other accounts are not handed out',user==='qsup'?others>0:others===0,String(others));
}

// ---------------- the report for a QA Manager ----------------
await as('pqm');
const before=await run(([AUTH])=>({state:JSON.stringify(state),auth:localStorage.getItem(AUTH)}),[AUTH]);
const rep=await run(()=>skAuth.accessReport());
ok('pqm: the report builds',rep.ok===true,JSON.stringify(rep).slice(0,300));
const acc=Object.fromEntries((rep.accounts||[]).map(a=>[a.username,a]));
ok('every account is listed once',JSON.stringify(Object.keys(acc).sort())===JSON.stringify(['jdoe','kqe','paus','pqm','qsup','selfg','tamp','ttech','xtra']),JSON.stringify(Object.keys(acc)));
ok('generated time, by and build id are on the report',Number.isFinite(Date.parse(rep.generatedAt))&&rep.generatedBy.name==='Parker Manager'&&rep.generatedBy.credentialId==='ACCT-pqm'&&rep.build.version===await run(()=>MES.buildStamp().version)&&!!rep.build.sha256,JSON.stringify({g:rep.generatedBy,b:rep.build}));
const enforced=await run(()=>Object.fromEntries(skAuth.users().map(u=>[u.username,[...u.caps].sort()])));
ok('the effective capabilities are the ones the app enforces, for every account',Object.keys(acc).every(k=>JSON.stringify([...acc[k].capabilities].sort())===JSON.stringify(enforced[k])),JSON.stringify(Object.keys(acc).filter(k=>JSON.stringify([...acc[k].capabilities].sort())!==JSON.stringify(enforced[k]))));
ok('primary roles read in words',acc.pqm.primaryRole==='QA Manager'&&acc.xtra.primaryRole==='Technician'&&acc.jdoe.primaryRole==='Master Access',JSON.stringify([acc.pqm.primaryRole,acc.xtra.primaryRole,acc.jdoe.primaryRole]));
ok('a paused extra role is marked Paused with its reason',JSON.stringify(acc.xtra.extraRoles)===JSON.stringify([{role:'Quality',status:'Paused',reason:'FOD training is not on record'}])&&!acc.xtra.capabilities.includes('approve-nc'),JSON.stringify(acc.xtra.extraRoles));
const auth=(u,name)=>acc[u].authorities.find(x=>x.authority===name);
ok('a grant citing training the person lacks is Paused with the reason',JSON.stringify(auth('paus','Conformity inspection'))===JSON.stringify({authority:'Conformity inspection',status:'Paused',reason:'TORQUE training is not on record'})&&!acc.paus.capabilities.includes('conformity'),JSON.stringify(auth('paus','Conformity inspection')));
ok('a self-made grant is shown as not active',auth('selfg','AQI signature').status==='Not active'&&/does not verify/.test(auth('selfg','AQI signature').reason)&&!acc.selfg.capabilities.includes('aqi-sign'),JSON.stringify(auth('selfg','AQI signature')));
ok('a tampered grant is shown as not active',auth('tamp','Conformity inspection').status==='Not active'&&!acc.tamp.capabilities.includes('conformity'),JSON.stringify(auth('tamp','Conformity inspection')));
ok('no grant reads Not granted',JSON.stringify(auth('kqe','AQI signature'))===JSON.stringify({authority:'AQI signature',status:'Not granted',reason:''}),JSON.stringify(auth('kqe','AQI signature')));
const st=(u,n)=>acc[u].stamps.find(s=>s.number===n);
ok('an expired stamp: type, status, dates and not valid now',(s=>s&&s.buyoffType==='Quality'&&s.status==='Active'&&s.expires==='2026-01-01'&&/^\d{4}-\d{2}-\d{2}$/.test(s.issued)&&s.valid===false&&s.reason==='expired on Jan 1, 2026')(st('kqe',setup.kNumber)),JSON.stringify(st('kqe',setup.kNumber)));
ok('a suspended stamp is not valid now',(s=>s&&s.status==='Suspended'&&s.valid===false&&s.reason==='is suspended')(st('tamp',setup.tNumber)),JSON.stringify(st('tamp',setup.tNumber)));
ok('a stamp in force with no PIN yet says it cannot be used for a buy-off until the holder sets it',(s=>s&&s.valid===true&&s.pinSet===false&&s.reason==='has no PIN yet, so it cannot be used for a buy-off until the holder sets it in Your credentials')(st('paus',setup.qNumber)),JSON.stringify(st('paus',setup.qNumber)));
ok('a stamp in force with no PIN is not usable, so the account has no buy-off type yet (#677)',(s=>s&&s.usable===false)(st('paus',setup.qNumber))&&JSON.stringify(acc.paus.buyoff)===JSON.stringify({any:false,types:[]}),JSON.stringify({s:st('paus',setup.qNumber),b:acc.paus.buyoff}));
ok('buy-off ability: Master Access needs no stamp, a role without buy-off has none, a technician without a stamp has no type',JSON.stringify(acc.jdoe.buyoff)===JSON.stringify({any:true,types:[]})&&acc.qsup.buyoff===null&&JSON.stringify(acc.ttech.buyoff)===JSON.stringify({any:false,types:[]}),JSON.stringify([acc.jdoe.buyoff,acc.qsup.buyoff,acc.ttech.buyoff]));
ok('a stamp in force is valid now and gives inspection',st('paus',setup.qNumber)?.valid===true&&acc.paus.capabilities.includes('inspect-steps')&&!acc.kqe.capabilities.includes('inspect-steps'),JSON.stringify(st('paus',setup.qNumber)));
ok('Support Access is shown',acc.ttech.supportAccess===true&&acc.kqe.supportAccess===false);
ok('a lockout in force is shown, and failed sign-ins below the limit are not a lockout',acc.ttech.lockout.locked===true&&/^Locked, 3 minutes left$/.test(acc.ttech.lockout.text)&&acc.kqe.lockout.locked===false&&acc.kqe.lockout.text==='Not locked (2 failed sign-ins)'&&acc.pqm.lockout.text==='Not locked',JSON.stringify([acc.ttech.lockout,acc.kqe.lockout]));

// ---------------- why blocked: one plain sentence per reason ----------------
const kNum=setup.kNumber,tNum=setup.tNumber;
// Running operations comes with the role, but each buy-off also needs a stamp in force of the operation's type.
const BUYOFF='Operation buy-off is blocked: no stamp in force is assigned to this account, and each buy-off needs one of the operation\'s buy-off type. Ask the QA Manager to issue and assign one.';
const expect={
  kqe:[`Inspection is paused: Quality stamp ${kNum} expired on Jan 1, 2026. Ask the QA Manager to renew it.`,'Conformity inspection is not granted: a QA Manager grants it to a named person against a current training.','AQI signature is not granted: a QA Manager grants it to a named person against a current training.'],
  tamp:[`Inspection is paused: Quality stamp ${tNum} is suspended. Ask the QA Manager to reinstate it.`,'Conformity inspection is not active: the grant record does not verify (granted to oneself, altered or incomplete), so it does not count. A QA Manager must grant it again.','AQI signature is not granted: a QA Manager grants it to a named person against a current training.'],
  paus:[`Quality buy-off is blocked: stamp ${setup.qNumber} has no PIN yet. The stamp holder sets it in Your credentials.`,'Conformity inspection is paused: TORQUE training is not on record. Record current TORQUE training to resume it.','AQI signature is not granted: a QA Manager grants it to a named person against a current training.'],
  selfg:['Inspection is paused: no Quality stamp is assigned to this account. Ask the QA Manager to issue and assign one.','Conformity inspection is not granted: a QA Manager grants it to a named person against a current training.','AQI signature is not active: the grant record does not verify (granted to oneself, altered or incomplete), so it does not count. A QA Manager must grant it again.'],
  xtra:['Quality role is paused: FOD training is not on record. Record current FOD training to resume it.',BUYOFF],
  ttech:[BUYOFF]
};
for (const [u,want] of Object.entries(expect)) ok(`${u}: the why-blocked sentences`,JSON.stringify(acc[u].blocked)===JSON.stringify(want)&&JSON.stringify(await run(n=>skAuth.blockedReasons(n),u))===JSON.stringify(want),JSON.stringify(acc[u].blocked));
ok('no em dash in any report text',!EM.test(JSON.stringify(rep)));

// ---------------- the Admin page and the production print ----------------
await run(()=>{view='admin';render();});
const panel=await run(()=>{const s=document.querySelector('#admin-panel-accounts .blocked-reasons');return s?{text:s.textContent,accounts:[...s.querySelectorAll('[data-blocked-account]')].map(x=>x.dataset.blockedAccount)}:null;});
ok('Admin, Accounts and roles: blocked or paused permissions per account',panel&&JSON.stringify(panel.accounts.sort())===JSON.stringify(Object.keys(acc).filter(u=>acc[u].blocked.length).sort())&&panel.text.includes(expect.kqe[0])&&panel.text.includes(expect.xtra[0])&&!EM.test(panel.text),JSON.stringify(panel));
ok('pqm: the Access review report button is on the Admin page',await run(()=>!!document.querySelector('.admin-page .page-heading [data-action="access-report"]')));
const html=await printReport(p);
ok('the printed report: title, generated by, time, build id and every account',/Access review: who can do what/.test(html)&&/Parker Manager · ACCT-pqm/.test(html)&&/Generated/.test(html)&&html.includes(rep.build.version)&&/Flight System build/.test(html)&&['jdoe','kqe','paus','pqm','qsup','selfg','tamp','ttech','xtra'].every(u=>html.includes(`data-review-account="${u}"`)),html.slice(0,300));
ok('the printed report shows statuses, stamps, support access, lockout and reasons',/Paused/.test(html)&&/Not active/.test(html)&&/Not granted/.test(html)&&html.includes(kNum)&&/Not valid now/.test(html)&&/In force, no PIN yet/.test(html)&&/Buy-off with:<\/strong> <span class="muted">no stamp in force with its PIN set, so no buy-off/.test(html)&&/Buy-off with:<\/strong> any buy-off type \(Master Access needs no stamp\)/.test(html)&&/Locked, 3 minutes left/.test(html)&&html.includes('Ask the QA Manager to renew it.'),'');
ok('the production print carries no DEMO mark',!/DEMO, NOT FOR ACCEPTANCE/.test(html)&&!/demo-print-mark/.test(html));
ok('no em dash in the printed report',!EM.test(html));
const after=await run(([AUTH])=>({state:JSON.stringify(state),auth:localStorage.getItem(AUTH)}),[AUTH]);
ok('building and printing the report changes neither the workspace nor the accounts',after.state===before.state&&after.auth===before.auth);

// ---------------- Your credentials: one's own reasons ----------------
await as('kqe');
await run(()=>profileDialog());
const own=await run(()=>document.querySelector('#dialog .own-blocked')?.textContent||'');
ok('Your credentials lists the signed-in person\'s own reasons',own.includes('Why some permissions are blocked')&&expect.kqe.every(t=>own.includes(t))&&!EM.test(own),own);
await run(()=>document.getElementById('dialog').close());
// A Technician stamp in force with no PIN still blocks buy-off (the PIN step-up refuses it); once its PIN is set,
// nothing is blocked for ttech.
await as('jdoe');
const tst=await run(([f])=>{const s=MES.issueStamp(state,{name:'Toni Tech',buyoffType:'Technician',account:'ttech',expires:f});const noPin=skAuth.blockedReasons('ttech');
  const p=MES.setStampPin(state,s.id,'4826','4826');save();return {s,noPin,p,why:skAuth.blockedReasons('ttech')};},[future()]);
ok('a stamp in force with no PIN set: buy-off is blocked until the holder sets it',tst.s&&tst.s.ok&&JSON.stringify(tst.noPin)===JSON.stringify([`Technician buy-off is blocked: stamp ${tst.s&&tst.s.number} has no PIN yet. The stamp holder sets it in Your credentials.`]),JSON.stringify(tst));
ok('a stamp in force of any buy-off type, with its PIN set, clears the operation buy-off block',tst.p&&tst.p.ok&&JSON.stringify(tst.why)==='[]',JSON.stringify(tst));
await as('ttech');
await run(()=>profileDialog());
ok('nothing blocked: no reasons block in Your credentials',await run(()=>!document.querySelector('#dialog .own-blocked')));
await run(()=>document.getElementById('dialog').close());

// Two stamps in force, one with a PIN and one without (#679): the one without blocks its own buy-off type, whatever
// PIN the other carries; the report lists only the usable type. Setting the second PIN clears it.
await as('jdoe');
const pair=await run(([f])=>{const code=MES.trainingCatalog(state).find(t=>t.status==='Active').code;const tr=MES.recordTraining(state,{account:'ttech',code,expires:f});const s=MES.issueStamp(state,{name:'Toni Tech',buyoffType:'Quality',account:'ttech',expires:f,trainingCode:code});save();
  return {tr,s,why:skAuth.blockedReasons('ttech')};},[future()]);
const pairRow=async()=>{await as('pqm');const r=await run(()=>skAuth.accessReport());return (r.accounts||[]).find(a=>a.username==='ttech');};
const pr=await pairRow();
ok('a pinned Technician stamp and an unpinned Quality stamp: the Quality buy-off is blocked, the Technician one is not',pair.tr&&pair.tr.ok&&pair.s&&pair.s.ok&&JSON.stringify(pair.why)===JSON.stringify([`Quality buy-off is blocked: stamp ${pair.s.number} has no PIN yet. The stamp holder sets it in Your credentials.`])&&JSON.stringify(pr.blocked)===JSON.stringify(pair.why),JSON.stringify({pair,blocked:pr&&pr.blocked}));
ok('the report lists only the buy-off type that can be used now',JSON.stringify(pr.buyoff)===JSON.stringify({any:false,types:['Technician']})&&pr.stamps.filter(x=>x.usable).map(x=>x.buyoffType).join()==='Technician',JSON.stringify(pr.buyoff));
await as('jdoe');
const pinned=await run(([n])=>{const s=state.stamps.find(x=>x.number===n);const r=MES.setStampPin(state,s.id,'5937','5937');save();return {r,why:skAuth.blockedReasons('ttech')};},[pair.s&&pair.s.number]);
const pr2=await pairRow();
ok('once the second PIN is set nothing is blocked and both buy-off types are listed',pinned.r&&pinned.r.ok&&JSON.stringify(pinned.why)==='[]'&&JSON.stringify(pr2.buyoff)===JSON.stringify({any:false,types:['Technician','Quality']}),JSON.stringify({pinned,b:pr2&&pr2.buyoff}));

// One instant decides every row, also without a server (#674, #646): the clock jumps three years ahead while the
// rows are being built; paus's stamp, which expires in two years, still reads as in force at the report's time.
// The refusal path: a report generated with the clock already three years on reads the same stamp as expired.
await as('pqm');
const jump=await run(async([n])=>{const RealDate=Date,realStamp=MES.hasValidInspectionStamp,skew=3*365*86400000;let shifted=false;
  class Later extends RealDate{constructor(...a){if(a.length)super(...a);else super(RealDate.now()+skew);}static now(){return RealDate.now()+skew;}}
  const read=r=>{const row=(r.accounts||[]).find(a=>a.username==='paus');return {ok:r.ok,generatedAt:r.generatedAt,stamp:row&&row.stamps.find(x=>x.number===n),blocked:row&&row.blocked};};
  const before=RealDate.now();let during,later;
  MES.hasValidInspectionStamp=function(){if(!shifted){shifted=true;window.Date=Later;}return realStamp.apply(this,arguments);};
  try{during=read(await skAuth.accessReport());}finally{window.Date=RealDate;MES.hasValidInspectionStamp=realStamp;}
  window.Date=Later;try{later=read(await skAuth.accessReport());}finally{window.Date=RealDate;}
  return {shifted,before,during,later};},[setup.qNumber]);
ok('a clock that moves on while the rows are built changes no status: each is decided at the report\'s generation time',jump.shifted&&jump.during.ok&&Math.abs(Date.parse(jump.during.generatedAt)-jump.before)<60000&&jump.during.stamp&&jump.during.stamp.valid===true&&JSON.stringify(jump.during.blocked)===JSON.stringify(expect.paus),JSON.stringify(jump));
ok('a report generated three years on reads the same stamp as expired (the instant is what decides)',jump.later.ok&&jump.later.stamp&&jump.later.stamp.valid===false&&/^expired on /.test(jump.later.stamp.reason),JSON.stringify(jump.later));
ok('the page clock is restored after the check',await run(()=>Math.abs(Date.now()-new Date().getTime())<1000&&new Date().getFullYear()<new Date(Date.now()+3*365*86400000).getFullYear()));

// A lockout that ends while the rows are built still reads as in force at the report's time, with the time left counted
// from that instant (#TBD). Refusal path: a report generated ten minutes on reads the same lock as ended.
await as('pqm');
const lock=await run(async([LOCK])=>{const RealDate=Date,realStamp=MES.hasValidInspectionStamp,skew=10*60000;let shifted=false;
  localStorage.setItem(LOCK,JSON.stringify({ttech:{fails:0,until:RealDate.now()+3*60000-5000}}));
  class Later extends RealDate{constructor(...a){if(a.length)super(...a);else super(RealDate.now()+skew);}static now(){return RealDate.now()+skew;}}
  const row=r=>((r.accounts||[]).find(a=>a.username==='ttech')||{}).lockout;
  let during,later;
  MES.hasValidInspectionStamp=function(){if(!shifted){shifted=true;window.Date=Later;}return realStamp.apply(this,arguments);};
  try{during=row(await skAuth.accessReport());}finally{window.Date=RealDate;MES.hasValidInspectionStamp=realStamp;}
  window.Date=Later;try{later=row(await skAuth.accessReport());}finally{window.Date=RealDate;}
  return {shifted,during,later};},[LOCK]);
ok('a lock that ends while the rows are built still reads as in force at the report time, minutes counted from that instant',lock.shifted&&lock.during&&lock.during.locked===true&&lock.during.text==='Locked, 3 minutes left',JSON.stringify(lock));
ok('a report generated after the lock ended reads the account as not locked',lock.later&&lock.later.locked===false&&lock.later.text==='Not locked',JSON.stringify(lock.later));

// The manager gate is decided at the report's time too: QA Manager held only as a training-backed extra role opens the
// report, also when the clock moves on between the gate and the rows; a report generated after the training lapses is refused.
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  if(!a.users.some(u=>u.username==='xqm'))a.users.push({username:'xqm',displayName:'Xi Extra QM',salt,hash,role:'technician',createdAt:new Date().toISOString(),createdBy:'jdoe',extraRoles:['qm'],roleTraining:{qm:{code:MES.trainingCatalog(state).find(t=>t.status==='Active').code,at:new Date().toISOString(),by:'jdoe'}}});
  localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);
await as('jdoe');
const xt=await run(([f])=>{const code=MES.trainingCatalog(state).find(t=>t.status==='Active').code;const r=MES.recordTraining(state,{account:'xqm',code,expires:f});save();return r;},[future()]);
ok('setup: current training recorded for the extra QA Manager role',xt&&xt.ok,JSON.stringify(xt));
await as('xqm');
const gate=await run(async()=>{const RealDate=Date,realTr=MES.trainingCurrentFor,skew=3*365*86400000;let shifted=false;
  class Later extends RealDate{constructor(...a){if(a.length)super(...a);else super(RealDate.now()+skew);}static now(){return RealDate.now()+skew;}}
  const start=RealDate.now(),normal=await skAuth.accessReport();let during,later;
  MES.trainingCurrentFor=function(){if(!shifted){shifted=true;window.Date=Later;}return realTr.apply(this,arguments);};
  try{during=await skAuth.accessReport();}finally{window.Date=RealDate;MES.trainingCurrentFor=realTr;}
  window.Date=Later;try{later=await skAuth.accessReport();}finally{window.Date=RealDate;}
  return {shifted,start,normal:{ok:normal.ok},during:{ok:during.ok,generatedAt:during.generatedAt,message:during.message},later:{ok:later.ok,message:later.message,accounts:later.accounts}};});
ok('a QA Manager role held by current training opens the report',gate.normal.ok===true,JSON.stringify(gate.normal));
ok('the gate is decided at the report time: a clock that moves on after that instant does not refuse it, and the report keeps its time',gate.shifted&&gate.during.ok===true&&Math.abs(Date.parse(gate.during.generatedAt)-gate.start)<60000,JSON.stringify(gate.during));
ok('a report generated after the training lapsed is refused with the plain message and lists no account',gate.later.ok===false&&gate.later.message==='Only a QA Manager or Master Access account opens the access review report. Ask one of them for a copy.'&&!gate.later.accounts,JSON.stringify(gate.later));

// Two invalid Quality stamps with different problems: each one is named with its own remedy.
await as('jdoe');
const two=await run(([f])=>{const s=MES.issueStamp(state,{name:'Tam Tampered',buyoffType:'Quality',account:'tamp',expires:f});if(!s.ok)return {s};
  const r=MES.updateStamp(state,state.stamps.find(x=>x.number===s.number).id,{expires:'2026-01-01'});save();return {s,r,number:s.number,why:skAuth.blockedReasons('tamp')[0]};},[future()]);
ok('two invalid stamps: every stamp is named with its own remedy',two.s&&two.s.ok&&two.r&&two.r.ok&&two.why===`Inspection is paused: Quality stamp ${setup.tNumber} is suspended. Ask the QA Manager to reinstate it. Quality stamp ${two.number} expired on Jan 1, 2026. Ask the QA Manager to renew it.`&&!EM.test(two.why||''),JSON.stringify(two));
ok('state valid at the end',await run(()=>MES.validate(state)));

// ---------------- the demo print is marked ----------------
const d=await ctx.newPage();d.on('pageerror',e=>errs.push('demo: '+e.message));
await d.goto(DEMO);
await d.locator('input[name=username]').fill('demo');await d.locator('input[name=password]').fill('demo1234');await d.locator('input[name=password]').press('Enter');
await d.waitForFunction(()=>typeof view!=='undefined'&&!document.getElementById('sk-boot'),null,{timeout:15000});await d.waitForTimeout(800);
if(!await d.evaluate(()=>skAuth.canReviewAccess())){await d.evaluate(S=>{sessionStorage.setItem(S,'master');window.dispatchEvent(new Event('sk-auth'));},SESSION);await d.waitForTimeout(300);}
ok('demo: a manager account can open the report',await d.evaluate(()=>skAuth.canReviewAccess()));
// The demo engine buys off with a demo stamp (no type, no PIN), so the demo report must not list the production stamp
// blockers: accounts with no usable stamp still read as able to buy off, and a role without buy-off still reads as none (#TBD).
const demoRep=await d.evaluate(()=>skAuth.accessReport());
const demoAcc=demoRep.accounts||[];
const demoOps=demoAcc.filter(a=>a.capabilities.includes('operate-steps')||a.capabilities.includes('inspect-steps'));
ok('demo: every account that can buy off reads as able to buy off any type, though none has a usable stamp',demoRep.ok&&demoOps.length>0&&demoOps.every(a=>a.buyoff&&a.buyoff.any===true&&a.buyoff.demo===true&&!a.stamps.some(s=>s.usable)),JSON.stringify(demoOps.map(a=>[a.username,a.buyoff])));
ok('demo: no stamp or PIN buy-off blocker is listed',demoAcc.every(a=>!a.blocked.some(x=>/buy-off is blocked/.test(x))),JSON.stringify(demoAcc.map(a=>a.blocked)));
ok('demo: an account whose role has no buy-off still reads as none',demoAcc.filter(a=>!a.capabilities.includes('operate-steps')&&!a.capabilities.includes('inspect-steps')).every(a=>a.buyoff===null),JSON.stringify(demoAcc.map(a=>[a.username,a.buyoff])));
await d.evaluate(()=>{view='admin';render();});
const demoHtml=await printReport(d);
ok('the demo print carries DEMO, NOT FOR ACCEPTANCE',/DEMO, NOT FOR ACCEPTANCE/.test(demoHtml)&&/Access review: who can do what/.test(demoHtml));
ok('the demo print says buy-off uses a demo stamp, not the production stamp gate',/the demo build buys off with a demo stamp, with no type or PIN check/.test(demoHtml)&&!/no stamp in force with its PIN set, so no buy-off/.test(demoHtml));
await d.close();

ok('no page errors',errs.length===0,JSON.stringify(errs));
await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
