const path=require('node:path');
const fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const queries=['ANNA ASTI','JONY','MACAN','Егор Крид','Тимати','Дима Билан'];
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1040,height:1000},serviceWorkers:'block'});
  try {
    const results=await Promise.allSettled(queries.map(async query=>{
      const page=await context.newPage();
      try {
        await page.goto('http://localhost/search?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded'});
        await page.locator('.artist-card').first().waitFor({timeout:30000});
        if(!(await page.locator('.sidebar').evaluate(e=>e.classList.contains('collapsed'))))await page.locator('.collapse-btn').click();
        await page.waitForTimeout(900);
        await page.screenshot({path:path.join(__dirname,`probe-${queries.indexOf(query)}.png`)});
        const artists=await page.locator('.artist-card').allTextContents();
        await page.locator('.search-filter').filter({hasText:/^Лучшие$/}).click();
        const rows=await page.locator('.tracks-table tbody tr').evaluateAll(rows=>rows.map(e=>({title:e.querySelector('.track-name')?.getAttribute('title'),artist:e.querySelector('.track-artist-cell')?.innerText,cover:e.querySelector('img')?.currentSrc,text:e.innerText})).slice(0,8));
        return {query,artists,rows};
      } finally {await page.close();}
    }));
    fs.writeFileSync(path.join(__dirname,'probe.json'),JSON.stringify(results,null,2)+'\n');
    for(let i=0;i<results.length;i++){const r=results[i];console.log(JSON.stringify({query:queries[i],status:r.status,...(r.status==='fulfilled'?r.value:{error:String(r.reason)})}));}
  } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
