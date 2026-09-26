import { testPath, testUrl } from './paths.mjs';
import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));const fails=[];const ok=(w,c,m)=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
await p.goto(testUrl('fixtures/demo_qa150_publish.html'));await p.waitForTimeout(900);
await p.evaluate(()=>{const un=document.querySelector('#sk-boot input[name=username]');const pw=document.querySelector('#sk-boot input[type=password]');un.value='demo';un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await p.waitForTimeout(3500);
const fx=await p.evaluate(()=>{const o=state.orders.find(o=>o.status==='Building'&&!MES.blockingTickets(o).length&&o.operations.some(x=>!x.done&&(x.steps||[]).length>=2&&!MES.isInspectionOp(x)&&x.classification!==MES.CONF_CLASS&&x.classification!==MES.ATP_CLASS&&!Object.keys(x.stepChecks||{}).length&&!(x.steps||[]).some(s=>s.recordsTorque||(s.consumables||[]).length)&&o.operations.indexOf(x)===o.operations.findIndex(q=>!q.done)));if(!o)return null;const op=o.operations.find(x=>!x.done);selectedId=o.id;selectedOp=op.id;view='order';tab='operations';render();return {o:o.id,op:op.id,n:op.steps.length};});
console.log('   fixture',JSON.stringify(fx));
if(fx){
const vis=()=>p.evaluate(()=>({fieldset:!!document.querySelector('.buyoff-inline:not([hidden])'),dock:!!document.querySelector('#operation-form .task-actions')}));
let v=await vis();ok('buy-off panel hidden and no Complete operation before steps',!v.fieldset&&!v.dock,JSON.stringify(v));
await p.evaluate(a=>{const o=MES.getOrder(state,a.o),op=o.operations.find(x=>x.id===a.op);MES.setStepCheck(state,a.o,a.op,op.steps[0].id,true,{});save();render();},fx);await p.waitForTimeout(300);
const who=await p.evaluate(()=>(document.querySelector('.step-checked-by')||{}).textContent||'');ok('checked step shows who checked it',/Checked by/.test(who),who);console.log('   ',who);
v=await vis();ok('still no Complete operation with steps left',!v.dock,JSON.stringify(v));
await p.evaluate(a=>{const o=MES.getOrder(state,a.o),op=o.operations.find(x=>x.id===a.op);op.steps.forEach(s=>{if(!op.stepChecks[s.id])MES.setStepCheck(state,a.o,a.op,s.id,true,{});});save();render();if(document.getElementById('dialog').open)document.getElementById('dialog').close();},fx);await p.waitForTimeout(300);
v=await vis();ok('Complete operation appears when all steps are checked; panel still hidden',v.dock&&!v.fieldset,JSON.stringify(v));
await p.click('#operation-form .task-actions [data-action="buyoff-now"]');await p.waitForTimeout(300);
ok('Complete operation opens the stamp prompt',await p.evaluate(()=>!!document.getElementById('step-stamp-form')),'no prompt');
await p.evaluate(()=>{document.getElementById('step-stamp-form').elements.stampNumber.value='DEMO';document.getElementById('step-stamp-form').requestSubmit();});await p.waitForTimeout(600);
ok('operation bought off through the prompt',await p.evaluate(a=>MES.getOrder(state,a.o).operations.find(x=>x.id===a.op).done,fx),await p.evaluate(()=>(document.getElementById('operation-error')||{}).textContent));
await p.screenshot({path:testPath('shots/v80i_done.png')});
}
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
