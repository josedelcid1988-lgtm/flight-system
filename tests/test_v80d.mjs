import {mkdirSync as __mkdirTests} from 'fs';const TESTS=decodeURI(new URL('.',import.meta.url).pathname);__mkdirTests(TESTS+'shots',{recursive:true}); // fixtures, shots and results resolve from this folder
import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+TESTS+'fixtures/demo_publish.html');await p.waitForTimeout(900);
await p.evaluate(()=>{const un=document.querySelector('#sk-boot input[name=username]');const pw=document.querySelector('#sk-boot input[type=password]');un.value='demo';un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await p.waitForTimeout(3500);
await p.evaluate(()=>{const o=state.orders.find(o=>o.status!=='Closed'&&o.fai&&o.fai.required&&o.fair);selectedId=o.id;view='order';tab='operations';render();window.scrollTo(0,0);});await p.waitForTimeout(500);
const t=await p.evaluate(()=>{const b=document.querySelector('.fai-link');const c=document.querySelector('.rev-chip[data-action=goto-fair]');return (b&&b.textContent.trim())+' | '+(c&&c.textContent.trim());});console.log('pill:',t);
await p.screenshot({path:TESTS+'shots/v80d_pill.png',clip:{x:92,y:0,width:1348,height:420}});
await p.click('.rev-chip[data-action=goto-fair]');await p.waitForTimeout(900);
console.log('on quality tab + fair in view:',await p.evaluate(()=>{const el=document.getElementById('fair-panel');if(!el)return 'no panel';const r=el.getBoundingClientRect();return tab+' '+(r.top<600&&r.bottom>0);}));
console.log('errors',errs);await b.close();
