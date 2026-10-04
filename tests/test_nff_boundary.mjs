// Development NFF is not for flight and not for credit. A unit built on an NFF order never reaches a
// production or flight path: no FAI or FAIR, no LRU conformity package, 8130-9 or 8130-3, no issue into a
// Production or Development order, no rework of an NFF unit on such an order, and no pedigree change away
// from NFF. NFF orders also do not use up the first-article slot of a WI revision. No role lifts any of it:
// these checks run as Master Access.
import {chromium} from 'playwright';
import {loadSampleInPage} from './lib/production-sample.mjs';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);

await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.requestSubmit();});
await p.waitForTimeout(2600);
// Production ships no WIs or tools (issue #247): load the sample WIs and test tools as this suite's data.
await loadSampleInPage(p,{tools:true});
ok('these checks run as Master Access',await run(()=>skAuth.role()==='admin'));
const NFF_RE='not for flight and not for credit';
ok('a Production lot may be used on a Development NFF order',await run(()=>MES.lotBuildClassAllowed({buildClass:'Production'},'Development NFF')));
ok('a Development NFF lot cannot enter Production or Prototype work',await run(()=>!MES.lotBuildClassAllowed({buildClass:'Development NFF'},'Production')&&!MES.lotBuildClassAllowed({buildClass:'Development NFF'},'Prototype')&&MES.lotBuildClassAllowed({buildClass:'Development NFF'},'Development NFF')));

// Orders from the same released WI: one NFF, one Production, one Development.
const ids=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const mk=(pedigree,extra={})=>{const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree,subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],...extra});if(!r.ok)throw new Error(pedigree+': '+r.message);return r.id;};
  const nff=mk('Development NFF'),prod=mk('Production',{fai:false,faiWaiver:'FAI covered on an earlier order.'}),dev=mk('Development',{fai:false,faiWaiver:'FAI covered on an earlier order.'});save();return {nff,prod,dev,wi:wi.id+'|'+wi.revision};});

// ---- FAI and FAIR ----
const faiSub=await run(w=>MES.addOrder(structuredClone(state),{masterWI:w,pedigree:'Development NFF',subcategory:'FAI',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]}),ids.wi);
const faiFlag=await run(w=>MES.addOrder(structuredClone(state),{masterWI:w,pedigree:'Development NFF',subcategory:'Mfg.',fai:true,quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]}),ids.wi);
ok('an NFF order cannot be an FAI order',!faiSub.ok&&faiSub.message.includes(NFF_RE)&&!faiFlag.ok&&faiFlag.message.includes(NFF_RE),JSON.stringify({faiSub,faiFlag}));
const first=await run(()=>{const c=structuredClone(state);const wi=c.masterWIs.find(x=>x.status==='Released');c.orders=c.orders.filter(o=>!(o.masterWI&&o.masterWI.id===wi.id&&o.masterWI.revision===wi.revision));const base={masterWI:wi.id+'|'+wi.revision,subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]};const a=MES.addOrder(c,{...base,pedigree:'Development NFF'});const b2=MES.addOrder(c,{...base,pedigree:'Production'});return {a:a.ok,nffFai:!!(MES.getOrder(c,a.id)||{}).fai,b:b2.ok,prodFai:!!((MES.getOrder(c,b2.id)||{}).fai||{}).required,msg:b2.message};});
const adhocFai=await run(()=>MES.addAdhocOrder(structuredClone(state),{partNumber:'SR-X-1',title:'Prototype bracket',pedigree:'Development NFF',subcategory:'FAI',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]}));
ok('an ad hoc NFF order cannot be an FAI order',!adhocFai.ok&&adhocFai.message.includes(NFF_RE),JSON.stringify(adhocFai));
ok('an NFF order is never flagged as a first article and does not use up the first-article slot',first.a&&!first.nffFai&&first.b&&first.prodFai,JSON.stringify(first));
const fair=await run(id=>MES.saveFairHeader(structuredClone(state),id,{type:'Full'}),ids.nff);
ok('an NFF order cannot carry a FAIR',!fair.ok&&fair.message.includes(NFF_RE),JSON.stringify(fair));

