const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:540,height:960},deviceScaleFactor:2,isMobile:true,hasTouch:true});
    page.on('response',r=>{if(r.url().includes('/api/'))console.log('API',r.status(),r.url().split('?')[0]);});
    page.on('requestfailed',r=>console.log('FAILED',r.url().split('?')[0],r.failure()?.errorText));
    await page.route('**/api/tracks/undefined',async route=>{
      const response=await route.fetch({url:'https://boltmusic.lat/api/tracks/6b3546a3-8ab0-47a6-8c5e-51735d6c79c1'});
      await route.fulfill({response});
    });
    await page.goto('https://boltmusic.lat/track/6b3546a3-8ab0-47a6-8c5e-51735d6c79c1',{waitUntil:'domcontentloaded',timeout:30000});
    await page.getByRole('heading',{name:/Азия.*Евразия/i}).waitFor({timeout:12000}).catch(()=>{});
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));});
    await page.screenshot({path:path.join(__dirname,'service-inspection.png')});
    console.log(JSON.stringify({url:page.url(),config:await page.evaluate(()=>window.__APP_CONFIG__?.VITE_API_URL),body:await page.locator('body').innerText(),audio:await page.locator('audio').evaluateAll(es=>es.map(a=>({src:a.currentSrc,readyState:a.readyState,error:a.error?.message})))},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
