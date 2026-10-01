// Item 8: every record carries the build id and the SHA-256 of index.html, so any acceptance traces to
// the exact build. Checks the stamp tool, then the production build: signature manifests, order history
// events, Support Overrides entries and printed documents all carry the stamp; older records without it
// still load and verify; a malformed stamp is refused by the manifest check.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {loadSampleInPage} from './lib/production-sample.mjs';
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
const {buildId:packageBuildId,demoProblem,assetsProblem,assetsDiff}=await import(path.join(ROOT,'tools/package-release.mjs'));
const headVersion=fs.readFileSync(path.join(ROOT,'VERSION.md'),'utf8'),stamped=stamp(committed,build);
const refuses=(fn,re)=>{try{fn();return false;}catch(e){return re.test(e.message);}};
ok('the release record accepts a stamp generated from the committed file and build id',releaseProblem(stamped,headVersion,committed)===null,releaseProblem(stamped,headVersion,committed));
ok('the release record refuses the unstamped committed form',/not stamped/.test(releaseProblem(committed,headVersion,committed)||''));
ok('the release record refuses a stamp that does not match the file',/computes/.test(releaseProblem(stamped.replace('</body>',' </body>'),headVersion,committed)||''));
ok('the release record refuses a build id that is not committed',/Commit the build id first/.test(releaseProblem(stamp(committed,build+'-next'),headVersion,committed)||''));
ok('the release record refuses a stamp generated from uncommitted source',/not generated from the committed/.test(releaseProblem(stamp(committed.replace('</body>',' </body>'),build),headVersion,committed)||''));
ok('the release record refuses, without throwing, when HEAD\'s VERSION.md has no build line',(()=>{try{return /HEAD's VERSION\.md: VERSION\.md has no "build: <id>" line/.test(releaseProblem(stamped,'# Flight System build\n',committed)||'');}catch{return false;}})());
// Packaged assets must be byte for byte the blobs the named commit holds. Checked against a real repository, so
// git index state that hides a change from git status (ignored, skip-worktree) cannot pass it.
ok('the asset comparison refuses a changed, an extra and a missing asset, and accepts a match',(()=>{const c=new Map([['assets/a.js','1'],['assets/b.css','2']]);return /assets\/a\.js differs/.test(assetsDiff(c,new Map([['assets/a.js','9'],['assets/b.css','2']]))||'')&&/assets\/x\.png is not in HEAD/.test(assetsDiff(c,new Map([...c,['assets/x.png','3']]))||'')&&/assets\/b\.css is in HEAD but missing on disk/.test(assetsDiff(c,new Map([['assets/a.js','1']]))||'')&&assetsDiff(c,new Map(c))===null;})());
{
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'flight-assets-')),g=(...a)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false',...a],{cwd:repo,encoding:'utf8'});
  try{
    fs.mkdirSync(path.join(repo,'assets'));fs.writeFileSync(path.join(repo,'assets/a.js'),'one');fs.writeFileSync(path.join(repo,'assets/b.css'),'two');fs.writeFileSync(path.join(repo,'.gitignore'),'*.tmp\n.cache/\n');
    g('init','-q');g('add','.');g('commit','-q','-m','assets');
    ok('the release record accepts assets that match the named commit',assetsProblem({root:repo})===null,assetsProblem({root:repo}));
    fs.writeFileSync(path.join(repo,'assets/a.js'),'changed');g('update-index','--skip-worktree','assets/a.js');
    ok('the release record refuses a changed asset that git status hides (skip-worktree)',g('status','--porcelain').trim()===''&&/assets\/a\.js differs from HEAD/.test(assetsProblem({root:repo})||''));
    g('update-index','--no-skip-worktree','assets/a.js');g('checkout','-q','--','assets/a.js');
    fs.writeFileSync(path.join(repo,'assets/extra.tmp'),'x');
    ok('the release record refuses a packaged asset that git ignores',/assets\/extra\.tmp is not in HEAD/.test(assetsProblem({root:repo})||''));
    fs.rmSync(path.join(repo,'assets/extra.tmp'));fs.mkdirSync(path.join(repo,'assets/.cache'));fs.writeFileSync(path.join(repo,'assets/.cache/x'),'x');fs.writeFileSync(path.join(repo,'assets/.DS_Store'),'x');
    ok('the release record accepts dot-named entries the packager leaves out',assetsProblem({root:repo})===null,assetsProblem({root:repo}));
    g('mv','assets/b.css','assets/.b.css');
    ok('the release record refuses a packaged asset renamed to a name the packager leaves out',/assets\/b\.css is in HEAD but missing on disk/.test(assetsProblem({root:repo})||''));
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
}
ok('the release packager refuses the unstamped committed form',refuses(()=>packageBuildId(committed),/not stamped/));
ok('the release packager refuses a stamp that does not match the file',refuses(()=>packageBuildId(stamped.replace('</body>',' </body>')),/computes/));
ok('the release packager accepts a verified stamp',packageBuildId(stamped)===build);
ok('the release packager refuses a demo build not regenerated after stamping',/Run node tools\/build-demo/.test(demoProblem(stamped,committed)||''));
ok('the release packager accepts a demo build carrying the production stamp',demoProblem(stamped,stamped)===null);
// ---- the release tools end to end, in a throwaway git repository holding copies of them ----
// Each sandbox is a committed release tree (tools, VERSION.md, a small index.html and demo.html, assets/),
// so the command-line tools run exactly as at release, against a HEAD the test controls.
const sandboxes=[];
function sandbox(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flight-release-'));sandboxes.push(dir);
  const at=f=>path.join(dir,f);
  const g=(...a)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false',...a],{cwd:dir,encoding:'utf8'}).trim();
  const node=(args,env={})=>{try{return {code:0,out:execFileSync(process.execPath,args,{cwd:dir,encoding:'utf8',env:{...process.env,FLIGHT_SOURCE_COMMIT:'',...env},stdio:['ignore','pipe','pipe']})};}catch(e){return {code:e.status,out:String(e.stdout||'')+String(e.stderr||'')};}};
  const page=b=>`<!doctype html><html><head><meta name="fs-build" content="${b}"><meta name="fs-build-sha256" content="unstamped"></head><body>Flight System</body></html>\n`;
  for(const d of ['tools','assets','tests'])fs.mkdirSync(at(d));
  for(const t of ['stamp-build.mjs','release-report.mjs','package-release.mjs','package-source.mjs'])fs.copyFileSync(path.join(ROOT,'tools',t),at('tools/'+t));
  fs.writeFileSync(at('VERSION.md'),'# Test build\n\nbuild: vT\n');fs.writeFileSync(at('index.html'),page('vT'));fs.writeFileSync(at('demo.html'),page('vT'));
  fs.writeFileSync(at('assets/a.js'),'one');fs.writeFileSync(at('.gitignore'),'tests/suite_results*.json\nrelease/\n');
  g('init','-q');g('add','.');g('commit','-q','-m','release');
  const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(at(f))).digest('hex');
  const s={dir,at,g,node,page,
    // node tools/stamp-build.mjs, then the demo regenerated from the stamped file (build-demo stand-in: same tags).
    stamp(){const r=node(['tools/stamp-build.mjs']);if(r.code)throw new Error(r.out);fs.copyFileSync(at('index.html'),at('demo.html'));},
    tested(){const v=verify(fs.readFileSync(at('index.html'),'utf8'));return {build:v.build,indexStamp:v.stamped,indexFileSha256:sha('index.html'),demoFileSha256:sha('demo.html'),commit:g('rev-parse','HEAD')};},
    // Both results files as tools/run-suites.mjs writes them, for one passing suite.
    results(tested=s.tested()){for(const [f,mirror] of [['suite_results.json',null],['suite_results_mirror.json',{records:1,chainIntact:true}]])fs.writeFileSync(at('tests/'+f),JSON.stringify({startedAt:'2026-09-29T00:00:00.000Z',finishedAt:'2026-09-29T00:01:00.000Z',tested,mirror,suites:[{name:'test_one',status:'pass',problems:[],checks:1,skips:[]}],skips:[]}));},
    tool:async f=>import(pathToFileURL(at('tools/'+f)).href)};
  return s;
}
try{
  // #44 (fixed in PR #25): --check compares the record with the stamp the committed index.html produces, so a
  // clean committed checkout passes and a changed index.html fails.
  {const s=sandbox();s.stamp();s.results();const w=s.node(['tools/release-report.mjs']);
   s.node(['tools/stamp-build.mjs','--clear']);fs.copyFileSync(s.at('index.html'),s.at('demo.html'));
   const c=s.node(['tools/release-report.mjs','--check']);
   ok('release-report --check accepts the record on a clean committed checkout',w.code===0&&c.code===0&&/matches this source/.test(c.out),w.out+c.out);
   fs.appendFileSync(s.at('index.html'),'<!-- changed -->\n');const d=s.node(['tools/release-report.mjs','--check']);
   ok('release-report --check refuses a record the committed index.html does not produce',d.code===1&&/does not match this source/.test(d.out),d.out);}
  // #45, packager half (fixed in PR #25): the packager refuses a demo.html not regenerated after stamping.
  {const s=sandbox();s.node(['tools/stamp-build.mjs']);const r=s.node(['tools/package-release.mjs','--out','release']);
   ok('the release packager refuses a demo.html left unstamped and writes no zip',r.code===1&&/demo\.html carries fs-build-sha256 unstamped/.test(r.out)&&!fs.existsSync(s.at('release')),r.out);
   // #45, release-report half: the record refuses the same demo.html, even with results from these files.
   s.results();const d=s.node(['tools/release-report.mjs','--dry-run']);
   ok('the release record refuses a demo.html not regenerated after stamping',d.code===1&&/demo\.html carries fs-build-sha256 unstamped/.test(d.out),d.out);
   s.stamp();s.results();const a=s.node(['tools/release-report.mjs','--dry-run']);
   ok('the release record accepts a demo.html carrying the production stamp',a.code===0,a.out);}
  // #84 (fixed in PR #82): a standalone run of the packager checks assets/ against HEAD before it writes.
  {const s=sandbox();s.stamp();fs.writeFileSync(s.at('assets/a.js'),'changed');const r=s.node(['tools/package-release.mjs','--out','release']);
   ok('the packager run on its own refuses an asset that differs from HEAD and writes no zip',r.code===1&&/assets\/a\.js differs from HEAD/.test(r.out)&&!fs.existsSync(s.at('release')),r.out);
   s.g('checkout','-q','--','assets/a.js');const a=s.node(['tools/package-release.mjs','--out','release']);
   ok('the packager run on its own writes both zips when assets/ matches HEAD',a.code===0&&fs.readdirSync(s.at('release')).length===2,a.out);}
  // #87: packageRelease() itself checks assets/, so every caller that writes zips is gated; only an explicit
  // option (used by tests/qa_full.mjs, which packages the working tree) skips it.
  {const s=sandbox();s.stamp();const {packageRelease}=await s.tool('package-release.mjs');const out=s.at('release');
   const tryPack=o=>{try{packageRelease(out,o);return 'ok';}catch(e){return e.message;}};
   fs.writeFileSync(s.at('assets/a.js'),'changed');
   const r=tryPack();ok('packageRelease() called directly refuses an asset that differs from HEAD and writes no zip',/assets\/a\.js differs from HEAD/.test(r)&&!fs.existsSync(out),r);
   const w=tryPack({allowUncommittedAssets:true});ok('packageRelease() packages the working tree only when asked explicitly',w==='ok'&&fs.readdirSync(out).length===2,w);
   fs.rmSync(out,{recursive:true,force:true});s.g('checkout','-q','--','assets/a.js');
   const a=tryPack();ok('packageRelease() called directly writes both zips when assets/ matches HEAD',a==='ok'&&fs.readdirSync(out).length===2,a);
   ok('qa_full asks for the working-tree packaging explicitly',/packageRelease\(OUT,\{allowUncommittedAssets:true\}\)/.test(fs.readFileSync(path.join(ROOT,'tests/qa_full.mjs'),'utf8')));}
  // #90: the packager ships only files directly in assets/, so a subdirectory is a plain refusal, not a crash.
  {const s=sandbox();s.stamp();fs.mkdirSync(s.at('assets/sub'));fs.writeFileSync(s.at('assets/sub/y.js'),'y');
   let r;try{r=assetsProblem({root:s.dir});}catch(e){r='threw '+e.message;}
   ok('the asset check refuses a subdirectory in assets/ with a plain message',/assets\/sub is a directory/.test(r||''),r);
   s.g('add','assets/sub');s.g('commit','-q','-m','sub');try{r=assetsProblem({root:s.dir});}catch(e){r='threw '+e.message;}
   ok('the asset check refuses a committed subdirectory in assets/ too',/assets\/sub is a directory/.test(r||''),r);
   const {packageRelease}=await s.tool('package-release.mjs');let w;try{packageRelease(s.at('release'),{allowUncommittedAssets:true});w='ok';}catch(e){w=e.message;}
   ok('packageRelease() refuses a subdirectory in assets/ even when packaging the working tree',/assets\/sub is a directory/.test(w)&&!fs.existsSync(s.at('release')),w);
   fs.rmSync(s.at('assets/sub'),{recursive:true});s.g('rm','-q','-r','--cached','assets/sub');s.g('commit','-q','-m','flat');
   ok('the asset check accepts a flat assets/ again',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));}
  // #88: with a clean filter (here eol=crlf) the stored blob is not the bytes a checkout writes. The bytes that
  // ship must be the committed blob or exactly what a checkout of it writes; anything else is refused.
  {const s=sandbox();fs.writeFileSync(s.at('.gitattributes'),'*.txt text eol=crlf\n');fs.writeFileSync(s.at('assets/n.txt'),'a\nb\n');
   s.g('add','.');s.g('commit','-q','-m','text asset');fs.rmSync(s.at('assets/n.txt'));s.g('checkout','-q','--','assets/n.txt');
   const crlf=fs.readFileSync(s.at('assets/n.txt'),'utf8')==='a\r\nb\r\n';
   ok('the asset check accepts a text asset exactly as a checkout with a clean filter writes it',crlf&&assetsProblem({root:s.dir})===null,crlf?assetsProblem({root:s.dir}):'the checkout did not convert line endings');
   fs.writeFileSync(s.at('assets/n.txt'),'a\nb\n');
   ok('the asset check accepts a text asset carrying the committed blob bytes',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   fs.writeFileSync(s.at('assets/n.txt'),'a\r\nc\r\n');
   ok('the asset check refuses a changed text asset under a clean filter',/assets\/n\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''));
   fs.writeFileSync(s.at('assets/n.txt'),'a\r\nb\n');
   ok('the asset check refuses bytes a clean filter would normalize but a checkout would not write',/assets\/n\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''));}
  // #96 review: only a conversion the named commit's own .gitattributes asks for is accepted. A conversion that
  // comes from this machine (core.autocrlf, info/attributes, a filter driver in local config) would not be
  // reproduced by another checkout of the commit, so those bytes are refused.
  {const s=sandbox();fs.writeFileSync(s.at('assets/n.txt'),'a\nb\n');s.g('add','.');s.g('commit','-q','-m','text asset');
   s.g('config','core.autocrlf','true');fs.writeFileSync(s.at('assets/n.txt'),'a\r\nb\r\n');
   ok('the asset check refuses a line-ending conversion that comes only from local core.autocrlf',/assets\/n\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   s.g('config','--unset','core.autocrlf');fs.mkdirSync(path.join(s.dir,'.git/info'),{recursive:true});fs.writeFileSync(path.join(s.dir,'.git/info/attributes'),'*.txt text eol=crlf\n');
   ok('the asset check refuses a line-ending conversion that comes only from info/attributes',/assets\/n\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   fs.rmSync(path.join(s.dir,'.git/info/attributes'));fs.writeFileSync(s.at('.gitattributes'),'*.txt filter=up\n');s.g('add','.gitattributes');s.g('commit','-q','-m','filter attr');
   s.g('config','filter.up.smudge','tr a-z A-Z');s.g('config','filter.up.clean','cat');fs.writeFileSync(s.at('assets/n.txt'),'A\nB\n');
   ok('the asset check refuses bytes written by a filter driver defined in local config',/assets\/n\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   s.g('rm','-q','.gitattributes');s.g('commit','-q','-m','no filter attr');fs.writeFileSync(s.at('.gitattributes'),'*.txt filter=up\n');
   ok('the asset check refuses bytes from a filter assigned only in an uncommitted .gitattributes',/assets\/n\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   s.g('add','.gitattributes');s.g('commit','-q','-m','filter attr again');
   fs.writeFileSync(s.at('assets/n.txt'),'a\nb\n');
   ok('the asset check still accepts the committed blob bytes under a filter attribute',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   fs.writeFileSync(s.at('.gitattributes'),'*.txt text=auto eol=crlf\n');s.g('add','.gitattributes');s.g('commit','-q','-m','auto');fs.writeFileSync(s.at('assets/n.txt'),'a\r\nb\r\n');
   ok('the asset check accepts the CRLF checkout of a text=auto eol=crlf asset the commit declares',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   // #135 review: git itself writes the accepted checkout bytes, so its own text=auto test decides, not a copy of it.
   const fresh=f=>{fs.rmSync(s.at(f));s.g('checkout','-q','--',f);return fs.readFileSync(s.at(f));};
   fs.writeFileSync(s.at('assets/m.txt'),Buffer.concat([Buffer.alloc(127,'x'),Buffer.from('\n\x01','latin1')]));s.g('add','assets/m.txt');s.g('commit','-q','-m','mostly printable');
   const m=fresh('assets/m.txt');fs.writeFileSync(s.at('assets/m.txt'),Buffer.from(m.toString('latin1').replace('\n','\r\n'),'latin1'));
   ok('the asset check refuses a CRLF form git would not write for a text=auto blob it treats as binary',!m.includes('\r')&&/assets\/m\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   fresh('assets/m.txt');
   fs.writeFileSync(s.at('assets/d.txt'),Buffer.from('a\n\x1a','latin1'));s.g('add','assets/d.txt');s.g('commit','-q','-m','dos eof');
   const d=fresh('assets/d.txt');
   ok('the asset check accepts git\'s CRLF checkout of a text=auto asset ending in a DOS EOF byte',d.toString('latin1')==='a\r\n\x1a'&&assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   fs.writeFileSync(s.at('assets/c.txt'),Buffer.from('a\rb\nc\n','latin1'));s.g('add','assets/c.txt');s.g('commit','-q','-m','lone cr');
   fresh('assets/c.txt');
   ok('the asset check accepts exactly what a clean checkout writes for a text=auto asset with a lone CR',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   fs.symlinkSync('a\nb',s.at('assets/l.txt'));s.g('add','assets/l.txt');s.g('commit','-q','-m','symlink');
   fs.rmSync(s.at('assets/l.txt'));fs.writeFileSync(s.at('assets/l.txt'),'a\r\nb');
   ok('the asset check never applies a text conversion to a committed symlink',/assets\/l\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   s.g('rm','-q','-f','assets/l.txt');s.g('commit','-q','-m','no symlink');
   fs.writeFileSync(s.at('assets/e.txt'),'a\nb\n');fs.chmodSync(s.at('assets/e.txt'),0o755);s.g('add','assets/e.txt');s.g('commit','-q','-m','executable');
   const e=fresh('assets/e.txt');
   ok('the asset check accepts the CRLF checkout of an executable text asset',/^100755 /.test(s.g('ls-tree','HEAD','assets/e.txt'))&&e.toString()==='a\r\nb\r\n'&&assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   fs.mkdirSync(path.join(s.dir,'.git/info'),{recursive:true});fs.writeFileSync(path.join(s.dir,'.git/info/attributes'),'docs/** text\n');
   ok('the asset check ignores a local attributes rule that does not apply to the asset',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));
   fs.writeFileSync(path.join(s.dir,'.git/info/attributes'),'assets/e.txt -text\n');
   ok('the asset check refuses when a local attributes rule changes the asset\'s own attributes',/assets\/e\.txt differs from HEAD/.test(assetsProblem({root:s.dir})||''),assetsProblem({root:s.dir}));
   fs.rmSync(path.join(s.dir,'.git/info/attributes'));}
  // #135 review: the isolated git uses the source repository's object format, so a SHA-256 repository works too.
  {const s=sandbox(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'flight-release-sha256-'));sandboxes.push(dir);
   fs.cpSync(s.dir,dir,{recursive:true,filter:src=>path.basename(src)!=='.git'});
   const g=(...a)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false',...a],{cwd:dir,encoding:'utf8'}).trim();
   fs.writeFileSync(path.join(dir,'.gitattributes'),'*.txt text eol=crlf\n');fs.writeFileSync(path.join(dir,'assets/n.txt'),'a\nb\n');
   g('init','-q','--object-format=sha256');g('add','.');g('commit','-q','-m','sha256 release');
   fs.rmSync(path.join(dir,'assets/n.txt'));g('checkout','-q','--','assets/n.txt');
   let r;try{r=assetsProblem({root:dir});}catch(e){r='threw '+e.message;}
   ok('the asset check accepts a committed CRLF conversion in a SHA-256 repository',g('rev-parse','--show-object-format')==='sha256'&&fs.readFileSync(path.join(dir,'assets/n.txt'),'utf8')==='a\r\nb\r\n'&&r===null,r);}
  // #86 (fixed in PR #82): no git status call remains; a git failure is a plain refusal, not a stack trace.
  {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flight-nogit-'));sandboxes.push(dir);fs.mkdirSync(path.join(dir,'assets'));fs.writeFileSync(path.join(dir,'assets/a.js'),'one');
   let r;try{r=assetsProblem({root:dir});}catch(e){r='threw '+e.message;}
   ok('the asset check outside a git checkout refuses with a plain message',/^assets\/ could not be read from commit HEAD\. Release from a git checkout/.test(r||''),r);
   const s=sandbox();s.stamp();fs.rmSync(s.at('.git'),{recursive:true,force:true});const x=s.node(['tools/release-report.mjs','--dry-run']);
   ok('the release record outside a git checkout refuses with a plain message',x.code===1&&/^FAIL the release record needs a git checkout/m.test(x.out)&&!/\n\s+at /.test(x.out),x.out);}
  // #52: the results name the commit the suites ran on, and the record is written only for that commit.
  {const {tested}=await import(path.join(ROOT,'tools/run-suites.mjs'));const head=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
   ok('the suite runner records the commit it tested',typeof tested==='function'&&tested(ROOT).commit===head,typeof tested==='function'?JSON.stringify(tested(ROOT)):'no tested export');
   const s=sandbox();s.stamp();const{commit,...noCommit}=s.tested();s.results(noCommit);
   const n=s.node(['tools/release-report.mjs','--dry-run']);
   ok('the release record refuses results that name no commit',n.code===1&&/different commit \(not recorded\)/.test(n.out),n.out);
   s.results();s.g('commit','-q','--allow-empty','-m','tooling change after the suite run');
   const o=s.node(['tools/release-report.mjs','--dry-run']);
   ok('the release record refuses results from a commit before HEAD',o.code===1&&new RegExp(`different commit \\(${commit}\\)`).test(o.out),o.out);
   s.results();const a=s.node(['tools/release-report.mjs','--dry-run']);
   ok('the release record accepts results from the commit it names',a.code===0&&a.out.includes('| Stamp generated from commit | `'+s.g('rev-parse','HEAD')+'` |'),a.out);}
  // #83: every release check reads HEAD, so the record refuses to name any other commit.
  {const s=sandbox();const first=s.g('rev-parse','HEAD');s.g('commit','-q','--allow-empty','-m','merge ref stand-in');const head=s.g('rev-parse','HEAD');
   s.stamp();s.results({...s.tested(),commit:first});
   const o=s.node(['tools/release-report.mjs','--dry-run'],{FLIGHT_SOURCE_COMMIT:first});
   ok('the release record refuses a FLIGHT_SOURCE_COMMIT that is not the checked-out HEAD',o.code===1&&new RegExp(`FLIGHT_SOURCE_COMMIT names ${first} but the checkout is at ${head}`).test(o.out),o.out);
   const u=s.node(['tools/release-report.mjs','--dry-run'],{FLIGHT_SOURCE_COMMIT:'no-such-commit'});
   ok('the release record refuses a FLIGHT_SOURCE_COMMIT that names no commit',u.code===1&&/FLIGHT_SOURCE_COMMIT names no-such-commit, which is not a commit/.test(u.out),u.out);
   s.results();const a=s.node(['tools/release-report.mjs','--dry-run'],{FLIGHT_SOURCE_COMMIT:head.slice(0,12)});
   ok('the release record accepts a FLIGHT_SOURCE_COMMIT naming HEAD and records it in full',a.code===0&&a.out.includes('| Stamp generated from commit | `'+head+'` |'),a.out);
   const ci=fs.readFileSync(path.join(ROOT,'.github/workflows/ci.yml'),'utf8');
   const job=n=>(ci.split(/\n  (?=[\w-]+:\n)/).find(b=>b.startsWith(n+':'))||'');
   const headCheckout=/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/;
   ok('CI runs the suites on the merge ref, not a pinned head',/uses: actions\/checkout@v4\n/.test(job('suites'))&&!/\bref:/.test(job('suites'))&&!/release-report/.test(job('suites')),job('suites').slice(0,80));
   ok('CI builds the dry-run record in a separate job on the pull request head that the record names',headCheckout.test(job('release-record'))&&/FLIGHT_SOURCE_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\n\s+run: node tools\/release-report\.mjs --dry-run/.test(job('release-record'))&&/run-suites\.mjs --mirror/.test(job('release-record')));}
  // #63: the source package is named from VERSION.md, so both pages must identify as that build.
  {const s=sandbox();const {packageSource}=await s.tool('package-source.mjs');const out=fs.mkdtempSync(path.join(os.tmpdir(),'flight-source-'));sandboxes.push(out);
   const tryPack=()=>{try{return 'ok '+path.basename(packageSource(out).file);}catch(e){return e.message;}};
   const a=tryPack();ok('the source package accepts pages carrying the VERSION.md build',a==='ok flight-system-vT-source.zip',a);
   fs.writeFileSync(s.at('VERSION.md'),'# Test build\n\nbuild: vT2\n');fs.rmSync(out,{recursive:true,force:true});
   const v=tryPack();ok('the source package refuses a VERSION.md build the pages do not carry, and writes no archive',/index\.html carries fs-build vT but VERSION\.md sets vT2/.test(v)&&!fs.existsSync(path.join(out,'flight-system-vT2-source.zip')),v);
   fs.writeFileSync(s.at('VERSION.md'),'# Test build\n\nbuild: vT\n');fs.writeFileSync(s.at('demo.html'),s.page('vOld'));
   const d=tryPack();ok('the source package refuses a demo.html still carrying the old build',/demo\.html carries fs-build vOld but VERSION\.md sets vT/.test(d),d);}
  // #85 (fixed in PR #82): the release steps name the assets/ refusal.
  ok('HANDOVER release step 4 lists the assets/ refusal',/a packaged file in\s+`assets\/` whose bytes differ from HEAD/.test(fs.readFileSync(path.join(ROOT,'docs/HANDOVER.md'),'utf8')));
  // #89 (does not reproduce): git ls-tree lists assets/ one level deep, so a committed file under a dot-named
  // directory appears as that directory and is left out on both sides.
  {const s=sandbox();fs.mkdirSync(s.at('assets/.cache'));fs.writeFileSync(s.at('assets/.cache/x'),'x');s.g('add','-f','assets/.cache/x');s.g('commit','-q','-m','cache');
   ok('the asset check accepts a committed file under a dot-named assets directory',assetsProblem({root:s.dir})===null,assetsProblem({root:s.dir}));}
}finally{for(const d of sandboxes)fs.rmSync(d,{recursive:true,force:true});}

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

// Production ships no WIs (issue #247): load the sample WIs as this suite's data.
await loadSampleInPage(p);
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
