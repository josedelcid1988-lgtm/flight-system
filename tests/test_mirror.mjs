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
const {createMirror,sha256,verifyChain,pruneBackups}=await import(path.join(ROOT,'server/server.mjs'));
const PROD='file://'+FIXTURES+'publish.html';
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fs-mirror-test-'));
const dbPath=path.join(tmp,'mirror.sqlite'),backupDir=path.join(tmp,'backups');

// ================= server =================
let m=createMirror({dbPath,backupDir,port:0,backupEveryMinutes:0});
const addr=await m.listen();const PORT=addr.port;const API=`http://127.0.0.1:${PORT}/api/v1`;
const rec=(i,x=i)=>{const payload=JSON.stringify({id:'WO-'+i,value:x});return {clientWriteId:'srv-'+i,storeKey:'skyryse-mes-work-order-v1',entityType:'order',entityId:'WO-'+i,operation:'upsert',payloadJson:payload,payloadSha256:sha256(payload),actor:'Test · ACCT-test',credential:'ACCT-test',clientTs:new Date().toISOString(),buildVersion:'test',buildSha256:'0'.repeat(64),manifests:[{path:'order.closure.manifest',meaning:'Closure approval: Obsolete',signerName:'Test',signerCredential:'ACCT-test',signedAt:new Date().toISOString(),algorithm:'SHA-256',hash:sha256('m'+i)}]};};
const post=async(body,headers={})=>{const r=await fetch(API+'/writes',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
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
const health=await (await fetch(API+'/health')).json();
ok('health reports the rows, the manifests and the backup settings',health.ok&&health.records===4&&health.manifests===4&&health.backup&&health.api==='v1',JSON.stringify(health));
let v=await (await fetch(API+'/verify')).json();
ok('verify walks an intact chain',v.chainIntact===true&&v.records===4&&v.firstBreak===null&&/^[0-9a-f]{64}$/.test(v.tip),JSON.stringify(v));
const back=await (await fetch(API+'/records?entity=order&id=WO-2')).json();
ok('records read-back returns one entity with its manifests',back.records.length===1&&back.records[0].manifests.length===1&&back.records[0].entity_id==='WO-2',JSON.stringify(back).slice(0,300));
ok('records read-back without entity and id is refused with the next step',(await fetch(API+'/records?entity=order')).status===400);
const exp=await (await fetch(API+'/export?format=json')).json();
ok('JSON export carries every record, its manifests and a verify result',exp.records.length===4&&exp.records.every(x=>x.manifests.length===1)&&exp.verify.ok,JSON.stringify(exp).slice(0,200));
const csvRes=await fetch(API+'/export?format=csv');const csv=await csvRes.text();
ok('CSV export has a header and one line per record',csv.trim().split('\r\n').length===5&&csv.startsWith('id,client_write_id')&&/attachment/.test(csvRes.headers.get('content-disposition')||''),csv.slice(0,120));
let refused='';try{m.db.exec("UPDATE records SET actor='x' WHERE id=1");}catch(e){refused=e.message;}
ok('the database refuses UPDATE on records',/append-only/.test(refused),refused);
refused='';try{m.db.exec('DELETE FROM signature_manifests WHERE id=1');}catch(e){refused=e.message;}
ok('the database refuses DELETE on signature manifests',/append-only/.test(refused),refused);
ok('WAL mode is on',m.db.prepare('PRAGMA journal_mode').get().journal_mode==='wal');

// Backup, then restore: the restored copy reproduces the chain exactly.
const bk=m.backup();
const rt=spawnSync(process.execPath,[path.join(ROOT,'server/restore-test.mjs'),bk,'--against',dbPath],{encoding:'utf8'});
ok('the restore test passes on a fresh backup and matches the live rows',rt.status===0&&/chain intact/.test(rt.stdout)&&/matches the first 4 of 4/.test(rt.stdout),rt.stdout+rt.stderr);
{const restored=path.join(tmp,'restored.sqlite');fs.copyFileSync(bk,restored);const m2=createMirror({dbPath:restored,backupDir:path.join(tmp,'b2'),port:0,backupEveryMinutes:0});const a2=await m2.listen();
 const v2=await (await fetch(`http://127.0.0.1:${a2.port}/api/v1/verify`)).json();
 ok('a server started on the restored file reproduces the chain tip',v2.chainIntact&&v2.tip===v.tip&&v2.records===4,JSON.stringify({v2,tip:v.tip}));
 const more=await (await fetch(`http://127.0.0.1:${a2.port}/api/v1/writes`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'srv',records:[rec(7)]})})).json();
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
 const rt2=spawnSync(process.execPath,[path.join(ROOT,'server/restore-test.mjs'),t],{encoding:'utf8'});ok('the restore test fails on a tampered backup',rt2.status===1&&/BROKEN/.test(rt2.stdout),rt2.stdout);}
