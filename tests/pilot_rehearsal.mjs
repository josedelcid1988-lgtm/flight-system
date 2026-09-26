import { testPath, testUrl } from './paths.mjs';
import {chromium} from 'playwright';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ctx=await b.newContext({viewport:{width:1600,height:1000}});
const p=await ctx.newPage();
const fails=[];
const step=(who,what,r)=>{const ok=r&&r.ok!==false;console.log((ok?'  ok   ':'  FAIL ')+who.padEnd(11)+what+(ok?'':' -> '+(r&&r.message||'no result')));if(!ok)fails.push(who+': '+what+' -> '+(r&&r.message));return r;};
async function signIn(u){
  // Each person signs in on their own machine; here one browser plays every seat, so sign out first.
  await p.evaluate(()=>{try{sessionStorage.removeItem('skyryse-mes-session-v1');}catch(e){}}).catch(()=>{});
  await p.goto(testUrl('fixtures/demo_qa150_publish.html')); await p.waitForTimeout(900);
  const gate=await p.evaluate(()=>!!document.querySelector('#sk-boot input[name=username]'));
  if(gate) await p.evaluate(x=>{const un=document.querySelector('#sk-boot input[name=username]');const pw=document.querySelector('#sk-boot input[type=password]');
    un.value=x;un.dispatchEvent(new Event('input',{bubbles:true}));pw.value='demo1234';pw.dispatchEvent(new Event('input',{bubbles:true}));
    un.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},u);
  await p.waitForTimeout(1500); await p.evaluate(()=>document.body.click()); await p.waitForTimeout(400);
  const who=await p.evaluate(()=>skAuth.user()&&skAuth.user().username);
  if(who!==u)fails.push('sign-in as '+u+' landed as '+who);
  return who;
}
const run=(fn,...a)=>p.evaluate(fn,...a);

console.log('\n=== SCENARIO 1: 2-piece Development order, NC drives an ECR, dispo rework ===');
await signIn('mfgeng');
let wo=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');
  const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Development',subcategory:'Mfg.',quantity:2,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});
  if(r.ok)save(); return r;});
step('mfgeng','create 2-pc Development order',wo);
const id=wo.id;
await signIn('quality');
step('quality','QA release approval',await run(i=>{const r=MES.approveRelease(state,i,{note:'Released for the pilot.'});if(r.ok)save();return r;},id));
await signIn('operations');
step('operations','kit the materials',await run(i=>{const o=MES.getOrder(state,i);let last={ok:true};
  o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,i,m.id,l?l.lot:'L1');last=MES.setMaterial(state,i,m.id,true);});save();return last;},id));
step('operations','attach the NetSuite kit list',await run(i=>{const o=MES.getOrder(state,i);if(o.status==='Draft')MES.advance(state,i);const r=MES.addKitFile(state,i,{name:'kit-list-'+i+'.pdf',type:'application/pdf',size:2048,dataUrl:null});if(r.ok)save();return r;},id));
step('operations','move to building',await run(i=>{const r=MES.advance(state,i);if(r.ok)save();return r;},id));
await signIn('tech');
const nc=await run(i=>{const o=MES.getOrder(state,i);const op=o.operations[0];
  const r=MES.createTicket(state,i,op.id,{type:'NC',title:'Hole undersize on one unit',description:'Measured under drawing tolerance during in-process check.',hold:true});
  if(r.ok)save();return r;},id);
step('tech','raise the NC',nc);
await signIn('mfgeng');
const tk=await run(i=>{const o=MES.getOrder(state,i);return o.tickets[o.tickets.length-1].id;},id);
step('mfgeng','ME disposition: Rework',await run(([i,t])=>{const r=MES.dispositionTicket(state,i,t,{decision:'Rework',note:'Ream to next size and re-inspect per the drawing note.'});if(r.ok)save();return r;},[id,tk]));
step('mfgeng','raise ECR from the NC',await run(([i,t])=>{const o=MES.getOrder(state,i);
  const r=MES.submitECRRequest(state,{type:'design',partNumber:o.partNumber,title:'Open up the hole tolerance',description:'Widen the tolerance band on the mounting hole.',reason:'Repeat undersize condition found in build.',origin:{kind:'NC',id:t,orderId:i}});
  if(r.ok)save();return r;},[id,tk]));
