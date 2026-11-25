import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/services/connectivity.js', import.meta.url), 'utf8')

function mount({ onLine = true, fetchImpl = async () => new Response('{}', { status: 200 }) } = {}) {
  const navigator = { onLine }
  const calls = []
  const handlers = new Map()
  const window = {
    addEventListener: (type, handler) => handlers.set(type, handler),
    removeEventListener: (type) => handlers.delete(type),
  }
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const context = vm.createContext({
    API_URL: '/api',
    navigator,
    window,
    document,
    fetch: (...args) => {
      calls.push(args)
      return fetchImpl(...args)
    },
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    console,
  })
  const code = source.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  vm.runInContext(
    code + '\nthis.api = { isOffline, isOnline, subscribeConnectivity, probeConnectivity, markOnline, reportNetworkFailure, startConnectivityMonitor };',
    context,
  )
  return { ...context.api, navigator, calls, handlers, cleanup: () => {} }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a reachable health endpoint keeps the app online even during a server error', async () => {
  const app = mount({ fetchImpl: async () => new Response('', { status: 503 }) })
  let notified = 0
  app.subscribeConnectivity(() => { notified++ })
  assert.equal(await app.probeConnectivity(), true)
  assert.equal(app.isOffline(), false)
  assert.equal(app.calls.length, 1)
  assert.match(String(app.calls[0][0]), /\/api\/health\?probe=\d+/)
  assert.equal(notified, 0)
})

test('a failed health request switches to offline and recovers on a later probe', async () => {
  let reachable = false
  const app = mount({ fetchImpl: async () => {
    if (!reachable) throw new TypeError('Failed to fetch')
    return new Response('{}', { status: 200 })
  } })
  const states = []
  app.subscribeConnectivity(() => states.push(app.isOffline()))
  assert.equal(await app.probeConnectivity(), false)
  assert.equal(app.isOffline(), true)
  reachable = true
  assert.equal(await app.probeConnectivity(), true)
  assert.equal(app.isOffline(), false)
  assert.deepEqual(states, [true, false])
})

test('a periodic probe requires two failures so a slow stream cannot fake an outage', async () => {
  const app = mount({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  assert.equal(await app.probeConnectivity({ confirm: true }), false)
  assert.equal(app.isOffline(), false)
  assert.equal(await app.probeConnectivity({ confirm: true }), false)
  assert.equal(app.isOffline(), true)
})

test('a request without a response triggers a probe instead of trusting navigator.onLine', async () => {
  const app = mount({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  app.reportNetworkFailure({ code: 'ERR_NETWORK' })
  await tick()
  assert.equal(app.calls.length, 1)
  assert.equal(app.isOffline(), true)
})

test('cancelled requests and any HTTP response never start an offline probe', async () => {
  const app = mount({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  app.reportNetworkFailure({ code: 'ERR_CANCELED' })
  app.reportNetworkFailure({ name: 'CanceledError' })
  await tick()
  assert.equal(app.calls.length, 0)
  assert.equal(app.isOffline(), false)
  app.markOnline()
  assert.equal(app.isOffline(), false)
})

test('online and offline browser events update the shared state automatically', async () => {
  let reachable = false
  const app = mount({ fetchImpl: async () => {
    if (!reachable) throw new TypeError('Failed to fetch')
    return new Response('{}', { status: 200 })
  } })
  const stop = app.startConnectivityMonitor(app.window)
  await tick()
  assert.equal(app.isOffline(), true)
  assert.equal(app.handlers.has('online') && app.handlers.has('offline') && app.handlers.has('pageshow'), true)
  reachable = true
  app.handlers.get('online')()
  await tick()
  assert.equal(app.isOffline(), false)
  app.handlers.get('offline')()
  assert.equal(app.isOffline(), true)
  stop()
})
