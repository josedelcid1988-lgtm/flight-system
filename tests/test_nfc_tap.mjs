// Badge tap (NFC) is identification only: it fills the username at sign-in and the stamp no. at a buy-off,
// never the password or the stamp PIN, never submits, and is off unless SK_IDENTITY.nfcTap is true and the
// browser has Web NFC. Web NFC is mocked here: desktop Chromium has no NDEFReader.
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.FLIGHT_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const fixtures = process.env.FS_FIXTURES_DIR ? 'file://' + process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : new URL('./fixtures/', import.meta.url).href;
const FAILS = [], errors = [];
let passed = 0;
const check = (ok, name) => { if (ok) passed++; else FAILS.push(name); };

// flag: SK_IDENTITY.nfcTap after the page sets its identity seam. reader: install a mock NDEFReader that
// delivers window.__tag as one text record.
function init({ flag, reader }) {
  if (flag) { let v; Object.defineProperty(window, 'SK_IDENTITY', { configurable: true, get() { return v; }, set(x) { v = x; v.nfcTap = true; } }); }
  if (reader) {
    window.__tag = null; window.__scans = 0;
    window.NDEFReader = class {
      scan() {
        window.__scans++;
        setTimeout(() => { if (window.__tag !== null && this.onreading) this.onreading({ message: { records: [{ recordType: 'text', encoding: 'utf-8', data: new TextEncoder().encode(window.__tag) }] } }); }, 30);
        return Promise.resolve();
      }
    };
  }
}
async function open(file, opts) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  page.on('pageerror', e => errors.push(file + ': ' + e.message));
  await page.addInitScript(init, opts);
  await page.goto(fixtures + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sk-login', { state: 'attached' });
  return page;
}