await signIn('quality');
step('quality','approve the rework disposition (names the affected serial)',await run(([i,t])=>{const o=MES.getOrder(state,i);
  const serials=MES.orderSerials(state,o).map(e=>e.serial);
  const r=MES.resolveTicket(state,i,t,'Approved for rework.',{defectCode:'DIM',subCode:'DIM-02',quantity:1,serials:serials.slice(0,1)});
  if(r.ok)save();return r;},[id,tk]));
await signIn('mfgeng');
step('mfgeng','add the rework operation',await run(i=>{const o=MES.getOrder(state,i);
  const r=MES.addOrderOperation(state,i,{title:'Ream hole and re-inspect',description:'Ream to next size, deburr, re-inspect.',steps:'Ream hole\nDeburr\nRe-inspect',position:o.operations.length,buyoffType:'Technician',classification:'Rework',callouts:[]});
  if(r.ok)save();return r;},id));
await signIn('quality');
step('quality','QA release the sequence',await run(i=>{const r=MES.approveSequenceChange(state,i);if(r.ok)save();return r;},id));
step('quality','NC closed and hold lifted',await run(([i,t])=>{const o=MES.getOrder(state,i);const x=o.tickets.find(y=>y.id===t);
  return {ok:x.status==='Resolved', message:'ticket is '+x.status};},[id,tk]));

console.log('\n=== SCENARIO 2: 1-pc ad hoc rework order, new NC, dispo Use as is ===');
await signIn('mfgeng');
const wo2=await run(()=>{
  // A rework order is raised against a real unit sitting in inventory, so pick one.
  // Only one open work order per unit, so find a serial that is free.
  const busy=new Set(state.orders.filter(o=>o.status!=='Closed').map(o=>o.sourceBuild&&o.sourceBuild.serial).filter(Boolean));
  const units=(MES.stockedUnits?MES.stockedUnits(state):[]).filter(u=>!busy.has(u.serial));
  const unit=units[0];
  if(!unit)return {ok:false,message:'every stocked unit already has an open work order'};
  // A rework order has to trace to the NC or IDR that caused it.
  let src=null;
  state.orders.forEach(o=>(o.tickets||[]).forEach(t=>{ if(!src)src={ticket:t.id}; }));
  if(!src)return {ok:false,message:'no existing NC or IDR to link the rework order to'};
  const r=MES.addAdhocOrder(state,{pedigree:'Production',subcategory:'Rework',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],
    partNumber:unit.partNumber,title:unit.title||'Unit rework',revision:unit.revision||'A',
    sourceUnit:unit.serial, sourceTicketId:src.ticket, firstOp:'Rework the bracket face'});
  if(r.ok)save();return r;},null);
