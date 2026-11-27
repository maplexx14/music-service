const { chromium } = require('C:/Users/maplex/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => {errors.push(error.message);console.error(error.message)});
    await page.route('**/__unbox-load.html', route => route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      window.phases=[];window.tasks=[];window.gaps=[];
      new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask'});
      let last=performance.now();function tick(now){if(now-last>50)gaps.push({start:last,duration:now-last});last=now;requestAnimationFrame(tick)}requestAnimationFrame(tick);
      const {default:React}=await import('/node_modules/.vite/deps/react.js');
      const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
      const {default:PlayerSetupScreen}=await import('/src/components/PlayerSetupScreen.jsx');
      function App(){const [stage,setStage]=React.useState('boxed');return React.createElement(PlayerSetupScreen,{stage,onStageChange:setStage,onFinish(){}})}
      createRoot(document.getElementById('root')).render(React.createElement(App));
      new MutationObserver(()=>{const node=document.querySelector('.unboxing-scene');const phase=node?.dataset.phase;if(phase&&phases.at(-1)?.phase!==phase)phases.push({phase,at:performance.now()})}).observe(document.getElementById('root'),{attributes:true,childList:true,subtree:true});
    </script></body></html>`}));
    await page.goto('http://127.0.0.1:3001/__unbox-load.html');
    await page.locator('.unboxing-pull-tab:not(:disabled)').waitFor();
    if (process.env.UNBOX_STYLE) await page.addStyleTag({content:process.env.UNBOX_STYLE});
    if (process.argv[2] === 'warm') await page.waitForFunction(()=>!document.querySelector('.cd-deck-loading'));
    const session = await page.context().newCDPSession(page);
    await session.send('Profiler.enable'); await session.send('Profiler.start');
    const tab = await page.locator('.unboxing-pull-tab').boundingBox();
    const scene = await page.locator('.unboxing-scene').boundingBox();
    await page.mouse.move(tab.x+tab.width/2,tab.y+tab.height/2);await page.mouse.down();
    await page.mouse.move(tab.x+tab.width/2,scene.y-50,{steps:5});
    await page.evaluate(()=>window.releaseAt=performance.now());await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('.unboxing-scene')?.dataset.phase==='ready',{},{timeout:20000});
    const {profile}=await session.send('Profiler.stop');
    const totals=new Map(),nodes=new Map(profile.nodes.map(n=>[n.id,n]));
    profile.samples.forEach((id,i)=>{const f=nodes.get(id).callFrame;const k=(f.functionName||'(anonymous)')+' '+f.url.split('/').pop()+':'+(f.lineNumber+1);totals.set(k,(totals.get(k)||0)+profile.timeDeltas[i]/1000)});
    console.log(JSON.stringify({metrics:await page.evaluate(()=>({releaseAt,phases,tasks:tasks.filter(t=>t.start>=releaseAt-1),gaps:gaps.filter(t=>t.start>=releaseAt-1)})),top:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,15),errors},null,2));
    fs.writeFileSync(`${__dirname}/${process.env.PERF_LABEL||'unbox'}-${process.argv[2]||'cold'}.cpuprofile`,JSON.stringify(profile));
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
