import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// #94 and #95: every React view that shows a record history renders it through one shared React component, from the
// record data, never from an HTML string. This suite checks two things.
// 1. History text is text. An entry whose action or actor carries markup (<b>, <img onerror>) prints that markup as
//    characters; no element is created and no handler runs.
// 2. The React history and the legacy history it replaces show the same entries, fields and order. Each legacy
//    template is rendered beside its React view on the same records and the two history lists must serialize the same.
const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(`${error.message}`));
  page.on('dialog', dialog => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);

  // Hostile entries, added in memory only (never saved). The work-order entry names record numbers so the timeline's
  // record links are compared too.
  const HOSTILE_ACTION = 'Note: <b>bold</b> on WO-12345 and NC-00012345 <img src=x onerror="window.__xss=1">';
  const HOSTILE_ACTOR = '<img src=x onerror="window.__xss=2">Mallory · <b>CRED-9</b>';
  const seeded = await page.evaluate(([action, actor]) => {
    const FM = window.FlightManeuver;
    const hostile = [
      { at: '2026-01-05T16:00:00.000Z', action: 'Plain entry before', actor: 'Avery Tech · TECH-1' },
      { at: '2026-01-06T17:30:00.000Z', action, actor, orderId: 'WO-12345' },
      { at: '2026-01-07T18:45:00.000Z', action: 'Plain entry after', actor: 'Blake QA · QA-2' }
    ];
    const add = rec => { rec.history = [...(rec.history || []), ...hostile.map(e => ({ ...e }))]; return rec.id; };
    state.orders.forEach(add);
    const wi = (state.masterWIs || [])[0];
    if (wi) add(wi);
    return {
      board: add(FM.list(state, 'mrb')[0]),
      nc: add(FM.list(state, 'ncs')[0]),
      pfmea: add(FM.list(state, 'pfmeas')[0]),
      order: state.orders[0]?.id,
      wi: wi ? { id: wi.id, revision: wi.revision } : null
    };
  }, [HOSTILE_ACTION, HOSTILE_ACTOR]);
  assert.ok(seeded.board && seeded.nc && seeded.pfmea && seeded.order && seeded.wi, 'the fixture has a record of every kind that shows a history');

  // Render the legacy markup and the React view for one record, and return each one's history element as HTML.
  // The timeline's filter ids are random per render, so they are normalized before comparing.
  const pair = kind => page.evaluate(async ([kind, ids]) => {
    const FM = window.FlightManeuver, UI = window.FlightManeuverUI;
    // Canonical form: tag, attributes in name order, then children; text as the characters it shows. Attribute order
    // is the only serialization difference React may introduce, and it has no effect on the page.
    const canon = node => node.nodeType === 3 ? JSON.stringify(node.data) : node.nodeType !== 1 ? '' : `<${node.localName}${[...node.attributes].map(a => ` ${a.name}=${JSON.stringify(a.value)}`).sort().join('')}>${[...node.childNodes].map(canon).join('')}</${node.localName}>`;
    const pick = (root, selector) => { const el = root.querySelector(selector); if (el) el.normalize(); return el ? canon(el).replace(/hf-\d+-[a-z0-9]+/g, 'hf-ID') : null; };
    const legacyHost = document.createElement('div'), reactHost = document.createElement('div');
    legacyHost.hidden = reactHost.hidden = true;
    document.body.append(legacyHost, reactHost);
    try {
      let selector;
      const extra = {};
      if (kind.startsWith('mnv-')) {
        const key = { 'mnv-board': 'board', 'mnv-nc': 'nc', 'mnv-pfmea-detail': 'pfmea' }[kind];
        const saved = { ...UI.sel };
        UI.sel[key] = ids[key];
        try { legacyHost.innerHTML = UI.render(kind); } finally { Object.keys(UI.sel).forEach(k => delete UI.sel[k]); Object.assign(UI.sel, saved); }
        window.FlightReact.renderManeuverDetail(reactHost, state, MES, FM, { ...saved, [key]: ids[key] }, skCan, UI.helpers, kind);
        selector = 'details.resolve-details:has(> ol.mnv-history)';
      } else if (kind === 'order') {
        const o = MES.getOrder(state, ids.order);
        legacyHost.innerHTML = renderRecord(o);
        window.FlightReact.renderOrder(reactHost, state, MES, o, 'record', null, skCan, 'Baseline');
        selector = 'ol.timeline';
        extra.selector = '.history-filter';
      } else if (kind === 'trace') {
        traceQuery = 'FC-200-00001';
        legacyHost.innerHTML = renderTraceReport();
        window.FlightReact.renderTraceReport(reactHost, state, MES, { query: traceQuery });
        selector = 'details.tr-history';
      } else if (kind === 'wi') {
        selectedWI = ids.wi;
        legacyHost.innerHTML = renderWIDetail();
        const wi = MES.findWI(state, ids.wi.id, ids.wi.revision);
        window.FlightReact.renderWIDetail(reactHost, state, MES, { FM, wi, perms: {}, peerOptionsHtml: '', qaOptionsHtml: '' });
        selector = 'ol.wi-history';
      }
      await new Promise(done => setTimeout(done, 50));
      return {
        kind, selector,
        legacy: pick(legacyHost, selector), react: pick(reactHost, selector),
        legacyExtra: extra.selector ? pick(legacyHost, extra.selector) : null, reactExtra: extra.selector ? pick(reactHost, extra.selector) : null,
        reactText: reactHost.querySelector(selector)?.textContent || '',
        injected: reactHost.querySelectorAll(`${selector} img, ${selector} b`).length
      };
    } finally {
      window.FlightReact.unmount?.();
      legacyHost.remove(); reactHost.remove();
    }
  }, [kind, seeded]);

  for (const kind of ['mnv-board', 'mnv-nc', 'mnv-pfmea-detail', 'order', 'trace', 'wi']) {
    const before = errors.length;
    const shown = await pair(kind);
    assert.ok(shown.legacy, `${kind}: the legacy view shows the record history (${shown.selector})`);
    assert.ok(shown.react, `${kind}: the React view shows the record history (${shown.selector})`);
    assert.equal(shown.react, shown.legacy, `${kind}: the React history matches the legacy history entry for entry`);
    assert.equal(shown.reactExtra, shown.legacyExtra, `${kind}: the React history filters match the legacy filters`);
    assert.equal(shown.injected, 0, `${kind}: markup in a history entry creates no element`);
    assert.ok(shown.reactText.includes('<b>bold</b>') && shown.reactText.includes('<img src=x onerror="window.__xss=1">'), `${kind}: markup in the action prints as text`);
    assert.ok(shown.reactText.includes('<img src=x onerror="window.__xss=2">Mallory · <b>CRED-9</b>'), `${kind}: the actor and credential print as recorded, as text`);
    assert.deepEqual(errors.slice(before), [], `${kind}: rendering the history raises no page errors`);
  }

  // The timeline links the record numbers in an entry, as buttons the page already handles, and nothing else.
  const links = await page.evaluate(async id => {
    const host = document.createElement('div'); host.hidden = true; document.body.appendChild(host);
    try {
      window.FlightReact.renderOrder(host, state, MES, MES.getOrder(state, id), 'record', null, skCan, 'Baseline');
      await new Promise(done => setTimeout(done, 50));
      const li = [...host.querySelectorAll('ol.timeline > li')].find(x => x.textContent.includes('<b>bold</b>'));
      return [...li.querySelectorAll('button.record-link')].map(b => `${b.dataset.kind}:${b.dataset.record}:${b.dataset.order}`);
    } finally { window.FlightReact.unmount?.(); host.remove(); }
  }, seeded.order);
  assert.deepEqual(links, ['order:WO-12345:WO-12345', 'ticket:NC-00012345:WO-12345', 'order:WO-12345:WO-12345'], 'the entry links its work order and ticket numbers');

  assert.equal(await page.evaluate(() => window.__xss), undefined, 'no handler from a history entry ran');
  assert.deepEqual(errors, []);
  console.log('React history: Maneuver, work-order, trace report and WI histories match their legacy templates entry for entry, and markup in an entry prints as text');
} finally {
  await browser.close();
}
