(function(){
const T=window.__T=window.__T||[];
const today=d=>new Date(Date.now()+(d||0)*86400000).toISOString().slice(0,10);
let FLOW='';
function st(role,label,fields,fn){const t0=performance.now();let r;try{r=fn();}catch(e){r={ok:false,message:'EXCEPTION '+e.message};}
  const ok=!(r&&r.ok===false)&&r!==false;T.push({flow:FLOW,role,label,fields:fields||0,ok,msg:ok?'':(r&&r.message)||'failed',ms:Math.round(performance.now()-t0)});
  if(!ok)throw new Error(label+': '+(r&&r.message));return r;}
function gate(label,fn){let r;try{r=fn(structuredClone(state));}catch(e){r={ok:false,message:'EXCEPTION '+e.message};}
  const ok=!!(r&&r.ok===false&&!/^EXCEPTION/.test(r.message||''));T.push({flow:FLOW,role:'-',label:'GATE '+label,gate:true,ok,msg:ok?'':(r&&r.message)||'was allowed'});return r;}
function check(label,cond,msg){T.push({flow:FLOW,role:'-',label:'CHECK '+label,gate:true,ok:!!cond,msg:cond?'':(msg||'check failed')});}
function end(text){if(T.length)T[T.length-1].end=text;}
function flow(name,fn){FLOW=name;try{fn();}catch(e){if(!T.length||T[T.length-1].ok!==false||T[T.length-1].flow!==name)T.push({flow:name,role:'-',label:'flow aborted',ok:false,msg:e.message});}
  try{save();}catch(e){} const v=MES.validate(state);if(!v)T.push({flow:name,role:'-',label:'workspace valid after flow',gate:true,ok:false,msg:JSON.stringify(MES.diagnose(state))});return name;}
const O=id=>MES.getOrder(state,id);
// ---------- order building blocks ----------
function mk(wi,qty,extra){const w=state.masterWIs.find(x=>x.id===wi&&(x.status==='Released'||x.status==='Unreleased'));
  const input=Object.assign({masterWI:w.id+'|'+w.revision,pedigree:'Production',subcategory:'Mfg.',quantity:qty,aircraft:MES.AIRCRAFT[0],priority:'Normal',site:MES.SITES[0],start:today(-6),due:today(9)},extra||{});
  const r=st('Planner','create WO from '+wi,8+(input.faiWaiver?1:0),()=>MES.addOrder(state,input));return O(r.id);}
function release(o){if(MES.requiresReleaseQA(o)&&!MES.releaseApproval(o))st('QA','QA release of the package',1,()=>MES.approveRelease(state,o.id,{note:'Package reviewed against the released master WI.'}));}
function issue(o){release(o);if(O(o.id).status==='Draft')st('Planner','issue to kitting',0,()=>MES.advance(state,o.id));else T.push({flow:FLOW,role:'-',label:'CHECK QA release auto-issued to Kitting',gate:true,ok:true,msg:''});st('Planner','print traveler (prompted)',0,()=>{MES.logTravelerPrint(state,o.id);return {ok:true};});}
function kit(o){const n=o.materials.filter(m=>!m.ready).length;
  st('Materials','kit '+n+' material lines',n*2,()=>{for(const m of o.materials){if(m.ready)continue;const lot=MES.availableLots(m.partNumber)[0];let r=MES.setMaterialLot(state,o.id,m.id,lot?lot.lot:'LOT-'+m.partNumber.slice(-4)+'-0001');if(!r.ok)return r;r=MES.setMaterial(state,o.id,m.id,true);if(!r.ok)return r;}return {ok:true};});
  if(!(o.kitFiles||[]).length)st('Materials','attach NetSuite kit list',1,()=>MES.addKitFile(state,o.id,{name:'NetSuite kit list '+o.id+'.pdf',type:'application/pdf',size:48213}));}
function build(o){kit(o);st('Planner','start build',0,()=>MES.advance(state,o.id));}
function addOp(o,input,role){const r=st(role||'ME','add operation: '+input.title,4+(input.stepList||[]).length*2,()=>MES.addOrderOperation(state,o.id,Object.assign({position:o.operations.length},input)));
  st('QA','release sequence change',0,()=>MES.approveSequenceChange(state,o.id));return r.opId;}
function buyOne(o,op,note){let fields=1;
  for(const s of (op.steps||[])){if(op.stepChecks&&op.stepChecks[s.id])continue;const pl={};fields++;
    if(s.recordsTorque){const t=MES.CAL_TOOLS.find(t=>MES.isTorqueTool(t)&&MES.toolCheck(t.tag).ok);Object.assign(pl,{value:45,unit:MES.TORQUE_UNITS[0],tool:t?t.tag:''});fields+=3;}
    if(Array.isArray(s.consumables)&&s.consumables.length){pl.consumables=s.consumables.map(c=>({name:c,lot:'LOT-CONS-0042',expires:today(200)}));fields+=s.consumables.length*2;}
    const r=MES.setStepCheck(state,o.id,op.id,s.id,true,pl);if(!r.ok)return {r,fields};}
  if(op.fodLevel==='critical'){MES.FOD_CHECKLIST.forEach(i=>MES.tickFodItem(state,o.id,op.id,i.id,true));fields+=MES.FOD_CHECKLIST.length;}
  if(op.requiresRecording&&!op.evidence.some(e=>e.reviewedAt)){const id='EV-'+crypto.randomUUID();let r=MES.attachEvidence(state,o.id,op.id,{id,fileName:'install-run.mp4',mimeType:'video/mp4',size:4096,source:'upload',description:'Installation run recorded at the bench'});if(!r.ok)return {r,fields};r=MES.reviewEvidence(state,o.id,op.id,id);if(!r.ok)return {r,fields};fields+=2;}
  const tools=op.requiresTooling?[MES.CAL_TOOLS.find(t=>MES.toolCheck(t.tag).ok&&!MES.isTorqueTool(t)).tag]:[];if(tools.length)fields++;
  const ex={tools,noTools:!tools.length,stampNumber:'x',pin:'',toolControlAck:true};
  if(MES.isInspectionOp(op)){ex.standardInspection=true;fields++;}
  if(op.classification===MES.ATP_CLASS){const t=MES.CAL_TOOLS.find(t=>MES.toolCheck(t.tag).ok);ex.testAssets=[{asset:t.tag},{asset:'TS-ATP-02',description:'FCC ATP test stand',calDue:today(120)},{asset:'FX-HAR-11',description:'Breakout harness fixture',noCal:true}];fields+=6;}
  return {r:MES.completeOperation(state,o.id,op.id,note||'Completed and verified against the work instruction.',ex),fields};}
function buy(o,count,note){for(let n=0;n<count;n++){const op=o.operations.find(x=>!x.done);if(!op)return;let res;
  const role=MES.isInspectionOp(op)?'Inspector':(op.buyoffType==='Quality'?'QA':(op.classification==='Part Conformity'?'AQI':'Operator'));
  st(role,'buy off '+op.title.slice(0,40),0,()=>{res=buyOne(o,op,note);return res.r;});T[T.length-1].fields=res.fields;}}
function finish(o){buy(o,o.operations.filter(x=>!x.done).length);st('Operator','hand to Quality',0,()=>MES.advance(state,o.id));st('QA','final quality review and close',0,()=>MES.closeOrder(state,o.id));}
function stock(o,bin){st('Materials','move to inventory',2,()=>MES.moveToInventory(state,o.id,{location:MES.SITES[0],bin:bin||'QA-E2E'}));}
const waiver={fai:false,faiWaiver:'QA run: FAI covered on an earlier order.'};
const ATP={classification:'Acceptance Test Procedure (ATP)',title:'Acceptance test (ATP-200)',description:'Run ATP-200 Rev C on the flight control computer and record the acceptance report.',buyoffType:'Quality',atpRepo:'https://github.com/skyryse/fcc-atp',atpSha:'a1b2c3d4e5f6a7b8',atpVersion:'2.4.1',stepList:[{title:'Set up the test stand',instruction:'Connect the unit to the ATP stand with the breakout harness. Verify stand calibration.'},{title:'Run ATP-200',instruction:'Run ATP-200 Rev C. Save the acceptance report to PDM and note its number.'}]};
const CONF={classification:'Part Conformity',title:'Part conformity review (SOP-860-002)',description:'Compile the LRU conformity package, complete the 8130-9 and hand the tagged LRU to Certification.',buyoffType:'8130-9 Authorized Inspector',stepList:[{title:'Work the conformity checklist',instruction:'Open the conformity checklist for each serial and complete Phases 1 to 6.'}]};
function fair(o,withChars){const f=()=>O(o.id).fair;
  st('QA','FAIR start + Form 1 header',6,()=>{let r=MES.saveFairHeader(state,o.id,{});if(!r.ok)return r;return MES.saveFairHeader(state,o.id,{type:'Full',reasons:['New part (first production)'],supplierCode:'8KSY1',po:'',sampleSize:String(o.quantity),comments:'First article.'});});
  const idx=f().index.length;st('QA','Form 1 index: FAIR ids for '+idx+' parts',idx,()=>MES.setFairIndex(state,o.id,f().index.map(x=>({...x,fairId:x.fairId||('LOT-'+x.pn.slice(-3)+'-0001')}))));
  st('QA','Form 2 material + special process',14,()=>{let r=MES.addFairForm2(state,o.id,{kind:'Material',name:'Aluminum 6061-T6 plate',spec:'AMS-QQ-A-250/11',code:'',supplier:'Pacific Metals, El Segundo CA',approval:'Yes',coc:'COC-44812'});if(!r.ok)return r;return MES.addFairForm2(state,o.id,{kind:'Special process',name:'Anodize Type II',spec:'MIL-A-8625 Type II Class 2',code:'',supplier:'South Bay Finishing, Gardena CA',approval:'Yes',coc:'COC-7731'});});
  const nt=f().tests.length;if(nt)st('QA','Form 2 functional test reports x'+nt,nt,()=>{for(let i=0;i<nt;i++){const r=MES.setFairTest(state,o.id,i,{report:'ATR-'+o.id.slice(3)+'-'+(i+1)});if(!r.ok)return r;}return {ok:true};});
  const ch=[['1','Sht 1 B3','Key','0.250 ±0.005 in','0.2512','CMM-01'],['2','Sht 1 C2','','Ø 0.125 +0.002 -0.000 in','0.1261','PIN-GAGE-14'],['3','Sht 2 note 4','','Part mark per MIL-STD-130','Conforms','Visual']];
  st('Inspector','Form 3 characteristics x'+ch.length,ch.length*7,()=>{for(const c of ch){const r=MES.addFairChar(state,o.id,{no:c[0],ref:c[1],designator:c[2],requirement:c[3],result:c[4],ok:'yes',tool:c[5]});if(!r.ok)return r;}return {ok:true};});}
function ticket(o,type,title,desc,role){const op=o.operations.find(x=>!x.done)||o.operations[o.operations.length-1];
  return st(role||'Operator','raise '+type+' on op',3,()=>MES.createTicket(state,o.id,op.id,{type,title,description:desc,hold:true})).id;}
function dispo(o,t,decision,note){st('ME','ME disposition '+decision,2,()=>MES.dispositionTicket(state,o.id,t,{decision,note:note||'Engineering rationale recorded for '+decision+'.'}));}
function board(o,t){const m=st('ME','convene MRB',1,()=>FlightManeuver.openMRB(state,o.id,t,'Board convened for '+t+'.'));const seats=FlightManeuver.get(state,'mrb',m.id).seats;
  seats.forEach(s=>st('MRB '+s,'MRB vote '+s,2,()=>FlightManeuver.voteMRB(state,m.id,s,'Approve','Reviewed; acceptable.')));
  check('board decision auto-recorded on unanimous vote',FlightManeuver.get(state,'mrb',m.id).status==='Approved',FlightManeuver.get(state,'mrb',m.id).status);return seats;}
function qaApprove(o,t,role){const c=MES.DEFECT_CODES[0];st(role||'QA','QA approves disposition',3,()=>MES.resolveTicket(state,o.id,t,'Disposition approved by Quality.',{defectCode:c.code,subCode:c.subs[0].code,quantity:1,serials:[]}));}
function tk(o,t){return O(o.id).tickets.find(x=>x.id===t);}
function reworkOp(o,t,cls){const tpl=MES.reworkLibrary(state).find(x=>x.status==='Approved'&&x.classification===cls);
  const r=st('ME','add QA-approved standard '+cls.toLowerCase()+' pair, linked to '+t,3,()=>MES.addStandardRework(state,o.id,{templateId:tpl.id,ticketId:t,position:MES.firstInsertIndex(O(o.id)),contentHash:tpl.contentHash}));
  st('QA','release rework sequence',0,()=>MES.approveSequenceChange(state,o.id));return r.opId;}
function building(filter){return state.orders.find(o=>o.status==='Building'&&!MES.blockingTickets(o).length&&filter(o));}
window.E={
orders(){
 flow('O1 Production Mfg. qty 2: create to stocked',()=>{const o=mk('MWI-0004',2,waiver);issue(o);build(o);
   gate('close before operations done',c=>MES.closeOrder(c,o.id));finish(o);stock(o,'SUB-A1');window.__stockA=o.id;end(O(o.id).status+' + stocked '+O(o.id).inventory.lotNumber);});
 flow('O2 Production FAI with FAIR to closed',()=>{const o=mk('MWI-0003',1);issue(o);build(o);buy(o,o.operations.length);st('Operator','hand to Quality',0,()=>MES.advance(state,o.id));
   gate('close FAI order without approved FAIR',c=>MES.closeOrder(c,o.id));fair(o);
   st('QA','verify FAIR (blocks 20-21)',1,()=>MES.verifyFair(state,o.id,{pin:''}));st('QA Manager','review FAIR (box 22)',1,()=>MES.reviewFair(state,o.id,{pin:''}));st('QA Manager','approve FAIR',1,()=>MES.approveFair(state,o.id,{pin:''}));
   st('QA','final quality review and close',0,()=>MES.closeOrder(state,o.id));end(O(o.id).status+', FAIR '+O(o.id).fair.status);});
 flow('O3 Production Installation to closed',()=>{const o=mk('MWI-0005',1,Object.assign({subcategory:'Installation'},waiver));issue(o);build(o);finish(o);end(O(o.id).status);});
 flow('O4 Development Mfg. to closed',()=>{const o=mk('MWI-0006',1,{pedigree:'Development',fai:false,faiWaiver:'Development build.'});issue(o);build(o);finish(o);end(O(o.id).status);});
 flow('O5 Development NFF to closed',()=>{const o=mk('MWI-0007',1,{pedigree:'Development NFF',fai:false,faiWaiver:'NFF build.'});issue(o);build(o);finish(o);end(O(o.id).status);});
 flow('O6 WO-to-WO sub-assembly issuance',()=>{const o=mk('MWI-0001',1,waiver);issue(o);const A=O(window.__stockA);const sn=(A.inventory.serials||[])[0];
   st('Materials','issue stocked sub-assembly into parent',2,()=>MES.issueFromOrder(state,o.id,A.id,{serials:sn?[sn]:[],quantity:1}));build(o);finish(o);end(O(o.id).status+' with '+A.id);});
 flow('O7 Ad hoc Upgrade on stocked unit (ECO)',()=>{const A=O(window.__stockA);const sn=(A.inventory.serials||[])[1]||(A.inventory.serials||[])[0];
   gate('Upgrade without ECR/ECO',c=>MES.addAdhocOrder(c,{pedigree:'Production',subcategory:'Upgrade',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],partNumber:A.partNumber,title:'Upgrade',revision:A.revision,sourceUnit:sn}));
   const r=st('Planner','create ad hoc Upgrade WO',9,()=>MES.addAdhocOrder(state,{pedigree:'Production',subcategory:'Upgrade',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],partNumber:A.partNumber,title:'Upgrade connector to Rev B',revision:A.revision,sourceUnit:sn,changeAuthority:'ECO-2201',firstOp:'Remove connector'}));
   const o=O(r.id);addOp(o,{classification:'Manufacturing',title:'Install Rev B connector',description:'Install the Rev B connector per ECO-2201.',buyoffType:'Technician',requiresTooling:true,stepList:[{title:'Install',instruction:'Install and torque the connector.'}]});
   issue(o);build(o);finish(o);end(O(o.id).status);});
 flow('O8 Split order and close child as Obsolete',()=>{const o=mk('MWI-0002',3,waiver);st('Planner','split 1 unit',1,()=>MES.splitOrder(state,o.id,1));const child=state.orders.find(x=>x.id.startsWith(o.id+'-'));
   st('Planner','request closure Obsolete',2,()=>MES.requestOrderClosure(state,child.id,{reason:'Obsolete',note:'Demand reduced by one unit.'}));st('QA','approve closure',1,()=>MES.decideOrderClosure(state,child.id,true,'Approved.'));
   end(o.id+' qty '+O(o.id).quantity+', '+child.id+' '+O(child.id).status);});
 flow('O9 Engineering change (quantity) on Draft',()=>{const o=mk('MWI-0008',2,waiver);st('ME','request engineering change',2,()=>MES.submitEngineeringChange(state,o.id,{reason:'Customer reduced quantity.',quantity:1}));if(MES.engineeringChange(O(o.id)).status==='Awaiting ECR')st('Engineering','approve ECR',0,()=>MES.approveECR(state,o.id));
   st('QA','approve engineering change',0,()=>MES.approveEngineeringChange(state,o.id));end('qty '+O(o.id).quantity);});
 flow('O10 Pedigree change request, two disciplines',()=>{const o=mk('MWI-0009',1,waiver);st('Planner','request pedigree change',2,()=>MES.requestPedigreeChange(state,o.id,{pedigree:'Development',reason:'Unit reassigned to the test fleet.'}));
   st('ME','approve pedigree change (1 of 2)',0,()=>MES.approvePedigreeChange(state,o.id));
   const r=MES.approvePedigreeChange(state,o.id);T.push({flow:FLOW,role:'QA',label:'approve pedigree change (2 of 2, same demo account)',fields:0,ok:true,msg:r.ok?'':'expected SoD refusal: '+r.message});end(O(o.id).pedigree+(O(o.id).pedigreeChange?' (awaiting 2nd discipline)':''));});
 return T.filter(x=>!x.ok&&!x.gate).length;},
tickets(){
 FLOW='T0 Standard rework library';
 ['Rework','Repair'].forEach(cls=>{const tpl=MES.reworkLibrary(state).find(x=>x.classification===cls&&x.status!=='Approved');if(tpl)st('QA','approve standard '+cls.toLowerCase()+' pair '+tpl.id,0,()=>MES.approveReworkTemplate(state,tpl.id));});
 flow('T1 WO NC Rework to closed + rework op bought off',()=>{const o=mk('MWI-0004',1,waiver);issue(o);build(o);buy(o,1);const t=ticket(o,'NC','Wrong washer installed','AN960-10 installed where AN960-10L is called out.');
   dispo(o,t,'Rework');check('Rework needs no MRB',!FlightManeuver.needsMRB(O(o.id),tk(o,t)));qaApprove(o,t);check('ticket waits for ME operation',tk(o,t).reworkPlan&&tk(o,t).reworkPlan.stage==='Awaiting ME operation');
   reworkOp(o,t,'Rework');buy(o,1);finish(o);end(tk(o,t).status+', WO '+O(o.id).status);});
 flow('T2 IDR Use as is, Production Mfg., MRB with Certification',()=>{const o=mk('MWI-0005',1,waiver);issue(o);build(o);const t=ticket(o,'IDR','Scratch on mounting face','0.5 in scratch, outside functional surfaces.');
   dispo(o,t,'Use as is');gate('QA approval before MRB',c=>MES.resolveTicket(c,o.id,t,'x',{defectCode:MES.DEFECT_CODES[0].code,subCode:MES.DEFECT_CODES[0].subs[0].code}));
   const seats=board(o,t);check('Certification seated',seats.includes('Certification'),seats.join(','));qaApprove(o,t);finish(o);end(tk(o,t).status+', seats '+seats.length+', WO '+O(o.id).status);});
 flow('T3 NC Repair, Production FAI, MRB + repair op',()=>{const o=mk('MWI-0006',1,{fai:true});issue(o);build(o);const t=ticket(o,'NC','Thread damaged','Helicoil required on tapped hole 4.');
   dispo(o,t,'Repair');const seats=board(o,t);check('Certification seated (FAI)',seats.includes('Certification'));qaApprove(o,t);reworkOp(o,t,'Repair');
   buy(o,o.operations.filter(x=>!x.done).length);st('Operator','hand to Quality',0,()=>MES.advance(state,o.id));fair(o);st('QA','verify FAIR',1,()=>MES.verifyFair(state,o.id,{pin:''}));st('QA Manager','review FAIR (box 22)',1,()=>MES.reviewFair(state,o.id,{pin:''}));st('QA Manager','approve FAIR',1,()=>MES.approveFair(state,o.id,{pin:''}));
   st('QA','close',0,()=>MES.closeOrder(state,o.id));end(tk(o,t).status+', WO '+O(o.id).status);});
 flow('T4 NC Use for Dev: QA Manager + pedigree downgrade',()=>{const o=mk('MWI-0007',1,waiver);issue(o);build(o);const t=ticket(o,'NC','Bore oversize','Bore 0.503 in, max 0.501 in.');
   dispo(o,t,'Use for Dev');check('no MRB for Use for Dev',!FlightManeuver.needsMRB(O(o.id),tk(o,t)));qaApprove(o,t,'QA Manager');check('downgraded to Development',O(o.id).pedigree==='Development',O(o.id).pedigree);
   finish(o);end(tk(o,t).status+', '+O(o.id).pedigree+', WO '+O(o.id).status);});
 flow('T5 NC Scrap, WO closed as Scrap in the same QA approval',()=>{const o=mk('MWI-0008',1,waiver);issue(o);build(o);const t=ticket(o,'NC','Housing cracked','Crack at boss 3 after press fit.');
   dispo(o,t,'Scrap');const c=MES.DEFECT_CODES[0];
   gate('close-as-scrap on a non-Scrap disposition',cc=>{const x=cc.orders.find(q=>q.id===o.id).tickets.find(q=>q.id===t);x.dispo.decision='Rework';return MES.resolveTicket(cc,o.id,t,'x',{defectCode:c.code,subCode:c.subs[0].code,quantity:1,serials:[],closeOrder:true});});
   st('QA','QA approves Scrap and closes the WO as Scrap',4,()=>MES.resolveTicket(state,o.id,t,'Scrap approved; housing cracked beyond repair.',{defectCode:c.code,subCode:c.subs[0].code,quantity:1,serials:[],closeOrder:true}));
   check('WO closed as Scrap with the NC linked',O(o.id).status==='Closed'&&O(o.id).closedAs==='Scrap'&&O(o.id).closure.ticket.ticketId===t,O(o.id).status);end(tk(o,t).status+', WO '+O(o.id).status+' as '+O(o.id).closedAs);});
 flow('T6 NC Return to supplier (Development)',()=>{const o=mk('MWI-0009',1,{pedigree:'Development',fai:false,faiWaiver:'Dev.'});issue(o);build(o);const t=ticket(o,'NC','Supplier connector bent pins','Two bent pins on receipt.');
   dispo(o,t,'Return to supplier');qaApprove(o,t);finish(o);end(tk(o,t).status+', WO '+O(o.id).status);});
 flow('T7 IDR Rejected in Error',()=>{const o=mk('MWI-0010',1,{pedigree:'Development',fai:false,faiWaiver:'Dev.'});issue(o);build(o);const t=ticket(o,'IDR','Suspected short','Continuity reading was a meter setting error.');
   dispo(o,t,'Rejected in Error');qaApprove(o,t);finish(o);end(tk(o,t).status+', WO '+O(o.id).status);});
 flow('T8 Inspection reject to NC, rework, re-inspect, close',()=>{const o=mk('MWI-0005',1,waiver);issue(o);build(o);const idx=o.operations.findIndex(x=>MES.isInspectionOp(x));buy(o,idx);const insp=o.operations[idx],src=o.operations[idx-1];
   gate('inspection buy-off without standard inspection ack',c=>MES.completeOperation(c,o.id,insp.id,'ok',{tools:[],noTools:true,stampNumber:'x',pin:'',toolControlAck:true}));
   const r=st('Inspector','reject inspection, raise NC',5,()=>MES.rejectInspection(state,o.id,insp.id,{sourceOperationId:src.id,type:'NC',title:'Backshell not torqued',requirement:'WI step B: 25 in-lb and torque stripe',description:'J3 backshell turns by hand.',serials:[]}));
   const t=O(o.id).tickets.find(x=>x.detected).id;check('inspection held',MES.blockingTickets(O(o.id),insp.id).length>0);dispo(o,t,'Rework');qaApprove(o,t);reworkOp(o,t,'Rework');finish(o);end(tk(o,t).status+', WO '+O(o.id).status);});
 return T.filter(x=>!x.ok&&!x.gate).length;},
maneuver(){
 const base={type:'NC',description:'Found during receiving inspection.',partNumber:'SR-IH-040',revision:'A',quantity:1,foundAt:'Receiving inspection',pedigree:'Production',escaped:'no'};
 const nc=id=>FlightManeuver.get(state,'ncs',id);const c=MES.DEFECT_CODES[0];
 flow('M1 Stock NC (PO line) Use as is, escape, MRB',()=>{gate('stock NC without source',c=>FlightManeuver.raiseNC(c,{...base,title:'x'}));
   const r=st('Inspector','raise stock NC from PO line',11,()=>FlightManeuver.raiseNC(state,{...base,title:'Anodize color mismatch',sourceType:'PO line',sourcePo:'PO4411',sourceLine:'3',escaped:'yes',escapedFrom:'Final inspection'}));
   st('ME','disposition Use as is',2,()=>FlightManeuver.dispositionNC(state,r.id,{decision:'Use as is',note:'Cosmetic only.'}));st('QA','containment',1,()=>FlightManeuver.containNC(state,r.id,'Lot quarantined in MRB cage.'));
   gate('approve before MRB',cc=>FlightManeuver.approveNC(cc,r.id,{defectCode:c.code,subCode:c.subs[0].code,note:'x',quantity:1}));
   const m=st('ME','convene MRB',1,()=>FlightManeuver.openMRB(state,'STOCK',r.id,'Cosmetic mismatch.'));const seats=FlightManeuver.get(state,'mrb',m.id).seats;seats.forEach(s=>st('MRB '+s,'MRB vote '+s,2,()=>FlightManeuver.voteMRB(state,m.id,s,'Approve','ok')));check('board decision auto-recorded',FlightManeuver.get(state,'mrb',m.id).status==='Approved');
   st('QA','approve NC',3,()=>FlightManeuver.approveNC(state,r.id,{defectCode:c.code,subCode:c.subs[0].code,note:'Approved per MRB.',quantity:1}));end(nc(r.id).status+', seats '+seats.join('/'));});
 flow('M2 Stock NC (Work order source) Scrap',()=>{const wo=state.orders.find(o=>o.status==='Closed').id;
   const r=st('Inspector','raise stock NC from WO',9,()=>FlightManeuver.raiseNC(state,{...base,title:'Dropped unit',foundAt:'Stock',sourceType:'Work order',sourceOrder:wo}));
   st('ME','disposition Scrap',2,()=>FlightManeuver.dispositionNC(state,r.id,{decision:'Scrap',note:'Impact damage.'}));st('QA','containment',1,()=>FlightManeuver.containNC(state,r.id,'Tagged and segregated.'));
   st('QA','approve NC',3,()=>FlightManeuver.approveNC(state,r.id,{defectCode:c.code,subCode:c.subs[0].code,note:'Scrap approved.',quantity:1}));end(nc(r.id).status);});
 flow('M3 Stock NC (Lot source) Return to supplier',()=>{const r=st('Inspector','raise stock NC from lot',9,()=>FlightManeuver.raiseNC(state,{...base,title:'Wrong plating',sourceType:'Lot',lot:'LOT-0040-0001'}));
   st('ME','disposition Return to supplier',2,()=>FlightManeuver.dispositionNC(state,r.id,{decision:'Return to supplier',note:'Supplier nonconformance.'}));st('QA','containment',1,()=>FlightManeuver.containNC(state,r.id,'Lot held.'));
   st('QA','approve NC',3,()=>FlightManeuver.approveNC(state,r.id,{defectCode:c.code,subCode:c.subs[0].code,note:'RTV approved.',quantity:1}));end(nc(r.id).status);});
 flow('M4 Stock NC (Serial) Rework via ad hoc Rework WO',()=>{const A=O(window.__stockA);const sn=(A.inventory.serials||[]).slice(-1)[0];
   const r=st('Inspector','raise stock NC from serial',9,()=>FlightManeuver.raiseNC(state,{...base,title:'Loose fastener',partNumber:A.partNumber,revision:A.revision,foundAt:'Stock',sourceType:'Serial number',serial:sn}));
   st('ME','disposition Rework',2,()=>FlightManeuver.dispositionNC(state,r.id,{decision:'Rework',note:'Re-torque.'}));st('QA','containment',1,()=>FlightManeuver.containNC(state,r.id,'Unit held.'));
   st('QA','approve NC',3,()=>FlightManeuver.approveNC(state,r.id,{defectCode:c.code,subCode:c.subs[0].code,note:'Rework approved.',quantity:1}));
   const w=st('Planner','create ad hoc Rework WO from stock NC',9,()=>MES.addAdhocOrder(state,{pedigree:'Production',subcategory:'Rework',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0],partNumber:A.partNumber,title:'Rework loose fastener',revision:A.revision,sourceUnit:sn,sourceTicketId:r.id,firstOp:'Re-torque fastener'}));
   if(!nc(r.id).reworkOrderId)st('QA','link rework WO to NC',1,()=>FlightManeuver.linkReworkOrder(state,r.id,w.id));
   const o=O(w.id);addOp(o,{classification:'Inspection',title:'Inspect rework',description:'Verify torque stripe.',buyoffType:'Quality',stepList:[{title:'Verify',instruction:'Verify torque stripe present.'}]});issue(o);build(o);finish(o);
   end(nc(r.id).status+', rework '+w.id+' '+O(w.id).status);});
 flow('M5 CAR lifecycle to closed',()=>{const r=st('QA','raise CAR',5,()=>FlightManeuver.raiseCAR(state,{title:'Torque escapes',description:'Repeat backshell torque escapes.',sourceType:'Observation',severity:'Major',dueDate:today(30)}));
   st('QA','containment',1,()=>FlightManeuver.recordContainment(state,r.id,'100% re-inspection of open orders.'));
   st('QA','root cause (5 why + fishbone)',5,()=>FlightManeuver.recordRootCause(state,r.id,{why1:'Not torqued',why2:'Step unclear',why3:'No unit',fishMethod:'WI missing torque unit',statement:'WI lacked the torque unit.',category:'Method'}));
   st('QA','add action',3,()=>FlightManeuver.addAction(state,r.id,{description:'Add torque unit to the WI.',owner:'ME',dueDate:today(14)}));
   st('ME','complete action',1,()=>FlightManeuver.completeAction(state,r.id,FlightManeuver.get(state,'cars',r.id).actions[0].id,'MCR incorporated.'));
   st('QA','verify CAR',1,()=>FlightManeuver.verifyCAR(state,r.id,'Verified on 5 orders.'));
   st('QA','effectiveness check',3,()=>FlightManeuver.effectivenessCheck(state,r.id,{checkDate:today(0),result:'Effective',note:'No recurrence.'}));
   st('QA','close CAR',1,()=>FlightManeuver.closeCAR(state,r.id,'Closed.'));end(FlightManeuver.get(state,'cars',r.id).status);});
 flow('M6 Supplier CAR with SCAR to closed',()=>{const r=st('QA','raise CAR',5,()=>FlightManeuver.raiseCAR(state,{title:'Bracket cracks',description:'Cracked brackets from one lot.',sourceType:'NC',severity:'Major',dueDate:today(30)}));
   st('QA','containment',1,()=>FlightManeuver.recordContainment(state,r.id,'Lot held.'));
   st('QA','root cause with supplier (opens SCAR)',6,()=>FlightManeuver.recordRootCause(state,r.id,{why1:'Cracks',why2:'Overbent',fishMaterial:'Wrong temper',statement:'Supplier formed in the wrong temper.',category:'Material',supplier:'Acme Metals'}));
   st('QA','link SCAR in Jira',2,()=>FlightManeuver.linkSCARJira(state,r.id,'SCAR-41','https://skyryse.atlassian.net/browse/SCAR-41'));
   st('QA','close SCAR',1,()=>FlightManeuver.closeSCAR(state,r.id,'Supplier corrected temper.'));
   st('QA','add action',3,()=>FlightManeuver.addAction(state,r.id,{description:'Add temper check at receiving.',owner:'QA',dueDate:today(14)}));
   st('QA','complete action',1,()=>FlightManeuver.completeAction(state,r.id,FlightManeuver.get(state,'cars',r.id).actions[0].id,'Done.'));
   st('QA','verify',1,()=>FlightManeuver.verifyCAR(state,r.id,'Verified.'));st('QA','effectiveness',3,()=>FlightManeuver.effectivenessCheck(state,r.id,{checkDate:today(0),result:'Effective',note:'OK'}));
   st('QA','close CAR',1,()=>FlightManeuver.closeCAR(state,r.id,'Closed.'));end(FlightManeuver.get(state,'cars',r.id).status);});
 flow('M7 SPR to closed',()=>{const r=st('Test','raise SPR',8,()=>FlightManeuver.raiseSPR(state,{title:'HIL timeout',partNumber:'SR-FC-200',serial:'FC-200-00003',foundAt:'HIL',defectCode:'TEST',subCode:'TEST-01',description:'Watchdog timeout at 40 min.',occurred:today(0)}));
   gate('close SPR before Jira',c=>FlightManeuver.closeSPR(c,r.id,'x'));st('Test','link Jira',2,()=>FlightManeuver.linkSPRJira(state,r.id,'SPR-2050','https://skyryse.atlassian.net/browse/SPR-2050'));
   st('Test','close SPR',1,()=>FlightManeuver.closeSPR(state,r.id,'Fixed in 2.4.2.'));end(FlightManeuver.get(state,'sprs',r.id).status);});
 flow('M8 Design ECR to closed',()=>{const r=st('ME','submit design ECR',5,()=>MES.submitECRRequest(state,{type:'design',partNumber:'SR-FC-200',title:'Add strain relief',description:'Add strain relief to J3.',reason:'Repeat damage.'}));
   st('Engineering','link Jira',2,()=>MES.linkECRJira(state,r.id,'ECR-301','https://skyryse.atlassian.net/browse/ECR-301'));
   st('Engineering','close ECR',2,()=>MES.closeECRRequest(state,r.id,'Rejected','Covered by existing ECO-2201.'));end((state.ecrRequests.find(e=>e.id===r.id)||{}).status);});
 return T.filter(x=>!x.ok&&!x.gate).length;},
