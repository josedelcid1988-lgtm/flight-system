// A role refusal reads the same from every engine scope (#134). The MES engine and the Flight Maneuver engine each
// check capabilities, and both build the refusal text from one shared builder, MES.roleDeniedMessage, so the wording
// cannot drift between them. Refusal behavior is unchanged: the action is refused and nothing is recorded.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createHost, extractBlocks } from '../server/mes-host.mjs';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const host = createHost(indexPath);
const { MES, FlightManeuver } = host;
const fails = [];
let checks = 0;
const check = (name, ok) => { checks += 1; if (ok) console.log(`ok ${name}`); else { fails.push(name); console.log(`not ok ${name}`); } };

check('MES exposes the shared refusal message builder', typeof MES.roleDeniedMessage === 'function');
const message = what => typeof MES.roleDeniedMessage === 'function' ? MES.roleDeniedMessage(what) : null;
check('the shared message names the action and says what to do next', message('do the thing') === 'Your role cannot do the thing. Ask the QA Manager to change your role.');

// A General user holds neither operate nor dispo-nc, so each scope refuses them. The QA Manager raises the CAR.
const caps = host.roles.ROLE_CAPS;
check('a General user holds neither operate nor dispo-nc', !caps.general.includes('operate') && !caps.general.includes('dispo-nc'));
const who = { username: 'refusal-general', displayName: 'Gale General', role: 'general' };
const qm = { username: 'refusal-qm', displayName: 'Quincy Manager', role: 'qm' };

{
  const state = MES.seed();
  const before = JSON.stringify(state.resources ?? null);
  const unit = MES.equipmentUnitsFor(state)[0];
  const result = host.withAccount(who, () => MES.recordMaintenance(state, { assetTag: unit && unit.tag, type: MES.MAINTENANCE_TYPES[0], description: 'Refusal check.' }), state);
  check('the MES scope refuses a role without operate', !!result && result.ok === false);
  check('the MES scope refusal is the shared message', !!result && result.message === message('record equipment maintenance'));
  check('the MES scope refusal records nothing', JSON.stringify(state.resources ?? null) === before);
}

{
  const state = MES.seed();
  FlightManeuver.ensure(state);
  const car = host.withAccount(qm, () => FlightManeuver.raiseCAR(state, { title: 'Refusal check', description: 'Refusal check.', sourceType: 'Observation', severity: 'Minor', dueDate: '2099-01-01' }), state);
  check('the QA Manager raises a CAR for the Flight Maneuver refusal check', !!car && car.ok);
  const result = car && car.ok ? host.withAccount(who, () => FlightManeuver.recordContainment(state, car.id, 'Parts quarantined.'), state) : null;
  check('the Flight Maneuver scope refuses a role without dispo-nc', !!result && result.ok === false);
  check('the Flight Maneuver scope refusal is the shared message', !!result && result.message === message('record containment'));
  check('the Flight Maneuver scope refusal records nothing', !!car && car.ok && !FlightManeuver.get(state, 'cars', car.id).containment);
}

// The wording lives in one place in the engine source, so a change to it reaches every scope.
const html = fs.readFileSync(indexPath, 'utf8');
const maneuverStart = html.indexOf('id="sk-maneuver-engine"');
const engine = html.slice(0, html.indexOf('</script>', maneuverStart));
const copies = engine.split('Ask the QA Manager to change your role.').length - 1;
check(`the role refusal wording appears once in the engine source (found ${copies})`, copies === 1);

// The Flight Maneuver refusal does not depend on the order the engines load in (#189). It looks MES up when a
// refusal happens, so a maneuver engine evaluated before the MES engine still refuses with the shared message,
// and one running with no MES engine at all still refuses instead of throwing.
{
  const blocks = extractBlocks(html);
  const engineContext = order => {
    const sandbox = { console, TextEncoder, TextDecoder, structuredClone, crypto: webcrypto, setTimeout, clearTimeout, URL };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    sandbox.document = { querySelector: () => null };
    const context = vm.createContext(sandbox);
    for (const key of order) vm.runInContext(blocks[key], context, { filename: `index.html#${key}` });
    sandbox.skAuth = { can: () => false, actor: () => ({ name: who.displayName, role: 'General', credentialId: 'GEN-001', account: who.username, accountRole: 'general' }) };
    return sandbox;
  };
  const state = MES.seed();
  FlightManeuver.ensure(state);
  const car = host.withAccount(qm, () => FlightManeuver.raiseCAR(state, { title: 'Load order check', description: 'Load order check.', sourceType: 'Observation', severity: 'Minor', dueDate: '2099-01-01' }), state);
  const attempt = sandbox => {
    const copy = JSON.parse(JSON.stringify(state));
    try { return { result: sandbox.FlightManeuver.recordContainment(copy, car.id, 'Parts quarantined.'), copy }; }
    catch (error) { return { thrown: String(error && error.message || error), copy }; }
  };

  const late = attempt(engineContext(['roles', 'flightManeuver', 'mes']));
  check(`a maneuver engine loaded before the MES engine refuses without throwing${late.thrown ? ` (threw ${late.thrown})` : ''}`, !late.thrown && !!late.result && late.result.ok === false);
  check('a maneuver engine loaded before the MES engine gives the MES scope refusal message', !!late.result && late.result.message === message('record containment'));
  check('a maneuver engine loaded before the MES engine records nothing', !late.thrown && !late.copy.maneuver.cars.find(c => c.id === car.id).containment);

  const alone = attempt(engineContext(['roles', 'flightManeuver']));
  check(`a maneuver engine with no MES engine refuses without throwing${alone.thrown ? ` (threw ${alone.thrown})` : ''}`, !alone.thrown && !!alone.result && alone.result.ok === false && typeof alone.result.message === 'string' && alone.result.message.length > 0);
  check('a maneuver engine with no MES engine records nothing', !alone.thrown && !alone.copy.maneuver.cars.find(c => c.id === car.id).containment);
}

console.log(`checks ${checks} pass ${checks - fails.length} fail ${fails.length}`);
console.log(`FAILS ${JSON.stringify(fails)}`);
process.exit(fails.length ? 1 : 0);
