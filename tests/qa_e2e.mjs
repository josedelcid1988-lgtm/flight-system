import { mkdirSync as __mkdirTests } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const TESTS = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
const FIXTURES = process.env.FS_FIXTURES_DIR
  ? pathToFileURL(path.resolve(process.env.FS_FIXTURES_DIR) + path.sep).href
  : new URL('./fixtures/', import.meta.url).href;
__mkdirTests(path.join(TESTS, 'shots'), { recursive: true }); // Results, helpers and screenshots belong beside this harness.
// End-to-end QA: every order type and every ticket type driven to closure through the live engines, with
// ease-of-processing metrics per flow (actions, typed fields, role handoffs, gates).
import {chromium} from 'playwright'; import fs from 'fs';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
async function signIn(u){await p.evaluate(()=>{try{sessionStorage.removeItem('skyryse-mes-demo-session-v1');}catch(e){}}).catch(()=>{});await p.goto(new URL('demo_qa150_publish.html', FIXTURES).href);await p.waitForTimeout(900);
 await p.evaluate(x=>{const un=document.querySelector('#sk-boot input[name=username]');if(!un)return;const pw=document.querySelector('#sk-boot input[type=password]');un.value=x;un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},u);await p.waitForTimeout(2800);
 await p.evaluate(()=>{window.__T=JSON.parse(localStorage.getItem('qa-e2e-trace')||'[]');});
 await p.evaluate(fs0=>eval(fs0),H);}
const H=fs.readFileSync(new URL('./qa_e2e_helpers.js',import.meta.url),'utf8');
const ALL=[];const phase=async(name,fn)=>{const r=await p.evaluate(fn);console.log(name,JSON.stringify(r).slice(0,400),'orders',await p.evaluate(()=>state.orders.length));const t=await p.evaluate(()=>{save();const t=window.__T.splice(0);return t;});ALL.push(...t);return r;};
await signIn('demo');
await p.evaluate(()=>localStorage.setItem('qa-e2e-trace','[]'));await p.evaluate(()=>{window.__T.length=0;});
await phase('wipe',()=>{['orders','activity','activityArchive','plannedOrders','assignments','ecrRequests','woRequests','notices','serialLog'].forEach(k=>{state[k]=[];});const m=state.maneuver;Object.keys(m).forEach(k=>{if(Array.isArray(m[k]))m[k]=[];});save();return MES.validate(state);});
await phase('orders',()=>E.orders());
await phase('tickets',()=>E.tickets());
await phase('maneuver',()=>E.maneuver());
await phase('conformity-1',()=>E.conf1());
await signIn('master');
await phase('conformity-2',()=>E.conf2());
await signIn('demo');
await phase('wi-change',()=>E.wi());
const T=await p.evaluate(()=>({trace:[],valid:MES.validate(state),diag:MES.validate(state)?null:MES.diagnose(state)}));
T.trace=ALL;fs.writeFileSync(TESTS+'qa_e2e_results.json',JSON.stringify(T,null,1));
const flows={};T.trace.forEach(s=>{const f=flows[s.flow]=flows[s.flow]||{actions:0,fields:0,roles:[],fails:[],gates:0,ms:0,end:''};f.actions+=s.gate?0:1;f.gates+=s.gate?1:0;f.fields+=s.fields||0;if(!s.gate&&(!f.roles.length||f.roles[f.roles.length-1]!==s.role))f.roles.push(s.role);if(!s.ok)f.fails.push(s.label+': '+s.msg);f.ms+=s.ms||0;if(s.end)f.end=s.end;});
Object.entries(flows).forEach(([k,v])=>console.log((v.fails.length?'FAIL ':'ok   ')+k.padEnd(52),'actions',v.actions,'fields',v.fields,'handoffs',v.roles.length-1,'gates',v.gates,v.end?'| '+v.end:'',v.fails.length?'\n      '+v.fails.join('\n      '):''));
console.log('flows',Object.keys(flows).length,'failed',Object.values(flows).filter(v=>v.fails.length).length,'valid',T.valid,T.diag?JSON.stringify(T.diag):'','errors',errs.slice(0,3));
await b.close();
