// Item 7: the persistence mirror. Server: append-only, idempotent, hash-chained, tamper evident, backed
// up and restorable. App: off by default; when on, queues every committed write, posts it, survives the
// server being down (queue, flag, retry with backoff, recover) and never sends a password or PIN hash.
import {chromium} from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {spawnSync} from 'child_process';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
// This suite switches the mirror on and off itself, so it always loads the shipped fixtures (mirror off),
// never the copies run-suites --mirror makes with SK_MIRROR already set.
const FIXTURES=TESTS+'fixtures/';
const ROOT=path.resolve(TESTS,'..');
const {createMirror,settings,sha256,verifyChain,pruneBackups,readAnchor,startRefusal,ackCheck,anchorMismatch}=await import(path.join(ROOT,'server/mirror/server.mjs'));
const PROD='file://'+FIXTURES+'publish.html';
const STAMP=(h=>({build:h.match(/<meta name="fs-build" content="([^"]*)">/)[1],sha256:h.match(/<meta name="fs-build-sha256" content="([^"]*)">/)[1]}))(fs.readFileSync(FIXTURES+'publish.html','utf8'));
const legacyMeta=db=>{try{return (db.prepare("SELECT value FROM mirror_meta WHERE key='legacy_through'").get()||{}).value;}catch(e){return 'no mirror_meta: '+e.message;}};
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fs-mirror-test-'));
const dbPath=path.join(tmp,'mirror.sqlite'),backupDir=path.join(tmp,'backups');

