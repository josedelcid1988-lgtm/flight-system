import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);

  await page.evaluate(() => { view = 'plan-kanban'; render(); });
  await page.getByRole('heading', { name: 'Kanban.' }).waitFor();
  assert.equal(await page.locator('.fr-plan-lane').count(), 4, 'React Kanban renders all live planned-order stages');
  const stageCounts = await page.locator('.fr-plan-lane .fr-count').allTextContents();
  const expectedCounts = await page.evaluate(() => {
    const all = FlightPlan.list(state), covered = item => !item.netsuite || item.netsuite.onHand >= item.quantity;
    return [all.filter(item => item.status === 'Planned'), all.filter(item => item.status === 'Firm' && !covered(item)), all.filter(item => item.status === 'Firm' && covered(item)), all.filter(item => item.status === 'Converted')].map(rows => String(rows.length).padStart(2, '0'));
  });
  assert.deepEqual(stageCounts, expectedCounts, 'Kanban lane counts are derived from the current FlightPlan records');
  assert.equal(await page.locator('.fr-plan-card').count(), expectedCounts.reduce((sum, count) => sum + Number(count), 0));
  await page.waitForFunction(() => [...document.getAnimations()].filter(animation => animation.effect?.target?.id === 'flight-react-island').every(animation => animation.playState === 'finished'));
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '#toast { display: none !important; }' });
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-plan-kanban-1440.png', import.meta.url).pathname });
  const density = page.locator('.fr-kanban-page .fr-density');
  await density.click();
  assert.equal(await density.getAttribute('aria-pressed'), 'true', 'Kanban density toggle is interactive');
  assert.ok((await page.locator('.fr-plan-lanes').getAttribute('class')).includes('is-compact'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('.fr-plan-card').first().evaluate(element => parseFloat(getComputedStyle(element).transitionDuration) < 0.001), 'Kanban honors reduced-motion preferences');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const firstPlanId = await page.locator('.fr-plan-card .fr-mono').first().textContent();
  await page.locator('.fr-plan-card [data-action="plan-open"]').first().click();
  await page.getByRole('heading', { name: 'Planned orders.' }).waitFor();
  assert.equal(await page.locator('[aria-label="Search planned orders"]').inputValue(), firstPlanId.trim(), 'Kanban detail action opens the existing filtered planning workflow');
  await page.evaluate(() => { view = 'plan-kanban'; render(); });
  await page.getByRole('heading', { name: 'Kanban.' }).waitFor();
  await page.locator('.fr-planning-nav').getByRole('button', { name: 'MRP forecast' }).click();
  await page.getByRole('heading', { name: 'MRP forecast.' }).waitFor();
  const counts = await page.evaluate(() => {
    const f = FlightPlan.forecast(state);
    return [f.open.length, f.explosion.length, f.shelfLife.length, f.designChanges.length];
  });
  const summary = await page.locator('.fr-forecast-summary strong').allTextContents();
  assert.deepEqual(summary.map(Number), counts, 'MRP summary values match the live forecast engine');
  const longestSourceCount = await page.evaluate(() => Math.max(0, ...FlightPlan.forecast(state).explosion.map(item => item.orders.length)));
  if (longestSourceCount > 3) {
    const sourceRow = page.locator('.fr-forecast-section').filter({ has: page.getByRole('heading', { name: 'Component demand' }) }).locator('tbody tr').filter({ has: page.locator('.fr-forecast-orders-more') }).first();
    assert.equal(await sourceRow.locator('.fr-forecast-orders > .fr-record-link').count(), 3, 'only three source orders are shown inline');
    const hiddenSourceCount = await sourceRow.locator('.fr-forecast-orders-more .fr-record-link').count();
    assert.equal(await sourceRow.locator('.fr-forecast-orders-more summary').textContent(), `+${hiddenSourceCount} more`, 'remaining sources are summarized in a disclosure');
    assert.ok(await sourceRow.evaluate(row => row.getBoundingClientRect().height < 120), 'many source orders do not stretch the component-demand row');
    await sourceRow.locator('summary').click();
    assert.equal(await sourceRow.locator('.fr-forecast-orders-more .fr-record-link').count(), hiddenSourceCount, 'the disclosure keeps every planned-order link available');
    await sourceRow.locator('summary').click();
  }
  await page.waitForFunction(() => [...document.getAnimations()].filter(animation => animation.effect?.target?.id === 'flight-react-island').every(animation => animation.playState === 'finished'));
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-plan-mrp-forecast-1440.png', import.meta.url).pathname });
  for (const heading of ['Component demand', 'Lead time from actuals', 'First Production FAIR', 'Shelf life', 'Design changes']) {
    await page.getByRole('heading', { name: heading }).waitFor();
    assert.ok(await page.locator('.fr-forecast-section').filter({ has: page.getByRole('heading', { name: heading }) }).count());
  }
  assert.ok(await page.locator('.fr-forecast-section table').count() >= 1, 'the forecast retains structured comparison tables');
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-plan-mrp-forecast-tablet.png', import.meta.url).pathname });
  await page.locator('.fr-planning-nav').getByRole('button', { name: 'Kanban', exact: true }).click();
  await page.getByRole('heading', { name: 'Kanban.' }).waitFor();
  // A project created from the React Plan forms is saved: it is still there after a reload.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => { view = 'plan'; render(); });
  const projectForm = page.locator('.fr-project-forms form').filter({ has: page.getByRole('heading', { name: 'New WBS project' }) });
  await projectForm.waitFor();
  const projectName = `Persisted plan ${Date.now()}`;
  await projectForm.locator('[name=name]').fill(projectName);
  await projectForm.locator('[name=dueDate]').fill(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  await projectForm.locator('button[type=submit]').click();
  await page.waitForFunction(name => (state.projectPlan?.projects || []).some(item => item.name === name), projectName);
  await page.reload();
  await page.waitForFunction(() => window.__ready === true);
  assert.equal(await page.evaluate(name => (state.projectPlan?.projects || []).some(item => item.name === name), projectName), true, 'a React Plan project survives a reload');
  // The Hangar milestone-risk button opens the milestone's own work order, not the first one in the workspace.
  const milestoneOrder = await page.evaluate(name => {
    const project = state.projectPlan.projects.find(item => item.name === name);
    const target = state.orders.filter(order => order.status !== 'Closed')[1];
    const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const result = MES.addProjectMilestone(state, { title: 'Hangar risk open check', projectId: project.id, dueDate: due, mustStart: true, workOrderId: target.id });
    if (!result.ok) throw new Error(result.message);
    save(); view = 'home'; selectedId = null; render();
    return { id: target.id, first: state.orders[0].id };
  }, projectName);
  assert.notEqual(milestoneOrder.id, milestoneOrder.first, 'the milestone points at a work order other than the first');
  const riskRow = page.locator('.fr-milestone-watch-row').filter({ hasText: 'Hangar risk open check' });
  await riskRow.getByRole('button', { name: 'Open work order' }).click();
  await page.waitForFunction(() => view === 'order');
  assert.equal(await page.evaluate(() => selectedId), milestoneOrder.id, 'the milestone opens its linked work order');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('React Flight Plan Kanban and MRP forecast render live records, expose density and retain structured planning views.');
} finally { await browser.close(); }
