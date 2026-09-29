// Item 8: every record carries the build id and the SHA-256 of index.html, so any acceptance traces to
// the exact build. Checks the stamp tool, then the production build: signature manifests, order history
// events, Support Overrides entries and printed documents all carry the stamp; older records without it
// still load and verify; a malformed stamp is refused by the manifest check.
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const ROOT=path.resolve(TESTS,'..');
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const {buildId,canonicalSha256,stamp,verify,clear}=await import(path.join(ROOT,'tools/stamp-build.mjs'));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};

// ---- the stamp tool ----
const index=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const build=buildId(fs.readFileSync(path.join(ROOT,'VERSION.md'),'utf8'));
const v=verify(index);
ok('index.html carries the build id from VERSION.md',v.build===build,v.build+' vs '+build);
ok('index.html carries its own SHA-256 and it recomputes',v.ok&&/^[0-9a-f]{64}$/.test(v.stamped),JSON.stringify(v));
ok('stamping is idempotent',stamp(index,build)===index);
ok('one changed byte anywhere changes the SHA-256',canonicalSha256(index.replace('Flight System','Flight Systen'))!==v.stamped);
ok('a copy edited after stamping fails verification',!verify(index.replace('</body>',' </body>')).ok);
// The stamp is generated, not committed: the committed form carries the build id and the placeholder.
const committed=clear(index,build);
ok('the committed form carries the build id and the "unstamped" placeholder',committed.includes(`<meta name="fs-build" content="${build}">`)&&committed.includes('<meta name="fs-build-sha256" content="unstamped">'));
ok('an unstamped file fails verification, so a stamp step that does nothing is caught',!verify(committed).ok);
ok('stamping the committed form reproduces this stamp, and clearing it gives the committed form back',stamp(committed,build)===stamp(index,build)&&clear(stamp(committed,build),build)===committed);
ok('the demo build carries the same build id and index.html SHA-256',(()=>{const d=fs.readFileSync(path.join(ROOT,'demo.html'),'utf8');return d.includes(`<meta name="fs-build" content="${build}">`)&&d.includes(`<meta name="fs-build-sha256" content="${v.stamped}">`);})());
// Release tooling refuses what cannot be traced: an unstamped or mismatched file, or a stamp not generated
// from the committed source and build id in the commit the release record names.
const {releaseProblem}=await import(path.join(ROOT,'tools/release-report.mjs'));
const {buildId:packageBuildId,demoProblem}=await import(path.join(ROOT,'tools/package-release.mjs'));
const headVersion=fs.readFileSync(path.join(ROOT,'VERSION.md'),'utf8'),stamped=stamp(committed,build);
const refuses=(fn,re)=>{try{fn();return false;}catch(e){return re.test(e.message);}};
ok('the release record accepts a stamp generated from the committed file and build id',releaseProblem(stamped,headVersion,committed)===null,releaseProblem(stamped,headVersion,committed));
ok('the release record refuses the unstamped committed form',/not stamped/.test(releaseProblem(committed,headVersion,committed)||''));
ok('the release record refuses a stamp that does not match the file',/computes/.test(releaseProblem(stamped.replace('</body>',' </body>'),headVersion,committed)||''));
ok('the release record refuses a build id that is not committed',/Commit the build id first/.test(releaseProblem(stamp(committed,build+'-next'),headVersion,committed)||''));
ok('the release record refuses a stamp generated from uncommitted source',/not generated from the committed/.test(releaseProblem(stamp(committed.replace('</body>',' </body>'),build),headVersion,committed)||''));
ok('the release packager refuses the unstamped committed form',refuses(()=>packageBuildId(committed),/not stamped/));
ok('the release packager refuses a stamp that does not match the file',refuses(()=>packageBuildId(stamped.replace('</body>',' </body>')),/computes/));
ok('the release packager accepts a verified stamp',packageBuildId(stamped)===build);
ok('the release packager refuses a demo build not regenerated after stamping',/Run node tools\/build-demo/.test(demoProblem(stamped,committed)||''));
ok('the release packager accepts a demo build carrying the production stamp',demoProblem(stamped,stamped)===null);
ok('the production fixture is the stamped index.html',fs.readFileSync(TESTS+'fixtures/publish.html','utf8').includes(`<meta name="fs-build-sha256" content="${v.stamped}">`));