// ================= server =================
// The mirror refuses to start without its tokens; the suite runs it the way IT does: an operator token that stays
// with the operator, a separate write token the page carries, and the app's origin.
const TOKEN='mirror-suite-operator-token',WTOKEN='mirror-suite-write-token',AUTH={authorization:'Bearer '+TOKEN},WAUTH={authorization:'Bearer '+WTOKEN},SECURE={token:TOKEN,writeToken:WTOKEN,allowOrigin:'*'};
const get=(u,o={})=>fetch(u,{...o,headers:{...AUTH,...(o.headers||{})}});
let m=createMirror({dbPath,backupDir,port:0,backupEveryMinutes:0,...SECURE});
const addr=await m.listen();const PORT=addr.port;const API=`http://127.0.0.1:${PORT}/api/v1`;
const rec=(i,x=i)=>{const payload=JSON.stringify({id:'WO-'+i,value:x});return {clientWriteId:'srv-'+i,storeKey:'skyryse-mes-work-order-v1',entityType:'order',entityId:'WO-'+i,operation:'upsert',payloadJson:payload,payloadSha256:sha256(payload),actor:'Test · ACCT-test',credential:'ACCT-test',clientTs:new Date().toISOString(),buildVersion:'test',buildSha256:'0'.repeat(64),manifests:[{path:'order.closure.manifest',meaning:'Closure approval: Obsolete',signerName:'Test',signerCredential:'ACCT-test',signedAt:new Date().toISOString(),algorithm:'SHA-256',hash:sha256('m'+i)}]};};
const post=async(body,headers={})=>{const r=await get(API+'/writes',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
let r=await post({clientId:'srv',records:[rec(1),rec(2),rec(3)]});
ok('a batch is stored in one request',r.status===200&&r.json.results.every(x=>x.status==='stored'),JSON.stringify(r.json));
r=await post({clientId:'srv',records:[rec(2),rec(3),rec(4)]});
ok('a retried batch is idempotent: stored records come back as duplicates and only the new one is added',JSON.stringify(r.json.results.map(x=>x.status))==='["duplicate","duplicate","stored"]',JSON.stringify(r.json.results));
r=await post({clientId:'srv',records:[rec(2,99)]});
ok('reusing a clientWriteId for a different payload is rejected',r.json.results[0].status==='rejected'&&/different payload/.test(r.json.results[0].reason),JSON.stringify(r.json.results));
r=await post({clientId:'srv',records:[{...rec(5),payloadSha256:'f'.repeat(64)}]});
ok('a payload whose hash does not match is rejected',r.json.results[0].status==='rejected'&&/does not match/.test(r.json.results[0].reason),JSON.stringify(r.json.results));
r=await post({clientId:'srv',records:[{...rec(6),manifests:[{path:'x',meaning:'y',signerName:'z',signerCredential:'c',signedAt:'t',algorithm:'MD5',hash:'1'}]}]});
ok('a malformed signature manifest is rejected',r.json.results[0].status==='rejected',JSON.stringify(r.json.results));
const health=await (await get(API+'/health')).json();
ok('health reports the rows, the manifests and the backup settings',health.ok&&health.records===4&&health.manifests===4&&health.backup&&health.api==='v1',JSON.stringify(health));
let v=await (await get(API+'/verify')).json();
ok('verify walks an intact chain',v.chainIntact===true&&v.records===4&&v.firstBreak===null&&/^[0-9a-f]{64}$/.test(v.tip),JSON.stringify(v));
const back=await (await get(API+'/records?entity=order&id=WO-2')).json();
ok('records read-back returns one entity with its manifests',back.records.length===1&&back.records[0].manifests.length===1&&back.records[0].entity_id==='WO-2',JSON.stringify(back).slice(0,300));
ok('records read-back without entity and id is refused with the next step',(await get(API+'/records?entity=order')).status===400);
const exp=await (await get(API+'/export?format=json')).json();
ok('JSON export carries every record, its manifests and a verify result',exp.records.length===4&&exp.records.every(x=>x.manifests.length===1)&&exp.verify.ok,JSON.stringify(exp).slice(0,200));
const csvRes=await get(API+'/export?format=csv');const csv=await csvRes.text();
{const lines=csv.trim().split('\r\n'),head=lines[0].split(','),cell=(l,c)=>l.split(',').slice(-2)[['chain_anchor_records','chain_anchor_tip'].indexOf(c)];
 ok('CSV export carries the chain anchor on its last row, so a removed suffix or a rewritten last row shows in the file',head.slice(-2).join()==='chain_anchor_records,chain_anchor_tip'&&cell(lines[4],'chain_anchor_records')==='4'&&cell(lines[4],'chain_anchor_tip')===v.tip&&cell(lines[1],'chain_anchor_tip')==='',lines[4].slice(-160));
 ok('JSON export carries the chain anchor it was verified against',exp.anchor&&exp.anchor.records===4&&exp.anchor.tip===v.tip,JSON.stringify(exp.anchor));}
ok('CSV export has a header and one line per record, with manifests_sha256 so the chain can be recomputed',csv.trim().split('\r\n').length===5&&csv.startsWith('id,client_write_id')&&csv.split('\r\n')[0].split(',').includes('manifests_sha256')&&/attachment/.test(csvRes.headers.get('content-disposition')||''),csv.slice(0,120));
let refused='';try{m.db.exec("UPDATE records SET actor='x' WHERE id=1");}catch(e){refused=e.message;}
ok('the database refuses UPDATE on records',/append-only/.test(refused),refused);
refused='';try{m.db.exec('DELETE FROM signature_manifests WHERE id=1');}catch(e){refused=e.message;}
ok('the database refuses DELETE on signature manifests',/append-only/.test(refused),refused);
ok('WAL mode is on',m.db.prepare('PRAGMA journal_mode').get().journal_mode==='wal');

// Backup, then restore: the restored copy reproduces the chain exactly.
const bk=m.backup();
const rt=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),bk,'--against',dbPath],{encoding:'utf8'});
ok('the restore test passes on a fresh backup and matches the live rows',rt.status===0&&/chain intact/.test(rt.stdout)&&/matches the first 4 of 4/.test(rt.stdout),rt.stdout+rt.stderr);
{const restored=path.join(tmp,'restored.sqlite');fs.copyFileSync(bk,restored);fs.copyFileSync(bk+'.anchor.json',restored+'.anchor.json');const m2=createMirror({dbPath:restored,backupDir:path.join(tmp,'b2'),port:0,backupEveryMinutes:0,...SECURE});const a2=await m2.listen();
 const v2=await (await get(`http://127.0.0.1:${a2.port}/api/v1/verify`)).json();
 ok('a server started on the restored file reproduces the chain tip',v2.chainIntact&&v2.tip===v.tip&&v2.records===4,JSON.stringify({v2,tip:v.tip}));
 const more=await (await get(`http://127.0.0.1:${a2.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'srv',records:[rec(7)]})})).json();
 ok('writes continue on the restored database and the chain stays intact',more.results[0].status==='stored'&&verifyChain(m2.db).ok);await m2.close();}
// Retention: newest copy per day, nothing older than the keep window.
{const d=path.join(tmp,'retention');fs.mkdirSync(d);const now=new Date('2026-09-30T12:00:00Z');['2026-08-01T010000Z','2026-09-29T010000Z','2026-09-29T230000Z','2026-09-30T010000Z'].forEach(s=>fs.writeFileSync(path.join(d,`flight-system-mirror-${s}.sqlite`),'x'));
 pruneBackups(d,30,now);const left=fs.readdirSync(d).sort();
 ok('retention keeps the newest copy of each day inside the window',JSON.stringify(left)===JSON.stringify(['flight-system-mirror-2026-09-29T230000Z.sqlite','flight-system-mirror-2026-09-30T010000Z.sqlite']),JSON.stringify(left));}
// A tampered row is found: the first break is reported by id.
{const t=path.join(tmp,'tamper.sqlite');fs.copyFileSync(bk,t);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(t);db.exec('DROP TRIGGER records_no_update');db.exec(`UPDATE records SET payload_json='{"id":"WO-2","value":1000}' WHERE id=2`);
 const tv=verifyChain(db);ok('verify detects a tampered payload and names the first broken row',!tv.ok&&tv.firstBreak.id===2&&/changed after it was written/.test(tv.firstBreak.reason),JSON.stringify(tv));
 db.exec(`UPDATE records SET payload_json='{"id":"WO-2","value":2}', actor='Someone else' WHERE id=2`);
 const tv2=verifyChain(db);ok('verify detects an edited column by the break in the next row',!tv2.ok&&tv2.firstBreak.id===3&&/previous row/.test(tv2.firstBreak.reason),JSON.stringify(tv2));db.close();
 const rt2=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),t],{encoding:'utf8'});ok('the restore test fails on a tampered backup',rt2.status===1&&/BROKEN/.test(rt2.stdout),rt2.stdout);}
await m.close();
// Token: every endpoint but health needs the operator token; the write token (the one in the page) only appends.
{const mt=createMirror({dbPath:path.join(tmp,'tok.sqlite'),backupDir:path.join(tmp,'b3'),port:0,backupEveryMinutes:0,token:TOKEN,writeToken:WTOKEN});const at=await mt.listen();const u=`http://127.0.0.1:${at.port}/api/v1`;
 const no=await fetch(u+'/verify');const yes=await fetch(u+'/verify',{headers:AUTH});const h=await fetch(u+'/health');
 ok('with a token set, requests without it are refused and health stays open',no.status===401&&yes.status===200&&h.status===200);
 const wpost=await fetch(u+'/writes',{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'w',records:[rec(40)]})});
 ok('the write token appends records',wpost.status===200&&(await wpost.json()).results[0].status==='stored');
 const nopost=await fetch(u+'/writes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'w',records:[rec(41)]})});
 ok('a write with no token is refused',nopost.status===401);
 const wread=await Promise.all(['/verify','/export?format=json','/export?format=csv','/records?entity=order&id=WO-40'].map(x=>fetch(u+x,{headers:WAUTH})));
 const wbody=await wread[0].json();
 ok('the write token cannot verify, export or read records back',wread.every(r=>r.status===401)&&/operator token/.test(wbody.error.message),JSON.stringify(wread.map(r=>r.status)));
 const wh=await (await fetch(u+'/health',{headers:WAUTH})).json();
 ok('health with the write token says only that the mirror is up',JSON.stringify(Object.keys(wh).sort())==='["api","ok"]',JSON.stringify(wh));
 await mt.close();}
// Start refusals: the page token must be a separate append-only token, and plain HTTP stays on loopback.
{const base={dbPath:path.join(tmp,'refuse.sqlite'),backupDir:path.join(tmp,'b8'),port:0,backupEveryMinutes:0};
 const refusal=o=>{try{const x=createMirror({...base,...o});x.db.close();return '';}catch(e){return e.message;}};
 ok('the mirror refuses to start with an operator token and no write token',/FS_MIRROR_WRITE_TOKEN/.test(refusal({token:TOKEN})),refusal({token:TOKEN}));
 ok('the mirror refuses a write token equal to the operator token',/must differ/.test(refusal({token:TOKEN,writeToken:TOKEN})));
 ok('the mirror refuses short tokens',/at least 16 characters/.test(refusal({token:'s3cret',writeToken:'w3cret'})));
 ok('the mirror refuses to listen beyond loopback in plain HTTP',/TLS-terminating reverse proxy/.test(refusal({...SECURE,host:'0.0.0.0'})),refusal({...SECURE,host:'0.0.0.0'}));
 ok('beyond loopback is allowed once a TLS proxy is stated',refusal({...SECURE,host:'0.0.0.0',behindTlsProxy:true})==='');
 ok('running with no token is refused beyond loopback, even behind a proxy',/only on loopback/.test(refusal({allowNoToken:true,host:'0.0.0.0',behindTlsProxy:true})));
 ok('a malformed numeric host is not loopback, so tokenless mode is refused there',/only on loopback/.test(startRefusal({allowNoToken:true,host:'127.999.999.999'})||'')&&startRefusal({allowNoToken:true,host:'127.0.0.2'})===null&&startRefusal({...SECURE,host:'127.1.2.300'})!==null,String(startRefusal({allowNoToken:true,host:'127.999.999.999'})));
 ok('loopback names are recognised',[ '127.0.0.1','127.0.0.2','localhost','::1'].every(h=>startRefusal({...SECURE,host:h})===null)&&startRefusal({...SECURE,host:'10.0.0.5'})!==null);
 ok('the environment names the write token, the proxy statement and the anchor',(()=>{const e=settings([],{FS_MIRROR_WRITE_TOKEN:'w',FS_MIRROR_BEHIND_TLS_PROXY:'1',FS_MIRROR_ANCHOR:'/x/a.json'});return e.writeToken==='w'&&e.behindTlsProxy===true&&e.anchorPath==='/x/a.json';})());}

// Chain anchor and signature manifests in the chain. Each case is a copy of a backup with its anchor.
{const {DatabaseSync}=await import('node:sqlite');
 const fresh=path.join(tmp,'anchor.sqlite');const ma=createMirror({dbPath:fresh,backupDir:path.join(tmp,'b9'),port:0,backupEveryMinutes:0,...SECURE});const aa=await ma.listen();const ua=`http://127.0.0.1:${aa.port}/api/v1`;
 const pa=b=>fetch(ua+'/writes',{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify(b)}).then(r=>r.json());
 const first=await pa({clientId:'anc',records:[rec(50),rec(51),rec(52)]});
 ok('an anchor is written next to the database and follows every stored batch',readAnchor(fresh+'.anchor.json')?.records===3&&readAnchor(fresh+'.anchor.json').tip===ma.verify().tip&&ma.verify().ok,JSON.stringify(readAnchor(fresh+'.anchor.json')));
 // lastAck: the newest confirmed row is still there, or it is not (a restored server).
 const top=first.results[2];
 const kept=await pa({clientId:'anc',lastAck:{id:top.id,clientWriteId:'srv-52'},records:[rec(53)]});
 ok('a post naming a confirmed row the server holds is answered ackCheck ok',kept.ackCheck==='ok',JSON.stringify(kept));
 const lost=await pa({clientId:'anc',lastAck:{id:99,clientWriteId:'srv-99'},records:[rec(54)]});
 ok('a post naming a confirmed row the server no longer holds is answered ackCheck missing',lost.ackCheck==='missing'&&lost.results[0].status==='stored',JSON.stringify(lost));
 ok('a row id holding a different write is missing too',ackCheck(ma.db,{id:top.id,clientWriteId:'someone-else'})==='missing'&&ackCheck(ma.db,undefined)===undefined);
 // Every result carries the stored row's chain link; an acknowledgement naming it is checked against the row's
 // content, so a row with the same id and clientWriteId but anything else changed is missing (r4161702700).
 {const row=ma.db.prepare('SELECT * FROM records WHERE id=?').get(top.id);const {linkHash}=await import(path.join(ROOT,'server/mirror/server.mjs'));
  ok('each stored result names the row\'s chain link',first.results.every(x=>/^[0-9a-f]{64}$/.test(x.link||''))&&top.link===linkHash(row),JSON.stringify(first.results[2]));
  const dup=await pa({clientId:'anc',records:[rec(52)]});
  ok('a duplicate result names the stored row\'s link too',dup.results[0].status==='duplicate'&&dup.results[0].link===top.link,JSON.stringify(dup.results[0]));
  ok('an acknowledgement with the row\'s link is ok',ackCheck(ma.db,{id:top.id,clientWriteId:'srv-52',link:top.link})==='ok');
  const other=first.results[1].link;
  ok('the refusal case is real: id and clientWriteId alone still match',ackCheck(ma.db,{id:top.id,clientWriteId:'srv-52'})==='ok');
  ok('an acknowledgement whose link the row no longer has is missing, and a malformed link is missing',ackCheck(ma.db,{id:top.id,clientWriteId:'srv-52',link:other})==='missing'&&ackCheck(ma.db,{id:top.id,clientWriteId:'srv-52',link:'x'})==='missing');
  const probed=await pa({clientId:'anc',lastAck:{id:top.id,clientWriteId:'srv-52',link:other},records:[]});
  ok('a probe naming a changed row is answered missing',probed.ackCheck==='missing',JSON.stringify(probed));}
 const bka=ma.backup();await ma.close();
 const copy=(n,keepTriggers)=>{const f=path.join(tmp,n+'.sqlite');fs.copyFileSync(bka,f);fs.copyFileSync(bka+'.anchor.json',f+'.anchor.json');if(keepTriggers)return {f};const db=new DatabaseSync(f);['records_no_update','records_no_delete','manifests_no_update','manifests_no_delete'].forEach(t=>db.exec('DROP TRIGGER '+t));return {f,db,anchor:readAnchor(f+'.anchor.json')};};
 {const {db,anchor}=copy('intact');const r=verifyChain(db,{anchor});ok('an intact copy verifies against its anchor',r.ok&&r.records===5,JSON.stringify(r));db.close();}
 {const {f,db,anchor}=copy('trunc');db.exec('DELETE FROM signature_manifests WHERE record_id=(SELECT MAX(id) FROM records)');db.exec('DELETE FROM records WHERE id=(SELECT MAX(id) FROM records)');
  const self=verifyChain(db);const r=verifyChain(db,{anchor});
  ok('without the anchor a truncated chain still looks intact (the refusal case is real)',self.ok,JSON.stringify(self));
  ok('with the anchor, rows removed from the end are found',!r.ok&&/removed from the end/.test(r.firstBreak.reason),JSON.stringify(r));db.close();
  const rt3=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),f],{encoding:'utf8'});
  ok('the restore test fails on a backup missing rows from its end',rt3.status===1&&/removed from the end/.test(rt3.stdout),rt3.stdout+rt3.stderr);}
 {const {db,anchor}=copy('lastrow');db.exec("UPDATE records SET actor='Someone else' WHERE id=(SELECT MAX(id) FROM records)");
  const r=verifyChain(db,{anchor});ok('a change to the last row is found by the anchored tip',!r.ok&&/anchored chain tip/.test(r.firstBreak.reason),JSON.stringify(r));db.close();}
 {const {db,anchor}=copy('lastpayload');const p2=JSON.stringify({id:'WO-54',value:'forged'});db.exec(`UPDATE records SET payload_json='${p2}', payload_sha256='${sha256(p2)}' WHERE id=(SELECT MAX(id) FROM records)`);
  const r=verifyChain(db,{anchor});ok('a last payload changed together with its hash is found',!r.ok&&/anchored chain tip/.test(r.firstBreak.reason),JSON.stringify(r));db.close();}
 {const {db,anchor}=copy('manifest');db.exec("UPDATE signature_manifests SET signer_credential='ACCT-forged' WHERE record_id=1");
  const r=verifyChain(db,{anchor});ok('a changed signature manifest breaks the chain at its record',!r.ok&&r.firstBreak.id===1&&/signature manifests/.test(r.firstBreak.reason),JSON.stringify(r));db.close();}
 {const {db,anchor}=copy('manifestadd');db.exec("INSERT INTO signature_manifests (record_id,path,meaning,signer_name,signer_credential,signed_at,algorithm,hash) VALUES (2,'x','Approval','Forger','ACCT-x','2026-01-01T00:00:00Z','SHA-256','"+'a'.repeat(64)+"')");
  const r=verifyChain(db,{anchor});ok('a signature manifest added to a record breaks the chain',!r.ok&&r.firstBreak.id===2,JSON.stringify(r));db.close();}
 {const {f}=copy('noanchor',true);fs.rmSync(f+'.anchor.json');
  const rt4=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),f],{encoding:'utf8'});
  ok('the restore test refuses a backup with no anchor',rt4.status===1&&/no anchor next to the backup/.test(rt4.stderr),rt4.stdout+rt4.stderr);
  const rt5=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),f,'--no-anchor'],{encoding:'utf8'});
  ok('--no-anchor checks an older backup and says truncation cannot be ruled out',rt5.status===0&&/cannot be ruled out/.test(rt5.stdout),rt5.stdout+rt5.stderr);
  let msg='';try{createMirror({dbPath:f,backupDir:path.join(tmp,'b10'),port:0,backupEveryMinutes:0,...SECURE});}catch(e){msg=e.message;}
  ok('the server refuses to start on a database with records and no anchor, and names --reanchor',/--reanchor/.test(msg),msg);
  const ra=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/server.mjs'),'--reanchor','--db',f],{encoding:'utf8'});
  ok('--reanchor checks the chain and writes the anchor',ra.status===0&&readAnchor(f+'.anchor.json')?.records===5,ra.stdout+ra.stderr);}
 {const {f,db}=copy('brokenreanchor');fs.rmSync(f+'.anchor.json');db.exec("UPDATE records SET payload_json='{}' WHERE id=2");db.close();
  const ra=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/server.mjs'),'--reanchor','--db',f],{encoding:'utf8'});
  ok('--reanchor refuses a broken chain',ra.status===1&&!fs.existsSync(f+'.anchor.json')&&/chain is broken/.test(ra.stderr),ra.stdout+ra.stderr);}
 // A database written before manifests joined the chain still verifies: its rows keep their original link.
 {const old=path.join(tmp,'legacy.sqlite');const db=new DatabaseSync(old);db.exec(fs.readFileSync(path.join(ROOT,'server/mirror/schema.sql'),'utf8').replace(',\n  -- SHA-256 of this record','\n  -- SHA-256 of this record').replace(/\n  manifests_sha256 TEXT/,''));
  const legacyLink=r=>sha256(JSON.stringify([r.id,r.client_write_id,r.store_key,r.entity_type,r.entity_id,r.operation,r.payload_sha256,r.prev_sha256,r.actor,r.credential,r.client_ts,r.server_ts,r.build_version,r.build_sha256,r.client_id]));
  let prev='0'.repeat(64);for(const i of [1,2]){const x=rec(60+i);db.prepare('INSERT INTO records (client_write_id,store_key,entity_type,entity_id,operation,payload_json,payload_sha256,prev_sha256,actor,credential,client_ts,server_ts,build_version,build_sha256,client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.clientWriteId,x.storeKey,x.entityType,x.entityId,x.operation,x.payloadJson,x.payloadSha256,prev,x.actor,x.credential,x.clientTs,'2026-01-01T00:00:00Z',x.buildVersion,x.buildSha256,'old');prev=legacyLink(db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 1').get());}
  db.prepare("INSERT INTO signature_manifests (record_id,path,meaning,signer_name,signer_credential,signed_at,algorithm,hash) VALUES (1,'order.closure','Closure approval','Old Signer','ACCT-old','2026-01-01T00:00:00Z','SHA-256',?)").run('e'.repeat(64));
  db.close();
  const ra=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/server.mjs'),'--reanchor','--db',old],{encoding:'utf8'});
  const ml=createMirror({dbPath:old,backupDir:path.join(tmp,'b11'),port:0,backupEveryMinutes:0,...SECURE});const al=await ml.listen();
  const more=await fetch(`http://127.0.0.1:${al.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'new',records:[rec(63)]})}).then(r=>r.json());
  const vl=ml.verify();
  ok('a database from before this change records its legacy rows once, at migration',legacyMeta(ml.db)==='2',String(legacyMeta(ml.db)));
  ok('a database from before this change gains the column, keeps its links and keeps writing',ra.status===0&&more.results[0].status==='stored'&&vl.ok&&vl.records===3&&vl.legacyRows===2,JSON.stringify({vl,ra:ra.stderr}));
  // A legacy row's manifests are covered by no hash, so restore-test --against compares them directly.
  const bkl=ml.backup();await ml.close();
  {const d=new DatabaseSync(old);d.exec('DROP TRIGGER manifests_no_update');d.prepare("UPDATE signature_manifests SET signer_credential='ACCT-forged' WHERE record_id=1").run();d.close();}
  {const d=new DatabaseSync(old,{readOnly:true});ok('the refusal case is real: the chain still verifies with a legacy manifest changed',verifyChain(d,{anchor:readAnchor(old+'.anchor.json')}).ok);d.close();}
  const rl=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),bkl,'--against',old],{encoding:'utf8'});
  ok('restore-test --against finds a changed manifest on a legacy row',rl.status===1&&/signature manifests of row 1 differ/.test(rl.stderr),rl.stdout+rl.stderr);}
}

// The anchor is never overwritten to cover a change: a mismatching database is refused at start, on every
// write and on every backup, and the restore comparison includes manifests_sha256.
{const {DatabaseSync}=await import('node:sqlite');
 const gp=path.join(tmp,'guard.sqlite');const mg=createMirror({dbPath:gp,backupDir:path.join(tmp,'b12'),port:0,backupEveryMinutes:0,...SECURE});const ag=await mg.listen();const ug=`http://127.0.0.1:${ag.port}/api/v1`;
 const pg=b=>fetch(ug+'/writes',{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify(b)});
 await pg({clientId:'g',records:[rec(70),rec(71),rec(72)]});
 const good=mg.backup();const anchorBefore=fs.readFileSync(gp+'.anchor.json','utf8');
 // Tamper while the server runs: the last row is removed behind its back.
 mg.db.exec('DROP TRIGGER records_no_delete');mg.db.exec('DROP TRIGGER manifests_no_delete');mg.db.exec('DELETE FROM signature_manifests WHERE record_id=3');mg.db.exec('DELETE FROM records WHERE id=3');
 const refused=await pg({clientId:'g',records:[rec(73)]});const rj=await refused.json();
 ok('a write is refused while the database no longer matches its anchor, and nothing is stored',refused.status===409&&rj.error.code==='anchor_mismatch'&&Number(mg.db.prepare('SELECT COUNT(*) n FROM records').get().n)===2,JSON.stringify(rj));
 ok('the refused write leaves the anchor as it was',fs.readFileSync(gp+'.anchor.json','utf8')===anchorBefore);
 let bmsg='';try{mg.backup();}catch(e){bmsg=e.message;}
 ok('a backup is refused while the database no longer matches its anchor',/backup refused/.test(bmsg)&&/removed from the end/.test(bmsg),bmsg);
 await mg.close();
 let smsg='';try{createMirror({dbPath:gp,backupDir:path.join(tmp,'b12'),port:0,backupEveryMinutes:0,...SECURE});}catch(e){smsg=e.message;}
 ok('the server refuses to start on a database that no longer matches its anchor',/does not match its chain anchor/.test(smsg)&&/removed from the end/.test(smsg),smsg);
 ok('the refusal to start leaves the anchor as it was',fs.readFileSync(gp+'.anchor.json','utf8')===anchorBefore);
 const bk=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/server.mjs'),'--backup-now','--db',gp,'--backup-dir',path.join(tmp,'b13')],{encoding:'utf8'});
 ok('--backup-now refuses the same database',bk.status===1&&/backup refused/.test(bk.stderr),bk.stdout+bk.stderr);
 // restore-test --against compares manifests_sha256: a live copy differing only in that column is not a prefix.
 const live=path.join(tmp,'mlive.sqlite');fs.copyFileSync(good,live);{const d=new DatabaseSync(live);d.exec('DROP TRIGGER records_no_update');d.exec("UPDATE records SET manifests_sha256='"+'0'.repeat(64)+"' WHERE id=1");d.close();}
 const rt=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),good,'--against',live],{encoding:'utf8'});
 ok('restore-test --against finds a row that differs only in manifests_sha256',rt.status===1&&/row 1 in the backup differs/.test(rt.stderr),rt.stdout+rt.stderr);}

