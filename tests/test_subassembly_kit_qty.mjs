// A sub-assembly issued from another work order fills an existing kit line only when that one issue
// covers the line's whole required quantity (#546). Issuing 1 serial into a line that needs 10 is
// refused with what is short and what to do next, the line stays not ready, and the order cannot move to
// Building. A short line already in saved data loads as valid and stays an open shortage that blocks the
// build. Drives the production build as Master Access.
import {chromium} from 'playwright';
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
ok('these checks run as Master Access',await run(()=>skAuth.role()==='admin'));

// Production Mfg. orders need no pre-release QA approval, so Master Access moves the parent to Kitting itself.
// A child order stocked with 10 serials, a child stocked with 3, a child stocked as a plain lot of 5, and a
// parent in Kitting with a kit line that needs 10 of the child part (plus one that needs 2). Every other kit
// line is ready and a kit list is attached, so the only thing between the parent and Building is those lines.
const ids=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const mk=()=>{const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',fai:false,faiWaiver:'FAI covered on an earlier order.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});if(!r.ok)throw new Error(r.message);return r.id;};
  const stock=(id,lot,quantity,serials)=>{MES.getOrder(state,id).inventory={lotNumber:lot,quantity,serials,location:'Stores',at:new Date().toISOString()};};
  const ten=mk(),three=mk(),plain=mk(),parent=mk();
  stock(ten,'LOT-546-TEN',10,Array.from({length:10},(_,i)=>`SA546-${String(i+1).padStart(2,'0')}`));
  stock(three,'LOT-546-THREE',3,['SB546-1','SB546-2','SB546-3']);
  stock(plain,'LOT-546-PLAIN',5,[]);
  const toKit=MES.advance(state,parent);if(!toKit.ok)throw new Error(toKit.message);const o=MES.getOrder(state,parent);
  o.materials.forEach(m=>{m.ready=true;m.lot=m.lot||'LOT-ANY';});
  o.materials=o.materials.slice(0,17);
  const part=MES.getOrder(state,ten).partNumber;
  o.materials.push({id:'m546-a',name:'Sub-assembly A',partNumber:part,required:10,ready:false,lot:''});
  o.materials.push({id:'m546-b',name:'Sub-assembly B',partNumber:part,required:2,ready:false,lot:''});
  const k=MES.addKitFile(state,parent,{name:'kit-546.pdf'});if(!k.ok)throw new Error(k.message);
  if(!MES.validate(state))throw new Error('setup left the workspace invalid');save();
  return {ten,three,plain,parent,part};});

// ---- the refusal path ----
const short=await run(({ten,parent})=>{const c=structuredClone(state);const r=MES.issueFromOrder(c,parent,ten,{serials:['SA546-01'],materialId:'m546-a'});const line=MES.getOrder(c,parent).materials.find(m=>m.id==='m546-a');return {r,line,shortfall:MES.subShortfall(line),gate:MES.canAdvance(MES.getOrder(c,parent)),adv:MES.advance(c,parent),status:MES.getOrder(c,parent).status,issued:MES.issuableOrders(c,parent).find(x=>x.id===ten),valid:MES.validate(c)};},ids);
ok('issuing 1 serial into a line that needs 10 is refused',!short.r.ok,JSON.stringify(short.r));
ok('the refusal says what is short and what to do next',/needs 10 of .*, 1 chosen\. Choose 9 more serials from .* and issue all 10 together\./.test(short.r.message||''),short.r.message);
ok('the refused line stays not ready, with no lot and no source',short.line.ready===false&&!short.line.lot&&!short.line.source&&short.line.required===10&&short.shortfall===0,JSON.stringify(short.line));
ok('the refused issue uses none of the child stock',short.issued&&short.issued.remaining===10&&short.issued.serials.length===10,JSON.stringify(short.issued));
ok('the order cannot advance to Building',!short.gate.allowed&&!short.adv.ok&&short.status==='Kitting',JSON.stringify({gate:short.gate,adv:short.adv}));
ok('the workspace is still valid after the refusal',short.valid);

const nine=await run(({ten,parent})=>MES.issueFromOrder(structuredClone(state),parent,ten,{serials:Array.from({length:9},(_,i)=>`SA546-0${i+1}`),materialId:'m546-a'}),ids);
ok('9 of 10 is refused too, naming the 1 still needed',!nine.ok&&/9 chosen\. Choose 1 more serial from /.test(nine.message||''),JSON.stringify(nine));

const few=await run(({three,parent})=>MES.issueFromOrder(structuredClone(state),parent,three,{serials:['SB546-1','SB546-2','SB546-3'],materialId:'m546-a'}),ids);
ok('a child without enough stock says it cannot fill the line',!few.ok&&/has only 3 units left, so it cannot fill this line\. Fill it from an order with 10 in stock\./.test(few.message||''),JSON.stringify(few));

