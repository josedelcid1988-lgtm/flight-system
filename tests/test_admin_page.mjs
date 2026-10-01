// The Admin page (production build). Accounts and roles, training, stamps and the master SDS book moved out of
// Your credentials onto one page that only an account holding manage-access opens. Covers: a non-manager sees
// no Admin entry and is refused the page, the deep link and the open-admin action; a manager sees every tab;
// each moved action still works there and still refuses the self-target with the engine's plain message;
// Your credentials keeps only the signed-in person's own items; individually granted authorities read in
// words; the stamp register fits a 1024x768 tablet (one header row, no wrapped words, nothing clipped).
import {chromium} from 'playwright';
const TESTS=decodeURI(new URL('.',import.meta.url).pathname);
const FIXTURES=process.env.FS_FIXTURES_DIR?process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):TESTS+'fixtures/';
const PROD='file://'+FIXTURES+'publish.html';
const AUTH='skyryse-mes-auth-v1',SESSION='skyryse-mes-session-v1';
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const ctx=await b.newContext({viewport:{width:1440,height:900}});
const p=await ctx.newPage();
const errs=[];p.on('pageerror',e=>errs.push(e.message));
const fails=[];const ok=(w,c,m='')=>{console.log((c?'  ok   ':'  FAIL ')+w+(c?'':' -> '+m));if(!c)fails.push(w);};
const run=(fn,a)=>p.evaluate(fn,a);
const future=(y=2)=>new Date(Date.now()+y*365*86400000).toISOString().slice(0,10);
const as=async u=>{await run(([S,u])=>{const d=document.getElementById('dialog');if(d&&d.open)d.close();sessionStorage.setItem(S,u);window.dispatchEvent(new Event('sk-auth'));},[SESSION,u]);await p.waitForTimeout(250);};
const openAdmin=()=>run(()=>{view='admin';render();});
const toast=()=>run(()=>document.querySelector('#toast p')?.textContent||'');
const clearToast=()=>run(()=>{const t=document.querySelector('#toast p');if(t)t.textContent='';});

await p.goto(PROD);await p.waitForTimeout(900);
await run(()=>{const un=document.querySelector('#sk-boot input[name=username]');const f=un.closest('form');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(un,'jdoe');set(f.querySelector('input[type=password]'),'demo1234');const cf=f.querySelector('input[name=confirm]');if(cf)set(cf,'demo1234');const d=f.querySelector('input[name=displayName]');if(d)set(d,'Jordan Doe');f.requestSubmit();});
await p.waitForTimeout(2600);
await run(async([AUTH])=>{const a=JSON.parse(localStorage.getItem(AUTH));const salt='00112233445566778899aabbccddeeff';const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':demo1234')));
  const add=(username,displayName,role)=>{if(!a.users.some(u=>u.username===username))a.users.push({username,displayName,salt,hash,role,createdAt:new Date().toISOString(),createdBy:'jdoe'});};
  add('pqm','Parker Manager','qm');add('kqe','Kai Quality','qe');add('ttech','Toni Tech','technician');localStorage.setItem(AUTH,JSON.stringify(a));},[AUTH]);