conf1(){flow('C1 LRU: FAI + ATP + Part Conformity + 8130-9 + 8130-3',()=>{const o=mk('MWI-0001',1,{fai:true});window.__conf=o.id;issue(o);addOp(o,ATP);addOp(o,CONF);build(o);buy(o,o.operations.length-1);fair(o);
   st('QA','verify FAIR',1,()=>MES.verifyFair(state,o.id,{pin:''}));st('QA Manager','review FAIR (box 22)',1,()=>MES.reviewFair(state,o.id,{pin:''}));st('QA Manager','approve FAIR',1,()=>MES.approveFair(state,o.id,{pin:''}));const sn=MES.confSerials(state,O(o.id))[0];window.__confSn=sn;
   st('QA','start conformity package',2,()=>MES.startConformity(state,o.id,{serial:sn,jira:'CONF-301'}));st('QA','package details (RFC, MDL, staging)',4,()=>MES.saveConformity(state,o.id,sn,{rfc:'RFC-0201',mdlRev:'G',mdlReceived:today(-2),staging:'QA cage A',nc:'No'}));
   const keys=['1.2','1.3','1.4','3.1','3.2','3.3','3.4','4.1a','4.1b','4.1c','4.1d','4.2'];st('QA','checklist phases 1-4 ('+keys.length+' items)',keys.length,()=>{for(const k of keys){const r=MES.checkConformity(state,o.id,sn,k,k==='3.3'?{value:'N/A',note:'No purchased parts.'}:{value:'Yes'});if(!r.ok)return r;}return {ok:true};});
   gate('N/A without justification',c=>MES.checkConformity(c,o.id,sn,'5.2',{value:'N/A'}));
   st('QA','complete 8130-9',6,()=>MES.complete8130_9(state,o.id,sn,{section:'Aircraft',item:'A',make:'Skyryse',model:O(o.id).aircraft,registration:'',basis:'Parts conform to MDL AA-CRT-0001 Rev G, S/N '+sn+'.'},{pin:''}));
   st('QA','check 6.1',1,()=>MES.checkConformity(state,o.id,sn,'6.1',{value:'Yes'}));
   gate('AQI signs own 8130-9',c=>MES.aqiSign8130_9(c,o.id,sn,{pin:''}));end('8130-9 prepared, awaiting independent AQI');});return 0;},
