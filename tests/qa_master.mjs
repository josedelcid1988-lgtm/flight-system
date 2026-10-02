// Fresh browser contexts only: no access to the user's account or saved workspace.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.FLIGHT_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const demo = await browser.newPage();
  await demo.goto(new URL((process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)?(process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)+'demo_publish.html':new URL('./fixtures/demo_publish.html', import.meta.url).href).href,{waitUntil:'domcontentloaded'});
  await demo.locator('#sk-username').fill('demo');
  await demo.locator('#sk-password').fill('demo1234');
  await demo.locator('#sk-login-submit').click();
  await demo.waitForFunction(() => !document.getElementById('sk-boot'));
  const fixture = await demo.evaluate(() => structuredClone(state));
  await demo.close();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.FLIGHT_UI_URL || new URL((process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)?(process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)+'publish.html':new URL('../index.html', import.meta.url).href).href,{waitUntil:'domcontentloaded'});
  const password = 'Test-' + crypto.randomUUID();
  for (const [id, value] of Object.entries({ 'sk-displayname': 'Master Test', 'sk-username': 'master-test', 'sk-password': password, 'sk-confirm': password })) await page.locator('#' + id).fill(value);
  await page.locator('#sk-login-submit').click();
  await page.waitForFunction(() => !document.getElementById('sk-boot'));
  const result = await page.evaluate(async fixture => {
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const check = r => { assert(r.ok, r.message); return r; };
    const setRole = role => { const k='skyryse-mes-auth-v1', a=JSON.parse(localStorage.getItem(k));a.users.find(u=>u.username==='master-test').role=role;localStorage.setItem(k,JSON.stringify(a)); };
    const caps=['view','raise-nc','submit-ecr','operate','operate-steps','split','request-pedigree','approve-pedigree','edit-wi','peer-review-wi','create-wo','adjust-wo','dispo-nc','push-software','assign-work','accept-software','safety-buyoff','inspect-steps','mrb-quality','mrb-me','mrb-eng','mrb-cert','approve-wo','approve-wi','approve-nc','post-notice','manage-access'];
    // Inspection requires an assigned current Quality stamp; MRB seats follow role capabilities. Only conformity and AQI are named grants.
    const granted=skAuth.GRANTED;
    for (const cap of caps.filter(c=>!granted.includes(c)&&c!=='inspect-steps')) assert(skAuth.can(cap), 'Missing Master capability: '+cap);
    assert(!skAuth.can('inspect-steps'), 'Master Access needs an assigned Quality stamp for inspection');
    for (const cap of granted) assert(!skAuth.can(cap), 'Master Access holds '+cap+' without a grant');
    { const k='skyryse-mes-auth-v1',a=JSON.parse(localStorage.getItem(k)),salt='00112233445566778899aabbccddeeff';
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':test-qm2')))].map(x=>x.toString(16).padStart(2,'0')).join('');
      a.users.push({username:'test-qm2',displayName:'Test QA Manager',salt,hash,role:'qm',createdAt:new Date().toISOString(),createdBy:'master-test'});localStorage.setItem(k,JSON.stringify(a));
      sessionStorage.setItem('skyryse-mes-session-v1','test-qm2');
      const r=MES.recordTraining(state,{account:'master-test',code:'ESD',expires:'2031-12-31',note:'test setup'}); assert(r.ok,r.message);
      for (const cap of granted) { const grant=skAuth.setGrant('master-test',cap,true,'Test setup grant.','ESD'); assert(grant.ok,grant.message); }
      const stamp=MES.issueStamp(state,{name:'Master Test',buyoffType:'Quality',account:'master-test',expires:'2031-12-31'});assert(stamp.ok,stamp.message);
      const latest=JSON.parse(localStorage.getItem(k));latest.users=latest.users.filter(user=>user.username!=='test-qm2');localStorage.setItem(k,JSON.stringify(latest));
      assert(save(),'training and QA Manager grant records saved');sessionStorage.setItem('skyryse-mes-session-v1','master-test'); }
    for (const cap of caps.filter(c=>c!=='inspect-steps')) assert(skAuth.can(cap), 'Missing Master capability after grants: '+cap);
    assert(skAuth.can('inspect-steps'), 'Master Access inspection activates only after an assigned Quality stamp is recorded');
    assert(FlightManeuver.seatsForRole('admin').length===4,'Master Access holds all four role-based MRB seats');
    const base=structuredClone(fixture);
    // Exercise the production engine with a saved sample, not the demo engine.
    base.profile={name:'Unassigned Test',role:'System Administrator',credentialId:'ACCT-unassigned'};
    MES.stampRegister(base);
    assert(MES.validate(base),'Initial sample is valid');
    const template=base.orders.find(o=>o.status==='Building'&&!MES.engineeringChange(o)&&!MES.pendingSequenceChange(o)&&!MES.blockingTickets(o).length&&o.operations.some(x=>!x.done));
    assert(template,'Building fixture');
    const opId=template.operations.find(x=>!x.done).id;
    function setup(type='Technician') {
      const s=structuredClone(base),o=MES.getOrder(s,template.id),op=o.operations.find(x=>x.id===opId);
      op.buyoffType=type;op.requiresTooling=false;op.requiresRecording=false;op.evidence=[];op.callouts=[];delete op.fodLevel;delete op.grounding;op.classification='Manufacturing';op.topLevelType='Manufacturing';op.subCode='';op.steps=[{id:'step-master',title:'Review work',instruction:'Review the work before buy-off.'}];op.stepChecks={};
      assert(MES.validate(s),'Fixture for '+type+' is valid: '+JSON.stringify(MES.diagnose(s)));
      return {s,o,op};
    }
    const beforeStamps=JSON.stringify(base.stamps);
    for (const type of MES.BUYOFF_TYPES) {
      const {s,o,op}=setup(type);
      check(MES.setStepCheck(s,o.id,op.id,op.steps[0].id,true));
      assert(op.stepChecks[op.steps[0].id].credentialId==='ACCT-master-test','Step attributed to account');
      check(MES.completeOperation(s,o.id,op.id,'Isolated Master regression',{standardInspection:true}));
      assert(op.buyoff.stamp===null,'Override is not a fabricated issued stamp');
      assert(op.buyoff.credentialId==='ACCT-master-test','Buy-off attributed to account');
      assert(op.buyoff.override.requiredTypes[0]===type,'Required buy-off type captured');
      assert(op.buyoff.manifest.override.kind==='Master Access override','Manifest identifies override');
      assert(/^[a-f0-9]{64}$/.test(op.buyoff.manifest.hash),'SHA-256 recorded');
      const subject={orderId:o.id,operationId:op.id,title:op.title,note:'Isolated Master regression',stepChecks:op.stepChecks,evidenceIds:[],stamp:null,override:op.buyoff.override,tools:[]};
      assert(MES.signManifest(s,'test',subject,op.buyoff.at).hash===op.buyoff.manifest.hash,'Override included in hash');
      assert(MES.validate(s),'Valid after '+type+' buy-off');
      assert(JSON.stringify(s.stamps)===beforeStamps,'Stamp register unchanged');
    }
    for (const role of ['general','technician','operator','me','swe','qe','qm','safety','cert']) {
      setRole(role);const {s,o,op}=setup();
      assert(!MES.masterAccess(),'Non-admin cannot get Master privileges');
      assert(!MES.buyoffCredential(s.profile,'Technician').ok,'Chosen admin profile cannot grant a stamp');
      op.steps=[];
      assert(!MES.completeOperation(s,o.id,op.id,'Refused',{}).ok,'Non-admin without stamp refused: '+role);
    }
    setRole('admin');
    {const {s,o,op}=setup();const later=o.operations[o.operations.indexOf(op)+1];
      if(later) assert(!MES.completeOperation(s,o.id,later.id,'Out of sequence',{standardInspection:true}).ok,'Sequence still enforced');}
    {const s=structuredClone(base),o=s.orders.find(o=>o.fair?.verified);
      assert(o,'FAIR signature fixture');o.fair.status='Verified';o.fair.approved=null;delete o.fair.reviewed;
      assert(!MES.approveFair(structuredClone(s),o.id,{}).ok,'FAIR approval waits for box 22, even for Master Access');
      check(MES.reviewFair(s,o.id,{}));
      check(MES.approveFair(s,o.id,{}));
      assert(o.fair.approved.by.override.kind==='Master Access override','FAIR bypass is explicit');
      assert(o.fair.approved.manifest.override.account==='master-test','FAIR override signed');
      assert(MES.validate(s),'Valid after FAIR approval');}
    {const s=structuredClone(base),o=s.orders.find(o=>o.conformity?.some(p=>p.form));
      assert(o,'8130-9 signature fixture');const p=o.conformity.find(p=>p.form);
      p.status='8130-9 completed';p.aqi=null;p.mdlReceived=new Date().toISOString().slice(0,10);
      p.form.prepared.by.credentialId='ACCT-master-test';
      // The person who completed the 8130-9 may sign as AQI only after acknowledging the warning; it is recorded.
      const self=MES.aqiSign8130_9(structuredClone(s),o.id,p.serial,{});
      assert(!self.ok&&self.warning==='aqi-self-sign'&&/you completed this 8130-9/.test(self.message),'Self-signature needs the warning acknowledged: '+self.message);
      { const s2=structuredClone(s),o2=MES.getOrder(s2,o.id),p2=o2.conformity.find(x=>x.serial===p.serial);const ack=MES.aqiSign8130_9(s2,o2.id,p2.serial,{selfSignAck:true});
        assert(ack.ok&&p2.aqi.selfSigned===true&&MES.validate(s2),'Acknowledged self-signature recorded: '+JSON.stringify(ack)); }
      p.form.prepared.by.credentialId='ACCT-other-inspector';
      check(MES.aqiSign8130_9(s,o.id,p.serial,{}));
      assert(p.aqi.by.override.kind==='Master Access override','AQI override explicit');
      assert(p.aqi.manifest.override.account==='master-test','AQI override signed');
      assert(MES.validate(s),'Valid after Master AQI signature');}
    {const {s,o,op}=setup();const t=check(MES.createTicket(s,o.id,op.id,{type:'NC',title:'Development use test',description:'Check role inheritance without losing independent approval.',hold:true}));
      check(MES.dispositionTicket(s,o.id,t.id,{decision:'Use for Dev',note:'Development only.'}));
      const c=MES.DEFECT_CODES[0],input={defectCode:c.code,subCode:c.subs[0].code};
      assert(!MES.resolveTicket(s,o.id,t.id,'Independent approval needed.',input).ok,'Master cannot approve own disposition');
      o.tickets.find(x=>x.id===t.id).dispo.credentialId='ACCT-other-engineer';
      check(MES.resolveTicket(s,o.id,t.id,'Reviewed by Master.',input));
      assert(MES.validate(s),'Valid after Master QA Manager approval');}
    {const {s,o,op}=setup();assert(!MES.completeOperation(s,o.id,op.id,'Missing steps',{}).ok,'Incomplete work refused');
      check(MES.createTicket(s,o.id,op.id,{type:'NC',title:'Test hold',description:'Hold must still block Master.',hold:true}));
      assert(!MES.setStepCheck(s,o.id,op.id,op.steps[0].id,true).ok,'Hold blocks Master');}
    const {s,o,op}=setup();check(MES.setStepCheck(s,o.id,op.id,op.steps[0].id,true));
    s.trainingRecords=structuredClone(state.trainingRecords||[]);
    state=s;lastSaved=structuredClone(s);view='order';selectedId=o.id;selectedOp=op.id;tab='operations';render();
    return {types:MES.BUYOFF_TYPES,order:o.id,op:op.id};
  },fixture);
  assert.match(await page.locator('.steps-complete').innerText(),/Master Access override/);
  // Nobody changes their own roles: your own row has no role control, and a forged one is refused.
  await page.evaluate(()=>{window.__ord={id:selectedId,op:selectedOp};view='admin';render();});
  await page.getByRole('heading',{name:'Admin',exact:true}).waitFor();
  assert(await page.locator('tr:has-text("master-test")').count()>0,'Your own row is listed on the Admin page');
  assert.equal(await page.locator('[data-role-user="master-test"],[data-roles-user="master-test"]').count(),0,'No role control on your own row');
  const forged=await page.evaluate(()=>{const sel=document.createElement('select');sel.dataset.roleUser='master-test';sel.innerHTML='<option value="general">General</option>';document.body.appendChild(sel);sel.value='general';sel.dispatchEvent(new Event('change',{bubbles:true}));sel.remove();return {role:skAuth.role(),toast:document.querySelector('#toast p')?.textContent||'',direct:skAuth.setRoles('master-test',['general'],'Testing self role refusal.','')};});
  assert.equal(forged.role,'admin','A forged own-row role control is refused');
  assert.match(forged.toast,/Nobody changes their own roles/);
  assert.match(forged.direct.message,/Nobody changes their own roles/);
  // A role change made by another manager refreshes the open dialog and the underlying buy-off without reload.
  await page.evaluate(async()=>{const k='skyryse-mes-auth-v1',a=JSON.parse(localStorage.getItem(k)),salt='00112233445566778899aabbccddeeff';const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':peer-admin')))].map(x=>x.toString(16).padStart(2,'0')).join('');if(!a.users.some(u=>u.username==='peer-admin'))a.users.push({username:'peer-admin',displayName:'Peer Admin',salt,hash,role:'admin',createdAt:new Date().toISOString(),createdBy:'master-test'});localStorage.setItem(k,JSON.stringify(a));});
  // A manager works on the Admin page; the account under test goes back to its open buy-off and Your credentials.
  const as=async user=>{await page.evaluate(user=>{sessionStorage.setItem('skyryse-mes-session-v1',user);window.dispatchEvent(new Event('sk-auth'));},user);await page.waitForTimeout(200);await page.evaluate(user=>{const d=document.getElementById('dialog');if(d&&d.open)d.close();if(user==='peer-admin'){view='admin';render();}else{view='order';selectedId=window.__ord.id;selectedOp=window.__ord.op;tab='operations';render();profileDialog();}},user);};
  const setPeerRole=peerRole=>page.evaluate(peerRole=>{const k='skyryse-mes-auth-v1',a=JSON.parse(localStorage.getItem(k));a.users.find(u=>u.username==='peer-admin').role=peerRole;localStorage.setItem(k,JSON.stringify(a));},peerRole);
  const storedRole=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.find(u=>u.username==='master-test').role);
  const role=page.locator('[data-role-user="master-test"]');
  await as('peer-admin');
  await role.selectOption('qm');
  assert.match(await page.locator('.access-panel [role=status]').filter({hasText:/Saved: master-test now has/}).innerText(),/Saved: master-test now has/);
  await as('master-test');
  assert.equal(await page.evaluate(()=>skAuth.role()),'qm');
  assert.match(await page.locator('#profile-preview').innerText(),/Quality Manager/);
  assert.match(await page.locator('.steps-complete').innerText(),/Buy-off blocked/);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    await as('peer-admin');
    await role.selectOption('admin');
    assert.match(await page.locator('.access-panel [role=status]').filter({hasText:/Saved: master-test now has Master Access/}).innerText(),/Saved: master-test now has Master Access/);
    await as('master-test');
    assert.equal(await page.evaluate(()=>skAuth.role()),'admin');
    assert.equal(await page.evaluate(()=>state.profile.role),'System Administrator');
    assert.match(await page.locator('#profile-preview').innerText(),/Master Access override/);
    assert.match(await page.locator('.steps-complete').innerText(),/Master Access override/);
    if(process.env.FLIGHT_QA_SCREENSHOTS){await mkdir(process.env.FLIGHT_QA_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/role-switch-'+width+'.png',animations:'disabled'});}
    await as('peer-admin');
    await role.selectOption('qm');
  }
  // A stale control cannot change access after the signed-in account loses authority.
  await setPeerRole('general');
  await role.selectOption('admin');
  assert.equal(await storedRole(),'qm','A manager who lost authority cannot use a stale role control');
  await setPeerRole('admin');
  await as('peer-admin');
  await role.selectOption('admin');
  assert.equal(await storedRole(),'admin');
  await as('master-test');
  // The stamp is issued by the second Master Access account: nobody issues a stamp to themselves.
  await page.evaluate(()=>{if(!MES.hasValidInspectionStamp(state,'master-test')){sessionStorage.setItem('skyryse-mes-session-v1','peer-admin');const stamp=MES.issueStamp(state,{name:'Master Test',buyoffType:'Quality',account:'master-test',expires:'2031-12-31'});sessionStorage.setItem('skyryse-mes-session-v1','master-test');if(!stamp.ok)throw Error(stamp.message);save();}if(!MES.hasValidInspectionStamp(state,'master-test'))throw Error('Master Test does not hold a current assigned Quality inspection stamp.');});
  await page.evaluate(()=>profileDialog());
  await page.locator('#profile-form button[type=submit]').click();
  assert.equal(await page.locator('#operation-form input[name=stampNumber]').count(),0);
  if(await page.locator('#operation-form input[name=stdInspection]').count()) await page.locator('#operation-form input[name=stdInspection]').check();
  await page.locator('.steps-complete [data-action=buyoff-now]').click();
  assert.equal(await page.locator('#step-stamp-form input[name=pin]').count(),0);
  if(process.env.FLIGHT_QA_SCREENSHOTS) {
    await mkdir(process.env.FLIGHT_QA_SCREENSHOTS,{recursive:true});
    for (const width of [1440,390]) {await page.setViewportSize({width,height:1000});await page.screenshot({path:process.env.FLIGHT_QA_SCREENSHOTS+'/master-buyoff-'+width+'.png',animations:'disabled'});}
  }
  await page.locator('#step-stamp-form button[type=submit]').click();
  try { await page.waitForFunction(({order,op})=>MES.getOrder(state,order).operations.find(x=>x.id===op).done,result,{timeout:5000}); }
  catch(error) { console.log(await page.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,error:document.querySelector('#operation-error')?.textContent,dialog:document.querySelector('#dialog')?.textContent,valid:MES.validate(state),blocked:storageBlocked})),errors);throw error; }
  await page.reload();await page.waitForFunction(()=>!document.getElementById('sk-boot'));
  assert.equal(await page.evaluate(({order,op})=>MES.getOrder(state,order).operations.find(x=>x.id===op).buyoff.override.account,result),'master-test');
  assert.deepEqual(errors,[]);
  console.log('PASS: all '+result.types.length+' buy-off types, all roles, FAIR and AQI signatures, account attribution, signed override payload, ordinary-role refusal, independent approvals, holds, required steps, UI completion and persistence.');
} finally { await browser.close(); }
