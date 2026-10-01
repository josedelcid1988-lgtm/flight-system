// AS9102 FAIR Forms 1, 2 and 3 never share a page: in print (real Chromium PDFs, every print path) and on screen (one form at a time).
import {mkdirSync} from 'fs';
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';mkdirSync(TESTS+'shots',{recursive:true});
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const errs=[],fails=[];let checks=0;
const step=(what,ok,detail)=>{checks++;console.log((ok?'  ok   ':'  FAIL ')+what+(ok?'':' -> '+(detail||'')));if(!ok)fails.push(what);};
const O='WO-10004';

async function openApp(width,height){const ctx=await browser.newContext({viewport:{width,height}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));
  await p.goto('file://'+FIXTURES+'demo_publish.html');await p.waitForTimeout(900);
  await p.evaluate(()=>{const un=document.querySelector('#sk-boot input[name=username]');if(!un)return;const pw=document.querySelector('#sk-boot input[type=password]');un.value='master';un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await p.waitForFunction(()=>typeof state!=='undefined'&&state&&state.orders&&typeof fairHtml==='function',null,{timeout:15000});await p.waitForTimeout(2500);
  await p.evaluate(()=>{document.getElementById('sk-boot')?.remove();document.body.click();document.querySelectorAll('.mnv-landing').forEach(e=>e.remove());});
  return {ctx,p};}
const openFair=(p,k)=>p.evaluate(([o,k])=>{if(k)fairPage=k;selectedId=o;view='order';tab='quality';render();},[O,k]);

// ---------- print: every path that can carry FAIR forms, rendered to a real PDF ----------
// Chromium writes each link as a /URI annotation on the page that shows it, so test-only links
// placed in the generated HTML tell which PDF page each form starts and ends on.
function pdfPages(buf){const s=buf.toString('latin1'),objs=new Map();for(const m of s.matchAll(/(\d+) 0 obj\b([\s\S]*?)endobj/g))objs.set(m[1],m[2]);
  const cat=[...objs.values()].find(v=>/\/Type \/Catalog/.test(v)),pages=[];
  const walk=id=>{const o=objs.get(id)||'';if(/\/Type \/Pages\b/.test(o)){for(const k of (/\/Kids \[([^\]]*)\]/.exec(o)||['',''])[1].matchAll(/(\d+) 0 R/g))walk(k[1]);}else pages.push(o);};
  walk(/\/Pages (\d+) 0 R/.exec(cat)[1]);
  return pages.map(o=>{const a=/\/Annots \[([^\]]*)\]/.exec(o);return a?[...a[1].matchAll(/(\d+) 0 R/g)].map(r=>(/\/URI \(https:\/\/pdf\.marker\/([^)]+)\)/.exec(objs.get(r[1])||'')||[])[1]).filter(Boolean):[];});}
const mk=(id,text)=>`<a href="https://pdf.marker/${id}" style="color:inherit;text-decoration:none">${text}</a>`;
function markForms(html){
  html=html.replace(/<h1>(AS9102 Form ([123]):)/g,(m,t,n)=>`<h1>${mk('start-'+n,t)}`);
  const parts=html.split('<div class="page">');
  for(let i=1;i<parts.length;i++){let part=parts[i];const n=(/start-([123])/.exec(part)||[])[1]||String(i);
    const k=part.indexOf('<div class="k">');if(k>=0)part=part.slice(0,k)+`<div class="k">${mk('table-'+n,'·')}`+part.slice(k+15);
    const build=part.indexOf('<div class="fs-build-line"'),close=build>=0?part.lastIndexOf('</div>',build):part.lastIndexOf('</div>');
    part=part.slice(0,close)+mk('end-'+n,'<span style="font-size:6px">.</span>')+part.slice(close);parts[i]=part;}
  html=parts.join('<div class="page">');
  html=html.replace('<th>15. Part number</th>',`<th>${mk('f1head','15. Part number')}</th>`).replace('<th>5. Char no.</th>',`<th>${mk('f3head','5. Char no.')}</th>`);
  html=html.replace('LASTIDXTOKEN',mk('f1last','LASTIDXTOKEN')).replace('LASTCHARTOKEN',mk('f3last','LASTCHARTOKEN'));
  return html.replace(/(<div class="fs-build-line"[^>]*>)/,`$1${mk('build','·')}`);}
