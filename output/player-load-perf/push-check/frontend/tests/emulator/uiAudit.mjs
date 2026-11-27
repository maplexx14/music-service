// Run the current production build in a real debug APK WebView. CDP serves
// local frontend assets; the API, captcha and audio still use the live server.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const reports = path.join(workspace, 'android/app/build/reports/ui-audit')
const dist = path.join(workspace, 'frontend/dist')
const serial = process.env.ANDROID_SERIAL || 'emulator-5554'
const adbPath = path.join(process.env.ANDROID_HOME || path.join(process.env.USERPROFILE, 'android-dev/sdk'), 'platform-tools/adb.exe')
const origin = 'https://boltmusic.lat'
const port = 9234
if (!/^emulator-\d+$/.test(serial)) throw new Error('Only disposable Android emulators are supported')
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await mkdir(reports, { recursive: true })

const [command = 'status', ...args] = process.argv.slice(2)
if (command !== 'serve') {
  const body = { command: command === 'summary' ? 'inspect' : command, args }
  if (command === 'eval') body.expression = args[0] === '--file' ? await readFile(args[1], 'utf8') : args.join(' ')
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  const output = command === 'summary' && response.ok ? {
    url: result.url, viewport: result.viewport, body: result.body.slice(0, 1600),
    buttons: result.buttons.map(el => el.text || el.label || el.name).slice(0, 24),
    discs: result.discs, brokenImages: result.images.filter(el => el.complete && !el.width).length,
    overflow: result.overflow.filter(el => el.scroll > el.client + 1),
  } : result
  console.log(JSON.stringify(output, null, 2))
  if (!response.ok) process.exitCode = 1
} else {
  const pid = adb('shell', 'pidof', '-s', 'lat.boltmusic.app')
  if (!pid) throw new Error('Open the debug APK first')
  adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`)
  const pages = await (await fetch('http://127.0.0.1:9223/json')).json()
  const page = pages.find((item) => item.type === 'page' && item.url.startsWith(origin))
  if (!page) throw new Error('App WebView was not found')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const pending = new Map(), errors = [], requests = []
  let tests = []
  try { tests = JSON.parse(await readFile(path.join(reports, 'tests.json'), 'utf8')) } catch { /* First run. */ }
  const rules = []
  let nextId = 0
  const send = (method, params = {}) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 40_000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value) },
        reject: (error) => { clearTimeout(timeout); reject(error) },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const safeUrl = (url) => {
    const parsed = new URL(url)
    for (const key of ['token', 'claim_token', 'access_token', 'code']) if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[redacted]')
    return parsed.href
  }
  const fulfill = async (event, status, body, type) => {
    await send('Fetch.fulfillRequest', {
      requestId: event.requestId, responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }],
      body: Buffer.from(body).toString('base64'),
    })
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
  const intercept = async (event) => {
    const url = new URL(event.request.url)
    const rule = rules.find((item) => (item.exact ? url.pathname === item.match : url.href.includes(item.match)) && item.remaining !== 0)
    if (rule) {
      if (rule.remaining > 0) rule.remaining--
      if (rule.delay) await sleep(rule.delay)
      if (rule.abort) return send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' })
      if (rule.status) return fulfill(event, rule.status, JSON.stringify(rule.body || { detail: 'Emulator test: temporary request failure' }), 'application/json')
    }
    if (url.origin === origin && !url.pathname.startsWith('/api/')) {
      if (url.pathname === '/sw.js') return send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' })
      if (url.pathname === '/config.js') return fulfill(event, 200, `window.__APP_CONFIG__={VITE_API_URL:${JSON.stringify(origin + '/api')}}`, types['.js'])
      const filename = event.resourceType === 'Document' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const absolute = path.resolve(dist, filename)
      if (absolute.startsWith(dist + path.sep)) {
        try { return await fulfill(event, 200, await readFile(absolute), types[path.extname(absolute)] || 'application/octet-stream') } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
    return send('Fetch.continueRequest', { requestId: event.requestId })
  }
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id)
      if (!callback) return
      pending.delete(message.id)
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
      else callback.resolve(message.result)
    } else if (message.method === 'Fetch.requestPaused') {
      intercept(message.params).catch((error) => { errors.push({ type: 'interception', message: error.message }); console.error(error.message) })
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push({ type: 'exception', at: Date.now(), details: message.params.exceptionDetails })
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const { text, source, url } = message.params.entry
      errors.push({ type: source, at: Date.now(), text, url: url ? safeUrl(url) : undefined })
    } else if (message.method === 'Network.responseReceived') {
      const { url, status, mimeType } = message.params.response
      requests.push({ at: Date.now(), url: safeUrl(url), status, mimeType })
    } else if (message.method === 'Network.loadingFailed') {
      errors.push({ type: 'network', at: Date.now(), error: message.params.errorText, blockedReason: message.params.blockedReason })
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: origin + '/*', requestStage: 'Request' }] })

  const inspect = `(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width && r.height && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && r.bottom > 0 && r.top < innerHeight && !el.closest('.screen:not([data-active])'); };
    return {
      url: location.origin + location.pathname, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visual: { width: visualViewport.width, height: visualViewport.height, top: visualViewport.offsetTop } },
      title: document.title, body: document.body.innerText.slice(0, 7000),
      buttons: [...document.querySelectorAll('button,a,input,select,textarea')].filter(visible).map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 90), label: el.getAttribute('aria-label'), title: el.title, name: el.name, type: el.type, disabled: el.disabled, href: el.getAttribute('href'), rect: rect(el) })),
      images: [...document.images].filter(visible).map(el => ({ src: el.currentSrc.slice(0, 250), complete: el.complete, width: el.naturalWidth, rect: rect(el) })),
      discs: [...document.querySelectorAll('.hero-disc')].filter(el => !el.closest('.screen:not([data-active])')).map(el => ({ rect: rect(el), visibility: getComputedStyle(el).visibility, cover: el.hasAttribute('data-cover-ready'), background: getComputedStyle(el).backgroundColor })),
      overflow: [...document.querySelectorAll('main,.screen[data-active],.auth-card,.full-player')].map(el => ({ cls: el.className, client: el.clientWidth, scroll: el.scrollWidth, rect: rect(el) })),
    };
  })()`
  const tap = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',behavior:'instant'})`)
    await sleep(200)
    const position = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found');
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!r.width || !r.height || style.visibility === 'hidden' || style.pointerEvents === 'none') throw new Error('Element is not tappable');
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const target = document.elementFromPoint(x, y);
      if (!target || !el.contains(target)) throw new Error('Element is outside the viewport or covered by another element');
      return {x:Math.round(x*devicePixelRatio),y:Math.round(y*devicePixelRatio)};
    })()`)
    adb('shell', 'input', 'tap', String(position.x), String(position.y))
    await sleep(200)
    return position
  }
  const execute = async (body) => {
    const [first, second] = body.args || []
    if (body.command === 'eval') return evaluate(body.expression)
    if (body.command === 'cdp') return send(first, JSON.parse(second || '{}'))
    if (body.command === 'reset-trace') { errors.length = 0; requests.length = 0; return { reset: true } }
    if (body.command === 'inspect') return evaluate(inspect)
    if (body.command === 'summary') {
      const snapshot = await evaluate(inspect)
      return { url: snapshot.url, viewport: snapshot.viewport, body: snapshot.body.slice(0, 1800), buttons: snapshot.buttons.map(el => el.text || el.label || el.name).slice(0, 30), brokenImages: snapshot.images.filter(el => el.complete && !el.width).length, discs: snapshot.discs, overflow: snapshot.overflow.filter(el => el.scroll > el.client + 1) }
    }
    if (body.command === 'status') return { page: await evaluate('location.href'), errors: errors.slice(-15), requests: requests.length, rules }
    if (body.command === 'tap') return tap(first)
    if (body.command === 'fill') {
      await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(first)}); if (!el) throw new Error('Input not found'); el.focus(); el.select(); })()`)
      await send('Input.insertText', { text: second })
      return { filled: first }
    }
    if (body.command === 'navigate') { await send('Page.navigate', { url: origin + first }); return { navigated: first } }
    if (body.command === 'reload') { await send('Page.reload', { ignoreCache: true }); return { reloaded: true } }
    if (body.command === 'rule') { rules.push(JSON.parse(first)); return rules }
    if (body.command === 'clear-rules') { rules.length = 0; return { cleared: true } }
    if (body.command === 'offline') { await send('Network.emulateNetworkConditions', { offline: first === 'true', latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); return { offline: first === 'true' } }
    if (body.command === 'screenshot') {
      if (!/^[a-z0-9-]+$/i.test(first)) throw new Error('Use a simple screenshot label')
      const snapshot = await evaluate(inspect)
      await writeFile(path.join(reports, `${first}.json`), JSON.stringify(snapshot, null, 2))
      const nativePath = `/sdcard/bolt-audit-${first}.png`
      adb('shell', 'screencap', '-p', nativePath)
      const filename = path.join(reports, `${first}.png`)
      adb('pull', nativePath, filename)
      adb('shell', 'rm', nativePath)
      return { screenshot: filename, url: snapshot.url }
    }
    if (body.command === 'record') {
      const result = JSON.parse(first)
      tests = tests.filter(item => item.label !== result.label)
      tests.push(result)
      await writeFile(path.join(reports, 'tests.json'), JSON.stringify(tests, null, 2))
      return { count: tests.length }
    }
    if (body.command === 'report') {
      await writeFile(path.join(reports, 'network.json'), JSON.stringify(requests, null, 2))
      await writeFile(path.join(reports, 'errors.json'), JSON.stringify(errors, null, 2))
      await writeFile(path.join(reports, 'tests.json'), JSON.stringify(tests, null, 2))
      return { reports, tests, errors: errors.length, failedRequests: requests.filter(item => item.status >= 400).length }
    }
    throw new Error('Unknown command')
  }
  const server = createServer(async (request, response) => {
    try {
      let input = ''
      for await (const chunk of request) input += chunk
      const result = await execute(JSON.parse(input))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result ?? null))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
    }
  })
  server.listen(port, '127.0.0.1', () => console.log(`Audit ready on ${port}; current frontend build, live API; ${page.url}`))
  const close = async () => {
    await writeFile(path.join(reports, 'network.json'), JSON.stringify(requests, null, 2))
    await writeFile(path.join(reports, 'errors.json'), JSON.stringify(errors, null, 2))
    server.close()
    socket.close()
    adb('forward', '--remove', 'tcp:9223')
    process.exit()
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}