// Two-phase anchor: a commit interrupted before the final anchor is recognised and finished; a failure to write the
// pending anchor stores nothing; a pending entry that matches nothing is still refused.
{const {DatabaseSync}=await import('node:sqlite');const {appendRecords,chainTip,writePendingAnchor}=await import(path.join(ROOT,'server/mirror/server.mjs'));
 const tp=path.join(tmp,'twophase.sqlite');const mt2=createMirror({dbPath:tp,backupDir:path.join(tmp,'b14'),port:0,backupEveryMinutes:0,...SECURE});
 const before=readAnchor(tp+'.anchor.json');
 let thrown='';try{appendRecords(mt2.db,'tp',[rec(80)],undefined,{beforeCommit:()=>{throw new Error('anchor storage unavailable');}});}catch(e){thrown=e.message;}
 ok('when the pending anchor cannot be written nothing commits',/anchor storage unavailable/.test(thrown)&&chainTip(mt2.db).records===0);
 // Commit a batch, then leave the anchor as a crash between COMMIT and the final anchor would: pending, not final.
 appendRecords(mt2.db,'tp',[rec(81),rec(82)],undefined,{beforeCommit:next=>writePendingAnchor(tp+'.anchor.json',before,next)});
 const left=readAnchor(tp+'.anchor.json');await mt2.close();
 ok('the interrupted state is real: the anchor still names the old count with the batch pending',left.records===0&&left.pending&&left.pending.records===2,JSON.stringify(left));
 const mt3=createMirror({dbPath:tp,backupDir:path.join(tmp,'b14'),port:0,backupEveryMinutes:0,...SECURE});
 const settled=readAnchor(tp+'.anchor.json');
 ok('the server recognises the interrupted commit, starts and finalises the anchor',settled.records===2&&!settled.pending&&mt3.verify().ok,JSON.stringify(settled));
 await mt3.close();
 // A pending entry that matches neither the database nor the committed state is still a mismatch.
 fs.writeFileSync(tp+'.anchor.json',JSON.stringify({records:1,tip:'a'.repeat(64),pending:{records:3,tip:'b'.repeat(64)}}));
 let refusedPending='';try{createMirror({dbPath:tp,backupDir:path.join(tmp,'b14'),port:0,backupEveryMinutes:0,...SECURE});}catch(e){refusedPending=e.message;}
 ok('a pending anchor that matches neither state is refused',/does not match its chain anchor/.test(refusedPending),refusedPending);
 // restore-test --against verifies the live database itself: a changed live manifest row fails it.
 const g2=path.join(tmp,'g2.sqlite');const mg2=createMirror({dbPath:g2,backupDir:path.join(tmp,'b15'),port:0,backupEveryMinutes:0,...SECURE});const ag2=await mg2.listen();
 await fetch(`http://127.0.0.1:${ag2.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'g2',records:[rec(90),rec(91)]})});
 const bk2=mg2.backup();await mg2.close();
 {const d=new DatabaseSync(g2);d.exec('DROP TRIGGER manifests_no_update');d.exec("UPDATE signature_manifests SET signer_credential='ACCT-forged' WHERE record_id=1");d.close();}
 const rt=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),bk2,'--against',g2],{encoding:'utf8'});
 ok('restore-test --against fails when a live signature manifest was changed',rt.status===1&&/live database is not intact/.test(rt.stderr)&&/signature manifests/.test(rt.stderr),rt.stdout+rt.stderr);}

// Every write is checked against the whole chain once the database was changed outside the server: a changed
// signature manifest of an earlier row passes the tip check but is refused, and nothing is stored.
{const {DatabaseSync}=await import('node:sqlite');const tp=path.join(tmp,'deep.sqlite');const md=createMirror({dbPath:tp,backupDir:path.join(tmp,'b16'),port:0,backupEveryMinutes:0,...SECURE});const ad=await md.listen();
 const pd=body=>fetch(`http://127.0.0.1:${ad.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify(body)});
 ok('writes are accepted while the database is untouched',(await pd({clientId:'d',records:[rec(101),rec(102),rec(103)]})).status===200&&(await pd({clientId:'d',records:[rec(104)]})).status===200);
 {const d=new DatabaseSync(tp);d.exec('DROP TRIGGER manifests_no_update');d.exec("UPDATE signature_manifests SET signer_credential='ACCT-forged' WHERE record_id=1");d.close();}
 ok('the refusal case is real: the tip check alone still passes',anchorMismatch(md.db,readAnchor(tp+'.anchor.json'))===null);
 const refused=await pd({clientId:'d',records:[rec(105)]});const rj=await refused.json();
 ok('a write after an earlier manifest was changed is refused, and nothing is stored',refused.status===409&&rj.error.code==='anchor_mismatch'&&Number(md.db.prepare('SELECT COUNT(*) n FROM records').get().n)===4,JSON.stringify(rj));
 await md.close();}
// A commit whose final anchor write failed leaves the anchor naming it as pending. Exports then carry the
// pending count and tip, which match the rows they hold, not the stale top-level ones.
{const tp=path.join(tmp,'pend.sqlite');const mp=createMirror({dbPath:tp,backupDir:path.join(tmp,'b18'),port:0,backupEveryMinutes:0,...SECURE});const ap=await mp.listen();
 const base=`http://127.0.0.1:${ap.port}/api/v1`;
 await fetch(base+'/writes',{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'p',records:[rec(301),rec(302)]})});
 const a=readAnchor(tp+'.anchor.json');fs.writeFileSync(tp+'.anchor.json',JSON.stringify({records:a.records-1,tip:'c'.repeat(64),anchoredAt:a.anchoredAt,pending:{records:a.records,tip:a.tip}}));
 ok('the refusal case is real: the anchor file still names the earlier state at top level',readAnchor(tp+'.anchor.json').records===a.records-1);
 const lines=(await (await get(base+'/export?format=csv')).text()).trim().split('\r\n');const tail=lines[lines.length-1].split(',').slice(-2);
 ok('the CSV export of an interrupted commit carries the count and tip the rows match',tail[0]===String(a.records)&&tail[1]===a.tip,JSON.stringify(tail));
 const j=await (await get(base+'/export?format=json')).json();
 ok('the JSON export carries the same, and verifies against it',j.anchor.records===a.records&&j.anchor.tip===a.tip&&j.verify.ok,JSON.stringify({anchor:j.anchor,ok:j.verify.ok}));
 await mp.close();}
