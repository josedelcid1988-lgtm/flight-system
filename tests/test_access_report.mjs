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
  paus:[`Operation buy-off is blocked: stamp ${setup.qNumber} has no PIN yet. The stamp holder sets it in Your credentials.`,'Conformity inspection is paused: TORQUE training is not on record. Record current TORQUE training to resume it.','AQI signature is not granted: a QA Manager grants it to a named person against a current training.'],
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
ok('the printed report shows statuses, stamps, support access, lockout and reasons',/Paused/.test(html)&&/Not active/.test(html)&&/Not granted/.test(html)&&html.includes(kNum)&&/Not valid now/.test(html)&&/Valid now/.test(html)&&/Locked, 3 minutes left/.test(html)&&html.includes('Ask the QA Manager to renew it.'),'');
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
ok('a stamp in force with no PIN set: buy-off is blocked until the holder sets it',tst.s&&tst.s.ok&&JSON.stringify(tst.noPin)===JSON.stringify([`Operation buy-off is blocked: stamp ${tst.s&&tst.s.number} has no PIN yet. The stamp holder sets it in Your credentials.`]),JSON.stringify(tst));
ok('a stamp in force of any buy-off type, with its PIN set, clears the operation buy-off block',tst.p&&tst.p.ok&&JSON.stringify(tst.why)==='[]',JSON.stringify(tst));
await as('ttech');
await run(()=>profileDialog());
ok('nothing blocked: no reasons block in Your credentials',await run(()=>!document.querySelector('#dialog .own-blocked')));
await run(()=>document.getElementById('dialog').close());

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
await d.evaluate(()=>{view='admin';render();});
const demoHtml=await printReport(d);
ok('the demo print carries DEMO, NOT FOR ACCEPTANCE',/DEMO, NOT FOR ACCEPTANCE/.test(demoHtml)&&/Access review: who can do what/.test(demoHtml));
await d.close();

ok('no page errors',errs.length===0,JSON.stringify(errs));
await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
