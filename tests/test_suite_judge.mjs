// The suite runner's verdict (tools/run-suites.mjs judge). The E2E suite passes only when every flow
// passes and the workspace it ends with still passes MES.validate; a run that reports valid false, or a
// result line that no longer says whether the workspace is valid, fails even when no flow failed.
import { judge } from '../tools/run-suites.mjs';

const fails = [];
const ok = (what, cond, more = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + more)); if (!cond) fails.push(what); };
const line = (failed, valid) => `ok   flow-a actions 3\nflows 30 failed ${failed}${valid === undefined ? '' : ` valid ${valid}`}  errors []\n`;

let j = judge('qa_e2e', 0, line(0, true));
ok('every flow passed and the final workspace is valid: the suite passes', j.status === 'pass', JSON.stringify(j.problems));

j = judge('qa_e2e', 0, line(0, false));
ok('every flow passed but the final workspace is invalid: the suite fails', j.status === 'fail' && j.problems.some(p => /final workspace is invalid/.test(p)), JSON.stringify(j.problems));

j = judge('qa_e2e', 0, line(0));
ok('a result line that does not report validity fails the suite', j.status === 'fail' && j.problems.some(p => /does not report whether the final workspace is valid/.test(p)), JSON.stringify(j.problems));

j = judge('qa_e2e', 0, line(2, true));
ok('a failed flow still fails the suite with a valid workspace', j.status === 'fail' && j.problems.some(p => /2 failed flows/.test(p)), JSON.stringify(j.problems));

j = judge('qa_full', 0, 'checks 10 pass 10 fail 0 skip 0\nFAILS []\n');
ok('a suite with no E2E result line is not asked for validity', j.status === 'pass', JSON.stringify(j.problems));

j = judge('qa_e2e', 1, line(0, false));
ok('the exit status qa_e2e sets on an invalid workspace is reported too', j.problems.includes('exit status 1'), JSON.stringify(j.problems));

console.log('errors', [], 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