// Every anchor write is flushed (the file before its rename, then the directory) before the server goes on.
{const tp=path.join(tmp,'durable.sqlite');const md=createMirror({dbPath:tp,backupDir:path.join(tmp,'b19'),port:0,backupEveryMinutes:0,...SECURE});const ad=await md.listen();
 const real=fs.fsyncSync;let calls=0;fs.fsyncSync=fd=>{calls+=1;return real(fd);};
 try{await fetch(`http://127.0.0.1:${ad.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'d',records:[rec(401)]})});}finally{fs.fsyncSync=real;}
 ok('a write flushes the pending and the final anchor, each file and its directory',calls>=4,String(calls));
 // Empty optional text is stored as NULL, so the CSV (an empty cell either way) still carries what the chain hashes.
 const pj=JSON.stringify({id:'WO-402'});const r0=await fetch(`http://127.0.0.1:${ad.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'d',records:[{...rec(402),actor:'',credential:''}]})});
 const row=md.db.prepare("SELECT actor,credential FROM records WHERE client_write_id='srv-402'").get();
 const j0=await r0.json();// A manifest that also carries another spelling of a field (signer_credential beside signerCredential) is hashed
// in the shape that is stored, so one such write cannot poison the chain.
 {const m0=rec(403).manifests[0];const r1=await fetch(`http://127.0.0.1:${ad.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'d',records:[{...rec(403),manifests:[{...m0,signer_credential:'ACCT-other',signer_name:'Someone Else',signed_at:'1999-01-01'}]}]})});
  const j1=await r1.json();const v1=md.verify();
  ok('a manifest with alias fields is stored and the chain still verifies',j1.results[0].status==='stored'&&v1.ok,JSON.stringify({j1,v1}));
  ok('the stored manifest keeps the camel-case values, not the aliases',md.db.prepare("SELECT s.signer_credential c FROM signature_manifests s JOIN records r ON r.id=s.record_id WHERE r.client_write_id='srv-403'").get().c===m0.signerCredential);}
 ok('an empty actor and credential are stored as NULL',j0.results&&j0.results[0].status==='stored'&&row&&row.actor===null&&row.credential===null,JSON.stringify({row,j0}));
 ok('the chain is still intact',md.verify().ok);
 await md.close();}
// restore-test --against takes the live anchor from where the server keeps it: --live-anchor or FS_MIRROR_ANCHOR.
{const {DatabaseSync}=await import('node:sqlite');const tp=path.join(tmp,'custom.sqlite'),ap=path.join(tmp,'anchors','custom.anchor.json');const mc=createMirror({dbPath:tp,anchorPath:ap,backupDir:path.join(tmp,'b17'),port:0,backupEveryMinutes:0,...SECURE});const ac=await mc.listen();
 const pc=body=>fetch(`http://127.0.0.1:${ac.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify(body)});
 await pc({clientId:'c',records:[rec(111),rec(112)]});const bkc=mc.backup();await pc({clientId:'c',records:[rec(113)]});await mc.close();
 const run=(args,env={})=>spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),bkc,'--against',tp,...args],{encoding:'utf8',env:{...process.env,...env}});
 ok('the live anchor is kept away from the database (the case under test)',fs.existsSync(ap)&&!fs.existsSync(tp+'.anchor.json'));
 let rt=run([]);ok('without the live anchor, --against fails and says how to give it',rt.status===1&&/no anchor for the live database/.test(rt.stderr)&&/--live-anchor/.test(rt.stderr),rt.stdout+rt.stderr);
 rt=run(['--live-anchor',ap]);ok('with --live-anchor, an intact live database passes',rt.status===0&&/matches the first 2 of 3/.test(rt.stdout),rt.stdout+rt.stderr);
 rt=run([],{FS_MIRROR_ANCHOR:ap});ok('FS_MIRROR_ANCHOR is honoured the same way',rt.status===0,rt.stdout+rt.stderr);
 // The live last row, which no later row links and the backup does not hold, is rewritten consistently.
 {const d=new DatabaseSync(tp);d.exec('DROP TRIGGER records_no_update');const pj=JSON.stringify({id:'WO-113',value:'forged'});d.prepare('UPDATE records SET payload_json=?, payload_sha256=? WHERE id=3').run(pj,sha256(pj));d.close();}
 {const d=new DatabaseSync(tp,{readOnly:true});ok('the refusal case is real: without an anchor the rewritten live chain still verifies',verifyChain(d).ok);d.close();}
 rt=run(['--live-anchor',ap]);ok('with its anchor, --against finds the rewritten live last row',rt.status===1&&/live database is not intact/.test(rt.stderr)&&/chain tip/.test(rt.stderr),rt.stdout+rt.stderr);}

// A probe (a post with no records) is answered with ackCheck alone and stores nothing, so a device with an empty
// queue still learns of a restore; without lastAck it is refused.
{const tp=path.join(tmp,'probe.sqlite');const mp=createMirror({dbPath:tp,backupDir:path.join(tmp,'b20'),port:0,backupEveryMinutes:0,...SECURE});const ap=await mp.listen();
 const pp=body=>fetch(`http://127.0.0.1:${ap.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));
 const w=await pp({clientId:'pr',records:[rec(501)]});const id=w.json.results[0].id;const anchorBefore=fs.readFileSync(tp+'.anchor.json','utf8');
 const okp=await pp({clientId:'pr',lastAck:{id,clientWriteId:'srv-501'},records:[]});
 const lostp=await pp({clientId:'pr',lastAck:{id:id+50,clientWriteId:'srv-gone'},records:[]});
 ok('a probe naming a row the server holds is answered ok, one naming a lost row missing',okp.status===200&&okp.json.ackCheck==='ok'&&okp.json.results.length===0&&lostp.json.ackCheck==='missing',JSON.stringify({okp,lostp}));
 ok('a probe stores nothing and leaves the anchor as it was',Number(mp.db.prepare('SELECT COUNT(*) n FROM records').get().n)===1&&fs.readFileSync(tp+'.anchor.json','utf8')===anchorBefore);
 const bad=await pp({clientId:'pr',records:[]});
 ok('a post with no records and no lastAck is refused',bad.status===400&&/lastAck/.test(bad.json.error.message),JSON.stringify(bad));
 await mp.close();}
// A row without manifests_sha256 is accepted only among the rows written before manifests joined the chain (#385).
{const {DatabaseSync}=await import('node:sqlite');const {linkHash,writeAnchor}=await import(path.join(ROOT,'server/mirror/server.mjs'));
 const tp=path.join(tmp,'nullrow.sqlite');const mn=createMirror({dbPath:tp,backupDir:path.join(tmp,'b21'),port:0,backupEveryMinutes:0,...SECURE});const an=await mn.listen();
 await fetch(`http://127.0.0.1:${an.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'n',records:[rec(601),rec(602)]})});
 ok('a database created with the column records that no row is legacy',legacyMeta(mn.db)==='0',String(legacyMeta(mn.db)));
 let metaRefused='';try{mn.db.exec("UPDATE mirror_meta SET value='99'");}catch(e){metaRefused=e.message;}
 ok('the legacy boundary cannot be changed',/append-only/.test(metaRefused),metaRefused);
 await mn.close();
 // A row appended outside the server, linked correctly but without manifests_sha256, with a manifest no hash covers.
 const d=new DatabaseSync(tp);const prev=d.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 1').get();const x=rec(603);
 d.prepare('INSERT INTO records (client_write_id,store_key,entity_type,entity_id,operation,payload_json,payload_sha256,prev_sha256,actor,credential,client_ts,server_ts,build_version,build_sha256,client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.clientWriteId,x.storeKey,x.entityType,x.entityId,x.operation,x.payloadJson,x.payloadSha256,linkHash(prev),x.actor,x.credential,x.clientTs,new Date().toISOString(),x.buildVersion,x.buildSha256,'n');
 d.prepare("INSERT INTO signature_manifests (record_id,path,meaning,signer_name,signer_credential,signed_at,algorithm,hash) VALUES (3,'order.closure','Closure approval','Forger','ACCT-x','2026-01-01T00:00:00Z','SHA-256',?)").run('d'.repeat(64));
 writeAnchor(tp+'.anchor.json',d);const forged=d.prepare('SELECT * FROM records WHERE id=3').get();
 ok('the refusal case is real: the forged row links to the row before it and the anchor matches',forged.prev_sha256===linkHash(prev)&&forged.manifests_sha256===null);
 const vf=verifyChain(d,{anchor:readAnchor(tp+'.anchor.json')});d.close();
 ok('a row without manifests_sha256 after rows that carry it breaks the chain',!vf.ok&&vf.firstBreak.id===3&&/no manifests_sha256/.test(vf.firstBreak.reason),JSON.stringify(vf));}
// A signature manifest added to a chain-covered row of a backup fails the restore comparison (#385).
{const {DatabaseSync}=await import('node:sqlite');const tp=path.join(tmp,'inject.sqlite');const mi=createMirror({dbPath:tp,backupDir:path.join(tmp,'b22'),port:0,backupEveryMinutes:0,...SECURE});const ai=await mi.listen();
 await fetch(`http://127.0.0.1:${ai.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'i',records:[rec(701),rec(702)]})});
 const bki=mi.backup();await mi.close();
 const clean=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),bki,'--against',tp],{encoding:'utf8'});
 ok('an untouched backup matches the live database',clean.status===0,clean.stdout+clean.stderr);
 {const d=new DatabaseSync(bki);d.prepare("INSERT INTO signature_manifests (record_id,path,meaning,signer_name,signer_credential,signed_at,algorithm,hash) VALUES (1,'order.extra','Approval','Forger','ACCT-x','2026-01-01T00:00:00Z','SHA-256',?)").run('b'.repeat(64));d.close();}
 const inj=spawnSync(process.execPath,[path.join(ROOT,'server/mirror/restore-test.mjs'),bki,'--against',tp],{encoding:'utf8'});
 ok('a manifest injected for a chain-covered row of a backup fails the restore test',inj.status===1&&/BROKEN/.test(inj.stdout)&&/signature manifests/.test(inj.stdout+inj.stderr),inj.stdout+inj.stderr);}

// A backup is checked again after the copy: a commit by another connection between the check and the copy is found
// in the copy, the copy is removed and the backup refused; the copy's anchor comes from the copy, not the live file.
{const {DatabaseSync}=await import('node:sqlite');const {backupNow,chainTip,linkHash}=await import(path.join(ROOT,'server/mirror/server.mjs'));
 const tp=path.join(tmp,'race.sqlite');const mr=createMirror({dbPath:tp,backupDir:path.join(tmp,'b23'),port:0,backupEveryMinutes:0,...SECURE});const ar=await mr.listen();
 await fetch(`http://127.0.0.1:${ar.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'r',records:[rec(801),rec(802)]})});
 const anchor=readAnchor(tp+'.anchor.json');const dir=path.join(tmp,'b23race');
 let msg='',checkedFirst=false;
 try{backupNow(mr.db,dir,new Date('2026-10-01T12:00:00Z'),{anchor,beforeCopy:()=>{checkedFirst=true;const d=new DatabaseSync(tp);const prev=d.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 1').get();const x=rec(803);d.prepare('INSERT INTO records (client_write_id,store_key,entity_type,entity_id,operation,payload_json,payload_sha256,prev_sha256,actor,credential,client_ts,server_ts,build_version,build_sha256,client_id,manifests_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.clientWriteId,x.storeKey,x.entityType,x.entityId,x.operation,x.payloadJson,x.payloadSha256,linkHash(prev),x.actor,x.credential,x.clientTs,new Date().toISOString(),x.buildVersion,x.buildSha256,'r',sha256(JSON.stringify([])));d.close();}});}catch(e){msg=e.message;}
 ok('the refusal case is real: the live database passed the check before the copy',checkedFirst);
 ok('a commit between the check and the copy is found in the copy and the backup is refused',/backup refused/.test(msg)&&/the copy taken/.test(msg),msg);
 ok('a refused copy leaves no backup and no anchor behind',!fs.existsSync(dir)||fs.readdirSync(dir).length===0,fs.existsSync(dir)?JSON.stringify(fs.readdirSync(dir)):'');
 await mr.close();
 const tq=path.join(tmp,'race2.sqlite');const mq=createMirror({dbPath:tq,backupDir:path.join(tmp,'b24'),port:0,backupEveryMinutes:0,...SECURE});const aq=await mq.listen();
 await fetch(`http://127.0.0.1:${aq.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'q',records:[rec(811)]})});
 const good=mq.backup();const ca=readAnchor(good+'.anchor.json');const cd=new DatabaseSync(good,{readOnly:true});const ct=chainTip(cd);cd.close();
 ok('an undisturbed backup is kept, with an anchor taken from the copy itself',ca&&ca.records===ct.records&&ca.tip===ct.tip&&ct.records===1,JSON.stringify({ca,ct}));
 await mq.close();}
// Only a database file the server creates gets a fresh anchor: an existing file with no anchor is refused even
// when it holds no rows (it may have been emptied, or the anchor's storage is not mounted).
{const tp=path.join(tmp,'emptyold.sqlite');const me=createMirror({dbPath:tp,backupDir:path.join(tmp,'b25'),port:0,backupEveryMinutes:0,...SECURE});
 ok('a new database file gets its anchor on first start',readAnchor(tp+'.anchor.json')?.records===0);me.db.close();
 fs.rmSync(tp+'.anchor.json');let msg='';try{const x=createMirror({dbPath:tp,backupDir:path.join(tmp,'b25'),port:0,backupEveryMinutes:0,...SECURE});x.db.close();}catch(e){msg=e.message;}
 ok('an existing database with no rows and no anchor is refused and the next step named',/missing for the existing database/.test(msg)&&/--reanchor/.test(msg)&&!fs.existsSync(tp+'.anchor.json'),msg);}

// A write's anchor and chain checks run while it holds the database write lock, so no other connection can commit
// between the check and the append; a change made before the write is still refused and nothing is stored.
{const {DatabaseSync}=await import('node:sqlite');const srv=await import(path.join(ROOT,'server/mirror/server.mjs'));
 const tp=path.join(tmp,'lock.sqlite');const ml=createMirror({dbPath:tp,backupDir:path.join(tmp,'b26'),port:0,backupEveryMinutes:0,...SECURE});
 ok('the server exposes the guarded write it uses',typeof srv.guardedAppend==='function');
 if(typeof srv.guardedAppend==='function'){
  const guard={verifiedVersion:null};srv.guardedAppend(ml.db,tp+'.anchor.json',guard,'l',[rec(901),rec(902)]);
  let other='';const r=srv.guardedAppend(ml.db,tp+'.anchor.json',guard,'l',[rec(903)],{afterCheck:()=>{const d=new DatabaseSync(tp);d.exec('PRAGMA busy_timeout = 0');try{const x=rec(904);d.prepare('INSERT INTO records (client_write_id,store_key,entity_type,entity_id,operation,payload_json,payload_sha256,prev_sha256,actor,credential,client_ts,server_ts,build_version,build_sha256,client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.clientWriteId,x.storeKey,x.entityType,x.entityId,x.operation,x.payloadJson,x.payloadSha256,'0'.repeat(64),null,null,x.clientTs,'t',x.buildVersion,x.buildSha256,'intruder');other='committed';}catch(e){other=e.message;}finally{d.close();}}});
  ok('another connection cannot commit while a write is being checked',/locked|busy/i.test(other),other);
  ok('the checked write is stored and the chain stays intact against its anchor',r.ok&&r.results[0].status==='stored'&&ml.verify().ok,JSON.stringify({r,v:ml.verify()}));
  // Between the commit and the final anchor another connection commits a row: the final anchor names this write's
  // own count and tip, so that row is not anchored as if it were good and the next write refuses it (r4161702697).
  {const n1=Number(ml.db.prepare('SELECT COUNT(*) n FROM records').get().n);let slipped='';
   const w=srv.guardedAppend(ml.db,tp+'.anchor.json',guard,'l',[rec(906)],{afterCommit:()=>{const d=new DatabaseSync(tp);try{const x=rec(907);d.prepare('INSERT INTO records (client_write_id,store_key,entity_type,entity_id,operation,payload_json,payload_sha256,prev_sha256,actor,credential,client_ts,server_ts,build_version,build_sha256,client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(x.clientWriteId,x.storeKey,x.entityType,x.entityId,x.operation,x.payloadJson,x.payloadSha256,'0'.repeat(64),null,null,x.clientTs,'t',x.buildVersion,x.buildSha256,'intruder');slipped='committed';}catch(e){slipped=e.message;}finally{d.close();}}});
   const an=readAnchor(tp+'.anchor.json');const total=Number(ml.db.prepare('SELECT COUNT(*) n FROM records').get().n);
   ok('the refusal case is real: another connection committed a row before the final anchor was written',slipped==='committed'&&total===n1+2,slipped);
   ok('the final anchor names the write\'s own count and tip, not the row committed after it',w.ok&&an.records===n1+1&&!an.pending&&an.records===w.committed.records&&an.tip===w.committed.tip,JSON.stringify({an,committed:w.committed,total}));
   const next=srv.guardedAppend(ml.db,tp+'.anchor.json',guard,'l',[rec(908)]);
   ok('the next write refuses the unanchored row and stores nothing',!next.ok&&next.status===409&&Number(ml.db.prepare('SELECT COUNT(*) n FROM records').get().n)===total,JSON.stringify(next));
   {const d=new DatabaseSync(tp);const t=d.prepare("SELECT sql FROM sqlite_master WHERE name='records_no_delete'").get().sql;d.exec('DROP TRIGGER records_no_delete');d.exec("DELETE FROM records WHERE client_id='intruder'");d.exec(t);d.close();}}
  {const d=new DatabaseSync(tp);d.exec('DROP TRIGGER records_no_delete');d.exec('DROP TRIGGER manifests_no_delete');d.exec('DELETE FROM signature_manifests WHERE record_id=3');d.exec('DELETE FROM records WHERE id=3');d.close();}
  const n0=Number(ml.db.prepare('SELECT COUNT(*) n FROM records').get().n);const bad=srv.guardedAppend(ml.db,tp+'.anchor.json',guard,'l',[rec(905)]);
  ok('a change made before the write is refused under the lock and nothing is stored',!bad.ok&&bad.status===409&&/rows/.test(bad.refusal||'')&&Number(ml.db.prepare('SELECT COUNT(*) n FROM records').get().n)===n0,JSON.stringify(bad));}
 ml.db.close();}

// Fail closed (issue 76): no token configured refuses to start, no origin configured sends no CORS header, and
// health tells a caller without the token only that the mirror is up.
{let refusedStart='';try{createMirror({dbPath:path.join(tmp,'none.sqlite'),backupDir:path.join(tmp,'b5'),port:0,backupEveryMinutes:0});}catch(e){refusedStart=e.message;}
 ok('the mirror refuses to start without a token and says how to set one',/FS_MIRROR_TOKEN/.test(refusedStart),refusedStart);
 const d=settings([],{});ok('the shipped defaults name no token and no CORS origin, listen on loopback and state no proxy',d.token===''&&d.writeToken===''&&d.allowOrigin===''&&d.allowNoToken===false&&d.host==='127.0.0.1'&&d.behindTlsProxy===false,JSON.stringify(d));
 const mc=createMirror({dbPath:path.join(tmp,'cors.sqlite'),backupDir:path.join(tmp,'b6'),port:0,backupEveryMinutes:0,token:TOKEN,writeToken:WTOKEN});const ac=await mc.listen();const cu=`http://127.0.0.1:${ac.port}/api/v1`;
 const r1=await fetch(cu+'/verify',{headers:{...AUTH,origin:'https://elsewhere.example'}});
 ok('with no allowed origin configured no CORS header is sent',r1.status===200&&r1.headers.get('access-control-allow-origin')===null,String(r1.headers.get('access-control-allow-origin')));
 const hn=await (await fetch(cu+'/health')).json();const hy=await (await fetch(cu+'/health',{headers:AUTH})).json();
 ok('health without the token says only that the mirror is up; with it, the counts and backup settings',JSON.stringify(Object.keys(hn).sort())==='["api","ok"]'&&!!hy.backup&&typeof hy.records==='number',JSON.stringify({hn,hy}));
 await mc.close();
 const mi=createMirror({dbPath:path.join(tmp,'insecure.sqlite'),backupDir:path.join(tmp,'b7'),port:0,backupEveryMinutes:0,allowNoToken:true});const ai=await mi.listen();
 ok('running without a token needs the explicit insecure setting',(await fetch(`http://127.0.0.1:${ai.port}/api/v1/verify`)).status===200);await mi.close();}

// ================= app =================
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const signUp=async p=>{await p.goto(PROD);await p.waitForTimeout(900);await p.evaluate(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await p.waitForTimeout(2600);};
const mkOrder=p=>p.evaluate(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});return {ok:r.ok,saved:save(),id:r.id};});

// Mirror off (the shipped default): nothing leaves the page and nothing is queued.
{const ctx=await b.newContext();const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));const net=[];p.on('request',q=>{if(/^https?:/.test(q.url()))net.push(q.url());});
 await signUp(p);const w=await mkOrder(p);
 const s=await p.evaluate(()=>({enabled:window.skMirror.enabled,url:window.SK_MIRROR.url,queue:localStorage.getItem('skyryse-mes-sync-queue-v1'),indicator:!!document.getElementById('sync-indicator')}));
 ok('mirror is off by default: empty url, nothing queued, no indicator',s.enabled===false&&s.url===''&&s.queue===null&&!s.indicator,JSON.stringify(s));
 ok('with the mirror off a write saves and no network request is made',w.ok&&w.saved&&net.length===0,JSON.stringify({w,net}));
 ok('no page errors with the mirror off',errs.length===0,errs.join(' | '));await ctx.close();}

// A mirror address in plain HTTP to another machine is refused: records and the token never cross the network unencrypted.
{const ctx=await b.newContext();await ctx.addInitScript(()=>{window.SK_MIRROR={url:'http://mes-mirror.example:8787',token:'mirror-suite-write-token',batchSize:25};});
 const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));const net=[];p.on('request',q=>{if(/mes-mirror\.example/.test(q.url()))net.push(q.url());});
 await signUp(p);const w=await mkOrder(p);
 const s=await p.evaluate(()=>({enabled:window.skMirror.enabled,refused:window.skMirror.refused||'',queue:localStorage.getItem('skyryse-mes-sync-queue-v1')}));
 ok('an http mirror address on another machine is refused with the next step, and the write still saves',w.ok&&w.saved&&s.enabled===false&&/not an https address/.test(s.refused)&&s.queue===null&&net.length===0,JSON.stringify({s,net}));
 const loop=await p.evaluate(()=>['http://127.0.0.1:8787','http://localhost:8787','https://mes-mirror.example'].map(u=>{try{const x=new URL(u);return x.protocol==='https:'||/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(x.hostname);}catch(e){return false;}}));
 ok('loopback http and any https address are accepted',loop.every(Boolean),JSON.stringify(loop));
 ok('no page errors with a refused mirror address',errs.length===0,errs.join(' | '));await ctx.close();}

