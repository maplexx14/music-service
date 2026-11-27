// Screenshots of the actual application. Fixtures are limited to this browser context.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/maplex/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright');
const root = path.resolve(__dirname, '../..');
const user = { id: 999999, username: 'alex', full_name: 'Алекс', email: 'alex@example.com', onboarding_completed: true, player_setup_completed: true, created_at: '2026-11-24T00:00:00Z', favorite_genres: ['indie', 'electronic'], favorite_artists: ['CUPSIZE'] };
const names = ['Юра Юра', 'Новый день', 'Всё будет', 'Тихий город', 'На повторе', 'В моменте'];
const tracks = names.map((title,i)=>({ id:i+1, title, artist:['CUPSIZE','madk1d','FORTUNA 812'][i%3], cover_url:`/studio-art/${i%3+1}.jpg`, duration:180+i*13, source:'local', is_liked:i%2===0 }));
const playlists = ['Поздний вечер','Любимое инди','В своём ритме','Дорога домой','Никаких планов','Громче обычного'].map((name,i)=>({id:i+10,name,cover_url:`/studio-art/${i%3+1}.jpg`,description:['Когда город засыпает','Только то, что нравится','Музыка для твоего дня'][i%3],track_count:24+i*7,tracks,is_public:false,owner_id:user.id}));
async function fixtures(context) {
  await context.addInitScript(({user})=>{
    localStorage.setItem('auth-storage',JSON.stringify({token:'design-preview',user}));
    localStorage.setItem('sidebar-collapsed','true');
  },{user});
  await context.route('**/studio-art/*', async route=>{
    const num=new URL(route.request().url()).pathname.match(/(\d)\.jpg/)[1];
    await route.fulfill({contentType:'image/jpeg',body:fs.readFileSync(path.join(root,`output/bolt-mobile-concept/assets/artist-${num}.jpg`))});
  });
  await context.route('**/api/**', async route=>{
    const p=new URL(route.request().url()).pathname.replace(/^\/api/,'');
    let data=[];
    if(p==='/auth/me') data=user;
    else if(p.startsWith('/recommendations')) data={tracks,playlists:[]};
    else if(p==='/playlists/me/liked') data={id:40,name:'Понравившиеся',description:'Треки, которые остаются с тобой',tracks,track_count:tracks.length};
    else if(p==='/playlists/me') data=playlists;
    else if(p.startsWith('/playlists/')) data=playlists[0];
    else if(p==='/home/releases') data=[];
    else if(p.startsWith('/home/')) data=[];
    else if(p==='/artists/search') data=tracks.slice(0,3).map(t=>({name:t.artist,image_url:t.cover_url,cover_url:t.cover_url}));
    else if(p==='/search/external/grouped') data={youtube:[],soundcloud:[],deezer:[],tracks:[]};
    else if(p==='/search/') data={tracks,playlists:[]};
    else if(p.includes('likes')) data=[];
    else if(p.includes('/imports')) data=[];
    await route.fulfill({json:data});
  });
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const errors=[]; const checks=[];
  try {
    for(const mode of ['desktop','mobile']) {
      const context=await browser.newContext({viewport:mode==='desktop'?{width:1440,height:1080}:{width:390,height:844},deviceScaleFactor:1,isMobile:mode==='mobile',hasTouch:mode==='mobile',serviceWorkers:'block'});
      await fixtures(context);
      const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
      for(const [name,url] of [['home','/'],['search','/search?q=cupsize'],['library','/playlists'],['liked','/liked'],['settings','/settings']]) {
        await page.goto('http://127.0.0.1:3012'+url,{waitUntil:'networkidle'});
        if(name==='home') {
          await page.locator('.cd-deck-canvas.is-ready').last().waitFor({state:'attached',timeout:20000});
          await page.screenshot({path:path.join(__dirname,`${mode}-home-empty.png`)});
          await page.evaluate(async ({tracks})=>{
            const {usePlayerStore}=await import('/src/store/playerStore.js');
            usePlayerStore.setState({currentTrack:tracks[0],queue:tracks,queueIndex:0,isPlaying:false,source:'wave',duration:tracks[0].duration});
          },{tracks});
          await page.waitForTimeout(900);
          await page.getByRole('button',{name:'Открыть плеер',exact:true}).click();
          await page.locator('.fullscreen-player').waitFor();
          await page.getByRole('button',{name:'Закрыть',exact:true}).click();
          await page.locator('.fullscreen-player').waitFor({state:'detached'});
        }
        await page.evaluate(()=>document.fonts.ready);
        await page.waitForTimeout(400);
        await page.locator('input:focus').evaluateAll(es=>es.forEach(e=>e.blur()));
        await page.screenshot({path:path.join(__dirname,`${mode}-${name}.png`)});
        checks.push({mode,name,title:await page.title(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),deckReady:await page.locator('.cd-deck-canvas.is-ready').count()});
        if(mode==='mobile' && name==='home') {
          await page.locator('.screen[data-active] .screen-scroll').evaluate(el=>el.scrollTop=600);
          await page.waitForTimeout(150);
          await page.screenshot({path:path.join(__dirname,'mobile-home-more.png')});
        }
      }
      await page.goto('http://127.0.0.1:3012/search?q=cupsize',{waitUntil:'networkidle'});
      await page.evaluate(async track=>{
        const {usePlayerStore}=await import('/src/store/playerStore.js');
        usePlayerStore.setState({currentTrack:track,queue:[track],isPlaying:false,isFullScreen:true,duration:track.duration,currentTime:45});
      },tracks[0]);
      await page.locator('.fullscreen-player').waitFor();
      await page.waitForTimeout(600);
      await page.screenshot({path:path.join(__dirname,`${mode}-player.png`)});
      await page.getByRole('button',{name:'Закрыть',exact:true}).click();
      await page.locator('.fullscreen-player').waitFor({state:'detached'});
      await page.screenshot({path:path.join(__dirname,`${mode}-mini-player.png`)});
      checks.push({mode,name:'player',closed:true});
      await context.close();
      const guest=await browser.newContext({viewport:mode==='desktop'?{width:1440,height:1080}:{width:390,height:844},serviceWorkers:'block'});
      const login=await guest.newPage();await login.goto('http://127.0.0.1:3012/login',{waitUntil:'networkidle'});
      await login.screenshot({path:path.join(__dirname,`${mode}-login.png`)});await guest.close();
    }
    fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify({errors,checks},null,2));
    console.log(JSON.stringify({errors,checks},null,2));
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
