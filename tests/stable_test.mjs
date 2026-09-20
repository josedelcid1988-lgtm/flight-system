import {chromium} from 'playwright'; import fs from 'fs';
const auth=fs.readFileSync('/tmp/auth.json','utf8');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
let bad=0,ok=0;
for(const file of ['publish.html','demo_publish.html']){
for(const w of [1200,1440,1706,1920]){
  const ctx=await b.newContext({viewport:{width:w,height:900}});
  await ctx.addInitScript(a=>{try{localStorage.setItem('skyryse-mes-auth-v1',a);sessionStorage.setItem('skyryse-mes-session-v1','qa');sessionStorage.setItem('sk-boot-seen','1');sessionStorage.setItem('sk-mnv-landing-seen','1');}catch(e){}},auth);
  const p=await ctx.newPage(); await p.goto('file:///home/claude/fc/'+file);
  await p.waitForFunction(()=>window.__ready===true,null,{timeout:60000});
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