// ---------------- refusal: an account without manage-access ----------------
for (const user of ['ttech','kqe']) {
  await as(user);
  await run(()=>{view='home';render();});
  const nav=await run(()=>({hidden:document.querySelector('[data-admin-nav]').hidden,can:skAuth.can('manage-access')}));
  ok(`${user}: no manage-access and no Admin entry in the sidebar`,!nav.can&&nav.hidden,JSON.stringify(nav));
  await openAdmin();
  const page=await run(()=>{const m=document.getElementById('main');return {refused:!!m.querySelector('.admin-refused [role=alert]'),text:m.textContent,controls:m.querySelectorAll('[data-admin-tab],details.access-panel,#stamp-issue-form,#training-form,#training-record-form,#msds-book-form,.stamp-register,[data-role-user],[data-stamp-account]').length,crumb:document.getElementById('breadcrumb').textContent};});
  ok(`${user}: opening the Admin view shows a plain refusal and no admin control`,page.refused&&page.controls===0&&/Admin is not available to your account/.test(page.text)&&/Ask one of them/.test(page.text),JSON.stringify({...page,text:page.text.slice(0,160)}));
  ok(`${user}: breadcrumb and tab title read Admin`,page.crumb==='Admin'&&await p.title().then(t=>/· Admin$/.test(t)),page.crumb);
}
await run(()=>{view='home';render();});await clearToast();
await run(()=>{const x=document.createElement('button');x.dataset.action='open-admin';document.body.appendChild(x);x.click();x.remove();});
ok('a forged Open Admin action is refused by the capability guard and the view does not change',await run(()=>view)!=='admin'&&/Your role cannot manage accounts and roles/.test(await toast()),await toast());
await p.goto(PROD+'#admin');await p.reload();await p.waitForFunction(()=>typeof view!=='undefined'&&!document.getElementById('sk-boot'));await p.waitForTimeout(800);
const deep=await run(()=>({view,user:skAuth.user()?.username,refused:!!document.querySelector('#main .admin-refused'),tabs:!!document.querySelector('#main [data-admin-tab]')}));
ok('the #admin deep link is refused for a non-manager after reload',deep.view==='admin'&&deep.refused&&!deep.tabs,JSON.stringify(deep));
await run(()=>profileDialog());
const plain=await run(()=>{const d=document.getElementById('dialog');const r={open:d.open,admin:d.querySelectorAll('details.access-panel,.stamp-register,#stamp-issue-form,#stamp-import-form,#training-form,#training-record-form,#msds-book-form,[data-role-user],[data-grant-user]').length,own:!!d.querySelector('.own-profile'),openAdmin:!!d.querySelector('[data-action="open-admin"]'),switch:!!d.querySelector('#account-switch-form'),form:!!d.querySelector('#profile-form'),signout:/Sign out/.test(d.textContent),stamps:!!d.querySelector('.own-stamps')};d.close();return r;});
const guide=await run(()=>document.querySelector('#dialog .own-profile')?.textContent||document.getElementById('dialog').textContent);
ok('Your credentials tells a non-manager that only Master Access or a QA Manager issues and changes stamps',/Stamps are issued and changed only by a Master Access or QA Manager account/.test(guide)&&!/Roles, training and stamps are changed by a Master Access, QA Manager or Quality Supervisor/.test(guide),guide.slice(0,400));
ok('Your credentials for a non-manager: own profile, own stamps, account switch, credential choice and sign out; no admin section and no Admin link',plain.open&&plain.admin===0&&plain.own&&!plain.openAdmin&&plain.switch&&plain.form&&plain.signout&&plain.stamps,JSON.stringify(plain));

// ---------------- a manager: every tab, every moved action ----------------
await as('jdoe');
const pqmStamp=await run(f=>{const r=MES.issueStamp(state,{name:'Parker Manager',buyoffType:'Quality',account:'pqm',expires:f});save();return r;},future());
ok('setup: another Master Access account issues the QA Manager a stamp',pqmStamp.ok,JSON.stringify(pqmStamp));
await as('pqm');
await run(()=>{view='home';render();});
ok('pqm: the Admin entry is shown to an account that manages access',await run(()=>skAuth.can('manage-access')&&!document.querySelector('[data-admin-nav]').hidden));
await p.getByRole('button',{name:'Admin',exact:true}).click();
await p.getByRole('heading',{name:'Admin',exact:true}).waitFor();
const heading=await run(()=>document.querySelector('.admin-page .page-heading').textContent);
ok('the Admin heading claims a reason only for the changes that ask for one',/recorded with your name and the time/.test(heading)&&/Authority grants, added or removed roles and training requirement changes also record the reason/.test(heading)&&!/recorded with your name and its reason/.test(heading),heading);
const tabs=await run(()=>[...document.querySelectorAll('[role=tab][data-admin-tab]')].map(t=>({k:t.dataset.adminTab,name:t.textContent,sel:t.getAttribute('aria-selected'),panel:!!document.getElementById(t.getAttribute('aria-controls'))})));
ok('pqm sees the four tabs, each with its panel, Accounts and roles first',JSON.stringify(tabs.map(t=>t.name))===JSON.stringify(['Accounts and roles','Training','Stamps','Master SDS book'])&&tabs.every(t=>t.panel)&&tabs[0].sel==='true',JSON.stringify(tabs));
const panels=await run(()=>({acc:!!document.querySelector('#admin-panel-accounts details.access-panel [data-access-add]'),tr:!!document.querySelector('#admin-panel-training #training-form')&&!!document.querySelector('#admin-panel-training #training-record-form'),st:!!document.querySelector('#admin-panel-stamps .stamp-register #stamp-issue-form')&&!!document.querySelector('#admin-panel-stamps #stamp-import-form'),sds:!!document.querySelector('#admin-panel-sds #msds-book-form'),hidden:['training','stamps','sds'].every(k=>document.getElementById('admin-panel-'+k).hidden)}));
ok('each tab holds its section: accounts, training requirements and records, the stamp register, the master SDS book',Object.values(panels).every(Boolean),JSON.stringify(panels));
await p.focus('[data-admin-tab="accounts"]');await p.keyboard.press('ArrowRight');
ok('arrow keys move between tabs',await run(()=>document.activeElement?.dataset.adminTab==='training'&&!document.getElementById('admin-panel-training').hidden&&document.getElementById('admin-panel-accounts').hidden));
await p.click('[data-admin-tab="accounts"]');

