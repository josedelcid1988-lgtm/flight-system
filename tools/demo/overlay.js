/* DEMO OVERLAY: demo overlay, appended by tools/build-demo.mjs. Not part of the production build.
   Loads the sample workspace once per browser, gives the named pilot accounts working stamps,
   seeds one PFMEA example, activates the generic role stamps and marks every page
   "DEMO, NOT FOR ACCEPTANCE". Role capabilities, stamps and separation of duties are relaxed by
   the numbered replacements listed in docs/DEMO_DEVIATIONS.md, not here. */
(function () {
  'use strict';
  var SEED_MARK = '__SEED_MARK__';
  var WORKSPACE = 'skyryse-mes-work-order-qa100-v1';

  // ---- preload the sample workspace once per browser ------------------------------------------
  try {
    if (!localStorage.getItem(SEED_MARK)) {
      localStorage.setItem(SEED_MARK, new Date().toISOString());
      localStorage.setItem(WORKSPACE, JSON.stringify(window.__DEMO_SEED));
      location.reload();
      return;
    }
  } catch (error) { /* private browsing: fall through to an empty workspace */ }

  // ---- pilot stamps ---------------------------------------------------------------------------
  // Each account that does bench, inspection or signing work starts with a stamp issued to it, so
  // the scenarios run without a detour through the register.
  var STAMP_FOR = { master: '8130-9 Authorized Inspector', demo: 'Quality', quality: 'Quality',
                    tech: 'Technician', operations: 'Technician', mfgeng: 'Engineering' };
  function seedStamps() {
    try {
      if (typeof state === 'undefined' || !state || !Array.isArray(state.stamps) || !window.skAuth) return;
      var changed = false;
      Object.keys(STAMP_FOR).forEach(function (user) {
        if (state.stamps.some(function (s) { return s.account === user; })) return;
        var free = state.stamps.find(function (s) { return s.status === 'Active' && s.buyoffType === STAMP_FOR[user] && !s.account; });
        if (!free) return;
        free.account = user;
        var acct = (skAuth.users ? skAuth.users() : []).find(function (u) { return u.username === user; });
        if (acct && acct.name) free.name = acct.name;
        changed = true;
      });
      if (changed && typeof save === 'function') save();
    } catch (e) { /* the stamp rules still report anything wrong */ }
  }
  seedStamps();
  document.addEventListener('click', seedStamps, true);

  // ---- PFMEA example ----------------------------------------------------------------------------
  // One critical safety work instruction through ME peer review and QA review, with its PFMEA
  // part-way through the analysis. The people are fictional.
  function seedPfmea() {
    try {
      if (typeof state === 'undefined' || !state || !state.maneuver || !window.FlightManeuver) return;
      var m = state.maneuver; if (m.__pfmeaSeed) return;
      if (!Array.isArray(m.pfmeas)) m.pfmeas = [];
      m.__pfmeaSeed = 1;
      if (m.pfmeas.length) { if (typeof save === 'function') save(); return; }
      var wi = (state.masterWIs || []).find(function (w) { return w.status === 'Draft' && w.operations.length >= 2; });
      if (!wi) { if (typeof save === 'function') save(); return; }
      var ago = function (d) { return new Date(Date.now() - d * 86400000).toISOString(); };
      var me = { name: 'Riley Vance', role: 'Manufacturing Engineer', credentialId: 'ACCT-rvance', account: null };
      var qe = { name: 'Casey Lindqvist', role: 'Quality Engineer', credentialId: 'ACCT-clindqvist', account: null };
      wi.criticalSafety = true;
      wi.peerReview = { name: me.name, role: me.role, credentialId: me.credentialId, at: ago(3), virtual: true };
      wi.qaReview = { name: qe.name, role: qe.role, credentialId: qe.credentialId, at: ago(2), virtual: true };
      var op1 = wi.operations[0].id, op2 = wi.operations[1].id;
      var h = function (at, action, who) { return { at: at, action: action, actor: who.name + ' · ' + who.credentialId }; };
      m.pfmeas.push({ id: 'PFM-101', wiId: wi.id, wiRevision: wi.revision, partNumber: wi.partNumber, title: wi.title, status: 'Analysis',
        scope: { team: 'R. Vance (ME), C. Lindqvist (QE), D. Okafor (Design), Safety Team representative', boundaries: 'Every operation of this revision, from kit verification to final inspection.', by: me, at: ago(2) },
        rows: [
          { id: 'FM-1', opId: op1, mode: 'Wrong kit issued to the bench', effect: 'Non-conforming part installed', cause: 'Kit label not checked against the work order', controls: 'Kit list attached from NetSuite', s: 7, o: 3, d: 4, rpn: 84, action: '', owner: '', due: null, done: null, by: me, at: ago(2) },
          { id: 'FM-2', opId: op2, mode: 'Fastener under-torqued', effect: 'Loss of retention in flight', cause: 'Wrench unit set to in-lb', controls: 'Torque step records value', s: 9, o: 3, d: 4, rpn: 108, action: '', owner: '', due: null, done: null, by: me, at: ago(1) }
        ],
        reviewed: {}, analysisDone: null, actionsDone: null, safety: null, returns: [], openedBy: qe, openedAt: ago(2), attachments: [],
        history: [h(ago(2), 'Opened from the QA review of ' + wi.id + ' Rev ' + wi.revision + '.', qe), h(ago(2), 'Scope and team recorded.', me), h(ago(2), 'FM-1 added.', me), h(ago(1), 'FM-2 added.', me)] });
      (wi.history = wi.history || []).push({ at: ago(3), action: 'Flagged as a critical safety part.', actor: me.name + ' · ' + me.credentialId });
      if (typeof save === 'function') save();
    } catch (e) { /* demo only */ }
  }
  seedPfmea();
  document.addEventListener('click', seedPfmea, true);

  // ---- every buy-off type usable in the demo -----------------------------------------------------
  // The live build seeds the generic role credentials as Retired, because real stamps are issued to
  // named people. The demo activates them so every buy-off type can be exercised; every other stamp
  // rule (type, expiry, suspension) still applies to them.
  (function activateRoleStamps() {
    var GENERIC = ['TE-01', 'QI-01', 'AP-01', 'EN-01', 'AI-01'];
    var horizon = new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);
    function run(st) {
      try {
        if (!st || !Array.isArray(st.stamps)) return false;
        var changed = false;
        st.stamps.forEach(function (stamp) {
          if (GENERIC.indexOf(stamp.number) === -1 || stamp.status === 'Active') return;
          stamp.status = 'Active';
          stamp.expires = horizon;
          stamp.qualifications = [{ buyoffType: stamp.buyoffType, expires: horizon }];
          stamp.history = (stamp.history || []).concat([{ at: new Date().toISOString(), by: 'demo build', action: 'Activated in the demo copy so this buy-off type can be exercised.' }]);
          changed = true;
        });
        return changed;
      } catch (error) { return false; }
    }
    if (window.MES && typeof window.MES.ensureStamps === 'function') {
      var original = window.MES.ensureStamps;
      window.MES.ensureStamps = function (st) { var out = original.apply(this, arguments); run(st); return out; };
    }
    // `state` is a top-level let in the app, so it is not a window property: read it by name.
    function current() { try { return state; } catch (error) { return null; } }
    var tries = 0, timer = setInterval(function () {
      var live = current();
      if (live && run(live)) {
        try { if (typeof save === 'function' && MES.validate(live)) save(); } catch (error) { /* demo only */ }
        try { if (typeof render === 'function') render(); } catch (error) { /* demo only */ }
        clearInterval(timer);
        return;
      }
      if (++tries > 80) clearInterval(timer);
    }, 150);
  })();

  // ---- DEMO, NOT FOR ACCEPTANCE on every page ---------------------------------------------------
  var style = document.createElement('style');
  style.textContent = '.demo-banner{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:2147483000;pointer-events:none;padding:4px 12px;border-radius:999px;background:#7a1f00;color:#fff;font:700 12px/16px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.04em;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.25)}@media print{.demo-banner{position:static;transform:none;display:block;text-align:center;margin:0 auto 8px}}'
    + '.demo-chip{display:inline-flex;align-items:center;gap:var(--s-1);margin-left:var(--s-2);padding:var(--s-1) var(--s-2);border-radius:var(--r-full);background:var(--warn-soft);color:var(--warn);font:600 12px/16px var(--font);white-space:nowrap}.demo-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:#F2A900}@media(max-width:700px){.demo-chip{display:none}}';
  document.head.appendChild(style);
  function markPage() {
    if (!document.querySelector('.demo-banner')) {
      var banner = document.createElement('div');
      banner.className = 'demo-banner'; banner.setAttribute('role', 'note');
      banner.textContent = 'DEMO, NOT FOR ACCEPTANCE';
      document.body.appendChild(banner);
    }
    var bar = document.querySelector('.breadcrumbs');
    if (bar && !bar.querySelector('.demo-chip')) {
      var chip = document.createElement('span');
      chip.className = 'demo-chip';
      chip.textContent = 'Demo copy · example data';
      chip.title = 'Demo build: pilot seats keep their real roles; every other account has full access. Records here are examples, not production records.';
      bar.appendChild(chip);
    }
  }
  markPage();
  document.addEventListener('click', markPage, true);
  var repaint = setInterval(markPage, 1500);
  setTimeout(function () { clearInterval(repaint); }, 30000);
})();
