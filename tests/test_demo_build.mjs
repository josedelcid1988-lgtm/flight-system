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
 ok('the demo takes only a mirror set before the page loads, recorded before any of the file runs',curated.indexOf('window.__demoMirrorPreset=window.SK_MIRROR||null;')>0&&curated.indexOf('window.__demoMirrorPreset=window.SK_MIRROR||null;')<curated.indexOf('<script id="sk-mirror">'));
 ok('the demo keeps its mirror queue under separate keys',!/['"]skyryse-mes-sync-(queue|sent|client)-v1['"]/.test(curated)&&/'skyryse-mes-demo-sync-queue-v1'/.test(curated));
 ok('production keeps its frozen mirror queue keys',/'skyryse-mes-sync-queue-v1'/.test(prod));}
ok('the demo reads and writes accounts only under skyryse-mes-demo-auth-v1',!/['"]skyryse-mes-auth-v1['"]/.test(curated)&&(curated.match(/['"]skyryse-mes-demo-auth-v1['"]/g)||[]).length===4);
{const shared=['session','lockout','security','oidc','drafts','evidence'];
 ok('the demo keeps its session, lockout, security log, sign-in token, drafts and evidence under demo keys',shared.every(k=>!new RegExp(`['"]skyryse-mes-${k}-v1['"]`).test(curated)&&new RegExp(`['"]skyryse-mes-demo-${k}-v1['"]`).test(curated)),shared.filter(k=>new RegExp(`['"]skyryse-mes-${k}-v1['"]`).test(curated)).join(','));
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
ok('no page errors',errs.length===0,errs.join(' | '));
await b.close();
console.log('errors',errs,'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
