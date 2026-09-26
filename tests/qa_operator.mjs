// Run against a regenerated demo: FLIGHT_DEMO_URL=http://localhost:port/demo.html
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.FLIGHT_DEMO_URL || new URL((process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)?(process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)+'demo_publish.html':new URL('../demo.html', import.meta.url).href).href);
  await page.locator('input[name=username]').fill('demo');
  await page.locator('input[name=password]').fill('demo1234');
  await page.locator('#sk-boot form').evaluate(f => f.requestSubmit());
  await page.waitForFunction(() => !document.getElementById('sk-boot'));
  // Pick a live Building order with no hold, no pending change and at least one completed and one open operation, rather than a fixed sample id.
  await page.evaluate(() => { view='order'; selectedId=state.orders.find(o=>o.status==='Building'&&!o.tickets.some(t=>t.status==='Open')&&!MES.engineeringChange(o)&&!MES.pendingSequenceChange(o)&&o.operations.some(x=>x.done)&&o.operations.some(x=>!x.done)).id; selectedOp=null; tab='operations'; render(); });
  assert.equal(await page.locator('.fs-work-cue').getAttribute('data-blocked'), 'false');
  await page.setViewportSize({width:1440,height:700});
  await page.locator('.sequence-panel').scrollIntoViewIfNeeded();
  const opList=page.locator('.sequence-list');
  assert.equal(await opList.getAttribute('tabindex'),'0');
  assert.equal(await opList.evaluate(e=>e.scrollHeight>e.clientHeight),true);
  await opList.evaluate(e=>e.scrollTop=0);
  await opList.focus();
  const headerY=await page.locator('.sequence-panel .panel-head').evaluate(e=>e.getBoundingClientRect().top);
  await page.keyboard.press('End');
  await page.waitForFunction(()=>{const e=document.querySelector('.sequence-list');return e.scrollTop>=e.scrollHeight-e.clientHeight-2;});
  assert.equal(await page.locator('.sequence-panel .panel-head').evaluate(e=>e.getBoundingClientRect().top),headerY);
  if(process.env.FLIGHT_QA_SCREENSHOTS)await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/sequence-scroll-1440.png'});
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.locator('.fs-work-cue').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(21, 28, 36)');
  assert.equal(await page.locator('.task-heading').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await page.locator('.task-panel').evaluate(e=>getComputedStyle(e).boxShadow),'none');
  if(await page.locator('.stepper-live').count())assert.equal(await page.locator('.stepper-live').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  await page.locator('.more-menu summary').click();
  const externalPrint=page.getByRole('button',{name:'Print · External (no messages)',exact:true});
  await externalPrint.waitFor({state:'visible'});
  assert.equal(await externalPrint.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  await page.locator('.more-menu summary').click();
  assert.equal(await page.locator('.operation-btn[data-fs-next="true"]').count(), 1);
  assert.match(await page.locator('.operation-btn[data-fs-next="true"] .op-sub').innerText(), /Complete this first/);
  assert.ok(await page.locator('.operation-btn[data-fs-status="complete"]').count() > 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('[data-fs-current-op]').evaluate(e => getComputedStyle(e,'::after').animationName), 'fs-next-sweep');
  assert.equal(await page.locator('[data-fs-current-op]').evaluate(e => getComputedStyle(e,'::before').animationIterationCount), 'infinite');
  assert.equal(await page.locator('.operation-btn.fs-shimmy').evaluate(e => getComputedStyle(e).animationName), 'fs-op-shimmy');
  assert.equal(await page.locator('.route-stage.current').evaluate(e => getComputedStyle(e,'::after').animationIterationCount), 'infinite');
  assert.equal(await page.locator('[data-fs-next="true"]').evaluate(e => getComputedStyle(e,'::before').animationName), 'fs-op-glow');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('[data-fs-current-op]').evaluate(e => getComputedStyle(e,'::after').animationName), 'none');
  assert.equal(await page.locator('.operation-btn.fs-shimmy').evaluate(e => getComputedStyle(e).animationName), 'none');
  assert.equal(await page.locator('.route-stage.current').evaluate(e => getComputedStyle(e,'::after').animationName), 'none');
  assert.equal(await page.locator('[data-fs-next="true"]').evaluate(e => getComputedStyle(e,'::before').animationName), 'none');
  const classification = await page.evaluate(() => {
    const o=JSON.parse(JSON.stringify(order())),i=currentIndex(o),op=o.operations[i];
    o.status='Draft';const draft=fsOperationStatus(o,op,i);
    o.status='Building';o.sequenceChange={status:'Awaiting QA'};const approval=fsOperationStatus(o,op,i);
    return {draft,approval};
  });
  assert.equal(classification.draft.status, 'approval'); assert.equal(classification.draft.next, false);
  // A pending sequence change is an issue to clear (fsOperationStatus reports 'Change approval required'), not a work order approval step.
  assert.equal(classification.approval.status, 'issue'); assert.match(classification.approval.label, /Change approval required/); assert.equal(classification.approval.next, false);
  const before = await page.evaluate(() => JSON.stringify(state));
  await page.locator('[data-fs-current-op]').click();
  assert.equal(await page.evaluate(() => selectedOp === order().operations[currentIndex(order())].id), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-title');
  assert.equal(await page.evaluate(() => JSON.stringify(state)), before);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('.fs-work-beacon').evaluate(e => getComputedStyle(e).animationName), 'fs-work-pulse');
  assert.equal(await page.locator('.fs-work-beacon').evaluate(e => getComputedStyle(e).animationIterationCount), 'infinite');
  assert.equal(await page.locator('.fs-work-beacon').evaluate(e => getComputedStyle(e,'::after').animationName), 'fs-beacon-ring');
  if(process.env.FLIGHT_QA_SCREENSHOTS){await page.locator('.fs-work-cue').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/beacon-motion.png'});}
  await page.evaluate(()=>document.documentElement.dataset.fsMotion='off');
  assert.equal(await page.locator('.fs-work-beacon').evaluate(e => getComputedStyle(e,'::after').animationName), 'none');
  await page.evaluate(()=>delete document.documentElement.dataset.fsMotion);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.fs-work-beacon').evaluate(e => getComputedStyle(e,'::after').animationName), 'none');
  if(process.env.FLIGHT_QA_SCREENSHOTS)await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/beacon-reduced.png'});
  if(process.env.FLIGHT_QA_SCREENSHOTS){await page.setViewportSize({width:390,height:844});await page.locator('.fs-work-cue').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/beacon-mobile.png'});await page.setViewportSize({width:1440,height:1000});}
  assert.equal(await page.locator('.fs-work-beacon').evaluate(e => getComputedStyle(e).animationDuration), '1e-05s');
  // A Building order with an open hold ticket, so the work cue reports blocked.
  await page.evaluate(() => { selectedId=state.orders.find(o=>o.status==='Building'&&o.tickets.some(t=>t.status==='Open'&&t.hold)).id; selectedOp=null; render(); });
  assert.equal(await page.locator('.fs-work-cue').getAttribute('data-blocked'), 'true');
  await page.emulateMedia({reducedMotion:'no-preference'});
  // A blocked cue never pulses: either no beacon is rendered or its ring animation is off.
  if(await page.locator('.fs-work-beacon').count())assert.equal(await page.locator('.fs-work-beacon').evaluate(e=>getComputedStyle(e,'::after').animationName),'none');
  assert.equal(await page.locator('.fs-next-click').count(), 0);
  assert.equal(await page.locator('.operation-btn[data-fs-next="true"]').count(), 0);
  assert.ok(await page.locator('.operation-btn[data-fs-status="issue"]').count() > 0);
  assert.match(await page.locator('.fs-work-cue').innerText(), /Resolve holds before continuing/);
  assert.equal(await page.locator('.task-panel').getAttribute('data-fs-current'), 'false');
  await page.setViewportSize({ width:390, height:844 });
  await page.locator('.fs-sequence-toggle').click();
  assert.equal(await opList.evaluate(e=>e.scrollHeight>e.clientHeight),true);
  await opList.evaluate(e=>e.scrollTop=e.scrollHeight);
  assert.ok(await opList.evaluate(e=>e.scrollTop)>0);
  if(process.env.FLIGHT_QA_SCREENSHOTS){await opList.scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.querySelectorAll('.sequence-list li')].every(e=>Number(getComputedStyle(e).opacity)===1));await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/sequence-scroll-390.png'});}
  await page.locator('.more-menu summary').click();
  await externalPrint.scrollIntoViewIfNeeded();
  assert.equal(await externalPrint.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  await page.locator('.more-menu summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => MES.validate(state)), true);
  await page.evaluate(()=>{selectedId=state.orders.find(o=>o.status==='Draft'&&MES.requiresReleaseQA(o)&&!MES.releaseApproval(o)).id;selectedOp=null;view='order';tab='operations';render();});
  await page.emulateMedia({reducedMotion:'no-preference'});
  // The QA release cue is the next-action button itself: it carries the glow (the separate release summary block no longer renders on a Draft order).
  const releaseNext=page.locator('.order-next-action [data-action="review-release"]');
  assert.equal(await releaseNext.evaluate(e=>e.classList.contains('fs-next-click')),true);
  assert.equal(await releaseNext.evaluate(e=>getComputedStyle(e,'::before').animationName),'fs-op-glow');
  for(const width of [1440,900,390]){
    await page.setViewportSize({width,height:1000});
    const layout=await page.locator('.order-next-action>.task-actions').evaluate(e=>{const b=[...e.querySelectorAll(':scope>.btn')].map(b=>b.getBoundingClientRect());return {height:e.getBoundingClientRect().height,sameRow:Math.abs(b[0].top-b[1].top)<1,sameLeft:Math.abs(b[0].left-b[1].left)<1};});
    assert.ok(layout.height<220);
    assert.ok(width>540?layout.sameRow:layout.sameLeft);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.FLIGHT_QA_SCREENSHOTS&&width!==900){await releaseNext.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/release-glow-'+width+'.png'});}
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await releaseNext.evaluate(e=>getComputedStyle(e,'::before').animationName),'none');
  if(process.env.FLIGHT_QA_SCREENSHOTS)await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/release-glow-reduced.png'});
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const route of ['home','plan-home','mnv-home']) {
    const heading = route === 'home' ? '.fr-page-heading h1' : '.page-heading';
    await page.evaluate(v => {view=v;render();}, route);
    assert.equal(await page.locator(heading).evaluate(e => getComputedStyle(e).animationName), route === 'home' ? 'none' : 'fs-heading-arrive');
    await page.evaluate(() => render());
    assert.equal(await page.locator(heading).evaluate(e => getComputedStyle(e).animationName), 'none');
  }
  await page.evaluate(() => {document.documentElement.dataset.fsMotion='off';view='home';render();});
  assert.equal(await page.locator('.fr-page-heading h1').evaluate(e => getComputedStyle(e).animationName), 'none');
  assert.deepEqual(errors, []);
  console.log('Operator cue checks passed: current operation, focus, blocked state, reduced motion, mobile, unchanged records.');
} finally { await browser.close(); }
