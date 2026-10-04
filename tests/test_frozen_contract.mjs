// The frozen contract. Fails if a storage key, a form number, a separation-of-duties rule or the fields an
// approval records change. Saved workspaces, printed forms and the traceability story depend on these, and
// the separation-of-duties rules exist for AS9100 and 14 CFR Part 21 reasons. Changing any of them is a
// decision for the quality organization, not a refactor: if this test fails, put the rule back.
//
// Part 1 pins the source of each rule in index.html. Part 2 drives the production build and checks the
// refusal paths that are not already exercised by another suite.
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const ROOT=path.resolve(TESTS,'..');
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const src=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const has=(label,text,count)=>{const n=src.split(text).length-1;ok(label,count===undefined?n>=1:n===count,`found ${n} of: ${text.slice(0,120)}`);};

// ---- storage keys ----
has('work order store key is skyryse-mes-work-order-v1',"const KEY='skyryse-mes-work-order-v1';",1);
has('account store key is skyryse-mes-auth-v1',"var AUTH_KEY = 'skyryse-mes-auth-v1'");
has('mirror queue key is skyryse-mes-sync-queue-v1',"var QUEUE_KEY = 'skyryse-mes-sync-queue-v1'",1);
ok('no other versions of the frozen keys',!/skyryse-mes-(work-order|auth|sync-queue)-v(?!1\b)\d/.test(src));

// ---- form numbers ----
for(const f of ['F-850-001','F-860-004','AS9102','8130-9','8130-3']) has(`form number ${f} is present`,f);
has('the traveler prints as F-850-001','<title>F-850-001 Traveler');
has('the FAIR is AS9102 Rev C','AS9102 Rev C');
has('8130-9 is the statement of conformity','FAA Form 8130-9');
ok('no renamed traveler form number',!/F-850-00[02-9]\b/.test(src));