await m.close();
// Token: when set, every endpoint but health needs it.
{const mt=createMirror({dbPath:path.join(tmp,'tok.sqlite'),backupDir:path.join(tmp,'b3'),port:0,backupEveryMinutes:0,token:'s3cret'});const at=await mt.listen();const u=`http://127.0.0.1:${at.port}/api/v1`;
 const no=await fetch(u+'/verify');const yes=await fetch(u+'/verify',{headers:{authorization:'Bearer s3cret'}});const h=await fetch(u+'/health');
 ok('with a token set, requests without it are refused and health stays open',no.status===401&&yes.status===200&&h.status===200);await mt.close();}

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

// Mirror on.
m=createMirror({dbPath:path.join(tmp,'live.sqlite'),backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0});await m.listen();
const ctx=await b.newContext();await ctx.addInitScript(url=>{window.SK_MIRROR={url,token:'',batchSize:25};},`http://127.0.0.1:${PORT}`);
const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await signUp(p);
await p.evaluate(async()=>{const a=JSON.parse(localStorage.getItem('skyryse-mes-auth-v1'));const salt='5a17c0ffee5a17c0ffee5a17c0ffee00';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');a.users.push({username:'rpark',displayName:'Riley Park',salt,hash:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234'))),role:'qm',createdAt:new Date().toISOString(),createdBy:'jdoe'});localStorage.setItem('skyryse-mes-auth-v1',JSON.stringify(a));window.dispatchEvent(new CustomEvent('sk-auth-saved'));});
const drain=()=>p.evaluate(async()=>{for(let i=0;i<60&&window.skMirror.status().unsynced;i++){await window.skMirror.flush();await new Promise(r=>setTimeout(r,100));}return window.skMirror.status();});
const w1=await mkOrder(p);let st=await drain();
const count=()=>Number(m.db.prepare('SELECT COUNT(*) n FROM records').get().n);
ok('mirror on: a committed write saves locally and every queued record reaches the server',w1.ok&&w1.saved&&st.unsynced===0&&count()>0,JSON.stringify({w1,st,rows:count()}));
ok('the order written is on the server with the build and the signed-in person',!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='order' AND entity_id=? AND actor LIKE 'Jordan Doe%' AND build_version<>''").get(w1.id));
ok('accounts are mirrored with name and role',!!m.db.prepare("SELECT 1 FROM records WHERE entity_type='account' AND entity_id='rpark' AND payload_json LIKE '%\"role\":\"qm\"%'").get());
ok('the header shows Synced',await p.evaluate(()=>document.getElementById('sync-indicator')?.textContent)==='Synced');
// A closure signed by a second account carries a manifest to the server.
const closed=await p.evaluate(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});const q=MES.requestOrderClosure(state,r.id,{reason:'Obsolete',note:'Superseded by the next revision.'});save();sessionStorage.setItem('skyryse-mes-session-v1','rpark');const d=MES.decideOrderClosure(state,r.id,true,'Confirmed.');sessionStorage.setItem('skyryse-mes-session-v1','jdoe');return {ok:q.ok&&d.ok,saved:save(),id:r.id};});
st=await drain();
ok('a signature manifest reaches the signature_manifests table',closed.ok&&!!m.db.prepare("SELECT 1 FROM signature_manifests s JOIN records r ON r.id=s.record_id WHERE r.entity_id=? AND s.meaning LIKE 'Closure approval%' AND s.signer_credential='ACCT-rpark'").get(closed.id),JSON.stringify(closed));

