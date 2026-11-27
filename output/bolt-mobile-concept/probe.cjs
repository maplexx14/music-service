const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const queries=['cupsize','madk1d','fortuna812'];
const phone={viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,serviceWorkers:'block',userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'};
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext(phone);
  try {
    const results=await Promise.allSettled(queries.map(async(query,index)=>{
      const page=await context.newPage();
      try {
        await page.goto('http://localhost/search?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded'});
        await page.locator('.search-filter').first().waitFor({timeout:30000});
        await page.waitForFunction(()=>{
          const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
          return !Array.from(document.querySelectorAll('.spinner-wrap')).some(visible)&&Array.from(document.querySelectorAll('.artist-card,.track-item')).some(visible);
        },{},{timeout:45000});
        await page.locator('.search-input').evaluate(e=>e.blur());await page.waitForTimeout(400);
        const artists=await page.locator('.artist-card img').evaluateAll(images=>images.map(e=>({name:e.alt,url:e.currentSrc||e.src})));
        await page.screenshot({path:path.join(__dirname,`probe-${index}-search.png`)});
        await page.locator('.search-filter').filter({hasText:/^Лучшие$/}).tap();
        await page.waitForTimeout(400);
        const rows=await page.locator('.search-mobile-tracks:visible .track-item').evaluateAll(rows=>rows.map(e=>({title:Array.from(e.querySelector('.track-item-title')?.childNodes||[]).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim(),artist:e.querySelector('.track-item-artist')?.innerText,cover:e.querySelector('img')?.currentSrc||e.querySelector('img')?.src,duration:e.querySelector('.track-item-duration')?.innerText})).slice(0,12));
        await page.screenshot({path:path.join(__dirname,`probe-${index}-best.png`)});
        return {query,artists,rows,mobile:await page.evaluate(()=>({width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer: coarse)').matches,navVisible:document.querySelector('.mobile-nav-global')?.getBoundingClientRect().height>0}))};
      } finally {await page.close();}
    }));
    fs.writeFileSync(path.join(__dirname,'probe.json'),JSON.stringify(results,null,2)+'\n');
    for(let i=0;i<results.length;i++){const r=results[i];console.log(JSON.stringify({query:queries[i],status:r.status,...(r.status==='fulfilled'?r.value:{error:String(r.reason)})}));}
  } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
