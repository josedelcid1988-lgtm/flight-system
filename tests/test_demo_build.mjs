// Item 4: the demo is built from index.html by tools/build-demo.mjs and nothing else.
// Checks the build is current, every deviation applies exactly, the refusal paths of --check,
// the pilot seats keeping their real role, DEMO, NOT FOR ACCEPTANCE on pages and prints, and the demo's
// separate account and mirror storage (it never seeds production accounts or reaches a production mirror).
import {chromium} from 'playwright';
import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const ROOT=path.resolve(TESTS,'..');
const {buildDemo,demoLiteralLines,deviationsDoc,OUTPUTS,PRODUCTION_FIXTURE}=await import(path.join(ROOT,'tools/build-demo.mjs'));
const {DEVIATIONS,PILOT_SEATS}=await import(path.join(ROOT,'tools/demo/deviations.mjs'));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const prod=read('index.html');

// ---- build chain ----
const check=spawnSync(process.execPath,[path.join(ROOT,'tools/build-demo.mjs'),'--check'],{encoding:'utf8'});
ok('build-demo --check passes on the committed files',check.status===0,check.stderr+check.stdout);
ok('deviation ids are D-1 to D-n in order',DEVIATIONS.every((d,i)=>d.id===`D-${i+1}`),DEVIATIONS.map(d=>d.id).join(','));
ok('every deviation says what it does and why',DEVIATIONS.every(d=>d.title&&d.why&&d.area&&Number.isInteger(d.count)&&d.count>0));
const curated=buildDemo(prod,'curated'),qa150=buildDemo(prod,'qa150');
for(const o of OUTPUTS){let expected=o.dataset==='curated'?curated:qa150;if(o.file.startsWith('tests/fixtures/'))expected=expected.replace(/((?:src|href)=")assets\//g,'$1../../assets/');ok(`${o.file} rebuilds byte for byte from index.html`,read(o.file)===expected);}
ok(`${PRODUCTION_FIXTURE} is the browser-ready copy of index.html`,read(PRODUCTION_FIXTURE)===prod.replace(/((?:src|href)=")assets\//g,'$1../../assets/'));
ok('docs/DEMO_DEVIATIONS.md is generated from the deviation list',read('docs/DEMO_DEVIATIONS.md')===deviationsDoc());
ok('the document lists every deviation',DEVIATIONS.every(d=>read('docs/DEMO_DEVIATIONS.md').includes(`| ${d.id} |`)));
const unmarked=DEVIATIONS.filter(d=>!new RegExp(`DEMO ${d.id}\\b`).test(curated)).map(d=>d.id);
ok('every deviation that can carry a marker does (only the title and the limit message cannot)',unmarked.length===2&&unmarked.every(id=>['Page title reads Flight System Demo','Work order limit message says 250'].includes(DEVIATIONS.find(d=>d.id===id).title)),unmarked.join(','));

// ---- refusal paths of the check ----
{const target=DEVIATIONS.find(d=>typeof d.find==='string'&&d.count===1&&d.find.length>20);let msg='';try{buildDemo(prod.replace(target.find,''),'curated');}catch(e){msg=e.message;}
ok('a missing replacement target stops the build and names the deviation',msg.startsWith(target.id)&&/found 0/.test(msg),msg);}
{const d=DEVIATIONS.find(x=>x.find instanceof RegExp&&x.count>1);let msg='';const m=prod.match(new RegExp(d.find.source,d.find.flags.replace('g','')))[0];try{buildDemo(prod+'\n<!-- '+m+' -->','curated');}catch(e){msg=e.message;}
ok('a target that matches more times than expected stops the build',msg.startsWith(d.id)&&/expected/.test(msg),msg);}
ok('the production engine compares no username to demo',demoLiteralLines(prod).length===0,JSON.stringify(demoLiteralLines(prod)));
ok('a username comparison against demo in production is caught',demoLiteralLines(prod.replace('const MAX_ORDERS = 100;',"const MAX_ORDERS = 100; if (u.username === 'demo') {}")).length===1);
{const tmp=fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR||'/tmp'),'fs-demo-'));
 // A copy of the repository pieces the build reads, with a stale demo.html, must fail --check.
 for(const p of ['index.html','tools/build-demo.mjs','tools/demo/deviations.mjs','tools/demo/overlay.js','tools/demo/seed-dates.mjs','tools/demo/accounts.json','tools/demo/seed-curated.json','tools/demo/seed-qa150.json','docs/DEMO_DEVIATIONS.md',...OUTPUTS.map(o=>o.file),PRODUCTION_FIXTURE]){fs.mkdirSync(path.dirname(path.join(tmp,p)),{recursive:true});fs.copyFileSync(path.join(ROOT,p),path.join(tmp,p));}
 fs.appendFileSync(path.join(tmp,'demo.html'),'\n');
 const stale=spawnSync(process.execPath,[path.join(tmp,'tools/build-demo.mjs'),'--check'],{encoding:'utf8'});
 ok('a demo.html that does not rebuild byte for byte fails --check',stale.status===1&&/demo\.html is not current/.test(stale.stderr),stale.stderr);
 fs.rmSync(tmp,{recursive:true,force:true});}

// ---- both product fixes reach the demo ----
ok('demo carries the stamp prompt submit fix',curated.includes('credential&&credential.ok&&credential.override'));
ok('demo NC review shows the approval form to the disposition author',curated.includes('if(true/* DEMO '));
ok('production keeps the NC review hand-off',prod.includes('if(t.dispo?.credentialId!==skActorId())return ticketQualityReviewForm(o,t);'));

// ---- the demo never reaches a production mirror ----
{const url='https://mes-mirror.example',token='prod-mirror-token-'+'x'.repeat(24);
 const fallback=prod.replace(/(window\.SK_MIRROR = window\.SK_MIRROR \|\| \{\n  url: )''/,`$1'${url}'`).replace(/(\n  token: )''/,`$1'${token}'`);
 const direct=prod.replace(/window\.SK_MIRROR = [^;{]*\{[\s\S]*?\};/,`window.SK_MIRROR = { url: '${url}', token: '${token}', batchSize: 50 };`);
 for(const [form,src] of [['the fallback object',fallback],['a direct assignment (the form server/mirror/README.md documents)',direct]]){
  ok(`the refusal case is real: the production file can carry a mirror address and token as ${form}`,src.includes(url)&&src.includes(token));
  let built='',msg='';try{built=buildDemo(src,'curated');}catch(e){msg=e.message;}
  ok(`a mirror address and token set in index.html as ${form} are not carried into the demo`,!msg&&!built.includes(url)&&!built.includes(token)&&built.includes("window.SK_MIRROR = window.__demoMirrorPreset || { url: '', token: '', batchSize: 50 };"),msg);}
 ok('the demo takes a mirror only from the suite runner\'s own setting, recorded before any of the file runs',curated.indexOf('window.__demoMirrorPreset=window.__FS_SUITE_DEMO_MIRROR__||null;')>0&&curated.indexOf('window.__demoMirrorPreset=window.__FS_SUITE_DEMO_MIRROR__||null;')<curated.indexOf('<script id="sk-mirror">'));
 ok('the demo keeps its mirror queue under separate keys',!/['"]skyryse-mes-sync-(queue|sent|client)-v1['"]/.test(curated)&&/'skyryse-mes-demo-sync-queue-v1'/.test(curated));
 ok('production keeps its frozen mirror queue keys',/'skyryse-mes-sync-queue-v1'/.test(prod));}
ok('the demo reads and writes accounts only under skyryse-mes-demo-auth-v1',!/['"]skyryse-mes-auth-v1['"]/.test(curated)&&(curated.match(/['"]skyryse-mes-demo-auth-v1['"]/g)||[]).length===5);
{const shared=['session','lockout','security','oidc','server-token','drafts','evidence'];
 ok('the demo keeps its session, lockout, security log, sign-in tokens, drafts and evidence under demo keys',shared.every(k=>!new RegExp(`['"]skyryse-mes-${k}-v1['"]`).test(curated)&&new RegExp(`['"]skyryse-mes-demo-${k}-v1['"]`).test(curated)),shared.filter(k=>new RegExp(`['"]skyryse-mes-${k}-v1['"]`).test(curated)).join(','));
 ok('production keeps those keys unchanged',shared.every(k=>new RegExp(`['"]skyryse-mes-${k}-v1['"]`).test(prod)));}

// ---- in the browser ----
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const errs=[];
async function open(file,user){const ctx=await b.newContext({viewport:{width:1440,height:1000}});if(user)await ctx.addInitScript(([u,sess])=>{sessionStorage.setItem(sess,u);sessionStorage.setItem('sk-boot-seen','1');sessionStorage.setItem('sk-mnv-landing-seen','1');},[user,/demo/.test(path.basename(file))?'skyryse-mes-demo-session-v1':'skyryse-mes-session-v1']);const p=await ctx.newPage();p.on('pageerror',e=>errs.push(file+': '+e.message));await p.goto('file://'+path.join(ROOT,file));await p.waitForTimeout(1500);return {p,ctx};}
const REAL={tech:['operate-steps'],operations:['operate','operate-steps'],mfgeng:['edit-wi','create-wo','dispo-nc'],quality:['approve-wo','approve-nc'],engineering:['push-software']};
const NOT={tech:['create-wo','approve-wo','edit-wi','dispo-nc','manage-access'],operations:['create-wo','approve-wo','edit-wi','approve-nc'],mfgeng:['approve-wo','approve-wi','approve-nc'],quality:['edit-wi','create-wo','dispo-nc','operate'],engineering:['edit-wi','approve-nc','operate','create-wo']};
for(const seat of PILOT_SEATS){const {p,ctx}=await open('tests/fixtures/demo_publish.html',seat);
  const r=await p.evaluate(([has,not])=>({role:skAuth.role(),has:has.filter(c=>!skAuth.can(c)),not:not.filter(c=>skAuth.can(c))}),[REAL[seat],NOT[seat]]);
  ok(`pilot seat ${seat} keeps its real role`,r.has.length===0&&r.not.length===0,JSON.stringify(r));await ctx.close();}
for(const user of ['demo','safety','certification']){const {p,ctx}=await open('tests/fixtures/demo_publish.html',user);
  const r=await p.evaluate(()=>({all:['create-wo','approve-wo','edit-wi','dispo-nc','approve-nc','manage-access','safety-buyoff','mrb-cert'].every(c=>skAuth.can(c)),seats:FlightManeuver.seatsForRole(skAuth.role()).length}));
  ok(`${user} (not a pilot seat) has full access and every MRB seat`,r.all&&r.seats===4,JSON.stringify(r));await ctx.close();}
{const {p,ctx}=await open('demo.html','demo');
 const banner=await p.evaluate(()=>{const e=document.querySelector('.demo-banner');return e?{text:e.textContent,visible:e.getBoundingClientRect().height>0&&getComputedStyle(e).display!=='none'}:null;});
 ok('demo page shows DEMO, NOT FOR ACCEPTANCE',!!banner&&banner.text==='DEMO, NOT FOR ACCEPTANCE'&&banner.visible,JSON.stringify(banner));
 ok('demo tab title says Demo on every view',/^Flight System Demo/.test(await p.title()),await p.title());
 const prints=await p.evaluate(async()=>{const got=[];const make=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{if(b&&b.type==='text/html')got.push(b);return make(b);};const wins=[];window.open=()=>{const d={html:'',open(){},write(h){this.html+=h;},close(){},querySelector(){return null;}};wins.push(d);return {opener:1,document:d,focus(){},print(){}};};
   const o=state.orders[0];printTraveler(o.id,true);
   const car=state.maneuver.cars[0];if(car){const x=document.createElement('button');x.setAttribute('data-action','mnv-open-car');x.setAttribute('data-car',car.id);document.body.appendChild(x);x.click();x.remove();await new Promise(r=>setTimeout(r,300));document.querySelector(`[data-action="mnv-print"][data-kind="cars"]`)?.click();}
   const texts=[...wins.map(w=>w.html),...await Promise.all(got.map(b=>b.text()))].filter(t=>t.length);return {n:texts.length,marked:texts.filter(t=>t.includes('DEMO, NOT FOR ACCEPTANCE')).length,download:markDocument('<html><body><p>x</p></body></html>').includes('DEMO, NOT FOR ACCEPTANCE')};});
 ok('every demo print and download carries DEMO, NOT FOR ACCEPTANCE',prints.n>=2&&prints.marked===prints.n&&prints.download,JSON.stringify(prints));
 await ctx.close();}
{const {p,ctx}=await open('tests/fixtures/publish.html',null);
 const r=await p.evaluate(()=>({banner:!!document.querySelector('.demo-banner'),mark:markDocument('<html><body><p>x</p></body></html>'),title:document.title}));
 ok('production shows no demo banner and prints carry the build line but no demo mark',!r.banner&&!/NOT FOR ACCEPTANCE/.test(r.mark)&&/^<html><body><p>x<\/p><div class="fs-build-line"/.test(r.mark)&&/^Flight System(?! Demo)/.test(r.title),JSON.stringify(r));await ctx.close();}
// Demo and production opened in the same browser: the demo's known-password accounts stay out of the production
// account list, so master / demo1234 never signs in to the production page.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 await p.goto('file://'+FIXTURES+'demo_publish.html');await p.waitForFunction(()=>!!localStorage.getItem('skyryse-mes-demo-auth-v1'));
 const demoSide=await p.evaluate(()=>({demo:JSON.parse(localStorage.getItem('skyryse-mes-demo-auth-v1')).users.map(u=>u.username),prod:localStorage.getItem('skyryse-mes-auth-v1')}));
 ok('opening the demo loads its accounts under the demo key and writes nothing under the production key',demoSide.demo.includes('master')&&demoSide.prod===null,JSON.stringify(demoSide));
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(900);
 const prodSide=await p.evaluate(()=>({prod:JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')||'{"users":[]}').users.map(u=>u.username),setup:!!document.querySelector('#sk-boot')}));
 ok('the production page in the same browser holds no demo account after the demo was opened',!prodSide.prod.includes('master')&&!prodSide.prod.includes('demo')&&prodSide.setup,JSON.stringify(prodSide));
 await ctx.close();}
// Signed in to the demo as master, then the same tab opens production, where a real account is also called master:
// production does not take the demo session, its lockout counter is untouched and the demo sign-in is not in its security log.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(600);
 await p.evaluate(()=>{localStorage.setItem('skyryse-mes-auth-v1',JSON.stringify({users:[{username:'master',displayName:'Production Master',salt:'00',hash:'f'.repeat(64),role:'admin',createdAt:new Date().toISOString()}]}));localStorage.setItem('skyryse-mes-lockout-v1',JSON.stringify({master:{fails:2,until:0}}));localStorage.removeItem('skyryse-mes-security-v1');});
 await p.goto('file://'+FIXTURES+'demo_publish.html');await p.waitForFunction(()=>!!document.querySelector('#sk-boot input[name=username]'));
 await p.locator('#sk-boot input[name=username]').fill('master');await p.locator('#sk-boot input[name=password]').fill('demo1234');
 await p.locator('#sk-boot form').evaluate(f=>f.requestSubmit());await p.waitForFunction(()=>!document.getElementById('sk-boot'),null,{timeout:20000});
 const demoIn=await p.evaluate(()=>({user:skAuth.user()&&skAuth.user().username,demoSession:sessionStorage.getItem('skyryse-mes-demo-session-v1'),prodSession:sessionStorage.getItem('skyryse-mes-session-v1'),prodSec:localStorage.getItem('skyryse-mes-security-v1'),demoSec:(localStorage.getItem('skyryse-mes-demo-security-v1')||'').length}));
 ok('signing in to the demo as master keeps the session and sign-in record under demo keys',demoIn.user==='master'&&demoIn.demoSession==='master'&&demoIn.prodSession===null&&demoIn.prodSec===null&&demoIn.demoSec>0,JSON.stringify(demoIn));
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(900);
 const prodIn=await p.evaluate(()=>({user:skAuth.user()&&skAuth.user().username,gate:!!document.querySelector('#sk-boot'),lock:JSON.parse(localStorage.getItem('skyryse-mes-lockout-v1')||'{}'),sec:localStorage.getItem('skyryse-mes-security-v1')}));
 ok('the same tab then opens production signed out, though production has its own master account',prodIn.user===null&&prodIn.gate,JSON.stringify(prodIn));
 ok('the demo sign-in neither cleared the production lockout counter nor wrote to the production security log',!!prodIn.lock.master&&prodIn.lock.master.fails===2&&!(prodIn.sec||'').includes('master'),JSON.stringify(prodIn));
 await ctx.close();}
// Leftovers from demo builds before the queue, session and evidence keys were split.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(600);
 await p.evaluate(()=>{localStorage.setItem('skyryse-mes-sync-queue-v1',JSON.stringify([{clientWriteId:'old-demo-1',storeKey:'skyryse-mes-work-order-qa100-v1',entityType:'order',entityId:'WO-1'},{clientWriteId:'prod-1',storeKey:'skyryse-mes-work-order-v1',entityType:'order',entityId:'WO-2'}]));sessionStorage.setItem('skyryse-mes-server-token-v1','production-server-session');});
 // An old demo recording in the shared evidence database, named by a demo record.
 await p.evaluate(()=>new Promise((ok,no)=>{const r=indexedDB.open('skyryse-mes-evidence-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('recordings');r.onerror=()=>no(r.error);r.onsuccess=()=>{const d=r.result;const t=d.transaction('recordings','readwrite');t.objectStore('recordings').put(new Blob([new Uint8Array(2048)],{type:'video/webm'}),'EV-olddemo-1');t.oncomplete=()=>{d.close();ok();};t.onerror=()=>no(t.error);};}));
 await p.goto('file://'+FIXTURES+'demo_publish.html');await p.waitForFunction(()=>!!document.querySelector('#sk-boot input[name=username]'));
 const q=await p.evaluate(()=>JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')).map(r=>r.clientWriteId));
 ok('opening the demo drops queued records that name the demo workspace and keeps production ones',JSON.stringify(q)==='["prod-1"]',JSON.stringify(q));
 await p.locator('#sk-boot input[name=username]').fill('master');await p.locator('#sk-boot input[name=password]').fill('demo1234');
 await p.locator('#sk-boot form').evaluate(f=>f.requestSubmit());await p.waitForFunction(()=>!document.getElementById('sk-boot'),null,{timeout:20000});
 const ev=await p.evaluate(async()=>{const a=await MESMedia.get('EV-olddemo-1');const none=await MESMedia.get('EV-notthere-1');const copied=await new Promise(done=>{const r=indexedDB.open('skyryse-mes-demo-evidence-v1');r.onsuccess=()=>{const d=r.result;if(!d.objectStoreNames.contains('recordings')){d.close();done(false);return;}const g=d.transaction('recordings','readonly').objectStore('recordings').get('EV-olddemo-1');g.onsuccess=()=>{d.close();done(g.result instanceof Blob&&g.result.size===2048);};};r.onerror=()=>done(false);});return {size:a&&a.size,none,copied};});
 ok('a recording an earlier demo record names is read from the old evidence store and copied into the demo store; an unknown one is still missing',ev.size===2048&&ev.none===null&&ev.copied===true,JSON.stringify(ev));
 await p.evaluate(()=>window.skSignOut('user'));await p.waitForTimeout(400);
 const tok=await p.evaluate(()=>sessionStorage.getItem('skyryse-mes-server-token-v1'));
 ok('signing out of the demo leaves the production server session token in place',tok==='production-server-session',String(tok));
 await ctx.close();}
// A browser that opened an older demo build, then opens production first: production removes the demo's
// known-password accounts and its queued workspace records once, keeps its own, and records that it did.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 const demoUsers=JSON.parse(fs.readFileSync(path.join(ROOT,'tools/demo/accounts.json'),'utf8')).users;
 await ctx.addInitScript(users=>{if(sessionStorage.getItem('seeded'))return;sessionStorage.setItem('seeded','1');
  // qa.boss was added in the older demo by its master with a chosen password and Master Access; tech.two by qa.boss.
  localStorage.setItem('skyryse-mes-auth-v1',JSON.stringify({users:[{username:'mlee',displayName:'Morgan Lee',salt:'00',hash:'f'.repeat(64),role:'qm',createdAt:'2026-09-01T00:00:00.000Z',createdBy:'mlee'},{username:'ops1',displayName:'Ops One',salt:'00',hash:'f'.repeat(64),role:'ops',createdAt:'2026-09-02T00:00:00.000Z',createdBy:'mlee'},...users,{username:'qa.boss',displayName:'QA Boss',salt:'01',hash:'ecad7597c83a96d133e45f9e9d271cbb0d1815dbae29b38b5148be7822799576',role:'admin',createdAt:'2026-09-03T00:00:00.000Z',createdBy:'master'},{username:'tech.two',displayName:'Tech Two',salt:'00',hash:'f'.repeat(64),role:'technician',createdAt:'2026-09-04T00:00:00.000Z',createdBy:'qa.boss'},{username:'__proto__',displayName:'Proto',salt:'00',hash:'f'.repeat(64),role:'admin',createdAt:'2026-09-05T00:00:00.000Z',createdBy:'master'}]}));
  localStorage.setItem('skyryse-mes-sync-sent-v1',JSON.stringify({'order|WO-10009':'a'.repeat(64),'account|master':'b'.repeat(64)}));
  localStorage.setItem('skyryse-mes-drafts-v1',JSON.stringify([['WO-10009|OP-10',{note:'rehearsal note',torque:'25 in-lb',stampNumber:''}]]));
  localStorage.setItem('skyryse-mes-demo-drafts-v1',JSON.stringify([['WO-10009|OP-10',{note:'current demo note',stampNumber:''}]]));
  localStorage.setItem('skyryse-mes-lockout-v1',JSON.stringify({master:{fails:3,until:0},mlee:{fails:4,until:0},locked1:{fails:0,until:Date.now()+3600e3}}));
  const acct=(id,cw,createdBy,op)=>({clientWriteId:cw,storeKey:'skyryse-mes-auth-v1',entityType:'account',entityId:id,operation:op||'upsert',payloadJson:JSON.stringify(op==='delete'?{entityType:'account',entityId:id,deleted:true}:{username:id,role:'admin',createdBy})});
  localStorage.setItem('skyryse-mes-sync-queue-v1',JSON.stringify([{clientWriteId:'old-demo-1',storeKey:'skyryse-mes-work-order-qa100-v1'},{clientWriteId:'prod-1',storeKey:'skyryse-mes-work-order-v1'},acct('master','old-demo-acct-1','demo build'),acct('qa.boss','old-demo-acct-2','master'),acct('ghost','old-demo-acct-3','qa.boss'),acct('tech.two','old-demo-acct-4',null,'delete'),acct('mlee','prod-acct-1','mlee'),acct('retired1','prod-acct-2',null,'delete')]));
  localStorage.setItem('skyryse-mes-security-v1',JSON.stringify([{at:'2026-09-03T00:00:00.000Z',page:'/srv/flight/demo.html',type:'signin',username:'master'},{at:'2026-09-03T00:01:00.000Z',page:'/srv/flight/demo.html',type:'role-change',username:'qa.boss',by:'master'},{at:'2026-09-03T00:02:00.000Z',page:'/srv/flight/index.html',type:'signin',username:'mlee'}]));},demoUsers);
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(1200);
 const r=await p.evaluate(()=>({users:JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.map(u=>u.username),queue:JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')).map(x=>x.clientWriteId),notice:(document.getElementById('sk-legacy-demo-notice')||{}).textContent||null,queueRaw:localStorage.getItem('skyryse-mes-sync-queue-v1'),sent:localStorage.getItem('skyryse-mes-sync-sent-v1'),drafts:localStorage.getItem('skyryse-mes-drafts-v1'),demoDrafts:JSON.parse(localStorage.getItem('skyryse-mes-demo-drafts-v1')||'[]'),legacyDrafts:JSON.parse(localStorage.getItem('skyryse-mes-legacy-demo-drafts-v1')||'[]'),locks:JSON.parse(localStorage.getItem('skyryse-mes-lockout-v1')||'{}'),legacyLocks:JSON.parse(localStorage.getItem('skyryse-mes-legacy-demo-lockout-v1')||'{}'),log:localStorage.getItem('skyryse-mes-security-v1')||'',demoLog:JSON.parse(localStorage.getItem('skyryse-mes-demo-security-v1')||'[]')}));
 ok('the refusal case is real: the older demo accounts include master',demoUsers.some(u=>u.username==='master'&&u.createdBy==='demo build'));
 ok('production opened first removes every account an older demo build created, and every account those created, and keeps its own',JSON.stringify(r.users)==='["mlee","ops1"]',JSON.stringify(r.users));
 ok('production opened first drops the older demo\'s queued workspace and account records before its mirror can send them, and keeps its own',JSON.stringify(r.queue)==='["prod-1","prod-acct-1","prod-acct-2"]',JSON.stringify(r.queue));
 const prodLog=JSON.parse(r.log||'[]');
 ok('security events a demo page wrote leave the production security log; production events stay',!prodLog.some(e=>/demo\.html$/.test(e.page||''))&&prodLog.some(e=>e.type==='signin'&&e.username==='mlee'),r.log.slice(0,400));
 ok('those demo events are kept in the demo security log, not deleted',r.demoLog.length===2&&r.demoLog.every(e=>e.page==='/srv/flight/demo.html'),JSON.stringify(r.demoLog));
 {const ev=prodLog.find(e=>e.type==='legacy-demo-removed')||{};ok('the removal is recorded in the production security log',(ev.accounts||[]).includes('master')&&(ev.accounts||[]).includes('qa.boss')&&ev.queuedRecords===5&&ev.securityEvents===2&&ev.draftsMoved===1&&ev.mirrorSentIndexCleared===true,JSON.stringify(ev));}
 ok('production shows a notice that asks for the account list to be reviewed',r.notice&&/review the account list/.test(r.notice),String(r.notice));
 ok('an account named __proto__ made by a demo account is removed, and the cleanup finishes',!r.users.includes('__proto__'),JSON.stringify(r.users));
 {const sent=JSON.parse(r.sent||'{}'),dels=JSON.parse(r.queueRaw||'[]').filter(x=>x&&x.operation==='delete').map(x=>x.entityId);
 ok('the mirror sent index the older demo shared is cleared, so its entities are never sent as production deletes',sent['order|WO-10009']!=='a'.repeat(64)&&sent['account|master']!=='b'.repeat(64)&&!dels.includes('WO-10009')&&!dels.includes('master'),JSON.stringify({sent:Object.keys(sent).slice(0,5),dels}));}
 ok('operation drafts are set aside under their own key, not deleted, and the demo\'s current drafts are untouched',r.drafts===null&&r.legacyDrafts.length===1&&r.legacyDrafts[0][1].note==='rehearsal note'&&r.demoDrafts.length===1&&r.demoDrafts[0][1].note==='current demo note',JSON.stringify({drafts:r.drafts,legacyDrafts:r.legacyDrafts,demoDrafts:r.demoDrafts}));
 ok('partial sign-in failure counts are set aside; a lockout in force is kept',JSON.stringify(Object.keys(r.locks))==='["locked1"]'&&r.locks.locked1.until>Date.now()&&r.legacyLocks.master.fails===3&&r.legacyLocks.mlee.fails===4,JSON.stringify({locks:r.locks,legacyLocks:r.legacyLocks}));
 // The review stays required across reloads and over the sign-in screen until a QA Manager marks it done.
 await p.reload();await p.waitForTimeout(700);
 const again1=await p.evaluate(()=>{const n=document.getElementById('sk-legacy-demo-notice');return {notice:!!n,z:n&&n.style.zIndex,boot:!!document.getElementById('sk-boot'),flag:!!localStorage.getItem('skyryse-mes-legacy-demo-review-v1')};});
 ok('the account review notice is shown again after a reload, above the sign-in screen',again1.notice&&again1.boot&&Number(again1.z)>1000&&again1.flag,JSON.stringify(again1));
 const clickReview=()=>p.evaluate(async()=>{const n=document.getElementById('sk-legacy-demo-notice');n.querySelector('button').click();await new Promise(r=>setTimeout(r,200));return {notice:!!document.getElementById('sk-legacy-demo-notice'),text:n.textContent,flag:!!localStorage.getItem('skyryse-mes-legacy-demo-review-v1'),log:JSON.parse(localStorage.getItem('skyryse-mes-security-v1')||'[]').filter(e=>e.type==='legacy-demo-reviewed')};});
 let rv=await clickReview();
 ok('nobody signed in cannot mark the review done',rv.notice&&rv.flag&&/Sign in as a QA Manager/.test(rv.text)&&rv.log.length===0,JSON.stringify(rv));
 await p.evaluate(()=>sessionStorage.setItem('skyryse-mes-session-v1','ops1'));await p.reload();await p.waitForTimeout(900);
 rv=await clickReview();
 ok('an Operations Manager cannot mark the review done',rv.notice&&rv.flag&&rv.log.length===0,JSON.stringify(rv));
 await p.evaluate(()=>sessionStorage.setItem('skyryse-mes-session-v1','mlee'));await p.reload();await p.waitForTimeout(900);
 rv=await clickReview();
 ok('a QA Manager marks the review done, and it is logged with who did it',!rv.notice&&!rv.flag&&rv.log.length===1&&rv.log[0].by==='mlee'&&rv.log[0].accounts.includes('qa.boss'),JSON.stringify(rv));
 await p.reload();await p.waitForTimeout(700);
 ok('once reviewed, the notice is gone after a reload',await p.evaluate(()=>!document.getElementById('sk-legacy-demo-notice')));
 await p.evaluate(()=>sessionStorage.removeItem('skyryse-mes-session-v1'));
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(600);
 const signIn=await p.evaluate(async()=>{const r=await skAuth.switchAccount('master','demo1234');return r.ok;});
 ok('master with demo1234 no longer signs in to production',signIn===false,String(signIn));
 const bossIn=await p.evaluate(async()=>{const r=await skAuth.switchAccount('qa.boss','chosen-pass-1');return r.ok;});
 ok('an account the older demo\'s master created no longer signs in to production with its chosen password',bossIn===false,String(bossIn));
 const again=await p.evaluate(()=>JSON.parse(localStorage.getItem('skyryse-mes-security-v1')||'[]').filter(e=>e.type==='legacy-demo-removed').length);
 ok('a second open finds nothing left to remove and records nothing new',again===1,String(again));
 await ctx.close();}
// An identity provider set for production (here before load, as a deployment page does) never reaches the demo.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 const fetched=[];await ctx.route(/idp\.example/,route=>{fetched.push(route.request().url());route.abort();});
 await ctx.addInitScript(()=>{window.SK_IDENTITY={provider:'okta',okta:{issuer:'https://idp.example/oauth2/default',clientId:'prod-client',redirectUri:'',scopes:'openid',groupsClaim:'groups',usernameClaim:'preferred_username',groupToRole:{},defaultRole:'general',sessionMinutes:720}};});
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(900);
 const prodProvider=await p.evaluate(()=>window.skIdentity&&window.skIdentity.provider);
 ok('the refusal case is real: production takes that provider',prodProvider==='okta'&&fetched.length>0,JSON.stringify({prodProvider,fetched}));
 fetched.length=0;
 await p.goto('file://'+FIXTURES+'demo_publish.html');await p.waitForFunction(()=>!!document.querySelector('#sk-boot input[name=username]'));
 const demoProvider=await p.evaluate(()=>window.skIdentity&&window.skIdentity.provider);
 ok('the demo keeps local sign-in and never contacts the production provider',demoProvider==='local'&&fetched.length===0,JSON.stringify({demoProvider,fetched}));
 await p.locator('#sk-boot input[name=username]').fill('master');await p.locator('#sk-boot input[name=password]').fill('demo1234');
 await p.locator('#sk-boot form').evaluate(f=>f.requestSubmit());await p.waitForFunction(()=>!document.getElementById('sk-boot'),null,{timeout:20000});
 ok('a demo account signs in with demo1234 although production names a provider',await p.evaluate(()=>skAuth.user()&&skAuth.user().username)==='master');
 await ctx.close();}
// A browser with nothing from an older demo shows no notice and logs nothing; an account created now is logged.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 await ctx.addInitScript(()=>{if(sessionStorage.getItem('seeded'))return;sessionStorage.setItem('seeded','1');localStorage.setItem('skyryse-mes-sync-sent-v1',JSON.stringify({'order|WO-1':'c'.repeat(64)}));localStorage.setItem('skyryse-mes-drafts-v1',JSON.stringify([['WO-1|OP-10',{note:'production draft'}]]));});
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForTimeout(900);
 const clean=await p.evaluate(()=>({notice:!!document.getElementById('sk-legacy-demo-notice'),sent:localStorage.getItem('skyryse-mes-sync-sent-v1'),drafts:localStorage.getItem('skyryse-mes-drafts-v1'),log:localStorage.getItem('skyryse-mes-security-v1')||''}));
 ok('a clean production browser keeps its mirror sent index and drafts, shows no notice and logs no removal',!clean.notice&&!!clean.sent&&/production draft/.test(clean.drafts||'')&&!/legacy-demo-removed/.test(clean.log),JSON.stringify(clean));
 await ctx.close();}
// Creating an account in production writes account-create with the creator, and only when the save succeeded.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 await ctx.addInitScript(()=>{if(sessionStorage.getItem('seeded'))return;sessionStorage.setItem('seeded','1');localStorage.setItem('skyryse-mes-auth-v1',JSON.stringify({users:[{username:'mlee',displayName:'Morgan Lee',salt:'01',hash:'ecad7597c83a96d133e45f9e9d271cbb0d1815dbae29b38b5148be7822799576',role:'qm',createdAt:'2026-09-01T00:00:00.000Z',createdBy:'mlee'}]}));sessionStorage.setItem('skyryse-mes-session-v1','mlee');});
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForFunction(()=>!document.getElementById('sk-boot')&&!!window.skAuth,null,{timeout:20000});
 const add=(un,failSave)=>p.evaluate(async([un,failSave])=>{const wrap=document.createElement('div');wrap.innerHTML=skAuth.accessHtml();document.body.appendChild(wrap);const f=wrap.querySelector('[data-access-add]');f.elements.displayName.value='New Person';f.elements.username.value=un;f.elements.password.value='long-enough-1';f.elements.role.value='general';
  const real=Storage.prototype.setItem;if(failSave)Storage.prototype.setItem=function(k,v){if(k==='skyryse-mes-auth-v1')throw new Error('storage full');return real.call(this,k,v);};
  window.addEventListener('unhandledrejection',e=>e.preventDefault(),{once:true});
  try{f.requestSubmit();await new Promise(r=>setTimeout(r,800));}finally{Storage.prototype.setItem=real;}
  wrap.remove();return {stored:JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.some(u=>u.username===un),logged:JSON.parse(localStorage.getItem('skyryse-mes-security-v1')||'[]').filter(e=>e.type==='account-create'&&e.username===un)};},[un,failSave]);
 const okAdd=await add('new.person',false);
 ok('an account created in production is logged as account-create with its creator',okAdd.stored&&okAdd.logged.length===1&&okAdd.logged[0].by==='mlee',JSON.stringify(okAdd));
 const badAdd=await add('not.saved',true);
 ok('an account whose save failed is not logged as created',!badAdd.stored&&badAdd.logged.length===0,JSON.stringify(badAdd));
 await ctx.close();}
// With the server, the save resolves false when the server refuses it: no account-create is logged then.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 const mlee={username:'mlee',displayName:'Morgan Lee',role:'qm',createdAt:'2026-09-01T00:00:00.000Z',createdBy:'mlee'};let refuse=true;
 await ctx.route(/^http:\/\/flight\.test\//,async route=>{const u=new URL(route.request().url()),m=route.request().method();
  if(u.pathname==='/api/auth/accounts'&&m==='PUT'){if(refuse)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Role training is not current.'})});return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({users:JSON.parse(route.request().postData()).users})});}
  if(u.pathname==='/api/auth/session')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,idleMinutes:15,maxHours:12})});
  return route.fulfill({status:404,contentType:'application/json',body:'{"error":"not here"}'});});
 await ctx.addInitScript(u=>{window.FLIGHT_SERVER={api:'http://flight.test/api',auth:{users:[u]}};sessionStorage.setItem('skyryse-mes-server-token-v1','tok');sessionStorage.setItem('skyryse-mes-session-v1','mlee');},mlee);
 await p.goto('file://'+FIXTURES+'publish.html');await p.waitForFunction(()=>window.skAuth&&skAuth.user()&&skAuth.user().username==='mlee',null,{timeout:20000});
 const add=un=>p.evaluate(async un=>{const wrap=document.createElement('div');wrap.innerHTML=skAuth.accessHtml();document.body.appendChild(wrap);const f=wrap.querySelector('[data-access-add]');f.elements.displayName.value='New Person';f.elements.username.value=un;f.elements.password.value='long-enough-1';f.elements.role.value='general';f.requestSubmit();await new Promise(r=>setTimeout(r,1200));wrap.remove();const log=JSON.parse(localStorage.getItem('skyryse-mes-security-v1')||'[]');return {created:log.filter(e=>e.type==='account-create'&&e.username===un).length,syncFailed:log.filter(e=>e.type==='account-sync-failed').length};},un);
 const refused=await add('srv.refused');
 ok('the server refusing a new account is logged as account-sync-failed and not as account-create',refused.syncFailed>=1&&refused.created===0,JSON.stringify(refused));
 refuse=false;const accepted=await add('srv.accepted');
 ok('an account the server accepts is logged as account-create',accepted.created===1,JSON.stringify(accepted));
 await ctx.close();}
ok('creating an account writes an account-create event with the creator, only once the save succeeded',/createdBy:me\.username\}\);saveAuth\(a\)\.then\(function\(saved\)\{if\(saved\)secEvent\('account-create',\{username:un,role:role,by:me\.username\}\);\}\);/.test(prod));
// A mirror address and token set as SK_MIRROR before the demo loads (by a page, proxy or extension) are ignored.
{const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
 const hits=[];await ctx.route(/mirror-preset\.example/,route=>{hits.push(route.request().url());route.abort();});
 await ctx.addInitScript(()=>{window.SK_MIRROR={url:'https://mirror-preset.example',token:'preset-write-token-'+'x'.repeat(16),batchSize:50};});
 // Copies without the mirror tools/run-suites.mjs --mirror injects, so this check means the same in both runs.
 const strip=h=>h.replace(/<head><script>window\.SK_MIRROR=[^<]*<\/script>/,'<head>');
 for(const f of ['publish.html','demo_publish.html'])fs.writeFileSync(FIXTURES+'_preset_'+f,strip(fs.readFileSync(FIXTURES+f,'utf8')));
 await p.goto('file://'+FIXTURES+'_preset_publish.html');await p.waitForTimeout(700);
 const prodGot=await p.evaluate(()=>window.SK_MIRROR&&window.SK_MIRROR.url);
 ok('the refusal case is real: production takes an SK_MIRROR set before load',prodGot==='https://mirror-preset.example',String(prodGot));
 await p.goto('file://'+FIXTURES+'_preset_demo_publish.html');await p.waitForTimeout(900);
 const demoGot=await p.evaluate(()=>({url:window.SK_MIRROR&&window.SK_MIRROR.url,token:window.SK_MIRROR&&window.SK_MIRROR.token,enabled:!!(window.skMirror&&window.skMirror.enabled)}));
 ok('the demo ignores an SK_MIRROR set before load: no address, no token, mirror off, nothing sent',demoGot.url===''&&demoGot.token===''&&!demoGot.enabled&&hits.length===0,JSON.stringify({demoGot,hits}));
 await ctx.close();for(const f of ['publish.html','demo_publish.html'])fs.rmSync(FIXTURES+'_preset_'+f,{force:true});}
// The demo build itself never runs that cleanup on its own accounts.
ok('the cleanup is switched off in the demo build and active in production',/function purgeLegacyDemoState\(\)\{return;\/\* DEMO D-\d+ \*\//.test(curated)&&/function purgeLegacyDemoState\(\)\{\n var REVIEW=/.test(prod));
// It runs before anything that reads accounts or the mirror queue: identity (whose Okta callback makes sign-in wait),
// the sign-in gate and the mirror client.
{const at=x=>prod.indexOf(x);ok('production runs the cleanup before identity, sign-in and the mirror client',at('<script id="sk-legacy-demo">')>0&&at('<script id="sk-legacy-demo">')<at('window.SK_IDENTITY = window.SK_IDENTITY ||')&&at('<script id="sk-legacy-demo">')<at('function skBoot(){')&&at('<script id="sk-legacy-demo">')<at('<script id="sk-mirror">'),JSON.stringify({c:at('<script id="sk-legacy-demo">'),i:at('window.SK_IDENTITY = window.SK_IDENTITY ||'),m:at('<script id="sk-mirror">')}));}
// ---- where the demo mark sits: sign-in, tablet width, print preview ----
async function openAt(file,user,width,height){const ctx=await b.newContext({viewport:{width,height}});await ctx.addInitScript(u=>{sessionStorage.setItem('sk-boot-seen','1');if(u){sessionStorage.setItem('skyryse-mes-session-v1',u);sessionStorage.setItem('skyryse-mes-demo-session-v1',u);sessionStorage.setItem('sk-mnv-landing-seen','1');}},user);const p=await ctx.newPage();p.on('pageerror',e=>errs.push(file+': '+e.message));await p.goto('file://'+path.join(ROOT,file));return {p,ctx};}
const overlaps=(a,c)=>!(a.r<=c.x||c.r<=a.x||a.b<=c.y||c.b<=a.y);
for(const [file,demo] of [['demo.html',true],['tests/fixtures/publish.html',false]]){const {p,ctx}=await openAt(file,null,1440,900);
  await p.waitForSelector('#sk-login:not([hidden])',{timeout:15000});await p.waitForTimeout(300);
  const r=await p.evaluate(()=>{const e=document.querySelector('.demo-banner'),hint=document.querySelector('#sk-login .demo-login-hint'),bx=e&&e.getBoundingClientRect();
    return {banner:e?{text:e.textContent,visibility:getComputedStyle(e).visibility,x:bx.x,y:bx.y,r:bx.right,b:bx.bottom,h:bx.height,vw:innerWidth,vh:innerHeight}:null,hint:hint?{text:hint.textContent,visible:getComputedStyle(hint).visibility==='visible'&&hint.getBoundingClientRect().height>0}:null,bootText:document.getElementById('sk-boot').textContent};});
  if(demo){const x=r.banner;
    ok('demo sign-in shows DEMO, NOT FOR ACCEPTANCE on screen',!!x&&x.text==='DEMO, NOT FOR ACCEPTANCE'&&x.visibility==='visible'&&x.h>0&&x.x>=0&&x.y>=0&&x.r<=x.vw&&x.b<=x.vh,JSON.stringify(x));
    ok('demo sign-in tells the reader the demo accounts and the password',!!r.hint&&r.hint.visible&&/demo1234/.test(r.hint.text)&&['demo','tech','quality','mfgeng','operations','engineering'].every(u=>r.hint.text.includes(u))&&!/\u2014/.test(r.hint.text),JSON.stringify(r.hint));}
  else ok('production sign-in shows neither the demo mark nor the demo password',!r.banner&&!r.hint&&!/demo1234|NOT FOR ACCEPTANCE/.test(r.bootText),JSON.stringify({banner:r.banner,hint:r.hint}));
  await ctx.close();}
const measure=()=>{const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,r:r.right,b:r.bottom,h:r.height};};const bar=document.querySelector('.next-action:not([hidden])');
  return {banner:box(document.querySelector('.demo-banner')),bar:box(bar),btn:box(bar&&bar.querySelector('.btn.primary')),state:box(bar&&bar.querySelector('.next-action-state')),rail:box(document.querySelector('.sidebar')),vh:innerHeight};};
for(const [w,h] of [[1024,768],[1440,900]]){const {p,ctx}=await openAt('demo.html','demo',w,h);await p.waitForTimeout(1500);
  await p.evaluate(()=>{const x=document.createElement('button');x.setAttribute('data-action','open-order');x.setAttribute('data-order','WO-10009');document.body.appendChild(x);x.click();x.remove();});
  await p.waitForSelector('.next-action:not([hidden]) .btn.primary',{timeout:10000});await p.waitForTimeout(300);const r=await p.evaluate(measure);
  ok(`at ${w}x${h} the demo mark does not cover the sticky bar or its primary action`,!!r.banner&&r.banner.h>0&&r.banner.b<=r.vh&&!overlaps(r.banner,r.btn)&&!overlaps(r.banner,r.bar),JSON.stringify(r));
  ok(`at ${w}x${h} the demo mark does not cover the rail`,!!r.banner&&r.banner.x>=r.rail.r-0.5,JSON.stringify({banner:r.banner,rail:r.rail}));
  ok(`at ${w}x${h} the sticky bar starts at the rail's right edge and its state label is clear of the rail`,r.bar.x>=r.rail.r-0.5&&r.state.x>=r.rail.r,JSON.stringify({bar:r.bar,state:r.state,rail:r.rail}));
  await ctx.close();}
{const {p,ctx}=await openAt('tests/fixtures/publish.html',null,1024,768);await p.waitForSelector('#sk-login:not([hidden])',{timeout:15000});
 // The same .next-action rule serves every view; a bar in the page measures it without a production work order.
 await p.evaluate(()=>{const bar=document.createElement('div');bar.className='next-action';bar.innerHTML='<div class="next-action-state"><strong>WO</strong><span>Draft</span></div><button class="btn primary">Act</button>';document.body.appendChild(bar);});const r=await p.evaluate(measure);
 ok('production at 1024x768: the sticky bar starts at the rail\'s right edge and reaches the bottom',!r.banner&&r.bar.x>=r.rail.r-0.5&&r.rail.r>0&&r.state.x>=r.rail.r&&Math.abs(r.bar.b-r.vh)<1,JSON.stringify(r));await ctx.close();}
{const {p,ctx}=await openAt('demo.html','demo',1024,768);await p.waitForTimeout(1500);
 const html=await p.evaluate(async()=>{let got=null;const make=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{if(b&&b.type==='text/html')got=b;return make(b);};window.open=()=>({opener:1,focus(){},print(){}});printRecord('<!doctype html><html><head><title>x</title></head><body><p>Record body</p></body></html>','x.html');return got?await got.text():'';});
 const view=await ctx.newPage();await view.setContent(html);
 const shown=await view.evaluate(()=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,r:r.right,b:r.bottom};};const m=document.querySelector('.demo-print-mark'),btn=document.querySelector('.print-action');return m&&btn?{mark:box(m),btn:box(btn),text:m.textContent}:null;});
 ok('print preview on screen: the Print button does not cover the DEMO mark',!!shown&&shown.text==='DEMO, NOT FOR ACCEPTANCE'&&!overlaps(shown.mark,shown.btn),JSON.stringify(shown));
 await view.emulateMedia({media:'print'});
 const printed=await view.evaluate(()=>{const m=document.querySelector('.demo-print-mark'),btn=document.querySelector('.print-action');return {top:m.getBoundingClientRect().top,shown:getComputedStyle(m).display!=='none',btn:getComputedStyle(btn).display};});
 ok('printed page: the DEMO mark stays at the top and the Print button is not printed',printed.shown&&printed.top<40&&printed.btn==='none',JSON.stringify(printed));
 await ctx.close();}
ok('no page errors',errs.length===0,errs.join(' | '));
await b.close();
console.log('errors',errs,'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