// Mirror on.
m=createMirror({dbPath:path.join(tmp,'live.sqlite'),backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0,...SECURE});await m.listen();
// The page carries the write token only, as IT deploys it.
const ctx=await b.newContext();await ctx.addInitScript(([url,token])=>{window.SK_MIRROR={url,token,batchSize:25};},[`http://127.0.0.1:${PORT}`,WTOKEN]);
const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await signUp(p);
await p.evaluate(async()=>{const a=JSON.parse(localStorage.getItem('skyryse-mes-auth-v1'));const salt='5a17c0ffee5a17c0ffee5a17c0ffee00';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');a.users.push({username:'rpark',displayName:'Riley Park',salt,hash:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234'))),role:'qm',createdAt:new Date().toISOString(),createdBy:'jdoe'});localStorage.setItem('skyryse-mes-auth-v1',JSON.stringify(a));window.dispatchEvent(new CustomEvent('sk-auth-saved'));});
const drain=()=>p.evaluate(async()=>{for(let i=0;i<60&&window.skMirror.status().unsynced;i++){await window.skMirror.flush();await new Promise(r=>setTimeout(r,100));}return window.skMirror.status();});
const w1=await mkOrder(p);let st=await drain();
const count=()=>Number(m.db.prepare('SELECT COUNT(*) n FROM records').get().n);
ok('mirror on: a committed write saves locally and every queued record reaches the server',w1.ok&&w1.saved&&st.unsynced===0&&count()>0,JSON.stringify({w1,st,rows:count()}));
ok('the order written is on the server with the build and the signed-in person',!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='order' AND entity_id=? AND actor LIKE 'Jordan Doe%' AND build_version=? AND build_sha256=?").get(w1.id,STAMP.build,STAMP.sha256));
{const ids=m.db.prepare("SELECT client_write_id c FROM records WHERE client_id LIKE 'client-%' ORDER BY id DESC LIMIT 5").all().map(r=>r.c);
 ok('write ids carry the page that made them, so two tabs of one device never reuse one',ids.length>0&&ids.every(c=>/^client-[^]+-page-[^]+-\d+$/.test(c)),JSON.stringify(ids));}
ok('accounts are mirrored with name and role',!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='account' AND entity_id='rpark' AND payload_json LIKE '%\"role\":\"qm\"%'").get());
ok('the header shows Synced',await p.evaluate(()=>document.getElementById('sync-indicator')?.textContent)==='Synced');
// A closure signed by a second account carries a manifest to the server.
const closed=await p.evaluate(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});const q=MES.requestOrderClosure(state,r.id,{reason:'Obsolete',note:'Superseded by the next revision.'});save();sessionStorage.setItem('skyryse-mes-session-v1','rpark');const d=MES.decideOrderClosure(state,r.id,true,'Confirmed.');sessionStorage.setItem('skyryse-mes-session-v1','jdoe');return {ok:q.ok&&d.ok,saved:save(),id:r.id};});
st=await drain();
ok('a signature manifest reaches the signature_manifests table',closed.ok&&!!m.db.prepare("SELECT 1 FROM signature_manifests s JOIN records r ON r.id=s.record_id WHERE r.entity_id=? AND s.meaning LIKE 'Closure approval%' AND s.signer_credential='ACCT-rpark'").get(closed.id),JSON.stringify(closed));