// ---- separation of duties, as written in the engine ----
const SOD=[
  ['the author of a WI cannot release it (rule)',"const wiAuthorRefusal = (state, wi) => wiAuthors(wi).has(actor(state).credentialId) ?",1],
  ['the author rule guards QA release, release against the ECO and the Safety Team release',"{ const own = wiAuthorRefusal(state, wi); if (own) return own; }",3],
  ['the author of a WI cannot record its peer review',"    { const own = wiPeerReviewRefusal(state, wi); if (own) return own; }",1],
  ['the peer reviewer cannot release the WI',"if (wi.peerReview.credentialId === actor(state).credentialId) return fail('The peer reviewer cannot also release the WI.');",1],
  ['the peer reviewer cannot record the QA review',"if (wi.peerReview.credentialId === actor(state).credentialId) return fail('The peer reviewer cannot also record the QA review.');",1],
  ['the requester of a closure cannot approve it',"if (req.requestedBy?.credentialId === who.credentialId) return fail('The person who requested the closure can’t approve or reject it.');",1],
  ['the requester of an engineering change cannot approve it',"const selfApprovalMessage = 'The requester cannot approve their own engineering change. Use a different QA credential.';",1],
  ['one person holds one MRB seat',"if (m.votes.some(v => v.seat !== seat && sameActor(v.by, who))) return fail('Separation of duties: one person holds one seat on a board.');",1],
  // QA Manager decision (2026-09-26): the person who completed the 8130-9 may sign as AQI only after an acknowledged warning, and it is recorded.
  ['the 8130-9 preparer signs as AQI only after acknowledging a warning',"if (selfSigned && !(execution && (execution.selfSignAck === true || execution.selfSignAck === 'on'))) return { ok: false, warning: 'aqi-self-sign',",1],
  ['an AQI self-signature is recorded on the signature and in the manifest',"...(selfSigned ? { selfSigned: true } : {}), manifest: signManifest(state, 'FAA Form 8130-9 Signature of Certifier",1],
  ['Development NFF never gets a conformity package, 8130-9 or 8130-3',"if (o && o.pedigree === NFF) return nffBlock('it cannot have an LRU conformity package, an 8130-9 statement of conformity or an 8130-3');",1],
  ['Development NFF never goes into a Production or Development order',"if (child && child.pedigree === NFF && parent.pedigree !== NFF) return nffBlock(",1],
  ['Development NFF is never an FAI order and never carries a FAIR',"if (order.pedigree === NFF) return { error: nffBlock('it cannot be an FAI order or carry a FAIR').message };",1],
  ['Development NFF pedigree is one way',"if (order.pedigree === NFF) return nffBlock('its pedigree cannot be changed; build a new order at the pedigree you need');",1],
  ['the own-work exception is Development NFF only',"const OWN_WORK_EXEMPT_PEDIGREES = Object.freeze(['Development NFF']);",1],
  ['inspection is role-gated on every inspection operation',"const stepsDenied = (operation, what) => isInspectionOp(operation) ? (can('inspect-steps') ? null : fail(`A current Quality inspection stamp assigned to your account is required to ${what}. Ask a QA Manager to assign or renew your stamp.`))",1],
  ['inspection capability requires a valid assigned Quality stamp',"function hasValidInspectionStamp(state, username, at = new Date().toISOString())",1],
  ['nobody grants their own authority',"if(u.username===me.username)return {ok:false,message:'Nobody grants or revokes their own authority.",1],
  ['nobody changes their own roles',"if(username===me.username)return {ok:false,message:'Nobody changes their own roles. Another QA Manager, Quality Supervisor, or Master Access account must do it.'};",1],
  ['nobody changes their own primary role from the access table',"if(u.username===me.username){sel.value=primaryRole(u);say('Nobody changes their own roles.",1],
  ['nobody records their own training',"if (account === signedInAccount()) return fail('Nobody records their own training.",1],
  ['nobody issues a stamp to their own account',"if (account && account === signedInAccount()) return fail('Nobody issues a stamp to their own account.",1],
  ['nobody assigns a stamp to their own account',"return fail('Nobody assigns a stamp to their own account.",1],
  ['nobody changes their own stamp beyond suspending or retiring it',"if (me && stamp.account === me && !Object.keys(patch || {}).every(key => key === 'status' && ['Suspended', 'Retired'].includes(patch.status))) return fail('Nobody changes their own stamp.",1],
  ['a grant needs a current training record',"if(!trainingOk(u,trainingCode))return {ok:false,message:u.displayName+' has no current '+trainingCode+' training record. Record the training first, then grant.'};",1],
  ['only conformity and AQI signatures require named grants',"var GRANTED=['conformity','aqi-sign'];",1],
  ['the person who recorded a disposition cannot approve it (work order NC and stock NC)',"=== actor(state).credentialId) return fail('Separation of duties: the person who recorded the disposition cannot approve it.');",2],
  ['the person who recorded a root cause cannot close the CAR',"if (sameActor(who, car.rootCause.by)) return fail('Separation of duties: the person who recorded the root cause cannot close the request. Use another Quality credential.');",1],
  ['an author of the PFMEA cannot give the Safety Team buy-off',"if (t.rows.some(r => r.by && r.by.credentialId === actor(state).credentialId)) return fail('Separation of duties: an author of the analysis cannot give the Safety Team buy-off.');",1],
  ['the author of a standard rework cannot approve it',"if (author.credentialId && author.credentialId === actor(state).credentialId) return fail('The person who wrote or last edited this standard rework can’t approve it.",1],
  ['an unchecked step keeps its performer for the own-work rule',"const performersOf = op => [op.buyoff, ...Object.values(plain(op.stepChecks) ? op.stepChecks : {}), ...(Array.isArray(op.stepPerformers) ? op.stepPerformers : [])].filter(plain);",1],
  ['a WI keeps every author, history-derived ones included',"const known = [...new Set([...list, ...wiAuthors(wi)])]; if (c && !known.includes(c)) known.push(c);",1],
  ['the WI history is never trimmed past an author who is not yet on the author list',"const wiLog = (state, wi, action) => { { const known = wiAuthors(wi),",1],
  ['a Master Access account cannot grant Support Access to itself (standalone)',"if(u.username===me.username)return {ok:false,message:'A Master Access account cannot grant Support Access to itself.'};",1],
  ['Support Access changes only after its log entry is saved',"if(detail.recorded!==true)return {ok:false,",1],
  ['nobody inspects their own work: buy-off',"    { const own = ownWorkRefusal(state, order, operation); if (own) return own; }",1],
  ['nobody inspects their own work: step check',"if (checked) { const own = ownWorkRefusal(state, order, operation); if (own) return own; }",1],
  ['the person who verified a FAIR cannot sign box 22',"    if (fair.verified && fair.verified.by && by.credentialId === fair.verified.by.credentialId) return fail('The FAI reviewer in box 22 is a second person.",1],
  ['the Skyryse QA approval of a FAIR waits for box 22',"    if (!plain(fair.reviewed)) return fail('Box 22 is not signed.",1],
  // #579: one stamp validity rule (issue date reached, Active, not expired, additional-stamp training current) for
  // operation buy-offs, the inspection capability and the FAIR, 8130-9 and AQI signatures.
  ['one stamp validity rule',"  function stampValidityProblem(holder, day, state) {",1],
  ['a buy-off stamp passes the stamp validity rule',"    { const problem = stampValidityProblem(holder, pacificDay(at)); if (problem) return fail(problem); }",1],
  ['the inspection capability uses the stamp validity rule',"!stampValidityProblem({ ...holderFromStamp(stamp), training: personTraining(state, account) }, day, state));",1],
  ['FAIR, 8130-9 and AQI signatures use the stamp validity rule',"const checked = mine.map(s => { const h = { ...holderFromStamp(s), training: personTraining(state, s.account) }; return { holder: h, problem: stampValidityProblem(h, day, state) }; });",1],
  ['an expired stamp does not sign',"if (holder.expires && (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(holder.expires)) || holder.expires < day)) return `${who} expired on ${holder.expires}.",1],
  ['a stamp does not sign before its issue date',"if (holder.since > day) return `${who} is not active until ${holder.since}.",1],
];
for(const [label,text,count] of SOD) has(label,text,count);

