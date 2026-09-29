#!/usr/bin/env node
// Runs every test suite in tests/ and decides pass or fail the same way for all of them.
//
//   node tools/run-suites.mjs                 every suite against tests/fixtures (mirror off, as shipped)
//   node tools/run-suites.mjs --mirror        every suite again with the persistence mirror switched on:
//                                             starts a mirror server on a free port with a temporary
//                                             database, runs the suites against copies of the fixtures
//                                             that set SK_MIRROR.url, then checks the server's chain
//   node tools/run-suites.mjs --only a,b      run only the named suites
//   node tools/run-suites.mjs --parallel 4    suites at a time (default 4)
//
// A suite fails if it exits non-zero, prints a non-empty FAILS list, reports a failed check or flow,
// reports a page error, or reports a skip that is not explained in tests/allowed_skips.json. Results
// are written to tests/suite_results.json (tests/suite_results_mirror.json with --mirror). Exit status 0 only when every suite passed. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const withMirror = argv.includes('--mirror');
const parallel = Math.max(1, Number(opt('parallel') || 4));
const only = opt('only') ? opt('only').split(',').map(s => s.trim().replace(/\.mjs$/, '')) : null;
const allowed = JSON.parse(fs.readFileSync(path.join(TESTS, 'allowed_skips.json'), 'utf8'));

export function judge(name, code, out) {
  const problems = [];
  if (code !== 0) problems.push(`exit status ${code}`);
  const fl = out.match(/FAILS (\[.*\])/); if (fl) { try { const list = JSON.parse(fl[1]); if (list.length) problems.push(`${list.length} failed: ${list.slice(0, 3).join('; ')}`); } catch { problems.push('unreadable FAILS list'); } }
  const checks = out.match(/checks (\d+) pass (\d+) fail (\d+)(?: skip (\d+))?/);
  if (checks && Number(checks[3]) > 0) problems.push(`${checks[3]} failed checks`);
  const flows = out.match(/flows (\d+) failed (\d+)/); if (flows && Number(flows[2]) > 0) problems.push(`${flows[2]} failed flows`);
  if (/REHEARSAL FAILURES/.test(out)) problems.push('rehearsal failures');
  if (/^FAIL \d+/m.test(out)) problems.push('layout drift');
  for (const m of out.matchAll(/(?:page )?errors (\[.*\])/g)) { try { const list = JSON.parse(m[1]); if (list.length) problems.push(`page errors: ${list.slice(0, 2).join(' | ')}`); } catch { /* informational line */ } }
  // qa_full prints SKIP <build> | <area> | <check> | <detail>; the first three fields name the check.
  const skips = [...out.matchAll(/^SKIP (.*)$/gm)].map(m => m[1].split(' | ').slice(0, 3).join(' | ').trim());
  const unexplained = skips.filter(s => !allowed[s]);
  if (unexplained.length) problems.push(`unexplained skip: ${unexplained.join('; ')}`);
  return { name, status: problems.length ? 'fail' : 'pass', problems, checks: checks ? Number(checks[1]) : null, skips: skips.map(s => ({ check: s, reason: allowed[s] || null })) };
}

function runOne(file, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(TESTS, file)], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25 * 60000);
    child.on('close', code => { clearTimeout(timer); resolve({ file, code: code ?? 1, out }); });
  });
}

async function mirrorFixtures() {
  const { createMirror, verifyChain } = await import(path.join(ROOT, 'server/mirror/server.mjs'));
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fs-suites-mirror-'));
  // The mirror refuses to start without a token: run it as IT does, with a one-run token the fixtures carry.
  const token = crypto.randomBytes(18).toString('base64url');
  const mirror = createMirror({ dbPath: path.join(tmp, 'mirror.sqlite'), backupDir: path.join(tmp, 'backups'), port: 0, backupEveryMinutes: 0, token, allowOrigin: '*' });
  const addr = await mirror.listen();
  const url = `http://127.0.0.1:${addr.port}`;
  // Mirror fixtures keep the repository's tests/fixtures depth because their relative
  // application assets resolve through ../../assets/ from that location.
  const dir = path.join(tmp, 'tests', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'assets'), path.join(tmp, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(path.join(TESTS, 'fixtures')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(TESTS, 'fixtures', f), 'utf8');
    if (!html.includes('<head>')) throw new Error(`${f} has no <head> to add the mirror setting to.`);
    fs.writeFileSync(path.join(dir, f), html.replace('<head>', `<head><script>window.SK_MIRROR={url:${JSON.stringify(url)},token:${JSON.stringify(token)},batchSize:100};</script>`));
  }
  return { url, dir, tmp, mirror, verifyChain };
}