// Offline: the server goes down; writes are never blocked, records queue and are flagged, then recover.
await m.close();const beforeRows=Number(new (await import('node:sqlite')).DatabaseSync(path.join(tmp,'live.sqlite'),{readOnly:true}).prepare('SELECT COUNT(*) n FROM records').get().n);
const off=await p.evaluate(async()=>{const out=[];for(let i=0;i<3;i++){const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});out.push(r.ok&&save());}await window.skMirror.flush();await new Promise(r=>setTimeout(r,300));const q=JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')||'[]');return {saved:out,status:window.skMirror.status(),indicator:document.getElementById('sync-indicator').textContent,queued:q.length,flagged:q.every(x=>x.synced===false)};});
ok('with the server down every write still saves',off.saved.every(Boolean),JSON.stringify(off.saved));
ok('records queue on the device, flagged unsynced, and the header counts them',off.queued>=3&&off.flagged&&off.status.unsynced===off.queued&&off.indicator===`${off.queued} unsynced`&&/unreachable/.test(off.status.lastError),JSON.stringify(off));
m=createMirror({dbPath:path.join(tmp,'live.sqlite'),backupDir:path.join(tmp,'b4'),port:PORT,backupEveryMinutes:0});await m.listen();
st=await p.evaluate(async()=>{for(let i=0;i<150&&window.skMirror.status().unsynced;i++)await new Promise(r=>setTimeout(r,200));return window.skMirror.status();});
ok('when the server returns the queue drains on its own (retry with backoff)',st.unsynced===0&&count()===beforeRows+off.queued,JSON.stringify({st,beforeRows,after:count(),queued:off.queued}));
ok('the header is back to Synced and the local queue is empty',await p.evaluate(()=>document.getElementById('sync-indicator').textContent==='Synced'&&JSON.parse(localStorage.getItem('skyryse-mes-sync-queue-v1')).length===0));
// The same records sent again (a retry the client never heard back from) change nothing.
const again=await p.evaluate(async url=>{const rows=await (await fetch(url+'/api/v1/export?format=json')).json();const last=rows.records.slice(-2).map(r=>({clientWriteId:r.client_write_id,storeKey:r.store_key,entityType:r.entity_type,entityId:r.entity_id,operation:r.operation,payloadJson:r.payload_json,payloadSha256:r.payload_sha256,actor:r.actor,credential:r.credential,clientTs:r.client_ts,buildVersion:r.build_version,buildSha256:r.build_sha256}));const res=await (await fetch(url+'/api/v1/writes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:rows.records.slice(-1)[0].client_id,records:last})})).json();return res.results.map(x=>x.status);},`http://127.0.0.1:${PORT}`);
ok('an idempotent retry from the app stores nothing twice',JSON.stringify(again)==='["duplicate","duplicate"]',JSON.stringify(again));
// Nothing secret left the device.
{const secrets=await p.evaluate(()=>JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.flatMap(u=>[u.hash,u.salt]).filter(Boolean));
 const all=m.db.prepare('SELECT payload_json FROM records').all().map(r=>r.payload_json).join('\n');
 ok('no password hash or salt is on the server',secrets.every(s=>!all.includes(s))&&!/"salt"/.test(all)&&!/"password/.test(all),'found a secret');
 ok('no stamp PIN is on the server',!/"pin"\s*:/.test(all));}
v=await (await fetch(API+'/verify')).json();
ok('the live chain is intact after the outage and recovery',v.chainIntact===true,JSON.stringify(v));
ok('state valid in the app at the end',await p.evaluate(()=>MES.validate(state)));
ok('no page errors with the mirror on, including the outage',errs.length===0,errs.join(' | '));
await ctx.close();await b.close();await m.close();
fs.rmSync(tmp,{recursive:true,force:true});
console.log('errors',[],'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
