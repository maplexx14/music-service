// Run with a Vite dev server: node scripts/bake-cd-software-frames.mjs [origin]
// CD_BROWSER_BINARY can point to another Chromium/Edge binary.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const origin = process.argv[2] || 'http://127.0.0.1:3001'
const output = fileURLToPath(new URL('../public/cd-player-frames/', import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const manifest = {}
await mkdir(output, { recursive: true })

for (const mobile of [false, true]) for (const shadows of [true, false]) {
  const port = 9380 + Number(mobile) * 2 + Number(!shadows)
  const name = `${mobile ? 'mobile' : 'desktop'}-${shadows ? 'shadows' : 'plain'}`
  const binary = process.env.CD_BROWSER_BINARY || (process.platform === 'win32'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : 'chromium')
  const browser = spawn(binary, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(tmpdir(), `cd-frame-bake-${name}-${Date.now()}`)}`,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  let socket
  const errors = []
  try {
    let page
    for (let attempt = 0; attempt < 100; attempt++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page') } catch { /* Wait for the browser's debugging endpoint. */ }
      if (page) break
      await wait(100)
    }
    assert.ok(page, 'Chromium starts')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
    let sequence = 0
    const pending = new Map()
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    socket.addEventListener('message', async event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request, responseStatusCode, responseHeaders } = message.params
        try {
          let source, headers
          if (request.url.endsWith('/__cd-frame-bake.html')) {
            source = `<!doctype html><html><head><style>html,body{margin:0}body{--brand-accent:#a259ff;--brand-accent-hover:#b578ff}#stage{position:relative;width:900px;height:600px}canvas{width:100%;height:100%}</style></head><body><div id="stage"><canvas id="deck"></canvas></div><script type="module">
              Object.defineProperty(navigator,'hardwareConcurrency',{value:${shadows ? 8 : 4}});
              Object.defineProperty(navigator,'deviceMemory',{value:8});
              const {createCdDeckScene}=await import('/src/utils/cdDeckScene.js');
              const {DEFAULT_CD_APPEARANCE}=await import('/src/utils/cdPlayerAppearance.js');
              window.api=await createCdDeckScene(document.querySelector('#deck'),{softwareRendering:true,presentation:'${mobile ? 'mobile' : 'default'}'});
              window.api.setAppearance(DEFAULT_CD_APPEARANCE);
              window.api.setState({currentTrack:null,currentIndex:0,currentTime:0,duration:0,volume:1,isPlaying:false,isShuffle:false,isRepeatOne:false});
            </script></body></html>`
            headers = [{ name: 'Content-Type', value: 'text/html' }]
          } else {
            const body = await send('Fetch.getResponseBody', { requestId })
            source = body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body
            headers = responseHeaders.filter(header => !['content-length', 'content-encoding'].includes(header.name.toLowerCase()))
            if (request.url.includes('cdDeckScene.js')) source = source.replace(/return \{\s*setState,/, 'window.__poseFrames=softwareFrames;return { setState,')
            if (request.url.includes('cdSoftwareFrames.js')) source = source.replace('status() {', 'status() {window.poseCache=cache;window.poseKey=key;')
            // The build tool must render source poses even when older shipped
            // or persistent poses exist. It never changes application source.
            if (request.url.includes('cdSoftwareFrameStore.js')) source = source.replace('async get(key) {', 'async get(key) {return null;')
          }
          await send('Fetch.fulfillRequest', { requestId, responseCode: responseStatusCode || 200, responseHeaders: headers, body: Buffer.from(source).toString('base64') })
        } catch (error) { errors.push(String(error)) }
      }
      const task = pending.get(message.id)
      if (task) {
        pending.delete(message.id)
        if (message.error) task.reject(new Error(JSON.stringify(message.error)))
        else task.resolve(message.result)
      }
    })
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
    await send('Fetch.enable', { patterns: [
      { urlPattern: '*__cd-frame-bake.html', requestStage: 'Request' },
      ...['*cdDeckScene.js*', '*cdSoftwareFrames.js*', '*cdSoftwareFrameStore.js*'].map(urlPattern => ({ urlPattern, requestStage: 'Response' })),
    ] })
    await send('Page.navigate', { url: `${origin}/__cd-frame-bake.html` })
    let ready = false
    for (let attempt = 0; attempt < 900; attempt++) {
      ready = await evaluate('Boolean(window.__poseFrames?.status().ready)')
      if (ready || errors.length) break
      await wait(100)
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    assert.ok(ready, 'Original poses are complete')
    const result = await evaluate(`(()=>{
      const c=window.poseCache,columns=6,atlas=document.createElement('canvas');
      atlas.width=c.size.width*columns;atlas.height=c.size.height*Math.ceil(c.frames.length/columns);
      const ctx=atlas.getContext('2d'),rectangles=[];
      c.frames.forEach((frame,index)=>{const rect={x:index%columns*c.size.width,y:Math.floor(index/columns)*c.size.height,...c.size};ctx.drawImage(frame.bitmap,rect.x,rect.y);rectangles.push(rect)});
      const r=c.region,w=c.width,h=c.height;
      return {key:window.poseKey,size:c.size,region:{x:(r.x-w/2)/h,y:(r.y-h/2)/h,width:r.width/h,height:r.height/h},rectangles,png:atlas.toDataURL('image/png').split(',')[1]};
    })()`)
    const { key, png, ...geometry } = result
    const pixels = await sharp(Buffer.from(png, 'base64')).webp({ lossless: true, effort: 6 }).toBuffer()
    const hash = createHash('sha256').update(pixels).digest('hex').slice(0, 12)
    const filename = `${name}-${hash}.webp`
    await writeFile(path.join(output, filename), pixels)
    manifest[key] = { ...geometry, atlas: filename }
    console.log(`${name}: ${result.rectangles.length} original poses`)
    await evaluate('window.api.dispose()')
  } finally {
    socket?.close()
    browser.kill()
    await wait(200)
  }
}
// Preserve extra camera presets if the caller has added them.
let previous = {}
try { previous = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')) } catch { /* First generation has no manifest. */ }
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({ ...previous, ...manifest }, null, 2)}\n`)