// Opening Admin after an order writes a clean #admin route, and that route reloads onto Admin.
// The production fixture holds no orders, so leave an order id and tab selected, as an order visit does.
await run(()=>{view='orders';selectedId='SWO-101';tab='operations';});
const orderHash=await run(()=>({selectedId,tab}));
await run(()=>{const x=document.createElement('button');x.dataset.action='open-admin';document.body.appendChild(x);x.click();x.remove();});
const adminHash=await run(()=>({view,hash:location.hash}));
ok('Open Admin from an order writes the clean #admin route, with no order or tab left in it',orderHash.selectedId==='SWO-101'&&orderHash.tab==='operations'&&adminHash.view==='admin'&&adminHash.hash==='#admin',JSON.stringify({orderHash,adminHash}));
await p.reload();await p.waitForFunction(()=>typeof view!=='undefined'&&!document.getElementById('sk-boot'));await p.waitForTimeout(800);
ok('the #admin route reloads onto the Admin page for a manager',await run(()=>view==='admin'&&location.hash==='#admin'&&!!document.querySelector('#main [data-admin-tab]')));

// Readable authority names, never the raw capability id.
const chips=await run(()=>[...document.querySelectorAll('.access-table .grant-cell .pill')].map(x=>x.textContent));
ok('authorities read in words in the access table',chips.length>0&&chips.every(t=>/^(Conformity inspection|AQI signature): (granted|not granted|paused, )/.test(t))&&!chips.some(t=>/conformity granted|aqi-sign/.test(t)),JSON.stringify(chips));
ok('your own row has no role, grant or support control',await run(()=>document.querySelectorAll('[data-role-user="pqm"],[data-roles-user="pqm"],[data-grant-user="pqm"],[data-support-toggle="pqm"]').length)===0);

// Roles: a change to another account saves and says so; a forged own-row control is refused.
await p.locator('[data-role-user="kqe"]').selectOption('qs');
await p.locator('.access-panel [role=status]').filter({hasText:/Saved: kqe now has/}).waitFor();
ok('a role change on the Admin page saves and stays on the page',await run(()=>view==='admin'&&JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.find(u=>u.username==='kqe').role==='qs'));
await p.locator('[data-role-user="kqe"]').selectOption('qe');
await p.locator('.access-panel [role=status]').filter({hasText:/Saved: kqe now has Quality Engineer|Saved: kqe now has/}).first().waitFor();
await clearToast();
const forged=await run(()=>{const sel=document.createElement('select');sel.dataset.roleUser='pqm';sel.innerHTML='<option value="general">General</option>';document.body.appendChild(sel);sel.value='general';sel.dispatchEvent(new Event('change',{bubbles:true}));sel.remove();return JSON.parse(localStorage.getItem('skyryse-mes-auth-v1')).users.find(u=>u.username==='pqm').role;});
ok('a forged own role control is refused with the plain message',forged==='qm'&&/Nobody changes their own roles/.test(await toast()),await toast());