step('mfgeng','create 1-pc rework order',wo2);
const id2=wo2.id;
if(wo2.ok){
 await signIn('quality');
 await run(i=>{const o=MES.getOrder(state,i);if(MES.requiresReleaseQA(o))MES.approveRelease(state,i,{note:'Released.'});save();},id2);
 await signIn('operations');
 await run(i=>{MES.advance(state,i);const o=MES.getOrder(state,i);
   o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,i,m.id,l?l.lot:'L1');MES.setMaterial(state,i,m.id,true);});
   MES.addKitFile(state,i,{name:'kit-list-'+i+'.pdf',type:'application/pdf',size:2048,dataUrl:null});
   MES.advance(state,i);save();},id2);
 await signIn('tech');
 step('tech','raise the NC',await run(i=>{const o=MES.getOrder(state,i);const r=MES.createTicket(state,i,o.operations[0].id,{type:'NC',title:'Cosmetic scratch on bracket face',description:'Light surface scratch, no structural effect.',hold:true});if(r.ok)save();return r;},id2));
 const tk2=await run(i=>{const o=MES.getOrder(state,i);return o.tickets[o.tickets.length-1].id;},id2);
 await signIn('mfgeng');
 step('mfgeng','ME disposition: Use as is',await run(([i,t])=>{const r=MES.dispositionTicket(state,i,t,{decision:'Use as is',note:'Cosmetic only, outside any sealing or bearing surface.'});if(r.ok)save();return r;},[id2,tk2]));
 const pedigree=await run(i=>MES.getOrder(state,i).pedigree,id2);
 console.log('  note  pedigree is '+pedigree+', so MRB is '+(pedigree==='Production'?'REQUIRED':'not required'));
 if(pedigree==='Production'){
   step('mfgeng','convene the MRB',await run(([i,t])=>{const r=window.FlightManeuver.openMRB(state,i,t,'Cosmetic scratch, technical justification attached.');if(r.ok)save();return r;},[id2,tk2]));
   const board=await run(([i,t])=>{const m=window.FlightManeuver.list(state,'mrb').find(x=>x.ticketId===t);return m?m.id:null;},[id2,tk2]);
   await signIn('quality');
   step('quality','Quality seat votes',await run(bd=>{const r=window.FlightManeuver.voteMRB(state,bd,'Quality','Approve','Agreed, cosmetic.');if(r.ok)save();return r;},board));
   await signIn('mfgeng');
   step('mfgeng','ME seat votes',await run(bd=>{const r=window.FlightManeuver.voteMRB(state,bd,'Manufacturing Engineering','Approve','Cosmetic only.');if(r.ok)save();return r;},board));
   await signIn('engineering');
   step('engineering','Engineering seat votes',await run(bd=>{const r=window.FlightManeuver.voteMRB(state,bd,'Engineering','Approve','No structural concern.');if(r.ok)save();return r;},board));
   await signIn('quality');
   step('quality','board decision recorded on the final unanimous vote',await run(bd=>{const m=window.FlightManeuver.get(state,'mrb',bd);return {ok:m.status==='Approved',message:m.status};},board));
 }
 await signIn('quality');
 step('quality','approve the disposition',await run(([i,t])=>{const r=MES.resolveTicket(state,i,t,'Approved use as is.',{defectCode:'DMG',subCode:'DMG-01',quantity:1,serials:[]});if(r.ok)save();return r;},[id2,tk2]));
}

console.log('\n=== SCENARIO 3: 5-pc standard Production order after WI changes ===');
await signIn('mfgeng');
const wo3=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');
  const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:5,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});
  if(r.ok)save();return r;},null);
step('mfgeng','create 5-pc Production order',wo3);
if(wo3.ok){
 await signIn('quality');
 step('quality','QA release approval (only when the pedigree needs it)',await run(i=>{const o=MES.getOrder(state,i);
  if(!MES.requiresReleaseQA(o))return {ok:true,message:'not required for this pedigree and subcategory'};
  const r=MES.approveRelease(state,i,{note:'Released.'});if(r.ok)save();return r;},wo3.id));
 await signIn('operations');
 step('operations','issue to kitting',await run(i=>{const o=MES.getOrder(state,i);
  const r=o.status==='Draft'?MES.advance(state,i):{ok:true,message:'already '+o.status};if(r.ok)save();return r;},wo3.id));
 step('operations','kit and move to building',await run(i=>{const o=MES.getOrder(state,i);
   o.materials.forEach(m=>{const l=MES.availableLots(m.partNumber)[0];MES.setMaterialLot(state,i,m.id,l?l.lot:'L1');MES.setMaterial(state,i,m.id,true);});
   MES.addKitFile(state,i,{name:'kit-list-'+i+'.pdf',type:'application/pdf',size:2048,dataUrl:null});
   const r=MES.advance(state,i);save();return r;},wo3.id));
}
console.log('\n'+(fails.length?('REHEARSAL FAILURES ('+fails.length+'):\n  '+fails.join('\n  ')):'REHEARSAL CLEAN: all three scenarios run end to end through the real accounts'));
await b.close();
