// Record-link buttons are built once. index.html holds the only record patterns, the split of an activity line
// into text and record links (targets and link order) and the attribute set of one link, published as
// window.FlightRecordLinks. The legacy recordLinks() template and the React RecordLinks both build from it, so
// the same activity text renders the same buttons with the same attributes, in the same attribute order and
// the same link order, through both paths.
import fs from 'node:fs';
import { chromium } from 'playwright';

const fails = [];
const check = (ok, label) => { if (!ok) fails.push(label); };

// Source: one definition of the patterns and of the link attributes, and the React view keeps no copy.
const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const jsx = fs.readFileSync(new URL('../src/react/flight-ui.jsx', import.meta.url), 'utf8');
const legacyFn = index.slice(index.indexOf('function recordLinks('), index.indexOf('function historyKind('));
check((index.match(/const RECORD_PATTERNS\s*=/g) || []).length === 1, 'index.html defines RECORD_PATTERNS once');
check(!/RECORD_PATTERNS/.test(jsx), 'src/react/flight-ui.jsx keeps no copy of RECORD_PATTERNS');
check(!/["'`]record-link["'`]/.test(jsx), 'src/react/flight-ui.jsx writes no record-link attributes of its own');
check(/window\.FlightRecordLinks/.test(jsx), 'src/react/flight-ui.jsx builds record links from window.FlightRecordLinks');
check(!/["'`]record-link["'`]|class="record-link/.test(legacyFn), 'the legacy recordLinks() writes no record-link attributes of its own');

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true && !!window.FlightReact);

  const builder = await page.evaluate(() => {
    const b = window.FlightRecordLinks;
    return b ? { frozen: Object.isFrozen(b) && Object.isFrozen(b.patterns), parts: typeof b.parts, attributes: typeof b.attributes, kinds: b.patterns.map(p => p[1]) } : null;
  });
  check(builder !== null, 'window.FlightRecordLinks is published by index.html');
  if (builder) {
    check(builder.frozen, 'the shared builder and its patterns are frozen');
    check(builder.parts === 'function' && builder.attributes === 'function', 'the shared builder offers parts() and attributes()');
    check(JSON.stringify(builder.kinds) === JSON.stringify(['order', 'ticket', 'report', 'rev', 'lot', 'serial']), `the shared patterns cover every record kind in order (got ${JSON.stringify(builder.kinds)})`);

    // The same activity text through both paths. Entries sort first (future timestamps) and cover every kind,
    // links with and without a work order, links out of pattern order, markup and escaped characters.
    const result = await page.evaluate(() => {
      const wo = state.orders[0].id;
      const base = Date.now() + 86400000;
      const entries = [
        { action: `NC-12345 raised on ${wo} after ATP-123, see ECR-1-2`, orderId: wo },
        { action: `SNL-12345 then LOT-2026010-001 then ${wo} then IDR-1234`, orderId: wo },
        { action: 'Lot LOT-2026010-001 with IDR-1234 and SNL-1234, no work order', orderId: '' },
        { action: `<b>x</b> '${wo}' "NC-1234" (ATP-123) &IDR-12345 ${wo},NC-2345/ATP-124;LOT-2026010-002`, orderId: wo },
        { action: 'IDR-1234 opened', orderId: '<img src=z onerror="window.__xss=1">' }
      ].map((e, i) => ({ id: `builder-${i}`, at: new Date(base - i * 60000).toISOString(), actor: 'Flight Master · QA-001', ...e }));
      const shapeOf = node => [...node.childNodes].flatMap(n => n.nodeType === 3 ? [{ text: n.textContent }]
        : n.tagName === 'BUTTON' ? [{ attrs: [...n.attributes].map(a => [a.name, a.value]), label: n.textContent }]
        : n.tagName === 'SPAN' ? shapeOf(n) : [{ element: n.tagName }]);
      const merge = parts => parts.reduce((out, p) => { const last = out[out.length - 1]; if (p.text !== undefined && last?.text !== undefined) last.text += p.text; else if (p.text !== '') out.push({ ...p }); return out; }, []);
      const expected = (text, orderId) => merge(window.FlightRecordLinks.parts(text, orderId).map(p => typeof p === 'string' ? { text: p } : { attrs: window.FlightRecordLinks.attributes(p), label: p.id }));
      const legacy = (text, orderId) => { const tpl = document.createElement('template'); tpl.innerHTML = recordLinks(text, orderId); return merge(shapeOf(tpl.content)); };
      state.activity = [...entries, ...state.activity];
      view = 'activity'; render();
      const rows = [...document.querySelectorAll('.fr-activity tbody tr')].slice(0, entries.length).map(tr => {
        const cell = tr.querySelectorAll('td')[2];
        const order = cell.querySelector('.fr-activity-order > span');
        return { action: merge(shapeOf(cell.firstElementChild)), order: order ? merge(shapeOf(order)) : null };
      });
      return { wo, xss: window.__xss, rows: entries.map((e, i) => ({
        entry: e, react: rows[i],
        expected: { action: expected(e.action, e.orderId), order: e.orderId ? expected(e.orderId, e.orderId) : null },
        legacy: { action: legacy(e.action, e.orderId), order: e.orderId ? legacy(e.orderId, e.orderId) : null }
      })) };
    });

    check(result.xss === undefined, 'no handler in an activity entry ran');
    const attrNames = ['type', 'class', 'data-action', 'data-kind', 'data-order', 'data-record', 'title'];
    result.rows.forEach(({ entry, react, expected, legacy }, i) => {
      for (const field of ['action', 'order']) {
        const want = JSON.stringify(expected[field]);
        check(JSON.stringify(legacy[field]) === want, `row ${i} ${field}: the legacy template matches the shared builder: ${JSON.stringify(legacy[field])} vs ${want}`);
        check(JSON.stringify(react?.[field] ?? null) === want, `row ${i} ${field}: the React view matches the shared builder: ${JSON.stringify(react?.[field])} vs ${want}`);
      }
      for (const link of expected.action.filter(p => p.attrs)) {
        check(JSON.stringify(link.attrs.map(a => a[0])) === JSON.stringify(attrNames), `row ${i}: a record link carries ${attrNames.join(', ')} in that order`);
        check(link.attrs.find(a => a[0] === 'title')[1] === `Open ${link.label}`, `row ${i}: a record link is titled Open and its record`);
      }
      if (!entry.orderId) check(expected.action.every(p => !p.attrs || ['order', 'serial'].includes(p.attrs[3][1])), `row ${i}: without a work order only order and serial numbers link`);
    });
    // Link order follows the text, not the pattern order.
    const second = result.rows[1].expected.action.filter(p => p.attrs).map(p => p.label);
    check(JSON.stringify(second) === JSON.stringify(['SNL-12345', 'LOT-2026010-001', result.wo, 'IDR-1234']), `links follow the order of the text (got ${JSON.stringify(second)})`);
  }

  check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  console.log(`errors ${JSON.stringify(errors)}`);
  await context.close();
} finally { await browser.close(); }
console.log(`FAILS ${JSON.stringify(fails)}`);
if (fails.length) process.exit(1);
console.log('Record links come from one shared builder: the legacy template and the React view render the same buttons, attributes and order.');
