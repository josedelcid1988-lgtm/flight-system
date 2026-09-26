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
  const roleOf = account => roles.ROLES.some(role => role.key === account.role) ? account.role : 'general';
  const rolesOf = account => {
    const assigned = Array.isArray(account && account.roles) ? account.roles.filter(key => roles.ROLES.some(role => role.key === key)) : [];
    const valid = [...new Set(assigned)];
    if (!valid.length) valid.push(roleOf(account));
    return valid;
  };
  const capsOf = account => [...new Set(rolesOf(account).flatMap(key => roles.ROLE_CAPS[key] || roles.EVERYONE))];
  const shimFor = account => account ? {
    ROLES: roles.ROLES,
    can: cap => capsOf(account).includes(cap),
    roleCan: (role, cap) => (Array.isArray(role) ? role : [role]).some(key => (roles.ROLE_CAPS[key] || roles.EVERYONE).includes(cap)),
    role: () => roleOf(account),
    user: () => ({ username: account.username, displayName: account.displayName, role: roleOf(account), roles: rolesOf(account) }),
    users: () => [],
    actor: () => {
      const role = roles.ROLES.find(item => item.key === roleOf(account));
      return { name: account.displayName, role: role ? role.profileRole : 'General user', roles: rolesOf(account), credentialId: `ACCT-${account.username}`, account: account.username, accountRole: roleOf(account) };
    }
  } : null;
  function withAccount(account, fn) {
    const before = sandbox.skAuth;
    sandbox.skAuth = shimFor(account);
    try { return fn(); } finally { sandbox.skAuth = before; }
  }
  function resolve(name) {
    const [namespace, functionName] = String(name).includes('.') ? String(name).split('.', 2) : ['MES', String(name)];
    const owners = { MES, FlightPlan, FlightManeuver };
    const owner = owners[namespace];
    return owner && typeof owner[functionName] === 'function' && !functionName.startsWith('_') ? owner[functionName] : null;
  }
  return { MES, FlightPlan, FlightManeuver, MESPrint, roles, withAccount, resolve, html, capsOf, roleOf, rolesOf };
}
