// Migration CLI fixtures: runs the real tools/migrate-browser.mjs entry point
// (argument parsing, file reading, dry-run report) against the checked-in
// browser-export JSON fixtures in tests/fixtures/migration-export-*.json.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'migrate-browser.mjs');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

const fails = [];
const ok = (what, cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + msg));
  if (!cond) fails.push(what);
};

const dryRun = (fixture) => {
  const run = spawnSync(process.execPath, [CLI, '--input', path.join(FIXTURES, fixture)], { encoding: 'utf8' });
  return { run, parsed: run.status === 0 ? JSON.parse(run.stdout) : null };
};

// ---- checked-in export fixtures ----
{
  const { run, parsed } = dryRun('migration-export-minimal.json');
  ok('minimal: cli exits 0', run.status === 0, run.stderr.slice(0, 200));
  ok('minimal: dry-run report is valid', !!parsed && parsed.mode === 'dry-run' && parsed.report.valid === true, 'bad report');
  ok('minimal: two simple accounts', parsed.report.accounts.count === 2 && parsed.report.accounts.multipleRoles.length === 0, JSON.stringify(parsed.report.accounts));
  ok('minimal: no missing media', parsed.report.evidence.missingMedia.length === 0, 'missing media');
}
{
  const { run, parsed } = dryRun('migration-export-multirole.json');
  ok('multirole: cli exits 0', run.status === 0, run.stderr.slice(0, 200));
  ok('multirole: dry-run report is valid', !!parsed && parsed.mode === 'dry-run' && parsed.report.valid === true, 'bad report');
  ok('multirole: qe accounts preserved', parsed.report.accounts.roles.qe === 2, JSON.stringify(parsed.report.accounts.roles));
  ok('multirole: multiple-roles warning names mig-combined', parsed.report.accounts.multipleRoles.includes('mig-combined') && parsed.report.warnings.some(w => w.includes('mig-combined')), 'no warning');
}
{
  const { run, parsed } = dryRun('migration-export-evidence.json');
  ok('evidence: cli exits 0', run.status === 0, run.stderr.slice(0, 200));
  ok('evidence: dry-run report is valid', !!parsed && parsed.mode === 'dry-run' && parsed.report.valid === true, 'bad report');
  ok('evidence: one recording migrated with bytes', parsed.report.evidence.bytesIncluded === 1, JSON.stringify(parsed.report.evidence));
  ok('evidence: missing recording reported', parsed.report.evidence.missingMedia.some(m => m.id === 'EV-22222222-2222-4222-8222-222222222222') && parsed.report.warnings.some(w => w.includes('absent from the export')), 'no missingMedia warning');
}

// ---- entry-point error handling ----
{
  const run = spawnSync(process.execPath, [CLI, '--input', path.join(FIXTURES, 'migration-export-broken.json')], { encoding: 'utf8' });
  ok('broken json refused with non-zero exit', run.status !== 0 && /Migration refused/.test(run.stderr), `status=${run.status} ${run.stderr.slice(0, 120)}`);
}
{
  const run = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  ok('missing --input refused with non-zero exit', run.status !== 0 && /Migration refused/.test(run.stderr), `status=${run.status} ${run.stderr.slice(0, 120)}`);
}

console.log(fails.length ? `FAILS ${JSON.stringify(fails)}` : 'migration cli fixtures: all checks passed');
process.exit(fails.length ? 1 : 0);