async function pdfOf(html,name){const pg=await browser.newPage();await pg.setContent(html,{waitUntil:'load'});await pg.emulateMedia({media:'print'});
  const buf=await pg.pdf({path:TESTS+`shots/fair_pages_${name}.pdf`,format:'Letter',printBackground:true,preferCSSPageSize:true});await pg.close();return pdfPages(buf);}
function checkFormPages(label,pages,{big}){const at=id=>pages.findIndex(x=>x.includes(id))+1,on=id=>pages.map((x,i)=>x.includes(id)?i+1:0).filter(Boolean);
  const s=[1,2,3].map(n=>on('start-'+n)),e=[1,2,3].map(n=>at('end-'+n));
  step(`${label}: Form 1, Form 2 and Form 3 headings each print exactly once`,s.every(x=>x.length===1),JSON.stringify(s));
  step(`${label}: Form 1 starts on page 1`,s[0][0]===1,JSON.stringify(s));
  step(`${label}: Form 2 starts on the page after Form 1 ends`,s[1][0]===e[0]+1,`Form 1 ends ${e[0]}, Form 2 starts ${s[1]}`);
  step(`${label}: Form 3 starts on the page after Form 2 ends`,s[2][0]===e[1]+1,`Form 2 ends ${e[1]}, Form 3 starts ${s[2]}`);
  step(`${label}: no page holds two forms' headings`,pages.every(x=>x.filter(m=>/^start-/.test(m)).length<=1),JSON.stringify(pages));
  step(`${label}: each form heading stays with its first table`,[1,2,3].every(n=>at('table-'+n)===s[n-1][0]),JSON.stringify(pages));
  step(`${label}: the build and SHA-256 line prints on Form 3's last page, with no page after it`,at('build')===e[2]&&pages.length===e[2],`build ${at('build')}, Form 3 ends ${e[2]}, pages ${pages.length}`);
  if(big){const f3=on('f3head'),last3=at('f3last'),f1=on('f1head'),last1=at('f1last');
    step(`${label}: a long Form 3 runs onto more than one page`,last3>s[2][0],`starts ${s[2]}, last row ${last3}`);
    step(`${label}: the Form 3 table header repeats on every page of the grid`,JSON.stringify(f3)===JSON.stringify(Array.from({length:last3-s[2][0]+1},(_,i)=>s[2][0]+i)),`header on ${f3}, grid ${s[2]} to ${last3}`);
    step(`${label}: the Form 1 index header repeats on every page of the index`,last1>=1&&JSON.stringify(f1)===JSON.stringify(Array.from({length:last1-f1[0]+1},(_,i)=>f1[0]+i)),`header on ${f1}, last index row ${last1}`);}}
