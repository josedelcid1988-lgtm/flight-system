import {chromium} from 'playwright';
// A Master Access account seeded into a throwaway browser context, so both builds open signed in without a file on disk.
const auth=JSON.stringify({users:[{username:'qa',displayName:'QA Admin',salt:'',hash:'unused',role:'admin',createdAt:new Date().toISOString()}]});
const fixtures=((process.env.FS_FIXTURES_DIR?'file://'+process.env.FS_FIXTURES_DIR.replace(/\/?$/,'/'):null)||new URL('./fixtures/',import.meta.url).href);
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
let bad=0,ok=0;
for(const file of ['publish.html','demo_publish.html']){
for(const w of [1200,1440,1706,1920]){
  const ctx=await b.newContext({viewport:{width:w,height:900}});
  // The demo keeps its accounts and session under its own keys (docs/DEMO_DEVIATIONS.md).
  await ctx.addInitScript(([a,key,sess])=>{try{localStorage.setItem(key,a);sessionStorage.setItem(sess,'qa');sessionStorage.setItem('sk-boot-seen','1');sessionStorage.setItem('sk-mnv-landing-seen','1');}catch(e){}},[auth,...(file.startsWith('demo')?['skyryse-mes-demo-auth-v1','skyryse-mes-demo-session-v1']:['skyryse-mes-auth-v1','skyryse-mes-session-v1'])]);
  const p=await ctx.newPage(); await p.goto(fixtures+file);
  await p.waitForFunction(()=>window.__ready===true,null,{timeout:60000});
  if(!(await p.evaluate(()=>!!(window.skAuth&&skAuth.actor&&skAuth.actor()))))throw new Error(file+' did not open signed in as the seeded account');
  if(file==='publish.html')await p.evaluate(()=>{const wi=state.masterWIs.find(x=>x.status==='Released');for(let i=0;i<25;i++)MES.addOrder(state,{masterWI:wi.id+'|'+wi.revision,pedigree:'Production',subcategory:'Mfg.',quantity:1,aircraft:MES.AIRCRAFT[0],site:MES.SITES[0]});save();});
  for(const v of ['orders','quality','activity','serials','wis','plan','mnv-cars','mnv-mrb']){
    const r=await p.evaluate(v=>{view=v;render();
      return new Promise(res=>{
        const snap=()=>[...document.querySelectorAll('.table-wrap')].map(tw=>[...tw.querySelectorAll('thead th')].map(t=>Math.round(t.getBoundingClientRect().width)).join(',')+'|'+tw.className).join(';');
        const samples=[];let n=0;
        const iv=setInterval(()=>{samples.push(snap());if(++n>=12){clearInterval(iv);res(samples);}},250);});},v);
    const first=r[2]; // after 750ms things have painted
    const drift=r.slice(3).filter(x=>x!==first);
    if(drift.length){bad++;console.log('DRIFT',file,w,v,'\n  settled:',first.slice(0,160),'\n  later  :',drift[0].slice(0,160));}
    else ok++;
  }
  await ctx.close();
}}
console.log(bad?('FAIL '+bad):'TABLE LAYOUT STABLE ('+ok+' checks)');
await b.close();