// ---- the same self-target refusal on the server access route ----
{const serverSrc=fs.readFileSync(path.join(ROOT,'server','server.mjs'),'utf8');const text="if (target.username === actor.username) return fail(403, 'Nobody changes their own roles. Another QA Manager, Quality Supervisor, or Master Access account must do it.');";const n=serverSrc.split(text).length-1;ok('the server refuses any account changing its own roles',n===1,`found ${n} of: ${text.slice(0,120)}`);}

// ---- what an approval records ----
has('a signature manifest names the signer, meaning, time, signed subject, SHA-256 and build',"return { meaning, at, signer, algorithm: 'SHA-256', hash: sha256(canonical(subject)), subject: JSON.parse(JSON.stringify(subject)), authenticated: false, build: buildStamp(),",1);
has('the signer is the signed-in account with its credential',"const signer = acct ? { name: acct.name, role: acct.role, credentialId: acct.credentialId, account: acct.account }",1);

// ---- #542: a work order in QA review is frozen; only a signed QA send back returns it to Building ----
has('the QA review freeze text',"const qaFreezeMessage = 'This work order is in QA review. Ask Quality to send it back to Building before changing it.';",1);
has('the QA review freeze is a status check on the order',"const qaFrozen = order => plain(order) && order.status === 'Quality' ? fail(qaFreezeMessage) : null;",1);
has('the freeze guards serials, file removal, engineering change, priority, AOG, schedule, ATP link, PO and project link',"{ const frozen = qaFrozen(order); if (frozen) return frozen; }",14);
has('serial auto-assign skips a work order in QA review',"if (!isSerialized(order.partNumber) || order.sourceBuild || qaFrozen(order)) return [];",1);
has('only Quality adds evidence files in QA review',"if (order.status === 'Quality' && !can('approve-wo') && !can('inspect-steps')) return fail(qaFreezeMessage);",1);
has('only the Quality role (approve-wo) sends a work order back',"{ const d = denied('approve-wo', 'send a work order back to Building'); if (d) return d; }",1);
has('a send back starts only from Quality',"if (order.status !== 'Quality') return fail(`Only a work order in QA review can be sent back to Building.",1);
has('a send back needs a rationale of 1 to 300 characters',"if (!rationale || rationale.length > 300) return fail('Enter the rationale for sending the work order back to Building (1 to 300 characters).');",1);
has('the send-back signature binds the order, its revisions, the rationale, the NC, the statuses, the signer and the time',"const sendBackSubject = (order, entry) => ({ orderId: order.id, sendBackId: entry.id, revision: entry.revision, woRev: entry.woRev, rationale: entry.rationale, ticketId: entry.ticketId, from: entry.from, to: entry.to, by: entry.by && entry.by.credentialId, at: entry.at });",1);
has('a send back is signed with a SHA-256 manifest',"entry.manifest = signManifest(state, SEND_BACK_MEANING, sendBackSubject(order, entry), at);",1);
has('validation rechecks every send back',"    if (!sendBacksValid(order)) return false;",1);
has('manifest verification rechecks every send back',"recheck(`${order.id} ${e.id} send back`, e.manifest, sendBackSubject(order, e));",1);
has('the order keeps a bounded send-back list',"const SEND_BACK_MAX = 20;",1);
has('a split never copies the signed send backs onto the new order',"    delete child.sendBacks;",2);
// #706: Review & close is an approval, so it writes a signed record (AGENTS.md rule 2) that validation and manifest verification recheck.
has('Review & close signs the quality review with a SHA-256 manifest',"qualityClose.manifest = signManifest(state, QUALITY_CLOSE_MEANING, qualityCloseSubject(order, qualityClose), at);",1);
has('validation rechecks the signed quality review closure',"    if (!qualityCloseValid(order)) return false;",1);
has('manifest verification rechecks the signed quality review closure',"recheck(`${order.id} quality close`, order.qualityClose.manifest, qualityCloseSubject(order, order.qualityClose));",1);
{const serverSrc=fs.readFileSync(path.join(ROOT,'server','mes-host.mjs'),'utf8');ok('the server allows MES.sendBackToBuilding as a reviewed action',serverSrc.split("'MES.sendBackToBuilding'").length-1===1&&src.split("'MES.sendBackToBuilding'").length-1===1);}