async function capturePrints(p){return p.evaluate(async o=>{const docs=[],blobs=[];const ow=window.open,oc=URL.createObjectURL,orv=URL.revokeObjectURL;
    window.open=()=>({opener:null,document:{open(){},write(h){docs.push(h);},close(){},querySelector(){return null;}},focus(){},print(){}});
    URL.createObjectURL=b=>{blobs.push(b);return 'blob:stub';};URL.revokeObjectURL=()=>{};
    const click=sel=>{const b=document.querySelector(sel);if(!b)throw new Error('missing '+sel);b.click();};
    const out={};try{
      click(`#fair-panel [data-action="fair-print"][data-order="${o}"]`);out.fairPrint=await blobs.pop()?.text();
      const dl=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){};click(`#fair-panel [data-action="fair-download"][data-order="${o}"]`);HTMLAnchorElement.prototype.click=dl;out.fairDownload=await blobs.pop()?.text();
      click('[data-action="print-order"][data-mode="external"]');out.orderExternal=docs.pop();
      click('[data-action="print-order"][data-mode="internal"]');out.orderInternal=docs.pop();
    }finally{window.open=ow;URL.createObjectURL=oc;URL.revokeObjectURL=orv;}
    return out;},O);}
{
  const {ctx,p}=await openApp(1440,900);
  for(const big of [false,true]){
    if(big)await p.evaluate(o=>{const f=MES.getOrder(state,o).fair;const base=f.chars[0];
      f.index=Array.from({length:40},(_,i)=>({pn:`SR-IDX-${100+i}`,name:`Index part ${i+1}`,type:'Detail',fairId:i===39?'LASTIDXTOKEN':`LOT-${i+1}`}));
      f.form2=Array.from({length:24},(_,i)=>({kind:i%2?'Special process':'Material',name:`Material or process ${i+1}`,spec:`AMS-${2400+i}`,code:'',supplier:`Supplier ${i+1}, Torrance CA`,approval:'Yes',coc:`COC-${7000+i}`}));
      f.tests=Array.from({length:6},(_,i)=>({procedure:`ATP-110-00${i} Rev A`,report:`ATR-${i}`,software:'1.4.2'}));
      f.chars=Array.from({length:90},(_,i)=>({...base,id:`C-${i+1}`,ref:`Sht ${1+i%3} zone B${i%9}`,requirement:'0.250 ±0.005 in',result:'0.2512',ok:true,tool:'CMM-01',comments:i===89?'LASTCHARTOKEN':''}));},O);
    await openFair(p,'1');await p.waitForTimeout(300);
    const docs=await capturePrints(p),label=big?'long FAIR':'sample FAIR';
    for(const [path,html] of [['FAIR print',docs.fairPrint],['FAIR download',docs.fairDownload]]){
      step(`${label} · ${path}: the document is captured`,typeof html==='string'&&html.includes('AS9102 Form 3:'),String(html).slice(0,80));
      if(typeof html==='string')checkFormPages(`${label} · ${path}`,await pdfOf(markForms(html),`${big?'long':'sample'}_${path.replace(/\W+/g,'_').toLowerCase()}`),{big});}
    for(const [path,html] of [['Print · External',docs.orderExternal],['Print · Internal',docs.orderInternal]]){
      step(`${label} · ${path}: the order print is captured`,typeof html==='string'&&html.includes('</html>'),String(html).slice(0,80));
      const pages=await pdfOf(markForms(String(html)),`${big?'long':'sample'}_${path.replace(/\W+/g,'_').toLowerCase()}`);
      step(`${label} · ${path}: carries no AS9102 form, so no page can hold two forms (the FAIR prints from its own button)`,!/AS9102 Form [123]:/.test(html)&&pages.every(x=>!x.some(m=>/^start-/.test(m))),JSON.stringify(pages));}
  }
  await ctx.close();
}

