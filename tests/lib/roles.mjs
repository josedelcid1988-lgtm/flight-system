// Test setup for role capabilities that need a current training record when added as an extra role.
export async function assignTestRoles(page, assignments, code = 'ESD') {
  return page.evaluate(async ([assignments, code]) => {
    const key = 'skyryse-mes-auth-v1';
    const auth = JSON.parse(localStorage.getItem(key));
    const sessionKey = 'skyryse-mes-session-v1', prior = sessionStorage.getItem(sessionKey);
    const manager = auth.users.find(user => skAuth.rolesOf(user.username).includes('qm'));
    if (!manager) return 'no QA Manager is available for test setup';
    sessionStorage.setItem(sessionKey, manager.username);
    for (const [account, extraRoles] of Object.entries(assignments)) {
      if (!auth.users.some(user => user.username === account)) return `no account ${account}`;
      const training = MES.recordTraining(state, { account, code, expires: '2031-12-31', note: 'test setup for added role' });
      if (!training.ok) return `${account}: ${training.message}`;
      const roles = [...new Set([...skAuth.rolesOf(account), ...extraRoles])];
      const changed = skAuth.setRoles(account, roles, 'Test setup role assignment.', code);
      if (!changed.ok) return `${account}: ${changed.message}`;
    }
    if (typeof save === 'function' && !save()) return 'the test role assignment was not saved';
    sessionStorage.setItem(sessionKey, prior);
    return true;
  }, [assignments, code]);
}
