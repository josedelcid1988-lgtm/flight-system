import {mkdirSync as __mkdirTests} from 'fs';const TESTS=decodeURI(new URL('.',import.meta.url).pathname);const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';__mkdirTests(TESTS+'shots',{recursive:true}); // shots and results resolve from this folder; fixtures from FS_FIXTURES_DIR when set (tools/run-suites.mjs --mirror)
import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ctx=await b.newContext({viewport:{width:1440,height:1000}});const p=await ctx.newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));const fails=[];const ok=(w,c,m)=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
await p.goto('file://'+FIXTURES+'demo_qa150_publish.html');await p.waitForTimeout(900);
await p.evaluate(()=>{const un=document.querySelector('#sk-boot input[name=username]');const pw=document.querySelector('#sk-boot input[type=password]');un.value='demo';un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await p.waitForTimeout(2800);
// make sure a stock NC exists
await p.evaluate(()=>{if(!state.maneuver.ncs.length){FlightManeuver.raiseNC(state,{type:'NC',title:'Print test NC',description:'Bent pin.',partNumber:'SR-IH-040',revision:'A',quantity:1,foundAt:'Receiving inspection',pedigree:'Production',escaped:'no',sourceType:'PO line',sourcePo:'PO4411',sourceLine:'3'});save();}});
// Capture what a print opens. printRecord hands the browser a blob URL; the older document.write path is still captured too.
await p.evaluate(()=>{window.__printed=[];const make=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{if(b&&b.type==='text/html')window.__printed.push(b);return make(b);};window.open=()=>{const d={html:'',open(){},write(h){this.html+=h;},close(){window.__printed.push({html:this.html});},querySelector(){return null;}};return {opener:1,document:d,focus(){},print(){}};};});
const cases=[['cars','mnv-open-car','data-car',()=>state.maneuver.cars.find(c=>c.rootCause&&c.actions.length).id,['Root cause','Corrective actions','Effectiveness']],
 ['mrb','mnv-open-board','data-board',()=>state.maneuver.mrb[0].id,['Seats and votes','Board decision']],
 ['ncs','mnv-open-nc','data-nc',()=>state.maneuver.ncs[0].id,['Observation','Manufacturing Engineering disposition','Quality approval']],
 ['pfmeas','mnv-open-pfmea','data-id',()=>state.maneuver.pfmeas[0].id,['Failure modes','Safety Team buy-off']]];
for(const [kind,act,attr,idf,must] of cases){
  const id=await p.evaluate(`(${idf})()`);
  await p.evaluate(([act,attr,id])=>{const x=document.createElement('button');x.setAttribute('data-action',act);x.setAttribute(attr,id);document.body.appendChild(x);x.click();x.remove();},[act,attr,id]);await p.waitForTimeout(400);
  const btn=await p.$(`[data-action="mnv-print"][data-kind="${kind}"][data-id="${id}"]`);ok(kind+' '+id+' detail has Print',!!btn,'no button');
  if(!btn)continue;await btn.click();await p.waitForTimeout(200);
  const html=await p.evaluate(async()=>{const d=window.__printed.pop();return !d?'':d instanceof Blob?await d.text():d.html;});
  ok(kind+' print has SKYRYSE header',html.includes('SKYRYSE')&&html.includes(id),'missing');
  must.forEach(m=>ok(kind+' print has '+m,html.includes(m),'missing'));
  const q=await b.newPage();await q.setContent(html);await q.screenshot({path:`${TESTS}shots/v78_print_${kind}.png`,fullPage:true});await q.close();
}
// WO view must not gain a print for tickets
const woTicketPrint=await p.evaluate(()=>document.querySelectorAll('[data-action="mnv-print"][data-kind="spr"],[data-action="mnv-print"][data-kind="scar"]').length);ok('no SPR/SCAR print',woTicketPrint===0,'found');
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