// ---------- screen: one form at a time ----------
const visibleForms=p=>p.evaluate(()=>[...document.querySelectorAll('#fair-panel .fair-page')].filter(x=>!x.hidden&&x.checkVisibility()).map(x=>x.id));
const visibleHeadings=p=>p.evaluate(()=>[...document.querySelectorAll('#fair-panel h3')].filter(h=>h.checkVisibility()).map(h=>h.textContent.trim().slice(0,6)).filter(t=>/^Form \d/.test(t)));
for(const [w,h] of [[1440,900],[1024,768]]){
  const {ctx,p}=await openApp(w,h),tag=`${w}x${h}`;
  await openFair(p,'1');await p.waitForTimeout(300);
  const tabs=await p.evaluate(()=>[...document.querySelectorAll('#fair-panel [role=tab]')].map(b=>({k:b.dataset.fairPage,text:b.textContent.replace(/\s+/g,' ').trim(),sel:b.getAttribute('aria-selected')})));
  step(`${tag}: the FAIR has four tabs: Form 1 · Part number, Form 2 · Product, Form 3 · Characteristics, Review and sign`,tabs.length===4&&/^Form 1 · Part number/.test(tabs[0].text)&&/^Form 2 · Product/.test(tabs[1].text)&&/^Form 3 · Characteristics/.test(tabs[2].text)&&/^Review and sign/.test(tabs[3].text),JSON.stringify(tabs));
  step(`${tag}: only Form 1 shows when the FAIR opens`,JSON.stringify(await visibleForms(p))==='["fair-page-1"]'&&JSON.stringify(await visibleHeadings(p))==='["Form 1"]',JSON.stringify([await visibleForms(p),await visibleHeadings(p)]));
  const open=await p.evaluate(o=>MES.getOrder(state,o).fair.chars.filter(c=>!c.result||c.ok===null).length,O);
  step(`${tag}: the Form 3 tab counts its open results`,open>0&&new RegExp(`^Form 3 · Characteristics ${open} ${open} open result`).test(tabs[2].text),`${open} open; tab "${tabs[2].text}"`);
  step(`${tag}: a form with nothing open says so on its tab`,/nothing open/.test(tabs[1].text),tabs[1].text);
  await p.screenshot({path:TESTS+`shots/fair_forms_tabs_form1_${tag}.png`});
  await p.click('#fair-panel [role=tab][data-fair-page="2"]');
  step(`${tag}: choosing Form 2 shows only Form 2 and marks its tab selected`,JSON.stringify(await visibleForms(p))==='["fair-page-2"]'&&JSON.stringify(await visibleHeadings(p))==='["Form 2"]'&&await p.evaluate(()=>document.querySelector('#fair-tab-2').getAttribute('aria-selected')==='true'&&document.querySelector('#fair-tab-1').getAttribute('aria-selected')==='false'),JSON.stringify(await visibleForms(p)));
  await p.focus('#fair-tab-2');await p.keyboard.press('ArrowRight');
  step(`${tag}: the right arrow key moves to Form 3 and keeps focus on the tabs`,JSON.stringify(await visibleForms(p))==='["fair-page-3"]'&&await p.evaluate(()=>document.activeElement&&document.activeElement.id==='fair-tab-3'),JSON.stringify(await visibleForms(p)));
  await p.screenshot({path:TESTS+`shots/fair_forms_tabs_form3_${tag}.png`});
  await p.click('#fair-panel [role=tab][data-fair-page="sign"]');
  const gap=await p.evaluate(()=>{const li=[...document.querySelectorAll('#fair-page-sign .conf-gaps li')].find(x=>/^Form 3 block 9: results missing for /.test(x.textContent));return li?{text:li.textContent,btn:!!li.querySelector('[data-fair-page="3"]')}:null;});
  step(`${tag}: the review keeps the message "Form 3 block 9: results missing for ..." and links it to Form 3`,gap&&gap.btn,JSON.stringify(gap));
  await p.screenshot({path:TESTS+`shots/fair_forms_tabs_review_${tag}.png`});
  await p.click('#fair-page-sign .conf-gaps [data-fair-page="3"]');await p.waitForTimeout(400);
  step(`${tag}: the review link opens the Form 3 tab and only Form 3`,JSON.stringify(await visibleForms(p))==='["fair-page-3"]'&&await p.evaluate(()=>document.querySelector('#fair-tab-3').getAttribute('aria-selected')==='true'&&document.activeElement&&document.activeElement.id==='fair-page-3'),JSON.stringify(await visibleForms(p)));
  await p.evaluate(()=>{fairPage='1';tab='operations';render();});await p.waitForTimeout(200);
  await p.evaluate(()=>document.querySelector('[data-action="goto-fair"]').click());await p.waitForTimeout(400);
  step(`${tag}: "Go to the FAIR" opens the form that still has open items (Form 3)`,JSON.stringify(await visibleForms(p))==='["fair-page-3"]',JSON.stringify(await visibleForms(p)));
  await p.evaluate(()=>{tab='operations';render();});await p.waitForTimeout(200);
  await p.evaluate(()=>{const b=document.querySelector('[data-action="goto-fair"]');b.dataset.fairPage='2';b.click();});await p.waitForTimeout(400);
  step(`${tag}: a FAIR link that names a form opens that form`,JSON.stringify(await visibleForms(p))==='["fair-page-2"]',JSON.stringify(await visibleForms(p)));
  step(`${tag}: switching tabs leaves the workspace valid and the FAIR unchanged`,await p.evaluate(o=>MES.validate(state)&&MES.fairReview(state,MES.getOrder(state,o)).some(g=>/^Form 3 block 9: results missing for /.test(g)),O));
  await ctx.close();
}
// The approved FAIR (closed order) shows the same tabs without edit forms or open counts.
{const {ctx,p}=await openApp(1440,900);
  await p.evaluate(()=>{const o=state.orders.find(x=>x.fair&&x.fair.status==='Approved');fairPage='3';selectedId=o.id;view='order';tab='quality';render();});await p.waitForTimeout(300);
  step('approved FAIR: one form at a time, no open counts, no edit forms',JSON.stringify(await visibleForms(p))==='["fair-page-3"]'&&await p.evaluate(()=>!document.querySelector('#fair-panel .fair-tab-count')&&!document.querySelector('#fair-panel [data-form="fair-res"]')),JSON.stringify(await visibleForms(p)));
  await ctx.close();}
await browser.close();
console.log(`checks ${checks} pass ${checks-fails.length} fail ${fails.length}`);
console.log('FAILS '+JSON.stringify(fails));console.log('errors '+JSON.stringify(errs));
process.exit(fails.length||errs.length?1:0);
