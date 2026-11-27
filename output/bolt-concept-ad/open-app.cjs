const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(path.join(process.env.USERPROFILE,'AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core'));
const authDir=path.join(process.env.USERPROFILE,'.codex/tmp/bolt-real-app-auth');fs.mkdirSync(authDir,{recursive:true});
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(authDir,'profile'),{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:false,viewport:{width:1440,height:1000},args:['--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9745']});
 const page=context.pages()[0]||await context.newPage();await page.goto('http://localhost/login',{waitUntil:'domcontentloaded'});console.log('Bolt login window opened. Waiting for login.');
 for(let i=0;i<900;i++){
  if(await page.evaluate(()=>{try{return Boolean(JSON.parse(localStorage.getItem('auth-storage')||'null')?.token)}catch{return false}})){
   await page.waitForTimeout(1500);await context.storageState({path:path.join(authDir,'storage-state.json')});console.log('Login complete. Session stored locally for recording.');await context.close();return;
  }
  await page.waitForTimeout(1000);
 }
 console.log('Login window timed out.');await context.close();
})().catch(e=>{console.error(e.message);process.exitCode=1});
