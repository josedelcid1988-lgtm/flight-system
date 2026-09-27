// ATP operations require an approved software link, and accept an HTTPS repository on any host.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : `${TESTS}fixtures/`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await (await browser.newContext()).newPage();
const failures = [];
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
const check = (name, passed, detail = '') => { console.log(`${passed ? '  ok   ' : '  FAIL '}${name}${passed ? '' : ` -> ${detail}`}`); if (!passed) failures.push(name); };
try {
  await page.goto(pathToFileURL(`${FIXTURES}demo_qa150_publish.html`).href);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const input = document.querySelector('#sk-boot input[name=username]');
    const form = input.closest('form');
    const set = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(input, 'master'); set(form.querySelector('input[type=password]'), 'demo1234');
    form.requestSubmit();
  });
  await page.waitForTimeout(2600);
  const result = await page.evaluate(() => {
    const identity = { user: skAuth.user()?.username, role: skAuth.role(), master: MES.masterAccess(), orders: state.orders.length };
    const order = state.orders.find(item => item.status !== 'Closed');
    if (!order) return { error: 'fixture has no open work order', identity };
    const base = { classification: MES.ATP_CLASS, title: 'Software acceptance test', buyoffType: 'Technician', position: order.operations.length, steps: 'Run approved software check.' };
    const withRepo = structuredClone(state);
    const valid = MES.addOrderOperation(withRepo, order.id, { ...base, atpRepo: 'https://git.example.test/skyryse/flight-controls', atpVersion: 'v1.2.3', atpSha: 'a1b2c3d' });
    const missing = MES.addOrderOperation(structuredClone(state), order.id, base);
    const unsafe = MES.addOrderOperation(structuredClone(state), order.id, { ...base, atpRepo: 'http://git.example.test/skyryse/flight-controls', atpVersion: 'v1.2.3', atpSha: 'a1b2c3d' });
    return { role: skAuth.role(), valid: valid.ok, repo: valid.ok && MES.getOrder(withRepo, order.id).operations.find(op => op.id === valid.opId)?.atp?.repo, missing: !missing.ok, unsafe: !unsafe.ok };
  });
  check('setup has a valid account and work order', !result.error && result.role === 'admin', JSON.stringify(result));
  check('an HTTPS repository on a non-GitHub host is accepted', result.valid && result.repo === 'https://git.example.test/skyryse/flight-controls', JSON.stringify(result));
  check('ATP without a repository is refused', result.missing, JSON.stringify(result));
  check('an HTTP repository is refused', result.unsafe, JSON.stringify(result));
  check('no browser errors', browserErrors.length === 0, browserErrors.join('; '));
} catch (error) {
  failures.push(error.message);
  console.error(error);
} finally { await browser.close(); }
console.log(`FAILS ${JSON.stringify(failures)}`);
process.exitCode = failures.length ? 1 : 0;
