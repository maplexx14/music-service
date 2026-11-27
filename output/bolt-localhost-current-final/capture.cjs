const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {chromium}=require('C:/Users/maplex/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright');
const origin='http://localhost',username='bolt_reference_preview_'+Date.now();
function python(source){const r=spawnSync('docker',['exec','-i','music_backend','python','-'],{input:source,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(r.stderr);return r.stdout;}
async function save(page,name){await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(2200);await page.waitForFunction(()=>Array.from(document.images).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0}).every(e=>e.complete),{},{timeout:12000}).catch(()=>{});const buffer=await page.screenshot();fs.writeFileSync(path.join(__dirname,name+'.png'),buffer);}
(async()=>{
 let browser; const errors=[],checks=[];
 try {
  const session=JSON.parse(python(`
import json,secrets
from datetime import timedelta
from app.database import SessionLocal
from app.models import User
from app.auth import get_password_hash,create_access_token
from app.schemas import UserResponse
with SessionLocal() as db:
 user=User(username=${JSON.stringify(username)},email=${JSON.stringify(username+'@example.com')},hashed_password=get_password_hash(secrets.token_urlsafe(24)),email_verified=True,onboarding_completed=True,player_setup_completed=True,preferred_artists=['CUPSIZE'],push_releases=False,push_reminders=False)
 db.add(user);db.commit();db.refresh(user)
 print(json.dumps({'token':create_access_token({'sub':user.username},expires_delta=timedelta(minutes=30)),'user':UserResponse.model_validate(user).model_dump(mode='json')}))
`));
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  for(const mode of ['mobile','desktop']) {
   const context=await browser.newContext({viewport:mode==='mobile'?{width:390,height:844}:{width:1440,height:1080},isMobile:mode==='mobile',hasTouch:mode==='mobile',serviceWorkers:'block'});
   await context.addInitScript(({token,user})=>{localStorage.setItem('auth-storage',JSON.stringify({token,user}));localStorage.setItem('cd-player-unboxed:'+user.id,'1');localStorage.setItem('sidebar-collapsed','true')},session);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/search?q=cupsize',{waitUntil:'domcontentloaded'});
   await page.locator('.track-item:visible,.search-track-row:visible,.track-row:visible').first().waitFor({timeout:60000});
   await page.locator('.search-input').evaluate(e=>e.blur());
   await save(page,mode+'-search');
   const song=page.locator('.search-mobile-tracks:visible .track-item').first();
   if(mode==='mobile') await song.click();
   else {
    const row=page.locator('.track-row:visible,.search-track-row:visible').first();
    if(await row.count()) await row.click();
    else await page.locator('.track-item:visible').first().click();
   }
   await page.locator('.player-cover-wrap').waitFor({timeout:45000});
   await page.waitForTimeout(1300);
   await page.locator(mode==='mobile'?'.mobile-nav-global-item[aria-label="Главная"]':'.sidebar-nav a[href="/"]').click();
   await page.locator('.home-page').waitFor();
   const play=page.locator('.play-pause-btn[aria-label="Играть"]');if(await play.count())await play.click();
   await page.locator('.hero-section.has-cd').waitFor({timeout:15000});
   const pause=page.locator('.play-pause-btn[aria-label="Пауза"]');if(await pause.count())await pause.click();
   await page.waitForTimeout(2200);
   await save(page,mode+'-home');
   checks.push({mode,url:page.url(),title:await page.title(),newDashboard:await page.locator('.transit-journey').count()});
   await page.locator('.player-cover-wrap').click();await page.locator('.fullscreen-player').waitFor();
   await save(page,mode+'-player');
   await page.getByRole('button',{name:'Закрыть',exact:true}).click();await page.locator('.fullscreen-player').waitFor({state:'detached'});
   await page.locator(mode==='mobile'?'.mobile-nav-global-item[aria-label="Медиатека"]':'.sidebar-nav a[href="/playlists"]').click();
   await page.waitForTimeout(1200);await save(page,mode+'-library');
   await page.goto(origin+'/settings',{waitUntil:'domcontentloaded'});await page.waitForTimeout(700);await save(page,mode+'-settings');
   await context.close();
  }
  fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify({origin,errors,checks},null,2));
  console.log(JSON.stringify({origin,errors,checks}));
 } finally {
  if(browser)await browser.close();
  python(`from app.database import SessionLocal\nfrom app.models import User\nwith SessionLocal() as db:\n user=db.query(User).filter(User.username==${JSON.stringify(username)}).one_or_none()\n if user is not None:\n  db.delete(user);db.commit()\n`);
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
