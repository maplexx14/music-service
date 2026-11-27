import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const reports = path.join(workspace, 'android/app/build/reports/background-playback')
const adbPath = path.join(process.env.ANDROID_HOME || path.join(process.env.USERPROFILE, 'android-dev/sdk'), 'platform-tools/adb.exe')
const serial = process.env.ANDROID_SERIAL || 'emulator-5554'
if (!/^emulator-\d+$/.test(serial)) throw new Error('This harness is only for a disposable Android emulator')
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
await mkdir(reports, { recursive: true })

async function connect() {
  const pid = adb('shell', 'pidof', '-s', 'lat.boltmusic.app')
  if (!pid) throw new Error('APK process is not running')
  adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`)
  const pages = await (await fetch('http://127.0.0.1:9223/json')).json()
  const page = pages.find((item) => item.type === 'page' && item.url.startsWith('https://boltmusic.lat/'))
  if (!page) throw new Error('App WebView was not found')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) return
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(JSON.stringify(message.error)))
    else callback.resolve(message.result)
  })
  return {
    async evaluate(expression) {
      const id = ++nextId
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP evaluation timed out')) }, 30_000)
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value) },
          reject: (error) => { clearTimeout(timeout); reject(error) },
        })
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    },
    async close() {
      await new Promise((resolve) => {
        socket.addEventListener('close', resolve, { once: true })
        socket.close()
      })
      adb('forward', '--remove', 'tcp:9223')
    },
  }
}

async function snapshot(label) {
  const client = await connect()
  try {
    const value = await client.evaluate('window.__boltEmulatorProbe?.snapshot()')
    if (!value) throw new Error('Playback harness is missing (page or renderer may have restarted)')
    await writeFile(path.join(reports, `${label}.json`), JSON.stringify(value, null, 2))
    const { events, diagnostics, ...summary } = value
    console.log(JSON.stringify({ label, ...summary, events: events.length }))
    return value
  } finally { await client.close() }
}

const [command, label = 'snapshot', seconds = '600'] = process.argv.slice(2)
if (command === 'start' || command === 'start-fixture') {
  const baselineRef = process.env.BOLT_BASELINE_REF
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./playbackHarness.jsx', import.meta.url))],
    bundle: true, write: false, minify: true, format: 'iife', target: 'chrome130',
    outfile: path.join(reports, 'harness.js'), define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' },
    loader: { '.webp': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl' },
    plugins: baselineRef ? [{
      name: 'baseline-player',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]src[\\/]components[\\/]Player\.jsx$/ }, () => ({
          contents: execFileSync('git', ['show', `${baselineRef}:frontend/src/components/Player.jsx`], { cwd: workspace, encoding: 'utf8', windowsHide: true }),
          loader: 'jsx', resolveDir: path.join(workspace, 'frontend/src/components'),
        }))
      },
    }] : [],
  })
  for (const file of result.outputFiles) await writeFile(file.path, file.contents)
  const code = result.outputFiles.find((file) => file.path.endsWith('.js')).text
  const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text || ''
  let tracks
  if (command === 'start-fixture') {
    tracks = [{ id: `emulator:${label}`, source: 'jamendo', title: 'Stalled HTTPS test stream',
      artist: 'Emulator fixture', duration: 480, stream_url: `https://10.0.2.2:9143/stream.wav?run=${encodeURIComponent(label)}` }]
  } else {
    const response = await fetch('https://boltmusic.lat/api/tracks/?limit=10')
    if (!response.ok) throw new Error(`Cannot load public tracks: HTTP ${response.status}`)
    tracks = await response.json()
    if (!Array.isArray(tracks) || tracks.length < 4) throw new Error('At least four public tracks are required')
  }
  await writeFile(path.join(reports, 'tracks.json'), JSON.stringify(tracks, null, 2))
  const client = await connect()
  try {
    await client.evaluate(`(() => {
      if (window.__boltEmulatorProbe) throw new Error('Restart the APK before loading another harness');
      if (JSON.parse(localStorage.getItem('auth-storage') || 'null')?.token) throw new Error('Use a logged-out disposable emulator');
      if (!window.__boltAndroid) throw new Error('Native APK bridge is required');
    })()`)
    await client.evaluate(code)
    await client.evaluate(`{ const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); }`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await client.evaluate(`window.__boltEmulatorProbe.start(${JSON.stringify(tracks)})`)
  } finally { await client.close() }
  console.log(`Player ${baselineRef || 'working tree'} loaded; ${command === 'start-fixture' ? 'HTTPS fixture' : 'public track queue'} started; debugger disconnected.`)
} else if (command === 'snapshot') {
  await snapshot(label)
} else if (command === 'observe') {
  await snapshot(`${label}-before`)
  const deadline = Date.now() + Number(seconds) * 1000
  // No CDP or adb calls during the observation window.
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, deadline - Date.now())))
    console.log(`${label}: ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} seconds remaining (debugger disconnected)`)
  }
  await snapshot(`${label}-after`)
  await writeFile(path.join(reports, `${label}-services.txt`), adb('shell', 'dumpsys', 'activity', 'services', 'lat.boltmusic.app'))
  await writeFile(path.join(reports, `${label}-audio.txt`), adb('shell', 'dumpsys', 'media.audio_flinger'))
  await writeFile(path.join(reports, `${label}-idle.txt`), adb('shell', 'dumpsys', 'deviceidle'))
} else if (command === 'analyze') {
  const before = JSON.parse(await readFile(path.join(reports, `${label}-before.json`), 'utf8'))
  const after = JSON.parse(await readFile(path.join(reports, `${label}-after.json`), 'utf8'))
  const progress = after.events.filter((event) => event.event === 'progress' && event.at >= before.at && event.at <= after.at)
  const times = [before.at, ...progress.map((event) => event.at), after.at]
  const lastProgress = progress.at(-1)
  const priorProgress = progress.at(-2)
  const summary = {
    label,
    elapsedSeconds: (after.at - before.at) / 1000,
    startTrack: before.title, endTrack: after.title,
    startPosition: before.audio.position, endPosition: after.audio.position,
    queueAdvances: after.index - before.index,
    progressSamples: progress.length,
    hiddenProgressSamples: progress.filter((event) => event.hidden).length,
    largestProgressGapSeconds: Math.max(...times.slice(1).map((at, i) => (at - times[i]) / 1000)),
    endedPlaying: after.requested && !after.audio.paused && after.playback === 'playing',
    // playbackState alone also says 'playing' when a mid-stream request hangs.
    stillAdvancing: Boolean(lastProgress && priorProgress &&
      after.at - lastProgress.at < 30_000 &&
      (lastProgress.track !== priorProgress.track || lastProgress.position > priorProgress.position + 0.1)),
    mediaErrors: after.events.filter((event) => event.event === 'error' && event.at >= before.at),
    debuggerDisconnectedDuringObservation: true,
  }
  await writeFile(path.join(reports, `${label}-summary.json`), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} else {
  throw new Error('Use start, start-fixture <run>, snapshot [label], observe <label> <seconds>, or analyze <label>')
}
