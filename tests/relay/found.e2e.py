import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
OUT=Path('/tmp/browser/mac-found')
OUT.mkdir(parents=True,exist_ok=True)
VECTOR=json.loads(Path(__file__).with_name('found-vectors.json').read_text())
async def main():
 async with async_playwright() as pw:
  browser=await pw.chromium.launch(headless=True)
  ctx=await browser.new_context(viewport={'width':1280,'height':1800})
  page=await ctx.new_page()
  if os.environ.get('LOVABLE_BROWSER_AUTH_STATUS')=='injected':
   storage_key=os.environ.get('LOVABLE_BROWSER_SUPABASE_STORAGE_KEY');session_json=os.environ.get('LOVABLE_BROWSER_SUPABASE_SESSION_JSON');cookies=json.loads(os.environ.get('LOVABLE_BROWSER_SUPABASE_COOKIES_JSON') or '[]')
  else:
   with open(os.path.expanduser('~/.cache/lovable-auth/session.json')) as f: minted=json.load(f)
   storage_key=minted['storage_key'];session_json=json.dumps(minted['session']);cookies=minted.get('cookies') or []
  if cookies: await ctx.add_cookies([{**c,'url':'http://localhost:8080'} for c in cookies])
  await page.goto('http://localhost:8080')
  await page.evaluate('([k,v])=>localStorage.setItem(k,v)',[storage_key,session_json])
  await page.goto('http://localhost:8080/workspace')
  await page.get_by_role('heading',name='Worth knowing',exact=True).wait_for()
  try:
   await page.evaluate('''async(v)=>{
    const r=await import('/src/lib/relay.functions.ts');const p=await r.createRelayPairingCode();
    const claim=await fetch('/api/relay/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({v:1,code:p.code,deviceName:'Found-items verification'})});
    if(!claim.ok)throw Error('claim status '+claim.status);window.__foundDevice=await claim.json();
    const c=await import('/src/lib/mac-cards.ts'); await c.saveKeyFromLink('#k='+v.key+'&kid='+v.keyId);
    window.__foundKey=await crypto.subtle.importKey('raw',Uint8Array.from(atob(v.key.replace(/-/g,'+').replace(/_/g,'/')+'='),x=>x.charCodeAt(0)),'AES-GCM',false,['encrypt','decrypt']);
    window.__foundSeq=Date.now();window.__foundDoc=v.found.document;
    window.__putFound=async(doc)=>{
     const nonce=crypto.getRandomValues(new Uint8Array(12)),bytes=new TextEncoder().encode(JSON.stringify(doc));const padded=new Uint8Array(Math.ceil(bytes.length/1024)*1024).fill(32);padded.set(bytes);
     const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode('nc-lists-v1|'+v.keyId)},window.__foundKey,padded);
     const refs=[...doc.list,...(doc.found||[])].map(x=>x.ref).filter(Boolean);for(let i=0;refs.length<30;i++){const ref=i.toString(16).padStart(24,'0');if(!refs.includes(ref))refs.push(ref)}refs.sort();
     const response=await fetch('/api/relay/lists',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__foundDevice.token},body:JSON.stringify({v:1,seq:++window.__foundSeq,keyId:v.keyId,generatedAt:new Date().toISOString(),nonce:btoa(String.fromCharCode(...nonce)),ciphertext:btoa(String.fromCharCode(...new Uint8Array(encrypted))),refs,expiresAt:new Date(Date.now()+86400000).toISOString()})});if(!response.ok)throw Error('upload status '+response.status);
    };await window.__putFound(v.found.document);localStorage.removeItem('nc-found');window.dispatchEvent(new Event('focus'));
   }''',VECTOR)
   device=await page.evaluate('window.__foundDevice')
   panel=page.locator('section[aria-labelledby="mac-found-heading"]')
   await panel.get_by_role('heading',name='Check what I found').wait_for()
   assert await panel.locator('li').count()==6
   assert await panel.get_by_role('button',name='Add',exact=True).count()==3
   for text in ['Something private','Something to check']:
    row=panel.locator('li').filter(has_text=text);assert await row.get_by_role('button').count()==0
   consent=panel.locator('li').filter(has_text='Return the trip consent form'); assert await consent.get_by_role('button',name='Add',exact=True).count()==0
   await panel.screenshot(path=str(OUT/'1_rows.png'))
   await panel.locator('li').filter(has_text='Swimming gala').get_by_role('button',name='Add',exact=True).click()
   await panel.get_by_role('status').filter(has_text='Added.').wait_for()
   await panel.locator('li').filter(has_text='PE kit').get_by_role('button',name='Skip',exact=True).click()
   await panel.get_by_role('status').filter(has_text='Skipped.').wait_for()
   actions=await page.evaluate('''async()=>{
    const response=await fetch('/api/relay/answers',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__foundDevice.token},body:JSON.stringify({v:1,ack:[]})});if(!response.ok)throw Error('poll status '+response.status);const {answers}=await response.json();const decode=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));return Promise.all(answers.map(async a=>{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(a.nonce),additionalData:new TextEncoder().encode('nc-answer-v1|'+a.keyId+'|'+a.ref)},window.__foundKey,decode(a.ciphertext));const x=JSON.parse(new TextDecoder().decode(plain).trim());return {action:x.action,ref:x.ref}}));
   }''')
   assert sorted(x['action'] for x in actions)==['add','skip']
   assert next(x['ref'] for x in actions if x['action']=='add')==VECTOR['found']['document']['found'][0]['ref']
   assert next(x['ref'] for x in actions if x['action']=='skip')==VECTOR['found']['document']['found'][1]['ref']
   await panel.screenshot(path=str(OUT/'2_answered.png'))
   await page.evaluate("async()=>{const d=structuredClone(window.__foundDoc);d.list[0].private=true;d.list[0].title='Something to check';d.schedule=[{start:'09:00',end:'',allDay:false,title:'Something to check',private:true}];d.coming=[{date:'2026-11-27',title:'Something to check',note:'',tone:'',private:true}];await window.__putFound(d);window.dispatchEvent(new Event('focus'))}")
   await page.locator('section[aria-labelledby="mac-your-list"]').get_by_text('Something to check',exact=True).wait_for()
   assert await page.locator('section[aria-labelledby="mac-today"]').get_by_text('Something to check',exact=True).count()==1
   assert await page.locator('section[aria-labelledby="mac-coming"]').get_by_text('Something to check',exact=True).count()==1
   await page.evaluate("async()=>{const d=structuredClone(window.__foundDoc);delete d.found;delete d.foundMore;await window.__putFound(d);window.dispatchEvent(new Event('focus'))}")
   await panel.wait_for(state='detached')
   await page.evaluate("async()=>{const d=structuredClone(window.__foundDoc);d.found=[];d.foundMore=0;await window.__putFound(d);window.dispatchEvent(new Event('focus'))}")
   await panel.get_by_text('Nothing waiting to be checked.',exact=True).wait_for()
   await page.evaluate("async()=>{await window.__putFound(window.__foundDoc);window.dispatchEvent(new Event('focus'))}")
   await panel.get_by_role('button',name='Add',exact=True).first.wait_for()
   print('Private list/calendar titles, absent found and empty found passed')
   await panel.locator('li').filter(has_text='Swimming gala').get_by_role('button',name='Add',exact=True).click()
   await panel.get_by_role('status').filter(has_text='Added.').wait_for()
   await page.reload();await page.evaluate('(d)=>window.__foundDevice=d',device);await panel.get_by_role('status').filter(has_text='Added.').wait_for()
   await page.set_viewport_size({'width':589,'height':675});await panel.screenshot(path=str(OUT/'3_mobile.png'))
   await page.evaluate('''async(kid)=>{const rawKey=await crypto.subtle.importKey('raw',Uint8Array.from(atob('q1RdFcNheKLTjwsck4BrVY/YytRfm1IEhma4N+RW6hs='),x=>x.charCodeAt(0)),'AES-GCM',false,['decrypt']);await new Promise((resolve,reject)=>{const q=indexedDB.open('nc-keys',1);q.onsuccess=()=>{const tx=q.result.transaction('keys','readwrite');tx.objectStore('keys').put(rawKey,kid);tx.oncomplete=()=>{q.result.close();resolve()};tx.onerror=reject}})}''',VECTOR['keyId'])
   await panel.locator('li').filter(has_text='In-service days').get_by_role('button',name='Add',exact=True).click()
   await panel.get_by_role('alert').filter(has_text="scan your Mac's code again").wait_for()
   await panel.screenshot(path=str(OUT/'4_scan.png'))
   print('Signed-in upload, six rows, Add/Skip, persisted encrypted polling, reload, mobile and decrypt-only rescan passed')
  finally:
   await page.evaluate('''async()=>{if(window.__foundDevice)await fetch('/api/relay/revoke',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__foundDevice.token},body:JSON.stringify({v:1})});}''')
  await browser.close()
asyncio.run(main())