const plainShort=await run(({plain,parent})=>MES.issueFromOrder(structuredClone(state),parent,plain,{quantity:1,materialId:'m546-b'}),ids);
ok('a plain lot quantity short of the line is refused, in units',!plainShort.ok&&/needs 2 of .*, 1 chosen\. Choose 1 more unit from /.test(plainShort.message||''),JSON.stringify(plainShort));

const over=await run(({ten,parent})=>{const c=structuredClone(state);const r=MES.issueFromOrder(c,parent,ten,{serials:['SA546-01','SA546-02','SA546-03'],materialId:'m546-b'});const line=MES.getOrder(c,parent).materials.find(m=>m.id==='m546-b');return {r,line};},ids);
ok('issuing more than a line needs is refused and leaves its required quantity alone',!over.r.ok&&/needs 2 of .*, 3 chosen\. Choose exactly 2, or add the extra as a new kit line\./.test(over.r.message||'')&&over.line.required===2&&over.line.ready===false,JSON.stringify(over));

// ---- the happy path ----
const full=await run(({ten,plain,parent})=>{const a=MES.issueFromOrder(state,parent,ten,{serials:Array.from({length:10},(_,i)=>`SA546-${String(i+1).padStart(2,'0')}`),materialId:'m546-a'});const bb=MES.issueFromOrder(state,parent,plain,{quantity:2,materialId:'m546-b'});const o=MES.getOrder(state,parent);const la=o.materials.find(m=>m.id==='m546-a'),lb=o.materials.find(m=>m.id==='m546-b');const gate=MES.canAdvance(o);const adv=MES.advance(state,parent);save();return {a,b:bb,la,lb,gate,adv,status:MES.getOrder(state,parent).status,left:MES.issuableOrders(state,parent).find(x=>x.id===plain),valid:MES.validate(state)};},ids);
ok('issuing all 10 serials fills the line',full.a.ok&&full.la.ready===true&&full.la.required===10&&full.la.source.serials.length===10&&full.la.lot==='LOT-546-TEN',JSON.stringify({a:full.a,la:full.la}));
ok('issuing the full plain-lot quantity fills the line',full.b.ok&&full.lb.ready===true&&full.lb.required===2&&full.lb.source.serials.length===0,JSON.stringify({b:full.b,lb:full.lb}));
ok('the plain lot shows the 2 issued units as used',full.left&&full.left.remaining===3,JSON.stringify(full.left));
ok('with every line covered the order advances to Building',full.gate.allowed&&full.adv.ok&&full.status==='Building',JSON.stringify({gate:full.gate,adv:full.adv}));
ok('the workspace is valid after the happy path',full.valid);

// ---- a short line already in saved data ----
// Only a serialized line can show its shortfall: a plain-lot line saved before the fix had its required quantity
// raised to what was issued, so there is nothing left to compare against.
const legacy=await run(({ten,part})=>{const c=structuredClone(state);const wi=c.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(c,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',fai:false,faiWaiver:'FAI covered on an earlier order.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});const toKit=MES.advance(c,r.id);if(!toKit.ok)throw new Error(toKit.message);const o=MES.getOrder(c,r.id);o.materials.forEach(m=>{m.ready=true;m.lot=m.lot||'LOT-ANY';});o.materials=o.materials.slice(0,19);
  o.materials.push({id:'m546-old',name:'Old sub-assembly line',partNumber:part,required:10,ready:true,lot:'LOT-546-TEN',source:{orderId:ten,lotNumber:'LOT-546-TEN',serials:['SA546-01'],revision:MES.getOrder(c,ten).revision,issuedAt:new Date().toISOString(),issuedBy:{name:'Jordan Doe',role:'Master Access',credentialId:'ACCT-jdoe'}}});
  MES.addKitFile(c,r.id,{name:'kit-old.pdf'});const line=o.materials.find(m=>m.id==='m546-old');return {valid:MES.validate(c),diag:MES.diagnose(c),shortfall:MES.subShortfall(line),gate:MES.canAdvance(o),adv:MES.advance(c,r.id),status:o.status};},ids);
ok('a saved short line still loads as a valid workspace',legacy.valid,JSON.stringify(legacy.diag));
ok('the saved short line is an open shortage of 9',legacy.shortfall===9,String(legacy.shortfall));
ok('the saved short line blocks the build and says how to clear it',!legacy.gate.allowed&&/Old sub-assembly line needs 10 but 1 serial was issued from .*\. Return it and issue all 10 before starting the build\./.test(legacy.gate.reason)&&!legacy.adv.ok&&legacy.status==='Kitting',JSON.stringify(legacy.gate));

ok('no em dashes in the new messages',![over.r.message,short.r.message,few.message,plainShort.message,legacy.gate.reason].some(m=>/—/.test(m||'')));
ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));
await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