// Grant form: the Reason label sits above its box.
await p.locator('[data-grant-user="kqe"][data-cap="conformity"]').click();
const grantForm=await run(()=>{const f=document.querySelector('[data-access-change]');const ta=f.querySelector('textarea[name=reason]'),label=ta.closest('label');const r=document.createRange();r.selectNodeContents(label.firstChild);return {title:f.querySelector('.access-add-title').textContent,labelBottom:r.getBoundingClientRect().bottom,taTop:ta.getBoundingClientRect().top};});
ok('the grant form opens on the Admin page and its Reason label does not overlap the box',/for kqe/.test(grantForm.title)&&grantForm.labelBottom<=grantForm.taTop+0.5,JSON.stringify(grantForm));
await p.locator('[data-access-cancel]').click();

// Password reset from the Admin page returns to the Admin page.
await p.locator('[data-account-password="kqe"]').click();
await p.locator('#account-password-form button[type=button]').click();await p.waitForTimeout(300);
ok('Cancel on a password reset opened from the Admin page returns to the Admin page, not Your credentials',await run(()=>view==='admin'&&!document.getElementById('dialog').open&&!document.querySelector('#profile-form')&&!!document.querySelector('#main [data-admin-tab]')));
await p.locator('[data-account-password="kqe"]').click();
await p.locator('#account-new-password').fill('demo12345');await p.locator('#account-confirm-password').fill('demo12345');
await p.locator('#account-password-form button[type=submit]').click();
await p.waitForTimeout(400);
ok('a password reset made on the Admin page returns to it',await run(()=>view==='admin'&&!document.getElementById('dialog').open&&!!document.querySelector('#main [data-admin-tab]')));

// Training: record for another person; recording your own is refused.
await p.click('[data-admin-tab="training"]');
await p.locator('#training-record-form [name=account]').selectOption('kqe');
await p.locator('#training-record-form [name=code]').selectOption('ESD');
await p.locator('#training-record-form [name=expires]').fill(future(1));
await p.locator('#training-record-form button[type=submit]').click();await p.waitForTimeout(300);
ok('recording training for another person works and the Training tab stays open',await run(()=>(state.trainingRecords||[]).some(r=>r.account==='kqe'&&r.code==='ESD')&&!document.getElementById('admin-panel-training').hidden));
await p.locator('#training-record-form [name=account]').selectOption('pqm');
await p.locator('#training-record-form [name=code]').selectOption('ESD');
await p.locator('#training-record-form [name=expires]').fill(future(1));
await p.locator('#training-record-form button[type=submit]').click();await p.waitForTimeout(200);
ok('recording your own training is refused with the plain message',/Nobody records their own training/.test(await p.locator('#training-record-error').innerText())&&!await run(()=>(state.trainingRecords||[]).some(r=>r.account==='pqm')),await p.locator('#training-record-error').innerText());

// Stamps: issue to another person; issuing, assigning or changing your own is refused; suspending your own is allowed.
await p.click('[data-admin-tab="stamps"]');
const issue=async(account)=>{const f=p.locator('#stamp-issue-form');await f.locator('[name=name]').fill(account==='kqe'?'Kai Quality':'Parker Manager');await f.locator('[name=buyoffType]').selectOption('Technician');await f.locator('[name=account]').selectOption(account);await f.locator('[name=expires]').fill(future());await f.locator('button[type=submit]').click();await p.waitForTimeout(300);};
await issue('kqe');
ok('issuing a stamp to another person works and the Stamps tab stays open',await run(()=>state.stamps.some(s=>s.account==='kqe'&&s.buyoffType==='Technician'&&s.status==='Active')&&!document.getElementById('admin-panel-stamps').hidden));
await issue('pqm');
ok('issuing a stamp to your own account is refused with the plain message',/Nobody issues a stamp to their own account/.test(await p.locator('#stamp-issue-error').innerText())&&!await run(()=>state.stamps.some(s=>s.account==='pqm'&&s.buyoffType==='Technician')),await p.locator('#stamp-issue-error').innerText());
await clearToast();
const placeholder=await run(()=>state.stamps.find(s=>MES.isPlaceholderStamp(s)&&!s.account).id);
await p.locator(`[data-stamp-account="${placeholder}"]`).selectOption('pqm');await p.waitForTimeout(300);
ok('assigning a stamp to your own account is refused with the plain message',/Nobody assigns a stamp to their own account/.test(await toast())&&!await run(id=>state.stamps.find(s=>s.id===id).account,placeholder),await toast());
const own=pqmStamp.id;
await clearToast();
await p.locator(`[data-stamp-expires="${own}"]`).fill(future(4));await p.locator(`[data-stamp-expires="${own}"]`).dispatchEvent('change');await p.waitForTimeout(300);
ok('changing your own stamp is refused with the plain message',/Nobody changes their own stamp/.test(await toast()),await toast());

