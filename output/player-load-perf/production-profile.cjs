const { chromium } = require('C:/Users/maplex/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const presentation = process.argv[2] || 'default';
    await page.route('**/__player-load.html', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>html,body{margin:0}body{--brand-accent:#a259ff;--brand-accent-hover:#b578ff}#stage{position:relative;width:900px;height:600px}canvas{width:100%;height:100%}</style></head><body><div id="root"></div><div id="stage"><canvas id="deck"></canvas></div><script type="module">
      window.longTasks=[];new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
      Object.defineProperty(navigator,'hardwareConcurrency',{value:8});Object.defineProperty(navigator,'deviceMemory',{value:8});
      const {createCdDeckScene}=await import('/assets/cdDeckScene-CWVZc40X.js');
      
      window.start=async()=>{window.startAt=performance.now();window.api=await createCdDeckScene(document.querySelector('#deck'),{softwareRendering:${presentation !== 'setup'},presentation:'${presentation}'});window.initMs=performance.now()-window.startAt;window.api.setState({currentTrack:null,currentIndex:0,currentTime:0,duration:0,volume:1,isPlaying:false,isShuffle:false,isRepeatOne:false});};
    </script></body></html>` }));
    await page.route('**/assets/index-*.js', async route => { const response = await route.fetch(); const body = (await response.text()).replace(/[\w$]+\(document\.getElementById\(\x22root\x22\)\)\.render\([\s\S]*?window\.__boltBooted=!0;/, 'window.__boltBooted=true;'); await route.fulfill({response, body}); });
    await page.goto('http://127.0.0.1:3000/__player-load.html');
    await page.waitForFunction(() => typeof window.start === 'function');
    const session = await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    await page.evaluate(() => window.start());
    await page.waitForTimeout(1800);
    const { profile } = await session.send('Profiler.stop');
    const totals = new Map();
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    profile.samples.forEach((id, i) => { const frame = nodes.get(id).callFrame; const name = frame.functionName || '(anonymous)'; const key = name + ' ' + frame.url.split('/').pop() + ':' + (frame.lineNumber + 1); totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[i] / 1000); });
    console.log(JSON.stringify({presentation,metrics:await page.evaluate(()=>({initMs:window.initMs,longTasks:window.longTasks.filter(t=>t.start>=window.startAt-1),canvas:document.querySelector('canvas').width})),top:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,22),errors},null,2));
    fs.writeFileSync(path.join(__dirname, `${process.env.PERF_LABEL || 'before'}-${presentation}.cpuprofile`), JSON.stringify(profile));
    await page.screenshot({path:path.join(__dirname,`${process.env.PERF_LABEL || 'before'}-${presentation}.png`)});
    await page.evaluate(()=>window.api.dispose());
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