// ---- conformity, 8130-9, 8130-3 ----
const conf=await run(id=>MES.startConformity(structuredClone(state),id,{serial:'X'}),ids.nff);
ok('an NFF order cannot open an LRU conformity package (8130-9, 8130-3)',!conf.ok&&conf.message.includes(NFF_RE),JSON.stringify(conf));

// ---- pedigree is one way ----
const ped=await run(id=>MES.requestPedigreeChange(structuredClone(state),id,{pedigree:'Production',reason:'Customer wants it as flight hardware.'}),ids.nff);
ok('an NFF order cannot change pedigree',!ped.ok&&ped.message.includes(NFF_RE),JSON.stringify(ped));
const pending=await run(id=>{const c=structuredClone(state);const o=MES.getOrder(c,id);o.pedigreeChange={from:'Development NFF',to:'Production',reason:'Legacy pending change.',requestedBy:{name:'X',role:'Y',credentialId:'ACCT-x'},requestedAt:new Date().toISOString(),approvals:[],status:'Awaiting approvals'};return MES.approvePedigreeChange(c,id);},ids.nff);
ok('a pending change away from NFF cannot be approved either',!pending.ok&&pending.message.includes(NFF_RE),JSON.stringify(pending));

// ---- sub-assemblies ----
const issue=await run(({nff,prod,dev})=>{const stock=c=>{MES.getOrder(c,nff).inventory={lotNumber:'LOT-NFF-1',quantity:1,serials:[],location:'Dev shelf',at:new Date().toISOString()};return c;};const out={};for(const [k,id] of [['prod',prod],['dev',dev]]){const c=stock(structuredClone(state));out[k]={listed:MES.issuableOrders(c,id).some(x=>x.id===nff),r:MES.issueFromOrder(c,id,nff,{quantity:1})};}const c=stock(structuredClone(state));const w=MES.getOrder(c,nff).masterWI;const nff2=MES.addOrder(c,{masterWI:w.id+'|'+w.revision,pedigree:'Development NFF',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});out.nff={listed:MES.issuableOrders(c,nff2.id).some(x=>x.id===nff),r:MES.issueFromOrder(c,nff2.id,nff,{quantity:1})};return out;},ids);
ok('an NFF unit is not offered to a Production or Development order',!issue.prod.listed&&!issue.dev.listed,JSON.stringify(issue));
ok('an NFF unit cannot be issued into a Production or Development order',!issue.prod.r.ok&&issue.prod.r.message.includes(NFF_RE)&&!issue.dev.r.ok&&issue.dev.r.message.includes(NFF_RE),JSON.stringify(issue));
ok('an NFF unit may go into another NFF order',issue.nff.listed&&!(issue.nff.r.message||'').includes(NFF_RE),JSON.stringify(issue.nff));

// ---- rework source ----
const rework=await run(({nff})=>{const c=structuredClone(state);const o=MES.getOrder(c,nff);c.serialLog=[...(c.serialLog||[]),{id:'SNL-99999',serial:'NFF-UNIT-1',partNumber:o.partNumber,revision:o.revision,orderId:nff,unit:1,status:'Assigned',assignedAt:new Date().toISOString(),assignedBy:{name:'X',role:'Y',credentialId:'ACCT-x'},lotNumber:'LOT-NFF-1'}];const base={partNumber:o.partNumber,revision:o.revision,title:'Rework of the development unit',subcategory:'Rework',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],sourceUnit:'NFF-UNIT-1'};return {prod:MES.addAdhocOrder(structuredClone(c),{...base,pedigree:'Production'}),nff:MES.addAdhocOrder(structuredClone(c),{...base,pedigree:'Development NFF'})};},ids);
ok('an NFF unit cannot be reworked on a Production order',!rework.prod.ok&&rework.prod.message.includes(NFF_RE),JSON.stringify(rework.prod));
ok('an NFF unit may be reworked on another NFF order',!(rework.nff.message||'').includes(NFF_RE),JSON.stringify(rework.nff));

ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));
await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