conf2(){FLOW='C1 LRU: FAI + ATP + Part Conformity + 8130-9 + 8130-3';try{const o=O(window.__conf||state.orders.find(x=>x.conformity&&x.conformity.length&&x.status!=='Closed').id);const sn=o.conformity[0].serial;
   st('AQI','AQI signs 8130-9',1,()=>MES.aqiSign8130_9(state,o.id,sn,{pin:''}));st('AQI','tag and 6.3a/6.3b',2,()=>{let r=MES.checkConformity(state,o.id,sn,'6.3a',{value:'Yes'});if(!r.ok)return r;return MES.checkConformity(state,o.id,sn,'6.3b',{value:'Yes'});});
   buy(o,1,'Package reviewed, 8130-9 signed, LRU tagged.');st('Operator','hand to Quality',0,()=>MES.advance(state,o.id));st('QA','close',0,()=>MES.closeOrder(state,o.id));
   st('QA','notify Certification',0,()=>MES.notifyCertification(state,o.id,sn));st('Certification','DAR details + 7.2',4,()=>{let r=MES.saveConformity(state,o.id,sn,{darName:'J. Rivera',darDesignation:'DAR-F 1287',darDate:today(0)});if(!r.ok)return r;return MES.checkConformity(state,o.id,sn,'7.2',{value:'Yes'});});
   st('Certification','record DAR approval',6,()=>MES.recordDarApproval(state,o.id,sn,{name:'J. Rivera',designation:'DAR-F 1287',date:today(0),aqiPresent:true,fieldsSigned:true}));
   st('Certification','record FAA 8130-3',5,()=>MES.record8130_3(state,o.id,sn,{number:'FC-0002',issuer:'DAR',issuerName:'J. Rivera, DAR-F 1287',date:today(0),block11:'PROTOTYPE'}));
   st('Certification','7.6 / 7.7 and close package',2,()=>{for(const k of ['7.6','7.7']){const r=MES.checkConformity(state,o.id,sn,k,{value:'Yes'});if(!r.ok)return r;}return MES.closeConformity(state,o.id,sn);});
   end('WO '+O(o.id).status+', package '+(O(o.id).conformity[0].status||'')+', 8130-3 '+((O(o.id).conformity[0].form8130_3||{}).number||'recorded'));}catch(e){}save();return 0;},
