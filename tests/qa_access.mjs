// Isolated browser only. Never provisions accounts in a user's existing browser.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.FLIGHT_UI_URL||new URL((process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)?(process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)+'publish.html':new URL('../index.html',import.meta.url).href).href);
  const password='Test-'+crypto.randomUUID();
  await page.locator('#sk-displayname').fill('Access Test');
  await page.locator('#sk-username').fill('access-test');
  await page.locator('#sk-password').fill(password);
  await page.locator('#sk-confirm').fill(password);
  await page.locator('#sk-login-submit').click();
  await page.waitForFunction(()=>!document.getElementById('sk-boot'));
  assert.equal(await page.evaluate(()=>skAuth.role()),'admin');
  await page.reload();
  await page.waitForFunction(()=>!document.getElementById('sk-boot'));
  assert.equal(await page.evaluate(()=>skAuth.role()),'admin');
  for(const cap of ['manage-access','safety-buyoff','approve-wi','approve-wo','approve-nc','operate-steps'])
    assert.equal(await page.evaluate(cap=>skAuth.can(cap),cap),true);
  // Inspection requires a Quality stamp even for Master Access; MRB remains role-based.
  assert.equal(await page.evaluate(()=>skAuth.can('inspect-steps')),false);
  for(const cap of ['mrb-quality','mrb-me','mrb-eng','mrb-cert'])
    assert.equal(await page.evaluate(cap=>skAuth.can(cap),cap),true);
  for(const cap of ['conformity','aqi-sign'])
    assert.equal(await page.evaluate(cap=>skAuth.can(cap),cap),false);
  assert.equal(await page.evaluate(()=>MES.stampCheck({name:'Unregistered Test',credentialId:'invalid'}).ok),false);
  await page.getByRole('button',{name:'Your credentials',exact:true}).click();
  assert.match(await page.locator('.access-coverage').innerText(),/Access coverage needs review/);
  assert.match(await page.locator('.access-coverage').innerText(),/target: at least 2/);
  await page.getByRole('button',{name:'Create Master Access account',exact:true}).click();
  assert.equal(await page.locator('[data-access-add] [name=role]').inputValue(),'admin');
  assert.equal(await page.locator('[data-access-add] [name=username]').inputValue(),'master');
  await page.locator('[data-access-add] [name=displayName]').fill('Second Test');
  await page.locator('[data-access-add] [name=password]').fill(password);
  await page.locator('[data-access-add] button[type=submit]').click();
  await page.waitForFunction(()=>skAuth.users().some(u=>u.username==='master'&&u.role==='admin'));
  const replacement=password+'-new';
  await page.locator('[data-account-password="master"]').click();
  await page.locator('#account-new-password').fill(replacement);
  await page.locator('#account-confirm-password').fill(replacement);
  await page.locator('#account-password-form button[type=submit]').click();
  await page.getByRole('heading',{name:'Your credentials'}).waitFor();
  // A general user cannot create a privileged account, even with a stale form.
  await page.locator('[data-access-add] [name=displayName]').fill('Refused Test');
  await page.locator('[data-access-add] [name=username]').fill('refused-test');
  await page.locator('[data-access-add] [name=password]').fill(password);
  await page.locator('[data-access-add] [name=role]').selectOption('admin');
  await page.evaluate(()=>{const k='skyryse-mes-auth-v1',a=JSON.parse(localStorage.getItem(k));a.users.find(u=>u.username==='access-test').role='general';localStorage.setItem(k,JSON.stringify(a));});
  await page.locator('[data-access-add] button[type=submit]').click();
  assert.equal(await page.evaluate(()=>skAuth.users().some(u=>u.username==='refused-test')),false);
  assert.match(await page.locator('[data-access-add] .access-add-error').innerText(),/Only a Master Access or QA Manager/);
  await page.locator('#dialog [data-action="close-dialog"]').first().click();
  await page.getByRole('button',{name:'Your credentials',exact:true}).click();
  await page.locator('#account-switch-user').selectOption('master');
  await page.locator('#account-switch-password').fill('wrong-password');
  await page.locator('#account-switch-form button[type=submit]').click();
  assert.match(await page.locator('#account-switch-error').innerText(),/^Account or password is incorrect\. Check both and try again, or ask a QA Manager to reset your password\./);
  assert.equal(await page.evaluate(()=>skAuth.user().username),'access-test');
  await page.locator('#account-switch-password').fill(replacement);
  await page.locator('#account-switch-form button[type=submit]').click();
  await page.waitForFunction(()=>skAuth.user().username==='master');
  assert.equal(await page.evaluate(()=>skAuth.role()),'admin');
  assert.deepEqual(errors,[]);
  console.log('Access checks passed: setup, reload, all role functions, invalid stamp refusal, master creation, password reset, unauthorized creation refusal, secure in-place account switch.');
} finally {await browser.close();}
