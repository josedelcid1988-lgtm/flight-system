// Item 4: the demo is built from index.html by tools/build-demo.mjs and nothing else.
// Checks the build is current, every deviation applies exactly, the refusal paths of --check,
// the pilot seats keeping their real role, and DEMO, NOT FOR ACCEPTANCE on pages and prints.
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

// ---- in the browser ----
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const errs=[];
async function open(file,user){const ctx=await b.newContext({viewport:{width:1440,height:1000}});if(user)await ctx.addInitScript(u=>{sessionStorage.setItem('skyryse-mes-session-v1',u);sessionStorage.setItem('sk-boot-seen','1');sessionStorage.setItem('sk-mnv-landing-seen','1');},user);const p=await ctx.newPage();p.on('pageerror',e=>errs.push(file+': '+e.message));await p.goto('file://'+path.join(ROOT,file));await p.waitForTimeout(1500);return {p,ctx};}
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
// ---- where the demo mark sits: sign-in, tablet width, print preview ----
async function openAt(file,user,width,height){const ctx=await b.newContext({viewport:{width,height}});await ctx.addInitScript(u=>{sessionStorage.setItem('sk-boot-seen','1');if(u){sessionStorage.setItem('skyryse-mes-session-v1',u);sessionStorage.setItem('sk-mnv-landing-seen','1');}},user);const p=await ctx.newPage();p.on('pageerror',e=>errs.push(file+': '+e.message));await p.goto('file://'+path.join(ROOT,file));return {p,ctx};}
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