// ---- the production build ----
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const run=(fn,a)=>p.evaluate(fn,a);
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1';
const as=u=>run(([S,u])=>sessionStorage.setItem(S,u),[SESSION,u]);
await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.requestSubmit();});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  add('radmin','Rowan Admin','admin');add('kqe','Kai Quality','qe');add('tme','Taylor Engineer','me');localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

ok('Support Access lifts stamp binding only; MRB seats and separation of duties cannot be overridden',await run(()=>JSON.stringify(Object.keys(MES.SUPPORT_RULES).sort())==='["stamp-binding"]'));

// Master Access writes a revision; a second Master Access account peer-reviews it.
await as('jdoe');
const wi=await run(()=>{const w=state.masterWIs.find(x=>x.status==='Released'&&x.criticalSafety!==true&&!state.masterWIs.some(y=>y.id===x.id&&y.status==='Draft'));const r=MES.reviseMasterWI(state,w.id,w.revision);if(!r.ok)return {error:r.message};const u=MES.updateMasterWI(state,r.id,r.revision,{title:w.title+' (rev)'});return {id:r.id,revision:r.revision,edited:u.ok,authors:MES.findWI(state,r.id,r.revision).authors};});
ok('editing a WI revision records its author',wi.edited&&Array.isArray(wi.authors)&&wi.authors.length===1,JSON.stringify(wi));
const selfPeer=await run(w=>MES.peerReviewMasterWI(structuredClone(state),w.id,w.revision),wi);
ok('the author cannot record the peer review, even with Master Access',!selfPeer.ok&&/so you cannot peer-review it/.test(selfPeer.message),JSON.stringify(selfPeer));
await as('radmin');
const peer=await run(w=>MES.peerReviewMasterWI(state,w.id,w.revision),wi);
ok('a second person records the peer review',peer.ok,JSON.stringify(peer));
const byPeer=await run(w=>MES.releaseMasterWI(structuredClone(state),w.id,w.revision,{eco:'ECO-1234'}),wi);
ok('the peer reviewer cannot release the WI, even with Master Access',!byPeer.ok&&/peer reviewer cannot also release/.test(byPeer.message),JSON.stringify(byPeer));
await as('jdoe');
const byAuthor=await run(w=>MES.releaseMasterWI(structuredClone(state),w.id,w.revision,{eco:'ECO-1234'}),wi);
ok('the author cannot release the WI, even with Master Access',!byAuthor.ok&&/you edited .* so you cannot release it/.test(byAuthor.message),JSON.stringify(byAuthor));
const legacy=await run(w=>{const c=structuredClone(state);const x=MES.findWI(c,w.id,w.revision);delete x.authors;return MES.releaseMasterWI(c,w.id,w.revision,{eco:'ECO-1234'});},wi);
ok('a revision saved before authors were recorded still refuses its author (from the history)',!legacy.ok&&/you edited/.test(legacy.message),JSON.stringify(legacy));
await as('kqe');
const byQE=await run(w=>{const r=MES.releaseMasterWI(state,w.id,w.revision,{eco:'ECO-1234'});return {r,status:MES.findWI(state,w.id,w.revision).status,valid:MES.validate(state)};},wi);
ok('an independent Quality credential releases it',byQE.r.ok&&byQE.status==='Released'&&byQE.valid,JSON.stringify(byQE));