// ---- the app ----
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await (await b.newContext({viewport:{width:1440,height:1000}})).newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const run=(fn,a)=>p.evaluate(fn,a);
await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.requestSubmit();});
await p.waitForTimeout(2600);

const bs=await run(()=>MES.buildStamp());
ok('the running app reports the build and the SHA-256',bs.version===build&&bs.sha256===v.stamped,JSON.stringify(bs));
ok('the export and integration build id follows the stamp',await run(()=>window.SK_BUILD)===build);

const rec=await run(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');const r=MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});const o=MES.getOrder(state,r.id);return {id:r.id,events:o.history.map(e=>e.build)};});
ok('every history event on a new order carries the build stamp',rec.events.length>0&&rec.events.every(x=>x&&x.version===bs.version&&x.sha256===bs.sha256),JSON.stringify(rec.events));

const man=await run(id=>MES.signManifest(state,'Test acceptance',{orderId:id},new Date().toISOString()),rec.id);
ok('a signature manifest carries the build stamp',man.build&&man.build.version===bs.version&&man.build.sha256===bs.sha256,JSON.stringify(man));
ok('the manifest hash still covers only the signed subject',await run(([m,id])=>m.hash===MES.sha256(MES.canonical({orderId:id})),[man,rec.id]));

const sup=await run(()=>{const s=structuredClone(state);const e=MES.logSupport(s,{name:'Jordan Doe',credentialId:'ACCT-jdoe',account:'jdoe',rule:'stamp-binding',reason:'Stamp register not yet loaded for this bench.'},'buy-off','WO-TEST/op-010');return {entry:e,valid:MES.supportLogValid(s.supportLog)};});
ok('a Support Overrides entry carries the build stamp and stays valid',!!sup.entry.build&&sup.entry.build.sha256===bs.sha256&&sup.valid!==false,JSON.stringify(sup));

const printed=await run(()=>markDocument('<!doctype html><html><body><h1>F-850-001 Traveler</h1></body></html>'));
ok('a printed or downloaded document shows the build and the SHA-256',printed.includes(`build ${bs.version}`)&&printed.includes(bs.sha256)&&/fs-build-line[\s\S]*<\/body>/.test(printed),printed.slice(-300));

const ver=await run(()=>MES.verifyManifests(state));
ok('every manifest in the workspace verifies with the stamp present',ver.failures.length===0,JSON.stringify(ver.failures.slice(0,3)));
const legacy=await run(()=>{const s=structuredClone(state);const strip=x=>{if(Array.isArray(x))return x.forEach(strip);if(x&&typeof x==='object'){if(x.manifest&&x.manifest.build)delete x.manifest.build;if(x.build&&x.action)delete x.build;Object.values(x).forEach(strip);}};strip(s);return {valid:MES.validate(s),fail:MES.verifyManifests(s).failures.length};});
ok('records written before stamping still validate and verify',legacy.valid===true&&legacy.fail===0,JSON.stringify(legacy));
const bad=await run(()=>{const s=structuredClone(state);const m=MES.signManifest(s,'Test acceptance',{x:1},new Date().toISOString());m.build={version:'v81',sha256:'not-a-hash'};s.orders[0].closure={reason:'Test',note:'',manifest:m};return MES.verifyManifests(s).failures.map(f=>f.reason);});
ok('a malformed build stamp on a manifest is reported',bad.includes('build stamp is malformed'),JSON.stringify(bad));
ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));

await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
