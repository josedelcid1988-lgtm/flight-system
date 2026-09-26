import {mkdirSync as __mkdirTests} from 'fs';const TESTS=decodeURI(new URL('.',import.meta.url).pathname);__mkdirTests(TESTS+'shots',{recursive:true}); // fixtures, shots and results resolve from this folder
import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const fails=[]; const step=(w,r)=>{const ok=r&&r.ok!==false;console.log((ok?'  ok   ':'  FAIL ')+w+(ok?'':' -> '+(r&&r.message)));if(!ok)fails.push(w);};
const no=(w,r)=>step(w,{ok:!(r&&r.ok),message:r&&r.message||'was allowed'});
await p.goto('file://'+TESTS+'fixtures/demo_qa150_publish.html'); await p.waitForTimeout(900);
await p.evaluate(x=>{const un=document.querySelector('#sk-boot input[name=username]');const pw=document.querySelector('#sk-boot input[type=password]');un.value=x;un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},'master');
await p.waitForTimeout(3000);
const run=(fn,a)=>p.evaluate(fn,a);
const S=(fn,a)=>run(new Function('a',`const r=(${fn})(a);if(r&&r.ok)save();return r&&{ok:r.ok,message:r.message,id:r.id,revision:r.revision};`),a);
// ---- Unreleased drawing WI ----
const src=await run(()=>{const w=state.masterWIs.find(x=>x.status==='Released'&&!state.masterWIs.some(y=>y.id===x.id&&y.status==='Draft'));return {id:w.id,rev:w.revision,pn:w.partNumber,prev:w.partRevision};});
const nw=await S(a=>MES.addMasterWI(state,{partNumber:a.pn,partRevision:a.prev,title:'Preliminary build WI',drawingStatus:'unreleased',drawingRef:a.pn+' Rev X1'}),src);step('create WI to unreleased drawing',nw);
await run(([a,n])=>{const w=MES.findWI(state,n.id,n.revision);w.operations=JSON.parse(JSON.stringify(MES.findWI(state,a.id,a.rev).operations));save();},[src,nw]);
step('peer review',await S(n=>MES.peerReviewMasterWI(state,n.id,n.revision),nw));
step('QE approve -> Unreleased (no ECO needed)',await S(n=>MES.releaseMasterWI(state,n.id,n.revision),nw));
step('status is Unreleased',{ok:await run(n=>MES.findWI(state,n.id,n.revision).status==='Unreleased',nw),message:'not unreleased'});
no('Production order from Unreleased WI refused',await run(n=>MES.addOrder(structuredClone(state),{masterWI:n.id+'|'+n.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],fai:false,faiWaiver:'test'}),nw));
step('Development order from Unreleased WI',await S(n=>MES.addOrder(state,{masterWI:n.id+'|'+n.revision,pedigree:'Development',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],fai:false,faiWaiver:'test'}),nw));
no('release with ECO needs confirmation',await run(n=>MES.releaseUnreleasedWI(structuredClone(state),n.id,n.revision,{eco:'ECO-4411',matches:false}),nw));
no('release with bad ECO refused',await run(n=>MES.releaseUnreleasedWI(structuredClone(state),n.id,n.revision,{eco:'12',matches:true}),nw));
step('Unreleased -> Released with ECO',await S(n=>MES.releaseUnreleasedWI(state,n.id,n.revision,{eco:'ECO-4411',matches:true}),nw));
step('now Released with ECO',{ok:await run(n=>{const w=MES.findWI(state,n.id,n.revision);return w.status==='Released'&&w.eco==='ECO-4411'&&w.drawingReleased===undefined;},nw),message:'state'});
// ---- ECO required for a released-drawing WI ----
const rv=await S(a=>MES.reviseMasterWI(state,a.id,a.rev),src);step('revise released WI',rv);
step('peer review rev',await S(r=>MES.peerReviewMasterWI(state,r.id,r.revision),rv));
no('release without ECO refused',await run(r=>MES.releaseMasterWI(structuredClone(state),r.id,r.revision,{eco:''}),rv));
step('release with ECO',await S(r=>MES.releaseMasterWI(state,r.id,r.revision,{eco:'ECO-5120'}),rv));
await valid();
async function valid(){step('state valid',{ok:await run(()=>MES.validate(state)),message:'invalid'});}
// UI: WI create dialog has drawing status; release button opens ECO dialog
await run(n=>{selectedWI={id:n.id,revision:n.revision};view='wi';render();},nw);await p.waitForTimeout(300);
step('WI page shows ECO pill',{ok:await run(()=>/ECO-4411/.test(document.querySelector('#wi-title').textContent)),message:'no pill'});
// ---- standard rework + NC link ----
const fx=await run(()=>{const o=state.orders.find(o=>o.status==='Building'&&o.tickets.some(t=>t.status==='Open'));return {o:o.id,t:o.tickets.find(t=>t.status==='Open').id,n:o.operations.length};});
step('library seeded',{ok:await run(()=>MES.reworkLibrary(state).length>=6&&MES.reworkLibrary(state).every(t=>t.status==='Draft')),message:'no library'});
no('rework op without NC link refused',await run(a=>{const x=structuredClone(state);const o=MES.getOrder(x,a.o);if(o.tickets.some(t=>t.reworkPlan&&t.reworkPlan.stage==='Awaiting ME operation'))return {ok:false,message:'awaiting plan; skip'};return MES.addOrderOperation(x,a.o,{classification:'Rework',title:'Re-torque',buyoffType:'Technician',steps:'Re-torque',position:MES.getOrder(x,a.o).operations.length});},fx));
const add=await S(a=>{const t=MES.reworkLibrary(state)[0];return MES.addOrderOperation(state,a.o,{classification:'Rework',title:t.title,buyoffType:t.buyoffType,stepList:t.steps,position:MES.getOrder(state,a.o).operations.length,ticketId:a.t});},fx);step('rework op from standard rework, linked to NC',add);
step('op linked + template use counted',{ok:await run(a=>{const o=MES.getOrder(state,a.o);const op=o.operations[o.operations.length-1];return op.ticketId===a.t&&MES.reworkOpsFor(o,a.t).some(x=>x.id===op.id);},fx),message:'link'});
await valid();
await run(a=>{selectedId=a.o;view='order';tab='operations';render();ticketDialog(a.t);},fx);await p.waitForTimeout(400);
step('NC view links to rework operation',{ok:await run(()=>!!document.querySelector('#dialog .rework-links [data-action="ticket-operation"]')),message:'no link'});
await p.click('#dialog .rework-links [data-action="ticket-operation"]');await p.waitForTimeout(400);
step('link opens the rework op with the linked NC shown',{ok:await run(a=>!!document.querySelector('#operation-detail .linked-nc [data-ticket="'+a.t+'"]'),fx),message:'op not shown'});
await p.screenshot({path:TESTS+'shots/v76_rework.png'});
await run(()=>{view='wis';render();});await p.waitForTimeout(300);
step('library panel on WI page',{ok:await run(()=>!!document.querySelector('.std-rw-panel')&&/approved/i.test(document.querySelector('.std-rw-panel').textContent)),message:'no panel'});
await run(()=>{sequenceAddDialog&&0;});
console.log('errors',errs,'FAILS',JSON.stringify(fails));await b.close();
