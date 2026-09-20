import {chromium} from 'playwright';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file:///home/claude/fc/demo_publish.html');await p.waitForTimeout(900);
await p.evaluate(()=>{const un=document.querySelector('#sk-boot input[name=username]');const pw=document.querySelector('#sk-boot input[type=password]');un.value='demo';un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await p.waitForTimeout(3500);
console.log(JSON.stringify(await p.evaluate(()=>state.orders.map(o=>{const e=MES.revisionEntries(o);return e.map(r=>{const a=MES.revisionAuthority(state,o,r);return o.id+' '+r.rev+' | '+(a.approvedBy?a.approvedBy.name:'-')+' | '+a.source+' | '+(a.eco||a.ecoNote);});}).flat()),null,1));
await p.evaluate(()=>{selectedId='WO-10001';view='order';tab='record';render();document.getElementById('rev-heading')?.scrollIntoView();});await p.waitForTimeout(500);
await p.screenshot({path:'/home/claude/shots/v80e_rev.png'});console.log('errors',errs);await b.close();
