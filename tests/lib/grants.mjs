// Test setup for granted authorities. Inspection, the MRB seats, conformity work and the AQI signature are
// granted to a named person by a QA Manager against a current training record; they are never part of a role.
// A suite that exercises those rules for other reasons grants them here, the way a QA Manager would, so its
// own assertions stay about the rule it tests. Run while signed in as a QA Manager or Master Access account.
//
//   await grantAuthorities(page, { qinsp: ['inspect-steps'], mhale: ['inspect-steps', 'mrb-quality'] });
//   await grantAuthorities(page, { rsup: ['inspect-steps'] }, { extraRoles: { rsup: ['qe'] } });
export async function grantAuthorities(page, grants, options = {}) {
  const code = options.code || 'ESD';
  return page.evaluate(([grants, code, extraRoles]) => {
    const key = 'skyryse-mes-auth-v1', auth = JSON.parse(localStorage.getItem(key));
    const at = new Date().toISOString(), by = { name: 'Test QA Manager', credentialId: 'ACCT-test-qm', account: 'test-qm' };
    const accounts = [...new Set([...Object.keys(grants), ...Object.keys(extraRoles)])];
    for (const account of accounts) {
      const r = MES.recordTraining(state, { account, code, expires: '2031-12-31', note: 'test setup' });
      if (!r.ok) return `${account}: ${r.message}`;
      const u = auth.users.find(x => x.username === account);
      if (!u) return `no account ${account}`;
      if (extraRoles[account]) { u.extraRoles = extraRoles[account]; u.roleTraining = Object.fromEntries(extraRoles[account].map(k => [k, { code, at, by: 'test-qm' }])); }
      u.grants = u.grants || {};
      for (const cap of grants[account] || []) u.grants[cap] = { by, at, reason: 'Test setup grant', trainingCode: code, hash: '' };
    }
    localStorage.setItem(key, JSON.stringify(auth));
    if (typeof save === 'function' && !save()) return 'the training record was not saved';
    return true;
  }, [grants, code, options.extraRoles || {}]);
}