// Saving operations counts as authorship: jdoe starts the revision, radmin edits the operations and
// a Manufacturing Engineer peer-reviews. radmin cannot release.
await as('jdoe');
const ops=await run(()=>{const w=state.masterWIs.find(x=>x.status==='Released'&&x.criticalSafety!==true&&!state.masterWIs.some(y=>y.id===x.id&&y.status==='Draft'));const r=MES.reviseMasterWI(state,w.id,w.revision);return r.ok?{id:r.id,revision:r.revision}:{error:r.message};});
await as('radmin');
const opsEdit=await run(w=>{const x=MES.findWI(state,w.id,w.revision);const s=MES.saveWIOperations(state,w.id,w.revision,structuredClone(x.operations));return {s,authors:MES.findWI(state,w.id,w.revision).authors};},ops);
await as('tme');
const qePeer=await run(w=>MES.peerReviewMasterWI(state,w.id,w.revision),ops);
await as('radmin');
const editorRelease=await run(w=>MES.releaseMasterWI(structuredClone(state),w.id,w.revision,{eco:'ECO-1234'}),ops);
ok('a person who saved the operations cannot release that revision',opsEdit.s.ok&&opsEdit.authors.length===2&&!editorRelease.ok&&/you edited/.test(editorRelease.message),JSON.stringify({opsEdit,qePeer,editorRelease}));

// #542 on the production build: a Quality order refuses changes even for Master Access, and only Quality sends it back.
await as('jdoe');
// The production fixture ships no orders, so the curated sample's Quality order is put into a copy of its workspace.
const qaOrder=JSON.parse(fs.readFileSync(FIXTURES+'demo_publish.html','utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]).orders.find(x=>x.status==='Quality');
await run(()=>{window.__withQA=o=>{const c=structuredClone(state);c.orders=[...(c.orders||[]).filter(x=>x.id!==o.id),structuredClone(o)];return c;};});
const qa=await run((o)=>{const c=window.__withQA(o);if(!MES.validate(c))return null;return {id:o.id,priority:MES.setPriority(c,o.id,o.priority==='High'?'Normal':'High'),serial:MES.assignSerial(c,o.id,'')};},qaOrder);
ok('a production workspace with a work order in QA review is valid',!!qa,'invalid');
if(qa){
  ok('Master Access cannot change a work order in QA review',!qa.priority.ok&&!qa.serial.ok&&qa.priority.message===qa.serial.message&&/This work order is in QA review/.test(qa.priority.message),JSON.stringify(qa));
  await as('tme');
  const byME=await run((o)=>MES.sendBackToBuilding(window.__withQA(o),o.id,{rationale:'Rework needed.'}),qaOrder);
  ok('Manufacturing Engineering cannot send a work order back to Building',!byME.ok&&/Your role cannot send a work order back to Building/.test(byME.message),JSON.stringify(byME));
  await as('kqe');
  const back=await run((o)=>{const c=window.__withQA(o);const r=MES.sendBackToBuilding(c,o.id,{rationale:'Rework needed.'});return {r,status:MES.getOrder(c,o.id).status,valid:MES.validate(c),verified:MES.verifyManifests(c).ok};},qaOrder);
  ok('Quality sends it back to Building with a signed, valid record',back.r.ok&&back.status==='Building'&&back.valid&&back.verified,JSON.stringify(back));
}

// Every approval writes person, credential, time and a SHA-256 manifest.
const m=await run(()=>MES.signManifest(state,'Contract check',{x:1},new Date().toISOString()));
ok('a manifest carries person, credential, time, algorithm and hash',!!m.signer.name&&!!m.signer.credentialId&&!Number.isNaN(Date.parse(m.at))&&m.algorithm==='SHA-256'&&/^[0-9a-f]{64}$/.test(m.hash),JSON.stringify(m));
ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));

await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
