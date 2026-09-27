// Load Flight System's actual rule engines in a Node vm. The server does not
// maintain a second implementation of Flight's gates.
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const SCRIPT_RE = /<script(?:\s+id="([^"]*)")?>([\s\S]*?)<\/script>/g;
const ENGINE_MATCHERS = [
  ['mes', body => body.includes('root.MES = MES')],
  ['flightPlan', body => body.includes('root.FlightPlan = FlightPlan')],
  ['flightManeuver', body => body.includes('root.FlightManeuver = FlightManeuver')],
  ['print', body => body.includes('root.MESPrint = MESPrint')]
];

export function extractBlocks(html) {
  const found = {};
  for (const match of html.matchAll(SCRIPT_RE)) {
    for (const [key, test] of ENGINE_MATCHERS) {
      if (!found[key] && test(match[2])) found[key] = match[2];
    }
  }
  const missing = ENGINE_MATCHERS.map(([key]) => key).filter(key => !found[key]);
  if (missing.length) throw new Error(`index.html is missing Flight engine blocks: ${missing.join(', ')}`);

  const roles = html.match(/var ROLES=\[[\s\S]*?\n \];/);
  const everyone = html.match(/var EVERYONE=\[[^\n]*\];/);
  const caps = html.match(/var ROLE_CAPS=\{[\s\S]*?\n \};/);
  const labels = html.match(/var CAP_LABELS=\{[^\n]*\};/);
  if (!roles || !everyone || !caps) throw new Error('index.html is missing the account role table');
  found.roles = `${roles[0]}\n${everyone[0]}\n${caps[0]}\nROLE_CAPS.admin=Array.from(new Set(Object.values(ROLE_CAPS).flat()));\n${labels ? labels[0] : 'var CAP_LABELS={};'}\nwindow.__roles={ROLES:ROLES,ROLE_CAPS:ROLE_CAPS,EVERYONE:EVERYONE,CAP_LABELS:CAP_LABELS};`;
  return found;
}

export function createHost(indexPath) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const blocks = extractBlocks(html);
  const sandbox = { console, TextEncoder, TextDecoder, structuredClone, crypto: webcrypto, setTimeout, clearTimeout, URL };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const key of ['roles', 'mes', 'flightPlan', 'flightManeuver', 'print']) {
    vm.runInContext(blocks[key], context, { filename: `index.html#${key}` });
  }
  const { MES, FlightPlan, FlightManeuver, MESPrint, __roles: roles } = sandbox;
  const rolesOf = (account, state) => {
    const primary = roles.ROLES.some(role => role.key === (account && account.role)) ? account.role : 'general';
    const standard = (Array.isArray(account && account.roles) ? account.roles : [primary]).filter(key => roles.ROLES.some(role => role.key === key));
    const valid = [...new Set([primary, ...standard])];
    for (const key of (Array.isArray(account && account.extraRoles) ? account.extraRoles : [])) {
      if (!roles.ROLES.some(role => role.key === key) || valid.includes(key)) continue;
      const code = account.roleTraining && account.roleTraining[key] && account.roleTraining[key].code;
      if (trainingCurrent(state, account, code)) valid.push(key);
    }
    return valid;
  };
  const trainingCurrent = (state, account, code) => {
    if (!state || !account || !code || typeof MES.trainingCurrentFor !== 'function') return false;
    try { return MES.trainingCurrentFor(state, account.username, code).ok === true; } catch { return false; }
  };
  const grantedCaps = ['conformity', 'aqi-sign'];
  const roleOf = (account, state) => { const assigned = rolesOf(account, state); return assigned.includes('admin') ? 'admin' : assigned.includes('qm') ? 'qm' : assigned.includes('qs') ? 'qs' : assigned[0]; };
  const capsOf = (account, state) => {
    const held = new Set(rolesOf(account, state).flatMap(key => roles.ROLE_CAPS[key] || roles.EVERYONE).filter(cap => !grantedCaps.includes(cap)));
    for (const cap of grantedCaps) {
      const grant = account && account.grants && account.grants[cap];
      const eligible = rolesOf(account, state).some(key => (roles.ROLE_CAPS[key] || roles.EVERYONE).includes(cap));
      if (eligible && grant && !grant.revokedAt && trainingCurrent(state, account, grant.trainingCode)) held.add(cap);
    }
    return [...held];
  };
  const shimFor = (account, state) => account ? {
    ROLES: roles.ROLES,
    can: cap => capsOf(account, state).includes(cap),
    roleCan: (role, cap) => (Array.isArray(role) ? role : [role]).some(key => (roles.ROLE_CAPS[key] || roles.EVERYONE).includes(cap)),
    role: () => roleOf(account, state),
    user: () => ({ username: account.username, displayName: account.displayName, role: roleOf(account, state), roles: rolesOf(account, state), supportAccess: account.supportAccess === true }),
    users: () => [],
    actor: () => {
      const role = roles.ROLES.find(item => item.key === roleOf(account, state));
      return { name: account.displayName, role: role ? role.profileRole : 'General user', roles: rolesOf(account, state), credentialId: `ACCT-${account.username}`, account: account.username, accountRole: roleOf(account, state), supportAccess: account.supportAccess === true };
    }
    ,
    supportAccess: () => account.supportAccess === true
  } : null;
  function withAccount(account, fn, state) {
    const before = sandbox.skAuth;
    sandbox.skAuth = shimFor(account, state);
    try { return fn(); } finally { sandbox.skAuth = before; }
  }
  function resolve(name) {
    const [namespace, functionName] = String(name).includes('.') ? String(name).split('.', 2) : ['MES', String(name)];
    const owners = { MES, FlightPlan, FlightManeuver };
    const owner = owners[namespace];
    return owner && typeof owner[functionName] === 'function' && !functionName.startsWith('_') ? owner[functionName] : null;
  }
  // The HTTP action route is a mutation boundary. Only engine functions that the browser
  // classifies as commands may be invoked there; getters, migration helpers and signature
  // primitives must never become remotely callable just because they are exported on MES.
  const actionName = /^(?:run|add|update|remove|delete|create|complete|close|issue|approve|reject|sign|mark|assign|advance|resolve|disposition|request|release|record|submit|start|stop|review|accept|return|void|reopen|split|move|link|verify|raise|cancel|withdraw|incorporate|peer|roll|set|save|store|open|finish|grant|revoke|capture|attach|detach|quarantine|repair|replace|send|change|configure|stamp|buyoff|log|tick|decide|vote|reset|publish|apply|import|reinspect|firm|convert|carry|propose|escalate|select|clock|aqi|post|acknowledge|edit|revise|ping|push|ical|check|notify|qa|note)/i;
  const actionExclude = new Set(['repair','signManifest','verifyManifests','verifyAIActionLog','stampCheck','stampRegister','stampRegisterCsv','stampCredential','stampHolderFor','ticketAttachments','openProcessECRs','syncAssignments','buyoffCredential','ensure','seedDemoRecords','icalExport']);
  function resolveAction(name) {
    const functionName = String(name).split('.').at(-1);
    return actionName.test(functionName) && !actionExclude.has(functionName) ? resolve(name) : null;
  }
  return { MES, FlightPlan, FlightManeuver, MESPrint, roles, withAccount, resolve, resolveAction, html, capsOf, roleOf, rolesOf };
}