// Offline: the server goes down; writes are never blocked, records queue and are flagged, then recover.
await m.close();const SQLite=await import('node:sqlite');const beforeRows=(()=>{const ro=new SQLite.DatabaseSync(path.join(tmp,'live.sqlite'),{readOnly:true});try{return Number(ro.prepare('SELECT COUNT(*) n FROM records').get().n);}finally{ro.close();}})();
const off=await p.evaluate(async()=>{const out=[];for(let i=0;i<3;i++){const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});out.push(r.ok&&save());}await window.skMirror.flush();await new Promise(r=>setTimeout(r,300));const q=JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')||'[]');return {saved:out,status:window.skMirror.status(),indicator:document.getElementById('sync-indicator').textContent,queued:q.length,flagged:q.every(x=>x.synced===false)};});
ok('with the server down every write still saves',off.saved.every(Boolean),JSON.stringify(off.saved));
ok('records queue on the device, flagged unsynced, and the header counts them',off.queued>=3&&off.flagged&&off.status.unsynced===off.queued&&off.indicator===`${off.queued} unsynced`&&/unreachable/.test(off.status.lastError),JSON.stringify(off));
m=createMirror({dbPath:path.join(tmp,'live.sqlite'),backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0,...SECURE});await m.listen();
st=await p.evaluate(async()=>{for(let i=0;i<150&&window.skMirror.status().unsynced;i++)await new Promise(r=>setTimeout(r,200));return window.skMirror.status();});
ok('when the server returns the queue drains on its own (retry with backoff)',st.unsynced===0&&count()===beforeRows+off.queued,JSON.stringify({st,beforeRows,after:count(),queued:off.queued}));
ok('the header is back to Synced and the local queue is empty',await p.evaluate(()=>document.getElementById('sync-indicator').textContent==='Synced'&&JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')).length===0));
// The same records sent again (a retry the client never heard back from) change nothing.
const exported=await (await get(API+'/export?format=json')).json();
const again=await p.evaluate(async([url,token,rows])=>{const auth={authorization:'Bearer '+token};const last=rows.records.slice(-2).map(r=>({clientWriteId:r.client_write_id,storeKey:r.store_key,entityType:r.entity_type,entityId:r.entity_id,operation:r.operation,payloadJson:r.payload_json,payloadSha256:r.payload_sha256,actor:r.actor,credential:r.credential,clientTs:r.client_ts,buildVersion:r.build_version,buildSha256:r.build_sha256}));const res=await (await fetch(url+'/api/v1/writes',{method:'POST',headers:{'content-type':'application/json',...auth},body:JSON.stringify({clientId:rows.records.slice(-1)[0].client_id,records:last})})).json();return res.results.map(x=>x.status);},[`http://127.0.0.1:${PORT}`,WTOKEN,exported]);
ok('an idempotent retry from the app stores nothing twice',JSON.stringify(again)==='["duplicate","duplicate"]',JSON.stringify(again));
// Nothing secret left the device.
{const secrets=await p.evaluate(()=>JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.flatMap(u=>[u.hash,u.salt]).filter(Boolean));
 const all=m.db.prepare('SELECT payload_json FROM records').all().map(r=>r.payload_json).join('\n');
 ok('no password hash or salt is on the server',secrets.every(s=>!all.includes(s))&&!/"salt"/.test(all)&&!/"password/.test(all),'found a secret');
 ok('no stamp PIN is on the server',!/"pin"\s*:/.test(all));}
v=await (await get(API+'/verify')).json();
ok('the live chain is intact after the outage and recovery',v.chainIntact===true,JSON.stringify(v));
// Restore: the server goes back to a backup taken before rows it had confirmed. The next post names the newest
// confirmed row, the server no longer has it, and the app sends every record again, so nothing is lost.
const authEdit=(fn,arg)=>p.evaluate(([src,arg])=>{const a=JSON.parse(localStorage.getItem('skyryse-mes-auth-v1'));new Function('a','arg',src)(a,arg);localStorage.setItem('skyryse-mes-auth-v1',JSON.stringify(a));window.dispatchEvent(new Event('sk-auth-saved'));},[fn,arg]);
const lastOp=id=>(m.db.prepare("SELECT operation FROM records WHERE entity_type='account' AND entity_id=? ORDER BY id DESC LIMIT 1").get(id)||{}).operation;
await authEdit("a.users.push({username:arg,displayName:'Temp Account',salt:'00',hash:'f'.repeat(64),role:'general',createdAt:new Date().toISOString()});",'tmpacct');st=await drain();
{const bk2=m.backup();
 // An account deleted after the backup: the restored mirror holds it as current until the device says again that it is gone.
 await authEdit("a.users=a.users.filter(u=>u.username!==arg);",'tmpacct');st=await drain();
 ok('a deletion after the backup reached the server before the restore',lastOp('tmpacct')==='delete',String(lastOp('tmpacct')));
 const after=[];for(let i=0;i<2;i++)after.push((await mkOrder(p)).id);st=await drain();
 const has=id=>!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='order' AND entity_id=?").get(id);
 ok('orders written after the backup reached the server before the restore',after.every(has)&&st.unsynced===0,JSON.stringify({after,st}));
 await m.close();
 const live=path.join(tmp,'live.sqlite');for(const x of ['-wal','-shm'])fs.rmSync(live+x,{force:true});fs.copyFileSync(bk2,live);fs.copyFileSync(bk2+'.anchor.json',live+'.anchor.json');
 m=createMirror({dbPath:live,backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0,...SECURE});await m.listen();
 ok('the restored server lacks the orders confirmed after its backup (the refusal case is real)',!after.some(has));
 ok('the restored server holds the deleted account as current (the refusal case is real)',lastOp('tmpacct')==='upsert',String(lastOp('tmpacct')));
 const w3=await mkOrder(p);st=await drain();
 ok('after a restore the app sends every record again: the orders confirmed after the backup are back',w3.ok&&after.every(has)&&has(w3.id)&&st.unsynced===0&&!!st.resentAt,JSON.stringify({st,after,w3}));
 ok('after a restore the app also re-sends its deletions: the deleted account is gone again',lastOp('tmpacct')==='delete',String(lastOp('tmpacct')));
 {const snap=m.db.prepare("SELECT payload_json FROM records WHERE entity_type='snapshot' ORDER BY id DESC LIMIT 1").get();const keys=snap?JSON.parse(snap.payload_json).keys:[];
  ok('after a restore the app sends a snapshot of every entity it holds, without the deleted account',!!snap&&keys.includes('order|'+w3.id)&&keys.some(k=>k.startsWith('account|'))&&!keys.includes('account|tmpacct'),JSON.stringify(keys.slice(0,5)));}
 ok('the restored and refilled chain is intact against its anchor',m.verify().ok,JSON.stringify(m.verify()));
 const w4=await mkOrder(p);const before=count();st=await drain();
 ok('once caught up, the next write sends only what changed',st.resentAt&&count()-before<=3,JSON.stringify({added:count()-before}));}
// Each page keeps its acknowledgement in its own slot; the device's is the highest of the newest epoch.
const devAck=()=>p.evaluate(()=>{const P='skyryse-mes-sync-ack-v1:',slots=[];const c=JSON.parse(localStorage.getItem('skyryse-mes-sync-client-v1')||'{}');if(c.ack)slots.push({key:null,epoch:c.ackEpoch||0,ack:c.ack});for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith(P)){const v=JSON.parse(localStorage.getItem(k));slots.push({key:k,epoch:v.epoch,ack:v.ack});}}let epoch=0,ack=null;slots.forEach(x=>{if(x.epoch>epoch)epoch=x.epoch;});slots.forEach(x=>{if(x.epoch===epoch&&x.ack&&(!ack||x.ack.id>ack.id))ack=x.ack;});return {epoch,ack,slots};});
// Two tabs: another tab confirms a newer row while this tab's answer is in flight. This tab writes only its own
// slot, so the other tab's acknowledgement is never overwritten and the device's never moves back.
{const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';let other=null;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{const resp=await route.fetch();if(!other){
   const r2=await fetch(API+'/writes',{method:'POST',headers:{'content-type':'application/json',...WAUTH},body:JSON.stringify({clientId:'other-tab',records:[rec(201)]})});const j2=await r2.json();
   other={id:j2.results[0].id,clientWriteId:'srv-201'};const e=(await devAck()).epoch;
   await p.evaluate(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),[OTHER,{epoch:e,ack:other,at:Date.now()}]);}
  await route.fulfill({response:resp});});
 await mkOrder(p);await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const d=await devAck();const theirs=await p.evaluate(k=>JSON.parse(localStorage.getItem(k)),OTHER);
 ok('another tab\'s acknowledgement, saved while this tab waited, is left as it was',!!other&&theirs&&theirs.ack&&theirs.ack.id===other.id,JSON.stringify({theirs,other}));
 ok('the device\'s acknowledgement never moves back below it',d.ack&&d.ack.id>=other.id,JSON.stringify(d.ack));
 const mine=d.slots.filter(x=>x.key&&x.key!==OTHER);
 ok('this page writes one slot of its own',mine.length>=1&&mine.every(x=>/^skyryse-mes-sync-ack-v1:page-/.test(x.key)),JSON.stringify(mine.map(x=>x.key)));
 // Another tab resets after a restore: a newer epoch outranks every older slot, this page's included.
 const before=d.epoch;await p.evaluate(([k,e])=>localStorage.setItem(k,JSON.stringify({epoch:e,ack:null,at:Date.now()})),[OTHER,before+1]);
 const r0=count();await mkOrder(p);const st2=await drain();const after=await devAck();
 ok('a reset another tab saved (a newer epoch) is kept, and this page\'s next acknowledgement joins that epoch',after.epoch===before+1&&after.ack&&after.ack.id>r0&&st2.unsynced===0,JSON.stringify({before,after:{e:after.epoch,ack:after.ack},r0}));}
// An answer that predates a restore another tab found meanwhile is not recorded in the new epoch: the tab sends
// everything again instead, since the row it names may be gone.
{const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';let held=null;
 const resentBefore=await p.evaluate(()=>window.skMirror.status().resentAt);const e0=(await devAck()).epoch;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{const resp=await route.fetch();if(!held){const j=await resp.json();held=Math.max(...(j.results||[]).filter(x=>Number.isInteger(x.id)).map(x=>x.id));
   await p.evaluate(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);}
  await route.fulfill({response:resp});});
 await mkOrder(p);await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const d=await devAck(),resentAfter=await p.evaluate(()=>window.skMirror.status().resentAt);
 ok('an answer from before another tab\'s restore reset is not recorded in the new epoch',Number.isFinite(held)&&!d.slots.some(x=>x.epoch===e0+1&&x.ack&&x.ack.id===held),JSON.stringify({held,slots:d.slots.map(x=>[x.epoch,x.ack&&x.ack.id])}));
 ok('instead the tab sends everything again',!!resentAfter&&resentAfter!==resentBefore,JSON.stringify({resentBefore,resentAfter}));}
// A tab whose workspace another tab changed meanwhile resends from the copy saved in the browser, so its snapshot
// lists what the other tab made instead of marking it deleted. The other tab's storage event has not reached this
// tab yet (storageBlocked is still false): the saved copy is read anyway.
const snapshots=()=>m.db.prepare("SELECT id,payload_json FROM records WHERE entity_type='snapshot' ORDER BY id").all();
{const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';let staged=null;const e0=(await devAck()).epoch;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{const resp=await route.fetch();if(!staged){staged='pending';
   staged=await p.evaluate(([k,v])=>{const ws=structuredClone(state);const wi=ws.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(ws,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});localStorage.setItem(KEY,JSON.stringify(ws));localStorage.setItem(k,JSON.stringify(v));return {id:r.id,blocked:storageBlocked,valid:MES.validate(ws)};},[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);}
  await route.fulfill({response:resp});});
 await mkOrder(p);await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const snap=snapshots().pop();const keys=snap?JSON.parse(snap.payload_json).keys:[];
 ok('the refusal case is real: this tab\'s own state lacks the other tab\'s order, and no storage event has marked it stale',staged&&staged.valid&&staged.blocked===false&&await p.evaluate(id=>!state.orders.some(o=>o.id===id),staged.id),JSON.stringify(staged));
 ok('a recovery snapshot lists the order another tab saved, even before its storage event arrives',keys.includes('order|'+staged.id),JSON.stringify(keys.filter(k=>k.startsWith('order|')).slice(-3)));
 // This tab takes the saved workspace as its own, as a reload would, so later writes do not drop the other tab's order.
 await p.evaluate(()=>{state=JSON.parse(localStorage.getItem(KEY));lastSaved=structuredClone(state);});}