try {
  for (const file of ['publish.html', 'demo_publish.html']) {
    // Off by default, even where the browser can read badges.
    let page = await open(file, { flag: false, reader: true });
    check(await page.locator('#sk-nfc-tap').isHidden(), `${file}: tap button hidden with the flag off`);
    check(await page.evaluate(() => window.skNfc.available() === false && window.skNfc.button('stamp-number') === '' && window.SK_IDENTITY.nfcTap === false), `${file}: flag defaults to off and no buy-off button is offered`);
    await page.close();
    // Flag on but no Web NFC (iPhone Safari, desktop): still not offered.
    page = await open(file, { flag: true, reader: false });
    check(await page.locator('#sk-nfc-tap').isHidden(), `${file}: tap button hidden without Web NFC`);
    check(await page.evaluate(() => window.skNfc.button('stamp-number') === ''), `${file}: no buy-off button without Web NFC`);
    await page.close();
  }

  // Badge record parsing: the refusal paths.
  {
    const page = await open('publish.html', { flag: true, reader: true });
    const r = await page.evaluate(() => {
      const p = window.skNfc.parse;
      return {
        ok: p('FS-BADGE:1;u=Tech.One;s=T042'),
        noStamp: p('FS-BADGE:1;u=tech'),
        firstWins: p('FS-BADGE:1;u=tech;u=master;s=1'),
        wrongPrefix: p('FS-BADGE:2;u=tech;s=1'),
        plainText: p('tech'),
        badUser: p('FS-BADGE:1;u=a b;s=1'),
        shortUser: p('FS-BADGE:1;u=a'),
        badStamp: p('FS-BADGE:1;u=tech;s=<script>'),
        longStamp: p('FS-BADGE:1;u=tech;s=123456789'),
        tooLong: p('FS-BADGE:1;u=tech;s=1;' + 'x'.repeat(200)),
        notText: p(null)
      };
    });
    check(r.ok && r.ok.username === 'tech.one' && r.ok.stamp === 'T042', 'parse: valid badge, username lower-cased');
    check(r.noStamp && r.noStamp.username === 'tech' && r.noStamp.stamp === '', 'parse: badge without a stamp no.');
    check(r.firstWins && r.firstWins.username === 'tech', 'parse: a repeated key cannot override the first');
    for (const k of ['wrongPrefix', 'plainText', 'badUser', 'shortUser', 'badStamp', 'longStamp', 'tooLong', 'notText']) check(r[k] === null, 'parse refuses: ' + k);

    // Sign-in: the tap fills the username only.
    check(await page.locator('#sk-nfc-tap').isVisible(), 'sign-in: tap button shown with the flag on and Web NFC present');
    await page.evaluate(() => { window.__tag = 'FS-BADGE:1;u=tech;s=T042'; });
    await page.locator('#sk-password').fill('');
    await page.locator('#sk-nfc-tap').click();
    await page.waitForFunction(() => document.getElementById('sk-username').value === 'tech');
    const after = await page.evaluate(() => ({ pass: document.getElementById('sk-password').value, focus: document.activeElement && document.activeElement.id, boot: !!document.getElementById('sk-boot'), err: document.getElementById('sk-login-error').textContent }));
    check(after.pass === '' && after.focus === 'sk-password', 'sign-in: password left empty and focused');
    check(after.boot && after.err === '', 'sign-in: nothing submitted, no error');

    // A tag that is not a Flight System badge changes nothing and says why.
    await page.locator('#sk-username').fill('kept');
    await page.evaluate(() => { window.__tag = 'https://example.com'; });
    await page.locator('#sk-nfc-tap').click();
    await page.waitForFunction(() => /not set up for Flight System/.test(document.getElementById('sk-login-error').textContent));
    check(await page.locator('#sk-username').inputValue() === 'kept', 'sign-in: a foreign tag leaves the username alone');
    check(!(await page.locator('#sk-login-error').textContent()).includes('—'), 'sign-in: message has no em dash');
    await page.close();
  }

  // Buy-off: only the signed-in person's own badge fills the stamp no.; the PIN is still typed.
  {
    const page = await open('publish.html', { flag: true, reader: true });
    const password = 'Test-' + crypto.randomUUID();
    for (const [id, value] of Object.entries({ 'sk-displayname': 'Badge Test', 'sk-username': 'badge-test', 'sk-password': password, 'sk-confirm': password })) await page.locator('#' + id).fill(value);
    await page.locator('#sk-login-submit').click();
    await page.waitForFunction(() => !document.getElementById('sk-boot'));
    const before = await page.evaluate(() => localStorage.getItem('skyryse-mes-work-order-v1'));
    await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'nfc-host';
      host.innerHTML = '<form id="nfc-form"><input id="stamp-number" name="stampNumber">' + window.skNfc.button('stamp-number') + '<input id="nfc-pin" name="pin" type="password"></form>';
      document.body.appendChild(host);
    });
    const tap = async (tag, wait) => {
      await page.evaluate(t => { window.__tag = t; document.getElementById('stamp-number').value = ''; }, tag);
      await page.locator('#nfc-host [data-nfc-target]').click();
      await page.waitForFunction(w => new RegExp(w).test(document.querySelector('[data-nfc-msg="stamp-number"]').textContent), wait);
      return page.evaluate(() => ({ stamp: document.getElementById('stamp-number').value, pin: document.getElementById('nfc-pin').value, focus: document.activeElement && document.activeElement.id, msg: document.querySelector('[data-nfc-msg="stamp-number"]').textContent }));
    };
    let r = await tap('FS-BADGE:1;u=badge-test;s=Q101', 'Enter your stamp PIN');
    check(r.stamp === 'Q101' && r.pin === '' && r.focus === 'nfc-pin', 'buy-off: own badge fills the stamp no. and moves to the PIN');
    r = await tap('FS-BADGE:1;u=someone-else;s=Q202', 'belongs to someone-else');
    check(r.stamp === '', "buy-off: another person's badge is refused");
    r = await tap('FS-BADGE:1;u=badge-test', 'carries no stamp');
    check(r.stamp === '', 'buy-off: a badge with no stamp no. fills nothing');
    check(!r.msg.includes('—'), 'buy-off: message has no em dash');
    check(await page.evaluate(b => localStorage.getItem('skyryse-mes-work-order-v1') === b, before), 'buy-off: a tap writes nothing to the workspace');
    await page.close();
  }

  // Both buy-off forms carry the hook.
  const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check(src.includes("window.skNfc.button('stamp-number')") && src.includes("window.skNfc.button('step-stamp-number')"), 'index.html: both buy-off forms offer the tap');
  check(/nfcTap: false,/.test(src), 'index.html: flag ships off');
} finally {
  await browser.close();
}
console.log(`test_nfc_tap: ${passed} pass, ${FAILS.length} fail`);
console.log('FAILS', JSON.stringify(FAILS));
if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors));
process.exit(FAILS.length || errors.length ? 1 : 0);
