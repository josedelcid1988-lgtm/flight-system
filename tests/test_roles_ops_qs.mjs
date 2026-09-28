import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const caps = host.roles.ROLE_CAPS;
const need = (role, list) => list.every(cap => caps[role].includes(cap));
const forbid = (role, list) => list.every(cap => !caps[role].includes(cap));
let checks = 0;
const check = (name, ok) => { checks += 1; assert.ok(ok, name); console.log(`ok ${name}`); };

check('Operations Manager runs work orders, planned-order conversion, assignment, sensitivity, and notices', need('ops', ['create-wo', 'adjust-wo', 'operate', 'assign-work', 'post-notice', 'configure-org', 'dispo-nc']));
check('Operations Manager can add training requirements to work instructions and record training', need('ops', ['edit-wi', 'configure-training']));
check('Operations Manager cannot approve a work order, release a WI, or manage accounts', forbid('ops', ['approve-wo', 'approve-wi', 'manage-access', 'configure-qms']));
check('Quality Supervisor role carries its approval permissions', need('qs', ['approve-wo', 'approve-wi', 'approve-nc']));
check('Quality Supervisor can manage standard accounts, notices, organization settings, and training', need('qs', ['manage-access', 'post-notice', 'configure-org', 'configure-training']));
check('Quality Supervisor cannot administer QMS configuration or take Manufacturing Engineering or Engineering seats', forbid('qs', ['configure-qms', 'mrb-me', 'mrb-eng', 'edit-wi']));
const account = { username: 'quality-supervisor', displayName: 'Quality Supervisor', role: 'qs', roles: ['qs'] };
check('server actor resolution retains the Quality Supervisor account role', host.roleOf(account) === 'qs');
const actorCaps = host.withAccount(account, () => ['inspect-steps', 'mrb-quality', 'conformity', 'aqi-sign'].filter(cap => host.capsOf(account).includes(cap)));
check('server capability evaluation follows the role for inspection and MRB while keeping named grants separate', JSON.stringify(actorCaps) === JSON.stringify(['inspect-steps', 'mrb-quality']));
const app = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
check('access administration flags critical capabilities held by fewer than two accounts', /Access coverage needs review/.test(app) && /holders<2/.test(app));
console.log(`roles_ops_qs: ${checks} checks, all passed`);
