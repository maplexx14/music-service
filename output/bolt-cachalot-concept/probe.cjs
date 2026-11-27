const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const origin=process.env.BOLT_URL||'http://localhost';
const queries=['cachalot onda andar','onda andar','cachalot'];
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,serviceWorkers:'block',userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'});
  try {
    const results=await Promise.allSettled(queries.map(async(query,index)=>{
      const page=await context.newPage();
      try {
        await page.goto(origin+'/search?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded'});
        await page.locator('.search-input').waitFor({timeout:30000});
        await page.waitForFunction(()=>{
          const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
          return !Array.from(document.querySelectorAll('.spinner-wrap')).some(visible)&&Array.from(document.querySelectorAll('.artist-card,.track-item,.search-empty,.empty-state')).some(visible);
        },{},{timeout:45000}).catch(()=>{});
        await page.locator('.search-input').evaluate(e=>e.blur());
        if(await page.getByRole('button',{name:'Закрыть подсказку',exact:true}).isVisible())await page.getByRole('button',{name:'Закрыть подсказку',exact:true}).tap();
        const filters=await page.locator('.search-filter').allTextContents();
        if(filters.some(t=>t==='Лучшие'))await page.locator('.search-filter').filter({hasText:/^Лучшие$/}).tap();
        await page.waitForTimeout(500);
        const result=await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(0,5000),authenticated:!!JSON.parse(localStorage.getItem('auth-storage')||'null')?.token,rows:Array.from(document.querySelectorAll('.search-mobile-tracks .track-item')).filter(e=>e.getBoundingClientRect().width>0).map(e=>({title:Array.from(e.querySelector('.track-item-title')?.childNodes||[]).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim(),artist:e.querySelector('.track-item-artist')?.innerText,cover:e.querySelector('img')?.currentSrc||e.querySelector('img')?.src,duration:e.querySelector('.track-item-duration')?.innerText})),buttons:Array.from(document.querySelectorAll('button')).filter(e=>e.getBoundingClientRect().width>0).slice(-15).map(e=>({label:e.getAttribute('aria-label'),text:e.innerText,className:e.className}))}));
        await page.screenshot({path:path.join(__dirname,`probe-${index}.png`)});return {query,...result};
      } finally {await page.close();}
    }));
    fs.writeFileSync(path.join(__dirname,'probe.json'),JSON.stringify(results,null,2)+'\n');
    results.forEach((r,i)=>console.log(JSON.stringify({query:queries[i],...(r.status==='fulfilled'?r.value:{error:String(r.reason)})})));
  } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
