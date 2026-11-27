const fs=require('node:fs'),path=require('node:path');
const profile=process.env.USERPROFILE;
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(profile,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const dir=path.join(__dirname,'assets/player-frames');fs.mkdirSync(dir,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  await page.route('**/utils/gpu.js*',async route=>{const response=await route.fetch();const source=(await response.text()).replace(/(export function isSoftwareRendering\(\) \{)/,'$1 return false;');await route.fulfill({response,body:source})});
  await page.clock.install();
  await page.goto('http://127.0.0.1:3001/__cd-preview.html');
  await page.waitForSelector('.cd-deck-canvas.is-ready',{timeout:60000});
  await page.addStyleTag({content:`body,#root,#root>div{background:#351467!important}h1,.cd-player-customizer,.cd-deck-queue-track,.cd-appearance-controls,.cd-deck-customizer{display:none!important}.hero-section{background:#351467!important;border:0!important;box-shadow:none!important}.desktop-cd-player{inset:35px 0 20px!important}`});
  await page.evaluate(()=>Promise.all([document.fonts.ready,...[...document.images].map(i=>i.decode().catch(()=>{}))]));
  await page.waitForTimeout(1000);
  console.log(await page.evaluate(()=>({store:!!window.__store,canvases:[...document.querySelectorAll('canvas')].map(e=>({class:e.className,width:e.width,height:e.height}))})));
  await page.screenshot({path:path.join(__dirname,'player-source.png')});
  if(process.argv.includes('--inspect'))return;
  await page.evaluate(()=>window.__store.setState({isPlaying:true}));
  const frozenAt=await page.evaluate(()=>Date.now()+700);await page.clock.pauseAt(frozenAt);
  for(let i=0;i<168;i++){
   await page.evaluate(i=>{
    const t=i/60;
    if(i===64){window.__store.getState().nextTrack();}
    const state=window.__store.getState();window.__store.setState({currentTime:(i<64?37:0)+t});
   },i);
   await page.clock.runFor(1000/60);
   await page.screenshot({path:path.join(dir,`${String(i).padStart(4,'0')}.png`),clip:{x:270,y:55,width:900,height:900}});
   if(i%30===0)console.log(`Captured ${i}/168`);
  }
  console.log('Player demonstration captured: 168 frames at 60 fps.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
