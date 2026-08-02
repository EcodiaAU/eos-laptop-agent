// Atomic money@ Stripe authenticator reconfigure + vault enrol, single session so the
// reconfigure pop-up handle is never lost (that was the "couldn't verify identity" cause).
const fs=require('fs');
const { spawn }=require('child_process');
const puppeteer=require('puppeteer-core');
const { createSeedStore }=require('./seed-store');
const { createKeystore, secureEnclaveBackend }=require('./keystore');
const totp=require('./totp');
const path=require('path'), os=require('os');
const LINK_FILE='/tmp/stripe-verify-link.txt';
const T=(pr,ms)=>Promise.race([pr,new Promise((_,r)=>setTimeout(()=>r(new Error('to')),ms))]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function pollEmail(sinceMs){ return new Promise((res)=>{ const p=spawn('node',['/Users/ecodia/.code/ecodiaos/backend/scripts/stripe-verify-link-reader.js',String(sinceMs)],{cwd:'/Users/ecodia/.code/ecodiaos/backend'}); let o=''; p.stdout.on('data',d=>o+=d); p.stderr.on('data',d=>o+=d); p.on('close',c=>res({code:c,out:o.trim()})); }); }
(async()=>{
  const b=await puppeteer.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
  const popup=await b.newPage();
  await popup.goto('https://dashboard.stripe.com/settings/user',{waitUntil:'networkidle2',timeout:45000}).catch(()=>{});
  // wait for the heavy SPA to actually hydrate the 2FA section (fixed sleeps race it)
  try{ await popup.waitForFunction(()=>/Authenticator app/i.test(document.body?document.body.innerText:''),{timeout:30000,polling:1000}); }
  catch(e){ console.log(JSON.stringify({abort:'auth row never hydrated', url:popup.url().slice(0,50)})); process.exit(0); }
  await sleep(1500);
  // kebab on Authenticator app row
  const kb=await popup.evaluate(()=>{const l=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&/^Authenticator app$/i.test((e.textContent||'').trim())); if(!l)return null; const cy=l.getBoundingClientRect().y+8; const btns=[...document.querySelectorAll('button,[aria-haspopup]')].map(e=>({e,r:e.getBoundingClientRect()})).filter(o=>o.r.width>0&&o.r.width<60&&Math.abs((o.r.y+o.r.height/2)-cy)<26).sort((a,z)=>z.r.x-a.r.x); if(!btns.length)return null; const r=btns[0].r; return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
  if(!kb){ console.log(JSON.stringify({abort:'no kebab'})); process.exit(0); }
  await popup.mouse.click(kb.x,kb.y); await sleep(1500);
  const up=await popup.evaluate(()=>{const e=[...document.querySelectorAll('[role=menuitem],button,a,div,span')].find(x=>/^Update$/i.test((x.innerText||x.textContent||'').trim())&&x.getBoundingClientRect().width>0&&x.getBoundingClientRect().width<200); if(!e)return null; const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
  if(!up){ console.log(JSON.stringify({abort:'no Update'})); process.exit(0); }
  await popup.mouse.click(up.x,up.y); await sleep(6000);
  const trigger=Date.now();
  await popup.evaluate(()=>{const s=[...document.querySelectorAll('button,a')].find(x=>/^Send verification$/i.test((x.innerText||'').trim())); if(s)s.click();});
  await sleep(2500);
  // poll for the email link (async, popup stays alive)
  const pr=await pollEmail(trigger);
  if(pr.code!==0){ console.log(JSON.stringify({abort:'no email link', poll:pr.out})); process.exit(0); }
  const link=fs.readFileSync(LINK_FILE,'utf8').trim();
  // open link in a NEW tab, same browser; popup handle stays alive
  const vt=await b.newPage();
  await vt.goto(link,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
  await sleep(5000);
  let vtxt=''; try{ vtxt=await T(vt.evaluate(()=>document.body.innerText.slice(0,80)),6000);}catch(e){}
  // Stripe verified in vt; the popup only advances when it regains focus/visibility
  // ("please return to the original tab"). Close vt and bring the popup to front,
  // and nudge a visibilitychange so its poller fires.
  await vt.close().catch(()=>{});
  await popup.bringToFront().catch(()=>{});
  try{ await popup.evaluate(()=>{ document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); }); }catch(e){}
  await sleep(2500);
  // poll the ORIGINAL popup handle for the QR
  let qrUri=null, popState=null;
  for(let i=0;i<8;i++){
    await sleep(2500);
    try{
      const st=await T(popup.evaluate(async()=>{
        const img=[...document.querySelectorAll('img')].find(i=>/^data:image/.test(i.src||'')||/QR/i.test(i.alt||''));
        let uri=null;
        if(img && ('BarcodeDetector' in window)){ try{ const bmp=await createImageBitmap(await (await fetch(img.src)).blob()); const codes=await new BarcodeDetector({formats:['qr_code']}).detect(bmp); if(codes.length&&/^otpauth:\/\//.test(codes[0].rawValue||'')) uri=codes[0].rawValue; }catch(e){} }
        return { hasImg:!!img, uri, verifyPending:/Check your email|Leave this pop-up|verification link/i.test(document.body.innerText), snip:document.body.innerText.slice(0,70).replace(/\n+/g,' ') };
      }),9000);
      popState=st;
      if(st.uri){ qrUri=st.uri; break; }
      if(!st.verifyPending && !st.hasImg && i>2) { /* maybe not there yet */ }
    }catch(e){ popState={hung:true}; }
  }
  if(!qrUri){ console.log(JSON.stringify({stage:'no-qr', verifyTab:vtxt, popState})); process.exit(0); }
  // enrol at birth + confirm
  const store=createSeedStore({keystore:createKeystore({backend:secureEnclaveBackend({})}),dbPath:path.join(os.homedir(),'PRIVATE','ecodia-creds','vault','vault.db')});
  const seed_id=store.enroll({service:'stripe-money',tier:'OPEN',backend:'totp',otpauthUri:qrUri,registered_origin:'https://dashboard.stripe.com',registered_account:'money@ecodia.au',enrolled_under_presence:true});
  const s=store.loadSeed(seed_id);
  const code=totp.totp(s.secret,{algorithm:s.algorithm||'sha1',digits:s.digits||6,period:s.period||30});
  // fill the confirm code on the popup + submit
  const filled=await popup.evaluate((c)=>{ const i=[...document.querySelectorAll('input')].find(x=>x.type==='text'||x.type==='tel'||x.inputMode==='numeric'||/code/i.test(x.name||x.getAttribute('aria-label')||'')); if(!i)return {ok:false}; i.focus(); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,c); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,len:i.value.length}; }, code);
  await sleep(700);
  await popup.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(x=>/^(add|confirm|verify|save|enable|done)$/i.test((x.innerText||'').trim())); if(btn)btn.click();});
  await sleep(5000);
  const res=await T(popup.evaluate(()=>({err:/incorrect|invalid|wrong|didn.t match/i.test(document.body.innerText), snip:document.body.innerText.slice(0,90).replace(/\n+/g,' ')})),8000).catch(()=>({}));
  console.log(JSON.stringify({ENROLLED:true, seed_id, filled, confirm:res}));
  process.exit(0);
})().catch(e=>{ console.log(JSON.stringify({err:e.message})); process.exit(0); });
