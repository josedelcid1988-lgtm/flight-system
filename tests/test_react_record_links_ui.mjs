// The React activity record builds its record links as React elements from the raw event text,
// never from an HTML string. Hostile markup in an activity entry renders as text, and the React view
// shows the same record links, targets and order as the legacy activity template.
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const fails = [];
const check = (ok, label) => { if (!ok) fails.push(label); };
// Adjacent text parts merge, so text split across React fragments compares equal to the template's.
const merge = parts => parts.reduce((out, p) => { const last = out[out.length - 1]; if (p.text !== undefined && last?.text !== undefined) last.text += p.text; else if (p.text !== '') out.push({ ...p }); return out; }, []);
const literal = parts => merge(parts).map(p => p.text ?? p.button[7]).join('');
const buttons = parts => merge(parts).filter(p => p.button).map(p => p.button);
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

  // Hostile entries sort first (future timestamps). They cover every record-link kind, links with and
  // without a work order, and markup in both the action and the work order field.
  const hostile = await page.evaluate(() => {
    const wo = state.orders[0].id;
    const base = Date.now() + 86400000;
    const entries = [
      { action: `<b>bold</b> note on ${wo} and NC-12345 <img src=x onerror="window.__xss=1">`, orderId: wo },
      { action: 'Lot LOT-2026010-001 moved <b>x</b> with IDR-1234 and no work order', orderId: '' },
      { action: `Serial SNL-12345 & ATP-123 "quoted" ECR-1-2 and LOT-2026010-001 on ${wo}`, orderId: wo },
      { action: 'IDR-1234 opened <img src=y onerror="window.__xss=2">', orderId: '<img src=z onerror="window.__xss=3">' },
      // Ids next to characters the legacy template escapes, ids split only by punctuation, and a work
      // order that itself matches a record pattern.
      { action: `'${wo}' "NC-1234" (ATP-123) &IDR-12345 ${wo},NC-2345/ATP-124;LOT-2026010-002`, orderId: wo }
    ].map((e, i) => ({ id: `hostile-${i}`, at: new Date(base - i * 60000).toISOString(), actor: 'Flight Master · QA-001', ...e }));
    state.activity = [...entries, ...state.activity];
    view = 'activity'; render();
    return { wo, entries };
  });
  await page.getByRole('heading', { name: 'Activity record.' }).waitFor();

  const views = await page.evaluate(count => {
    const shapeOf = node => [...node.childNodes].flatMap(n => n.nodeType === 3 ? [{ text: n.textContent }]
      : n.tagName === 'BUTTON' ? [{ button: [n.type, n.className, n.dataset.action, n.dataset.kind, n.dataset.order, n.dataset.record, n.title, n.textContent] }]
      : n.tagName === 'SPAN' ? shapeOf(n) : [{ element: n.tagName }]);
    const reactRows = [...document.querySelectorAll('.fr-activity tbody tr')].slice(0, count).map(tr => {
      const cell = tr.querySelectorAll('td')[2];
      const order = cell.querySelector('.fr-activity-order > span');
      return { action: shapeOf(cell.firstElementChild), order: order ? shapeOf(order) : null, elements: [...cell.querySelectorAll('*')].map(e => e.tagName).filter(t => !['SPAN', 'SMALL', 'BUTTON'].includes(t)) };
    });
    // The legacy template is parsed inert: a <template> runs no scripts or event handlers.
    const tpl = document.createElement('template');
    tpl.innerHTML = renderActivity();
    const legacyRows = [...tpl.content.querySelectorAll('ol.timeline > li')].slice(0, count).map(li => {
      const small = li.querySelector('small');
      const tag = small.querySelector('.hf-kind-tag');
      // After the kind tag and actor, the legacy template appends " · " and the work order links.
      const after = [...small.childNodes].slice([...small.childNodes].indexOf(tag) + 1);
      return { action: shapeOf(li.querySelector('strong')), order: after.flatMap(n => shapeOf({ childNodes: [n] })) };
    });
    return { reactRows, legacyRows, xss: window.__xss };
  }, hostile.entries.length);

  check(views.xss === undefined, `no hostile handler ran (window.__xss is ${views.xss})`);
  views.reactRows.forEach((row, i) => {
    const entry = hostile.entries[i], legacy = views.legacyRows[i];
    check(row.elements.length === 0, `row ${i}: the record cell holds only text and record-link buttons (found ${row.elements.join(', ')})`);
    check(literal(row.action) === entry.action, `row ${i}: the action renders as its literal text, markup included`);
    check(JSON.stringify(merge(row.action)) === JSON.stringify(merge(legacy.action)), `row ${i}: React action text and links match the legacy template: ${JSON.stringify(merge(row.action))} vs ${JSON.stringify(merge(legacy.action))}`);
    if (entry.orderId) {
      check(literal(row.order || []) === entry.orderId, `row ${i}: the work order renders as its literal text`);
      check(JSON.stringify(buttons(row.order || [])) === JSON.stringify(buttons(legacy.order)), `row ${i}: React work order links match the legacy template`);
      check(literal(legacy.order).endsWith(entry.orderId), `row ${i}: the legacy template shows the same work order text`);
    } else {
      check(row.order === null && buttons(legacy.order).length === 0, `row ${i}: no work order line when the event has none`);
    }
  });
  const kinds = new Set(views.reactRows.flatMap(r => [...buttons(r.action), ...buttons(r.order || [])]).map(b => b[3]));
  for (const k of ['order', 'ticket', 'report', 'rev', 'lot', 'serial']) check(kinds.has(k), `a ${k} record link renders`);
  check(buttons(views.reactRows[1].action).length === 0, 'links that need a work order stay plain text when the event has none');
  check(JSON.stringify(buttons(views.reactRows[0].action).map(b => b[5])) === JSON.stringify([hostile.wo, 'NC-12345']), 'the first hostile row links its work order and NC in text order');

  // The React view must not depend on the legacy escaping: with a legacy recordLinks that stops
  // escaping, the React cells still show the literal text and no injected element.
  const unescaped = await page.evaluate(count => {
    const original = recordLinks;
    recordLinks = text => String(text);
    try {
      render();
      const cells = [...document.querySelectorAll('.fr-activity tbody tr')].slice(0, count).map(tr => tr.querySelectorAll('td')[2]);
      return { injected: cells.flatMap(c => [...c.querySelectorAll('b, img')]).length, text: cells.map(c => c.firstElementChild.textContent), xss: window.__xss };
    } finally { recordLinks = original; render(); }
  }, hostile.entries.length);
  check(unescaped.injected === 0, `with an unescaped legacy recordLinks the React cells hold ${unescaped.injected} injected elements`);
  check(unescaped.xss === undefined, 'with an unescaped legacy recordLinks no hostile handler runs');
  check(JSON.stringify(unescaped.text) === JSON.stringify(hostile.entries.map(e => e.action)), 'with an unescaped legacy recordLinks the React cells still show the literal action text');

  // A React record link still opens its record through the global record-link handler.
  await page.locator('.fr-activity tbody tr').first().locator('td').nth(2).locator('button.record-link[data-kind="order"]').first().click();
  const opened = await page.evaluate(() => ({ view, selectedId, tab }));
  check(opened.view === 'order' && opened.selectedId === hostile.wo && opened.tab === 'operations', `the work order link opens ${hostile.wo} (got ${JSON.stringify(opened)})`);
  check(await page.evaluate(() => window.__xss) === undefined, 'no hostile handler ran after navigation');

  check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  console.log(`errors ${JSON.stringify(errors)}`);
  await context.close();
} finally { await browser.close(); }
console.log(`FAILS ${JSON.stringify(fails)}`);
if (fails.length) process.exit(1);
console.log('React activity record links render as elements from the record text: hostile markup stays text, links, targets and order match the legacy template, and a link opens its record.');