// Your credentials: own stamps and own PIN only.
await run(()=>profileDialog());
const mine=await run(()=>{const d=document.getElementById('dialog');return {admin:d.querySelectorAll('details.access-panel,.stamp-register,#stamp-issue-form,#training-form,#training-record-form,#msds-book-form,[data-role-user]').length,stamps:[...d.querySelectorAll('.own-stamps tbody tr')].map(r=>r.cells[0].textContent),pin:d.querySelectorAll('.own-stamps [data-stamp-pin]').length,profile:d.querySelector('.own-profile')?.textContent||'',link:!!d.querySelector('[data-action="open-admin"]'),height:d.scrollHeight};});
ok('Your credentials for a manager: no admin section, only your own stamp with Set my PIN, and a link to Admin',mine.admin===0&&mine.stamps.length===1&&mine.pin===1&&mine.link,JSON.stringify(mine));
ok('Your credentials names your authorities in words',/Conformity inspection: not granted/.test(mine.profile)&&/AQI signature: not granted/.test(mine.profile)&&!/aqi-sign/.test(mine.profile),mine.profile);
ok('Your credentials is short (under 2,000 px, was over 6,700 px)',mine.height<2000,String(mine.height));
await p.locator('.own-stamps [data-stamp-pin]').click();
await p.locator('#stamp-pin-new').fill('482913');await p.locator('#stamp-pin-confirm').fill('482913');
await p.locator('#stamp-pin-form button[type=submit]').click();await p.waitForTimeout(300);
ok('setting your own PIN from Your credentials saves and returns to Your credentials',await run(id=>!!state.stamps.find(s=>s.id===id).pin&&!!document.querySelector('#dialog[open] #profile-form'),own));
await p.locator('[data-action="open-admin"]').click();await p.waitForTimeout(200);
ok('Open Admin closes the dialog and opens the Admin page',await run(()=>view==='admin'&&!document.getElementById('dialog').open));
await p.click('[data-admin-tab="stamps"]');
await p.locator(`[data-stamp-status="${own}"]`).selectOption('Suspended');await p.waitForTimeout(300);
ok('suspending your own stamp is still allowed',await run(id=>state.stamps.find(s=>s.id===id).status==='Suspended',own));

// Master SDS book.
await p.click('[data-admin-tab="sds"]');
await p.locator('#msds-book-url').fill('https://example.com/sds-book');await p.locator('#msds-book-label').fill('Plant SDS book');
await p.locator('#msds-book-form button[type=submit]').click();await p.waitForTimeout(300);
ok('the master SDS book saves from its tab and shows the new link',await run(()=>MES.msdsBook(state)?.url==='https://example.com/sds-book'&&!document.getElementById('admin-panel-sds').hidden&&!!document.querySelector('#admin-panel-sds a[href="https://example.com/sds-book"]')));