// A saved workspace that fails validation is not trusted: no snapshot is sent and no workspace entity is marked
// deleted; the account records are still sent again.
{const tabB=await ctx.newPage();tabB.on('pageerror',e=>errs.push('tab B: '+e.message));await tabB.goto(PROD);await tabB.waitForFunction(()=>!!window.skMirror&&window.skMirror.enabled,null,{timeout:30000});
const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';let staged=false;const e0=(await devAck()).epoch;const before=snapshots().length;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{const resp=await route.fetch();if(!staged){staged=true;
   await p.evaluate(([k,v])=>{const ws=JSON.parse(localStorage.getItem(KEY));ws.orders=[{id:'not a valid order'}];localStorage.setItem(KEY,JSON.stringify(ws));localStorage.setItem(k,JSON.stringify(v));},[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);}
  await route.fulfill({response:resp});});
 const r0=count();await mkOrder(p);const st3=await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const added=m.db.prepare('SELECT entity_type t,operation o FROM records WHERE id>?').all(r0);
 ok('the refusal case is real: the saved workspace fails validation',await p.evaluate(()=>!MES.validate(JSON.parse(localStorage.getItem(KEY)))));
 ok('with an invalid saved workspace no snapshot is sent and no order is marked deleted',snapshots().length===before&&!added.some(x=>x.t==='order'&&x.o==='delete')&&added.some(x=>x.t==='account')&&st3.unsynced===0,JSON.stringify({added:added.slice(0,8),st3}));
 const pendingFlag=await p.evaluate(()=>localStorage.getItem('skyryse-mes-sync-recovery-v1')==='true');
 ok('the refusal case is real: the recovery is left pending while the saved workspace is invalid',pendingFlag);
 // Another tab, open since before the recovery, saves its older client record (without the pending recovery) and
 // then commits once the saved workspace is valid again: it still runs the pending recovery.
 const r1=count();const snapsBefore=snapshots().length;
 const savedValid=await tabB.evaluate(()=>{const c=JSON.parse(localStorage.getItem('skyryse-mes-sync-client-v1'));delete c.recoveryPending;localStorage.setItem('skyryse-mes-sync-client-v1',JSON.stringify(c));
   const ws=structuredClone(lastSaved);localStorage.setItem(KEY,JSON.stringify(ws));const valid=MES.validate(JSON.parse(localStorage.getItem(KEY)));window.skMirror.commit(ws);return valid;});
 ok('the workspace the other tab saves is valid',savedValid);
 const sb=await tabB.evaluate(async()=>{for(let i=0;i<80&&window.skMirror.status().unsynced;i++){await window.skMirror.flush();await new Promise(r=>setTimeout(r,100));}return window.skMirror.status();});
 const after=await p.evaluate(()=>localStorage.getItem('skyryse-mes-sync-recovery-v1'));
 ok('a tab with an older client record still runs the pending recovery once the workspace is valid: a snapshot is sent and nothing is left pending',snapshots().length>snapsBefore&&after===null&&sb.unsynced===0&&count()>r1,JSON.stringify({before:snapsBefore,now:snapshots().length,after,sb}));
 // Tab B's write marked this tab stale; take the saved workspace as this tab's own, as a reload would.
 await tabB.close();await p.evaluate(()=>{storageBlocked=false;state=JSON.parse(localStorage.getItem(KEY));lastSaved=structuredClone(state);save();});await drain();}
// A device with nothing queued still finds a restore: it probes the mirror, which no longer holds its last
// confirmed row, and sends everything again (#374).
{const w6=await mkOrder(p);await drain();const bk3=m.backup();
 const w7=await mkOrder(p);st=await drain();
 const has=id=>!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='order' AND entity_id=?").get(id);
 ok('an order confirmed after the backup is on the server, and nothing is queued',has(w7.id)&&st.unsynced===0,JSON.stringify(st));
 await m.close();const live=path.join(tmp,'live.sqlite');for(const x of ['-wal','-shm'])fs.rmSync(live+x,{force:true});fs.copyFileSync(bk3,live);fs.copyFileSync(bk3+'.anchor.json',live+'.anchor.json');
 m=createMirror({dbPath:live,backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0,...SECURE});await m.listen();
 const resent0=await p.evaluate(()=>window.skMirror.status().resentAt);
 ok('the refusal case is real: the restored server lacks the order and the device has nothing to send',!has(w7.id)&&has(w6.id)&&(await p.evaluate(()=>window.skMirror.status().unsynced))===0);
 await p.evaluate(()=>window.skMirror.probe());st=await drain();
 ok('a probe from an idle device finds the restore and the order is sent again',has(w7.id)&&st.unsynced===0&&st.resentAt&&st.resentAt!==resent0,JSON.stringify({st,resent0}));
 const r1=count();await p.evaluate(()=>window.skMirror.probe());await p.waitForTimeout(300);
 ok('a probe once caught up stores nothing and sends nothing again',count()===r1&&(await p.evaluate(()=>window.skMirror.status().resentAt))===st.resentAt);
 ok('the chain is intact after the probe recovery',m.verify().ok,JSON.stringify(m.verify()));}
// Two real tabs of one device, a restore, and both tabs recover at once: their write ids never collide, nothing is
// refused, every order is back, and the device's acknowledgement ends on a row the server holds (#386, r4154794192).
{const p2=await ctx.newPage();p2.on('pageerror',e=>errs.push('tab 2: '+e.message));await p2.goto(PROD);await p2.waitForFunction(()=>!!window.skMirror&&window.skMirror.enabled,null,{timeout:30000});
 const bk4=m.backup();const later=[];for(let i=0;i<2;i++)later.push((await mkOrder(p)).id);st=await drain();
 const has=id=>!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='order' AND entity_id=?").get(id);
 const tab2Stale=await p2.evaluate(()=>storageBlocked);
 ok('the second tab saw the first tab\'s writes as another tab\'s change, and its own state lacks them',tab2Stale===true&&await p2.evaluate(ids=>ids.every(id=>!state.orders.some(o=>o.id===id)),later),String(tab2Stale));
 await m.close();const live=path.join(tmp,'live.sqlite');for(const x of ['-wal','-shm'])fs.rmSync(live+x,{force:true});fs.copyFileSync(bk4,live);fs.copyFileSync(bk4+'.anchor.json',live+'.anchor.json');
 m=createMirror({dbPath:live,backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0,...SECURE});await m.listen();
 ok('the refusal case is real: the restored server lacks both orders',!later.some(has));
 await Promise.all([p.evaluate(()=>window.skMirror.probe()),p2.evaluate(()=>window.skMirror.probe())]);
 const drainTab=pg=>pg.evaluate(async()=>{for(let i=0;i<80&&window.skMirror.status().unsynced;i++){await window.skMirror.flush();await new Promise(r=>setTimeout(r,100));}return window.skMirror.status();});
 const [s1,s2]=await Promise.all([drainTab(p),drainTab(p2)]);
 ok('both tabs recover with nothing refused and nothing left queued',s1.rejected===0&&s2.rejected===0&&s1.unsynced===0&&s2.unsynced===0,JSON.stringify({s1,s2}));
 ok('every order confirmed before the restore is back on the server',later.every(has));
 const ids=m.db.prepare("SELECT client_write_id c FROM records WHERE client_id LIKE 'client-%'").all().map(r=>r.c);
 ok('no write id is used twice across the two tabs',new Set(ids).size===ids.length&&new Set(ids.map(c=>c.split('-page-')[1].split('-').slice(0,-1).join('-'))).size>=2,String(ids.length));
 const snaps=snapshots().slice(-2).map(x=>JSON.parse(x.payload_json).keys);
 ok('no recovery snapshot leaves out an order either tab holds',snaps.length>0&&snaps.every(k=>later.every(id=>k.includes('order|'+id))),JSON.stringify(snaps.map(k=>k.filter(x=>x.startsWith('order|')).length)));
 const d=await devAck();const {ackCheck:ac}=await import(path.join(ROOT,'server/mirror/server.mjs'));
 ok('the device\'s acknowledgement ends on a row the restored server holds',!!d.ack&&ac(m.db,d.ack)==='ok',JSON.stringify(d.ack));
 const resentNow=await p.evaluate(()=>window.skMirror.status().resentAt);const w8=await mkOrder(p);st=await drain();
 ok('after both tabs recovered, the next write is confirmed without another resend',has(w8.id)&&st.resentAt===resentNow,JSON.stringify({st,resentNow}));
 ok('the chain is intact after both tabs recovered',m.verify().ok,JSON.stringify(m.verify()));
 await p2.close();
 await p.evaluate(()=>{state=JSON.parse(localStorage.getItem(KEY));lastSaved=structuredClone(state);storageBlocked=false;});}
// A device upgraded from a build without acknowledgements: it has confirmed records but no lastAck, so its
// first confirmed post sends everything once instead of trusting a mirror that may have been restored.
{await p.evaluate(()=>{const c=JSON.parse(localStorage.getItem('skyryse-mes-sync-client-v1'));delete c.ack;delete c.ackEpoch;localStorage.setItem('skyryse-mes-sync-client-v1',JSON.stringify(c));Object.keys(localStorage).filter(k=>k.startsWith('skyryse-mes-sync-ack-v1:')).forEach(k=>localStorage.removeItem(k));});
 await p.reload();await p.waitForFunction(()=>window.__ready===true&&!!window.skMirror,null,{timeout:30000});
 const pre={ack:(await devAck()).ack,...(await p.evaluate(()=>({sent:Object.keys(JSON.parse(localStorage.getItem('skyryse-mes-sync-sent-v1')||'{}')).length,resent:window.skMirror.status().resentAt})))};
 const before=count();const w5=await mkOrder(p);st=await drain();
 const post=(await devAck()).ack;
 ok('an upgraded device with confirmed records and no acknowledgement sends everything once on its first post, then records an acknowledgement',pre.ack===null&&pre.sent>0&&pre.resent===null&&w5.ok&&!!st.resentAt&&count()-before>=pre.sent&&!!post&&Number.isInteger(post.id),JSON.stringify({pre,added:count()-before,post}));
 const b2=count();await mkOrder(p);st=await drain();
 ok('after that baseline the next write sends only what changed',count()-b2<=3,JSON.stringify({added:count()-b2}));}
// An upgraded device with confirmed records, no acknowledgement and nothing queued still sends its baseline on its
// own (on load), so it gets an acknowledgement to probe with and a restore is found without a new edit.
{await p.evaluate(()=>{const c=JSON.parse(localStorage.getItem('skyryse-mes-sync-client-v1'));delete c.ack;delete c.ackEpoch;localStorage.setItem('skyryse-mes-sync-client-v1',JSON.stringify(c));Object.keys(localStorage).filter(k=>k.startsWith('skyryse-mes-sync-ack-v1:')).forEach(k=>localStorage.removeItem(k));});
 const r0=count();await p.reload();await p.waitForFunction(()=>window.__ready===true&&!!window.skMirror,null,{timeout:30000});
 const pre=await p.evaluate(()=>({queued:window.skMirror.status().unsynced,sent:Object.keys(JSON.parse(localStorage.getItem('skyryse-mes-sync-sent-v1')||'{}')).length}));
 const st6=await p.evaluate(async()=>{for(let i=0;i<100&&!(window.skMirror.status().ack&&!window.skMirror.status().unsynced);i++)await new Promise(r=>setTimeout(r,100));return window.skMirror.status();});
 ok('the refusal case is real: the reloaded device has confirmed records and nothing queued',pre.sent>0&&pre.queued===0,JSON.stringify(pre));
 ok('with no edit, the idle upgraded device sends its baseline and gets an acknowledgement',!!st6.resentAt&&!!st6.ack&&st6.unsynced===0&&count()-r0>=pre.sent,JSON.stringify({st6,added:count()-r0,sent:pre.sent}));}
