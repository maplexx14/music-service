// Requires Node 22+ and a running Vite dev server (the Docker profiling server works).
// node scripts/bake-cd-studio-environment.mjs [origin]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const origin = process.argv[2] || 'http://127.0.0.1:3001'
const binary = process.env.CD_BROWSER_BINARY || (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : 'chromium')
const browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=9390', `--user-data-dir=${path.join(tmpdir(), `cd-studio-bake-${Date.now()}`)}`,
  'about:blank'], { windowsHide: true, stdio: 'ignore' })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
try {
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    try { page = (await (await fetch('http://127.0.0.1:9390/json/list')).json()).find(item => item.type === 'page') } catch { /* Browser startup. */ }
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
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const task = pending.get(message.id)
    if (!task) return
    pending.delete(message.id)
    if (message.error) task.reject(new Error(JSON.stringify(message.error)))
    else task.resolve(message.result)
  })
  await send('Page.enable')
  await send('Page.navigate', { url: `${origin}/manifest.webmanifest` })
  await wait(300)
  const result = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const {WebGLRenderer} = await import('/node_modules/.vite/deps/three.js');
    const {bakeStudioEnvironment} = await import('/scripts/cd-studio-environment-source.mjs');
    const renderer = new WebGLRenderer();
    const target = bakeStudioEnvironment(renderer);
    try {
      const pixels = new Uint16Array(target.width * target.height * 4);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, pixels);
      const bytes = new Uint8Array(pixels.buffer);
      let text = '';
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return {width:target.width,height:target.height,pixels:btoa(text)};
    } finally { target.dispose(); renderer.dispose(); renderer.forceContextLoss(); }
  })()` })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  const { width, height, pixels } = result.result.value
  const header = Buffer.alloc(12)
  header.write('CDEN')
  header.writeUInt32LE(width, 4)
  header.writeUInt32LE(height, 8)
  const bytes = Buffer.concat([header, Buffer.from(pixels, 'base64')])
  const compressed = gzipSync(bytes, { level: 9 })
  await writeFile(new URL('../src/assets/cd-studio-environment.bin.gzip', import.meta.url), compressed)
  console.log(JSON.stringify({ width, height, rawBytes: bytes.length, compressedBytes: compressed.length }))
} finally { socket?.close(); browser.kill() }