// ---------------- the stamp register at 1024x768 ----------------
await p.setViewportSize({width:1024,height:768});await p.waitForTimeout(300);
await p.click('[data-admin-tab="stamps"]');await p.waitForTimeout(300);
const layout=await run(()=>{
  const wrap=document.querySelector('.stamp-register .admin-scroll'),table=wrap.querySelector('table'),panel=wrap.closest('.access-panel');
  const wr=wrap.getBoundingClientRect(),pr=panel.getBoundingClientRect();
  const heads=table.querySelectorAll('thead tr').length,sticky=[...table.querySelectorAll('thead th')].some(th=>getComputedStyle(th).position==='sticky');
  // Every text run in the table renders on one line: no word broken mid-way.
  const walker=document.createTreeWalker(table,NodeFilter.SHOW_TEXT);const wrapped=[];let n;
  while((n=walker.nextNode())){if(!n.textContent.trim())continue;const r=document.createRange();r.selectNodeContents(n);const lines=new Set([...r.getClientRects()].map(x=>Math.round(x.top)));if(lines.size>1)wrapped.push(n.textContent.trim());}
  // Every control lies inside the scroll area of its container.
  const clipped=[...table.querySelectorAll('input,select,button')].filter(el=>{const r=el.getBoundingClientRect();return r.left<wr.left-1||r.right>wr.left+wrap.scrollWidth+1;}).map(el=>el.outerHTML.slice(0,60));
  const cue=document.querySelector('.stamp-register .scroll-cue');
  const file=document.getElementById('stamp-import-file'),fr=file.getBoundingClientRect(),form=file.closest('form').getBoundingClientRect(),lab=file.closest('label').getBoundingClientRect();
  const ta=document.getElementById('stamp-import-text').getBoundingClientRect();
  return {heads,sticky,wrapped,clipped,overflow:wrap.scrollWidth>wrap.clientWidth,scrollable:getComputedStyle(wrap).overflowX==='auto',cue:!!cue&&!cue.hidden,wrapInPanel:wr.left>=pr.left-1&&wr.right<=pr.right+1,page:document.documentElement.scrollWidth<=window.innerWidth,
    file:fr.left>=form.left-1&&fr.right<=form.right+1&&fr.right<=lab.right+1&&fr.width>=80,textarea:ta.right<=form.right+1&&ta.width>=form.width*0.8};
});
ok('1024: the register has one header row and the header does not stick mid-table',layout.heads===1&&!layout.sticky,JSON.stringify(layout));
ok('1024: no text in the register wraps mid-word (Reset, SKY numbers, dates, pills)',layout.wrapped.length===0,JSON.stringify(layout.wrapped.slice(0,10)));
ok('1024: every register control sits inside the scroll area; the table scrolls sideways inside its panel, not the page',layout.clipped.length===0&&layout.scrollable&&layout.wrapInPanel&&layout.page,JSON.stringify(layout));
ok('1024: a visible cue says the table scrolls sideways when it does',!layout.overflow||layout.cue,JSON.stringify(layout));
ok('1024: Choose File and the CSV box fit inside the import form',layout.file&&layout.textarea,JSON.stringify(layout));
await p.click('[data-admin-tab="accounts"]');await p.waitForTimeout(300);
const accButtons=await run(()=>{const out=[];document.querySelectorAll('.access-table .btn').forEach(el=>{const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){if(!n.textContent.trim())continue;const r=document.createRange();r.selectNodeContents(n);if(new Set([...r.getClientRects()].map(x=>Math.round(x.top))).size>1)out.push(n.textContent.trim());}});return out;});
ok('1024: account table buttons (Reset password, More roles) stay on one line',accButtons.length===0,JSON.stringify(accButtons));
await p.click('[data-admin-tab="training"]');
const trainReason=await run(()=>{const ta=document.querySelector('#training-form textarea[name=reason]'),label=ta.closest('label');const r=document.createRange();r.selectNodeContents(label.firstChild);return r.getBoundingClientRect().bottom<=ta.getBoundingClientRect().top+0.5;});
ok('1024: the training form Reason label sits above its box',trainReason);

