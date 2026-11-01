import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
OUT=Path('/tmp/browser/mac-answers')
async def main():
 async with async_playwright() as pw:
  browser=await pw.chromium.launch(headless=True)
  ctx=await browser.new_context(viewport={'width':1280,'height':1800})
  page=await ctx.new_page()
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  if os.environ.get('LOVABLE_BROWSER_AUTH_STATUS')=='injected':
   storage_key=os.environ.get('LOVABLE_BROWSER_SUPABASE_STORAGE_KEY');session_json=os.environ.get('LOVABLE_BROWSER_SUPABASE_SESSION_JSON');cookies=json.loads(os.environ.get('LOVABLE_BROWSER_SUPABASE_COOKIES_JSON') or '[]')
  else:
   with open(os.path.expanduser('~/.cache/lovable-auth/session.json')) as f: minted=json.load(f)
   storage_key=minted['storage_key'];session_json=json.dumps(minted['session']);cookies=minted.get('cookies') or []
  if cookies: await ctx.add_cookies([{**c,'url':'http://localhost:8080'} for c in cookies])
  await page.goto('http://localhost:8080')
  await page.evaluate('([k,v])=>localStorage.setItem(k,v)',[storage_key,session_json])
  await page.goto('http://localhost:8080/workspace')
  await page.get_by_role('heading',name='Worth knowing').wait_for()
  await page.evaluate('''async()=>{
   const r=await import('/src/lib/relay.functions.ts');const pairing=await r.createRelayPairingCode();
   const claim=await fetch('/api/relay/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({v:1,code:pairing.code,deviceName:'Encrypted answer browser check'})});
   const result=await claim.json(); window.__relayTest=result; if(!claim.ok)throw Error('claim failed '+claim.status);
  }''')
  print('Paired test Mac')
  await page.evaluate('''async()=>{
   const c=await import('/src/lib/mac-cards.ts'); const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
   const raw=new Uint8Array(await crypto.subtle.exportKey('raw',key));const b64=btoa(String.fromCharCode(...raw)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
   await c.saveKeyFromLink('#k='+b64+'&kid=abc12345');window.__answerKey=key;
   window.__publishCard=async(seq)=>{const nonce=crypto.getRandomValues(new Uint8Array(12));const ref='abcdef012345abcdef012345';const card={id:'browser-answer-check',kind:'reminder',text:'Encrypted answer browser check',why:'Test card from your Mac',sources:['mac'],domain:'personal',origin:'mac',createdAt:'2026-11-01T00:00:00Z',actions:[{kind:'done',label:'Test Done',ref:'done#0'},{kind:'remind',label:'Test Remind',ref:'remind#1'}]};
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode('nc-card-v1|abc12345|'+ref)},key,new TextEncoder().encode(JSON.stringify(card)));
    const response=await fetch('/api/relay/publish',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__relayTest.token},body:JSON.stringify({v:1,seq,generatedAt:new Date().toISOString(),keyId:'abc12345',cards:[{ref,nonce:btoa(String.fromCharCode(...nonce)),ciphertext:btoa(String.fromCharCode(...new Uint8Array(encrypted))),order:0,expiresAt:new Date(Date.now()+86400000).toISOString()}]})});if(!response.ok)throw Error('publish failed '+response.status);
   };await window.__publishCard(1);
  }''')
  await page.evaluate("window.dispatchEvent(new Event('focus'))")
  await page.get_by_role('button',name='Test Done',exact=True).wait_for()
  await page.get_by_role('button',name='Test Remind',exact=True).wait_for()
  await page.screenshot(path=str(OUT/'1_actions.png'))
  await page.get_by_role('button',name='Test Done',exact=True).click()
  await page.get_by_role('status').filter(has_text='Sent to your Mac').wait_for()
  assert await page.get_by_role('button',name='Test Done',exact=True).count()==0
  await page.screenshot(path=str(OUT/'2_sent.png'))
  action=await page.evaluate('''async()=>{const response=await fetch('/api/relay/answers',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__relayTest.token},body:JSON.stringify({v:1,ack:[]})});const data=await response.json();if(!response.ok||data.answers.length!==1)throw Error('poll failed');const a=data.answers[0];const decode=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(a.nonce),additionalData:new TextEncoder().encode('nc-answer-v1|'+a.keyId+'|'+a.ref)},window.__answerKey,decode(a.ciphertext));window.__ack=a.id;return JSON.parse(new TextDecoder().decode(plain).trim()).action;}''')
  assert action=='done#0'; print('Done stored, polled and decrypted by originating Mac key')
  await page.evaluate('window.__publishCard(2)')
  await page.evaluate("window.dispatchEvent(new Event('focus'))")
  await page.get_by_role('button',name='Test Done',exact=True).wait_for()
  await page.screenshot(path=str(OUT/'3_republished.png'))
  print('Republished card with new nonce visible')
  await page.evaluate('''async()=>{const raw=await crypto.subtle.exportKey('raw',window.__answerKey);const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);await new Promise((resolve,reject)=>{const q=indexedDB.open('nc-keys',1);q.onsuccess=()=>{const db=q.result;const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put(key,'abc12345');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject;};});}''')
  await page.get_by_role('button',name='Test Done',exact=True).click()
  await page.get_by_role('alert').filter(has_text='scan your Mac').wait_for()
  await page.screenshot(path=str(OUT/'4_scan.png'))
  print('Decrypt-only key requires rescan; card remains visible')
  await page.evaluate('''async()=>{await fetch('/api/relay/revoke',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.__relayTest.token},body:JSON.stringify({v:1})});}''')
  print('Test Mac revoked; page errors:',len(errors))
  await browser.close()
asyncio.run(main())