wi(){flow('W1 Unreleased WI -> Development WO -> release with ECO',()=>{const src=state.masterWIs.find(x=>x.id==='MWI-0010'&&x.status==='Released');
   const r=st('ME','create WI to unreleased drawing',5,()=>MES.addMasterWI(state,{partNumber:src.partNumber,partRevision:src.partRevision,title:'Harness routing, preliminary drawing',drawingStatus:'unreleased',drawingRef:src.partNumber+' Rev X3 (preliminary)'}));
   const w=MES.findWI(state,r.id,r.revision);w.operations=JSON.parse(JSON.stringify(src.operations));
   st('ME','peer review',0,()=>MES.peerReviewMasterWI(state,w.id,w.revision));st('QA','approve as Unreleased',0,()=>MES.releaseMasterWI(state,w.id,w.revision));
   check('status Unreleased',MES.findWI(state,w.id,w.revision).status==='Unreleased',MES.findWI(state,w.id,w.revision).status);
   gate('Production WO on an Unreleased WI',c=>MES.addOrder(c,{masterWI:w.id+'|'+w.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],priority:'Normal',site:MES.SITES[0],start:today(0),due:today(7),fai:false,faiWaiver:'x'}));
   const o=mk(w.id,1,{pedigree:'Development',fai:false,faiWaiver:'Dev build to preliminary drawing.'});issue(o);build(o);finish(o);
   gate('release without ECO',c=>MES.releaseUnreleasedWI(c,w.id,w.revision,{matches:true}));
   st('QA','release against drawing ECO',2,()=>MES.releaseUnreleasedWI(state,w.id,w.revision,{eco:'ECO-3001',matches:true}));end('WI '+MES.findWI(state,w.id,w.revision).status+', WO '+O(o.id).status);});
 flow('W2 MCR incorporated into new WI revision, released with ECO',()=>{const w=state.masterWIs.find(x=>x.id==='MWI-0009'&&x.status==='Released');
   gate('MCR without operation',c=>MES.submitECRRequest(c,{type:'process',wiId:w.id,wiRevision:w.revision,title:'x',description:'x',reason:'x'}));
   const m=st('Operator','submit MCR on an operation',5,()=>MES.submitECRRequest(state,{type:'process',wiId:w.id,wiRevision:w.revision,opId:w.operations[1].id,title:'State torque unit',description:'Add in-lb to step B.',reason:'Floor query.'}));
   const rv=st('ME','revise WI',0,()=>MES.reviseMasterWI(state,w.id,w.revision));const nw=state.masterWIs.find(x=>x.id===w.id&&x.status==='Draft');
   st('ME','incorporate MCR',1,()=>{MES.incorporateECRs(state,w.id,nw.revision,[m.id]);return {ok:true};});
   st('ME','peer review',0,()=>MES.peerReviewMasterWI(state,w.id,nw.revision));gate('release without ECO',c=>MES.releaseMasterWI(c,w.id,nw.revision,{}));
   st('QA','release with ECO',1,()=>MES.releaseMasterWI(state,w.id,nw.revision,{eco:'ECO-3002'}));end('WI '+MES.findWI(state,w.id,nw.revision).status+', MCR '+(state.ecrRequests.find(e=>e.id===m.id)||{}).status);});
 return 0;}
};})();