// A snapshot that waits in the queue is rebuilt from the saved workspace just before it is sent: an order another
// tab saved after the recovery began is listed, with a takenAt after it was saved.
{const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';const e0=(await devAck()).epoch;let phase=0;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{if(phase===0){phase=1;const resp=await route.fetch();await p.evaluate(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);await route.fulfill({response:resp});}else if(phase===1)await route.abort();else await route.continue();});
 await mkOrder(p);
 await p.waitForFunction(()=>(JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')||'[]')).some(r=>r.entityType==='snapshot'),null,{timeout:15000});
 const queued=await p.evaluate(()=>JSON.parse(JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')).find(r=>r.entityType==='snapshot').payloadJson));
 const made=await p.evaluate(()=>{const ws=structuredClone(state);const wi=ws.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(ws,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});localStorage.setItem(KEY,JSON.stringify(ws));return {id:r.id,at:new Date().toISOString()};});
 ok('the refusal case is real: the queued snapshot was built before the other tab saved its order',!queued.keys.includes('order|'+made.id),String(queued.keys.length));
 phase=2;await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const sent=snapshots().pop();const sk=sent?JSON.parse(sent.payload_json):{keys:[]};
 ok('the snapshot sent lists the order saved while it waited, with a takenAt after that save',sk.keys.includes('order|'+made.id)&&sk.takenAt>=made.at,JSON.stringify({takenAt:sk.takenAt,made}));
 await p.evaluate(()=>{state=JSON.parse(localStorage.getItem(KEY));lastSaved=structuredClone(state);});}
// When the browser refuses to save an acknowledgement, the tab keeps it in memory and still names it on its next
// post, so a restore during that session is still found.
{const before=await devAck();
 await p.evaluate(()=>{const set=Storage.prototype.setItem;window.__ackSet=set;Storage.prototype.setItem=function(k,v){if(String(k).startsWith('skyryse-mes-sync-ack-v1:'))throw new DOMException('Browser storage refused the write.','QuotaExceededError');return set.call(this,k,v);};});
 const r0=count();await mkOrder(p);const s1=await drain();const stored=await devAck();
 const newest=Number(m.db.prepare('SELECT MAX(id) n FROM records').get().n);
 ok('the refusal case is real: no acknowledgement newer than before was saved in the browser',newest>r0&&!(stored.ack&&stored.ack.id>(before.ack?before.ack.id:0)&&stored.ack.id>r0),JSON.stringify({stored:stored.ack,r0}));
 ok('the tab keeps the newest acknowledgement in memory',s1.ack&&s1.ack.id>r0&&s1.ack.id<=newest,JSON.stringify({ack:s1.ack,r0,newest}));
 let sentAck=null;await ctx.route(/\/api\/v1\/writes$/,async route=>{if(sentAck===null){try{sentAck=JSON.parse(route.request().postData()).lastAck||false;}catch(e){sentAck=false;}}await route.continue();});
 await mkOrder(p);await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 ok('its next post names that acknowledgement',sentAck&&s1.ack&&sentAck.id>=s1.ack.id,JSON.stringify({sentAck,mem:s1.ack}));
 await p.evaluate(()=>{Storage.prototype.setItem=window.__ackSet;});await mkOrder(p);await drain();}
// A recovery stays pending until the server confirms its snapshot: when the queued recovery is lost before it is
// sent (the queue is cleared, the tab closes), the next load runs it again (r4161702691).
{const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';const e0=(await devAck()).epoch;let phase=0;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{if(phase===0){phase=1;const resp=await route.fetch();await p.evaluate(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);await route.fulfill({response:resp});}else if(phase===1)await route.abort();else await route.continue();});
 await mkOrder(p);
 await p.waitForFunction(()=>(JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')||'[]')).some(r=>r.entityType==='snapshot'),null,{timeout:15000});
 const flag=await p.evaluate(()=>localStorage.getItem('skyryse-mes-sync-recovery-v1'));
 ok('a recovery whose snapshot is queued but not confirmed stays pending',flag==='true',String(flag));
 const s0=snapshots().length;
 await p.evaluate(()=>{localStorage.setItem('skyryse-mes-sync-queue-v1','[]');});
 phase=2;await p.reload();await p.waitForFunction(()=>window.__ready===true&&!!window.skMirror,null,{timeout:30000});
 const st7=await p.evaluate(async()=>{for(let i=0;i<120&&(localStorage.getItem('skyryse-mes-sync-recovery-v1')||window.skMirror.status().unsynced);i++){await new Promise(r=>setTimeout(r,100));if(window.skMirror.status().unsynced)await window.skMirror.flush();}return {...window.skMirror.status(),flag:localStorage.getItem('skyryse-mes-sync-recovery-v1')};});
 await ctx.unroute(/\/api\/v1\/writes$/);
 ok('with its queued records lost, the next load runs the recovery again: a snapshot is confirmed and nothing is left pending',snapshots().length>s0&&st7.flag===null&&st7.unsynced===0,JSON.stringify({s0,now:snapshots().length,st7}));}
// The device id is saved when it is made, every id the device has used is kept, and a tab adopts the id another
// tab saved; a snapshot lists every id, so records written under either are covered (r4161702712).
{const fctx=await b.newContext();await fctx.addInitScript(([url,token])=>{window.SK_MIRROR={url,token,batchSize:25};},[`http://127.0.0.1:${PORT}`,WTOKEN]);
 const fp=await fctx.newPage();await fp.goto(PROD);await fp.waitForFunction(()=>!!window.skMirror&&window.skMirror.enabled,null,{timeout:30000});
 const born=await fp.evaluate(()=>({id:window.skMirror.status().clientId,stored:(JSON.parse(localStorage.getItem('skyryse-mes-sync-client-v1')||'null')||{}).id,reg:Object.keys(localStorage).filter(k=>k.startsWith('skyryse-mes-sync-id-v1:'))}));
 ok('a new device registers its client id at once, before any write, under a key of its own',!!born.id&&born.reg.includes('skyryse-mes-sync-id-v1:'+born.id),JSON.stringify(born));
 ok('a page that only loads does not write the shared client record',born.stored===undefined,JSON.stringify(born));
 await fctx.close();
 const mine=await p.evaluate(()=>window.skMirror.status().clientId);const other='client-other-tab-'+Date.now();
 await p.evaluate(o=>{const c=JSON.parse(localStorage.getItem('skyryse-mes-sync-client-v1'));c.id=o;localStorage.setItem('skyryse-mes-sync-client-v1',JSON.stringify(c));localStorage.setItem('skyryse-mes-sync-id-v1:'+o,'1');},other);
 const w9=await mkOrder(p);await drain();
 const by=m.db.prepare("SELECT client_id c FROM records WHERE entity_type='order' AND entity_id=? ORDER BY id DESC LIMIT 1").get(w9.id);
 ok('a tab adopts the client id another tab saved, and writes under it',by&&by.c===other&&await p.evaluate(()=>window.skMirror.status().clientId)===other,JSON.stringify({by,other}));
 const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';const e0=(await devAck()).epoch;let staged=false;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{const resp=await route.fetch();if(!staged){staged=true;await p.evaluate(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);}await route.fulfill({response:resp});});
 await mkOrder(p);await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const sk=JSON.parse(snapshots().pop().payload_json);
 ok('the snapshot lists every client id this device has used',Array.isArray(sk.clientIds)&&sk.clientIds.includes(mine)&&sk.clientIds.includes(other)&&sk.clientId===other,JSON.stringify({clientIds:sk.clientIds,mine,other}));}
// Record and snapshot times come from a device clock that never moves backward: with the system clock behind the
// last time this device used, the next record and snapshot are still later (r4161702707).
{const ahead=Date.now()+3600*1000;await p.evaluate(t=>localStorage.setItem('skyryse-mes-sync-clock-v1',String(t)),ahead);
 const r0=count();await mkOrder(p);await drain();
 const ts=m.db.prepare('SELECT client_ts t FROM records WHERE id>? ORDER BY id').all(r0).map(x=>Date.parse(x.t));
 ok('the refusal case is real: the system clock is behind the device clock',Date.now()<ahead);
 ok('records written after the system clock moved back carry later times than the device last used',ts.length>0&&ts.every(t=>t>ahead)&&ts.every((t,i)=>i===0||t>=ts[i-1]),JSON.stringify({ahead,ts:ts.slice(0,4)}));
 const OTHER='skyryse-mes-sync-ack-v1:page-other-tab';const e0=(await devAck()).epoch;let staged=false;
 await ctx.route(/\/api\/v1\/writes$/,async route=>{const resp=await route.fetch();if(!staged){staged=true;await p.evaluate(([k,v])=>localStorage.setItem(k,JSON.stringify(v)),[OTHER,{epoch:e0+1,ack:null,at:Date.now()}]);}await route.fulfill({response:resp});});
 await mkOrder(p);await drain();await ctx.unroute(/\/api\/v1\/writes$/);
 const sk=JSON.parse(snapshots().pop().payload_json);
 ok('a snapshot taken after the system clock moved back is later than every record this device wrote before it',Date.parse(sk.takenAt)>Math.max(...ts),JSON.stringify({takenAt:sk.takenAt,last:new Date(Math.max(...ts)).toISOString()}));}
// The demo never uses the mirror a production setting names: an SK_MIRROR set before load (as a page, proxy or
// the suite runner could) is replaced with an empty address, nothing is queued and no request leaves the page.
// Only the suite runner's own hook, __FS_SUITE_DEMO_MIRROR__, turns the demo's mirror on, under its own keys.
{const DEMO='file://'+FIXTURES+'demo_publish.html';const port=`127.0.0.1:${PORT}`;
 const syncKeys=pg=>pg.evaluate(()=>Object.keys(localStorage).filter(k=>/sync/.test(k)).sort());
 const dctx=await b.newContext();await dctx.addInitScript(([url,token])=>{window.SK_MIRROR={url,token,batchSize:25};},[`http://${port}`,WTOKEN]);
 const dp=await dctx.newPage();const derrs=[];dp.on('pageerror',e=>derrs.push(e.message));const dnet=[];dp.on('request',q=>{if(q.url().includes(port))dnet.push(q.url());});
 await dp.goto(DEMO);await dp.waitForFunction(()=>!!window.skMirror&&typeof state!=='undefined',null,{timeout:30000});
 const r0=count();
 const ds=await dp.evaluate(async()=>{const saved=save();await window.skMirror.flush();await new Promise(r=>setTimeout(r,2000));return {saved,enabled:window.skMirror.enabled,url:window.SK_MIRROR.url,token:window.SK_MIRROR.token,status:window.skMirror.status()};});
 ok('the demo ignores a mirror setting made before it loads: no address, no token, mirror off',ds.saved&&ds.enabled===false&&ds.url===''&&ds.token===''&&ds.status.unsynced===0,JSON.stringify(ds));
 ok('the demo sends nothing to the mirror and queues nothing',dnet.length===0&&count()===r0&&(await syncKeys(dp)).length===0,JSON.stringify({dnet,keys:await syncKeys(dp),added:count()-r0}));
 ok('no page errors in the demo with a mirror setting present',derrs.length===0,derrs.join(' | '));
 await dctx.close();
 const sctx=await b.newContext();await sctx.addInitScript(([url,token])=>{window.SK_MIRROR={url,token,batchSize:25};window.__FS_SUITE_DEMO_MIRROR__=window.SK_MIRROR;},[`http://${port}`,WTOKEN]);
 const sp=await sctx.newPage();await sp.goto(DEMO);await sp.waitForFunction(()=>!!window.skMirror&&typeof state!=='undefined',null,{timeout:30000});
 const r1=count();
 const ss=await sp.evaluate(async()=>{const saved=save();for(let i=0;i<60&&window.skMirror.status().unsynced;i++){await window.skMirror.flush();await new Promise(r=>setTimeout(r,100));}return {saved,enabled:window.skMirror.enabled,status:window.skMirror.status()};});
 const keys=await syncKeys(sp);
 ok('the suite runner\'s hook alone turns the demo mirror on, and its records reach that server',ss.saved&&ss.enabled===true&&ss.status.unsynced===0&&count()>r1,JSON.stringify({ss,added:count()-r1}));
 ok('the demo keeps its mirror queue, confirmations and acknowledgements under demo keys only',keys.length>0&&keys.every(k=>k.startsWith('skyryse-mes-demo-sync-')),JSON.stringify(keys));
 await sctx.close();}
ok('state valid in the app at the end',await p.evaluate(()=>MES.validate(state)));
ok('no page errors with the mirror on, including the outage',errs.length===0,errs.join(' | '));
await ctx.close();await b.close();await m.close();
fs.rmSync(tmp,{recursive:true,force:true});
console.log('errors',[],'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