// What a results file was produced against, so it can be matched to the exact build and commit it tested
// (tools/release-report.mjs): the build id and stamp in index.html, the SHA-256 of index.html and demo.html,
// and the commit checked out (null outside a git checkout, which a release record refuses).
export function tested(root = ROOT) {
  const fileSha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
  const stampOf = (html, name) => (html.match(new RegExp(`<meta name="${name}" content="([^"]*)">`)) || [])[1] || 'unstamped';
  const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return { build: stampOf(indexHtml, 'fs-build'), indexStamp: stampOf(indexHtml, 'fs-build-sha256'), indexFileSha256: fileSha('index.html'), demoFileSha256: fileSha('demo.html'), commit: head.status === 0 ? head.stdout.trim() : null };
}

async function main() {
  const pathCheck = spawnSync(process.execPath, [path.join(ROOT, 'tests/check_no_machine_paths.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (pathCheck.stdout) process.stdout.write(pathCheck.stdout);
  if (pathCheck.stderr) process.stderr.write(pathCheck.stderr);
  if (pathCheck.status !== 0) process.exit(pathCheck.status || 1);
  const files = fs.readdirSync(TESTS).filter(f => f.endsWith('.mjs') && (!only || only.includes(f.replace(/\.mjs$/, '')))).sort();
  let env = { ...process.env }, m = null;
  if (withMirror) { m = await mirrorFixtures(); env = { ...env, FS_FIXTURES_DIR: m.dir }; console.log(`mirror on: ${m.url}; fixtures ${m.dir}`); }
  const testedAgainst = tested();
  const queue = [...files], results = [];
  const started = new Date().toISOString();
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const file = queue.shift();
      const r = await runOne(file, env);
      // Keep generated suite logs portable too: stack traces often include the local checkout path.
      const output = r.out.split(ROOT).join('<repo>');
      const j = judge(file.replace(/\.mjs$/, ''), r.code, output);
      results.push(j);
      console.log(`${j.status === 'pass' ? 'PASS' : 'FAIL'}  ${j.name}${j.checks ? ` (${j.checks} checks)` : ''}${j.skips.length ? `, ${j.skips.length} explained skip${j.skips.length > 1 ? 's' : ''}` : ''}${j.problems.length ? `: ${j.problems.join('; ')}` : ''}`);
      if (j.status !== 'pass') {
        fs.writeFileSync(path.join(TESTS, `suite_${j.name}.log`), output);
        // The failing lines go to the console too, so a CI log says what failed without the artifact.
        for (const line of output.split('\n').filter(l => /^\s*FAIL\b|Error|errors \["/.test(l)).slice(0, 20)) console.log(`      ${j.name}: ${line.trim().slice(0, 400)}`);
      }
    }
  }));
  let mirrorSummary = null;
  if (m) {
    const v = m.verifyChain(m.mirror.db);
    const rows = Number(m.mirror.db.prepare('SELECT COUNT(*) n FROM records').get().n);
    mirrorSummary = { url: m.url, records: rows, chainIntact: v.ok, firstBreak: v.firstBreak };
    console.log(`mirror received ${rows} records; chain ${v.ok ? 'intact' : 'BROKEN at row ' + v.firstBreak.id}`);
    if (!v.ok || rows === 0) results.push({ name: 'mirror-chain', status: 'fail', problems: [rows === 0 ? 'the mirror received no records' : 'the mirror chain is broken'], checks: null, skips: [] });
    await m.mirror.close();
    fs.rmSync(m.tmp, { recursive: true, force: true });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  const failed = results.filter(r => r.status !== 'pass');
  const skips = results.flatMap(r => r.skips.map(s => ({ suite: r.name, ...s })));
  fs.writeFileSync(path.join(TESTS, withMirror ? 'suite_results_mirror.json' : 'suite_results.json'), JSON.stringify({ startedAt: started, finishedAt: new Date().toISOString(), tested: testedAgainst, mirror: mirrorSummary, suites: results, skips }, null, 1));
  console.log(`\n${results.length - failed.length} of ${results.length} suites passed${skips.length ? `; ${skips.length} explained skip${skips.length > 1 ? 's' : ''}` : ''}${withMirror ? ' (mirror on)' : ''}.`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