// ---------------- stamp state reads as the buy-off gate reads it ----------------
await as('pqm');await openAdmin();await p.click('[data-admin-tab="stamps"]');
const rowFlag=id=>run(id=>{const el=document.querySelector(`[data-stamp-status="${id}"]`);const tr=el&&el.closest('tr');return tr?[...tr.querySelectorAll('.pill')].map(x=>x.textContent).join('|'):'';},id);
// An additional stamp whose qualifying training lapses is refused at buy-off, so the register must not say OK.
const extra=await run(f=>{const r=MES.issueStamp(state,{name:'Kai Quality',buyoffType:'Engineering',account:'kqe',expires:f,trainingCode:'ESD'});save();return r;},future());
ok('setup: an additional Engineering stamp for kqe on current ESD training',extra.ok,JSON.stringify(extra));
await run(()=>{render();});await p.click('[data-admin-tab="stamps"]');
ok('an additional stamp on current training reads OK',/\bOK\b/.test(await rowFlag(extra.id)),await rowFlag(extra.id));
await run(()=>{window.__esd=JSON.stringify(state.trainingRecords);state.trainingRecords.filter(r=>r.account==='kqe'&&r.code==='ESD').forEach(r=>{r.expires='2020-01-01';});render();});
await p.click('[data-admin-tab="stamps"]');
const lapsed={gate:await run(()=>MES.trainingCurrentFor(state,'kqe','ESD').ok),flag:await rowFlag(extra.id)};
ok('an additional stamp whose ESD training lapsed reads Needs current ESD training, not OK',!lapsed.gate&&/Needs current ESD training/.test(lapsed.flag)&&!/\bOK\b/.test(lapsed.flag),JSON.stringify(lapsed));
await run(()=>{state.trainingRecords=JSON.parse(window.__esd);render();});
// A stamp expiring today (Pacific) is still valid in the evening, when the UTC date has moved on.
const pday=ms=>new Date(ms).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
const E=pday(Date.now()+2*86400000);
const late=await run(e=>{const r=MES.issueStamp(state,{name:'Kai Quality',buyoffType:'A&P',account:'kqe',expires:e,trainingCode:'ESD'});save();return r;},E);
ok('setup: a stamp expiring in two days',late.ok,JSON.stringify(late));
await p.clock.setFixedTime(new Date(`${E}T23:30:00-07:00`));
await run(()=>{render();document.querySelector('[data-admin-tab="stamps"]').click();});
const eve={utc:await run(()=>new Date().toISOString().slice(0,10)),flag:await rowFlag(late.id)};
ok('at 23:30 Pacific on its expiry day the stamp reads Expires soon, not Expired (UTC date '+eve.utc+')',eve.utc>E&&/Expires soon/.test(eve.flag)&&!/Expired/.test(eve.flag),JSON.stringify(eve));
await p.clock.setFixedTime(new Date(`${pday(new Date(`${E}T23:30:00-07:00`).getTime()+86400000)}T09:00:00-07:00`));
await run(()=>{render();document.querySelector('[data-admin-tab="stamps"]').click();});
ok('the next Pacific morning the same stamp reads Expired',/Expired/.test(await rowFlag(late.id)),await rowFlag(late.id));
await p.clock.setFixedTime(new Date());

// ---------------- the accounts table at phone width ----------------
await p.setViewportSize({width:375,height:812});await p.click('[data-admin-tab="accounts"]');await p.waitForTimeout(400);
const phone=await run(()=>{
  const wrap=document.querySelector('#admin-panel-accounts .admin-scroll'),table=wrap&&wrap.querySelector('table.access-table');if(!table)return {missing:true};
  const wr=wrap.getBoundingClientRect(),cue=wrap.parentNode.querySelector('.scroll-cue');
  const clipped=[...table.querySelectorAll('input,select,button')].filter(el=>{const r=el.getBoundingClientRect();return r.left<wr.left-1||r.right>wr.left+wrap.scrollWidth+1;}).map(el=>el.outerHTML.slice(0,60));
  return {scrollable:getComputedStyle(wrap).overflowX==='auto',overflow:wrap.scrollWidth>wrap.clientWidth,inView:wr.right<=window.innerWidth+1,page:document.documentElement.scrollWidth<=window.innerWidth,cue:!!cue&&!cue.hidden,clipped};
});
ok('375: the accounts table scrolls sideways inside its panel and the page does not widen',!phone.missing&&phone.scrollable&&phone.inView&&phone.page&&phone.clipped.length===0,JSON.stringify(phone));
ok('375: a visible cue says the accounts table scrolls sideways',phone.overflow&&phone.cue,JSON.stringify(phone));
await p.setViewportSize({width:1440,height:900});

ok('state valid at the end',await run(()=>MES.validate(state)));
ok('no page errors',errs.length===0,JSON.stringify(errs));
await b.close();
console.log('errors',JSON.stringify(errs),'FAILS',JSON.stringify(fails));
process.exit(fails.length?1:0);
