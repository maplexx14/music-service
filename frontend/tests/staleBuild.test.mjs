import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/services/staleBuild.js', import.meta.url), 'utf8')
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
function environment(online) {
  const names = new Set(['bolt-shell-v12', 'bolt-offline-v1', 'bolt-covers-v1'])
  const storage = new Map()
  let reloads = 0
  const caches = { keys: async () => [...names], delete: async (key) => names.delete(key) }
  const context = vm.createContext({
    navigator: { onLine: online }, caches, Date, console,
    isOffline: () => !online,
    lazy: (factory) => ({ factory }),
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    location: { reload: () => { reloads++ } },
    window: { caches, location: { reload: () => { reloads++ } }, addEventListener() {} },
    document: {}, setTimeout() {},
  })
  vm.runInContext(source.replace(/\r\n/g, '\n').replace(/^import .+\n/gm, '').replace(/\bexport /g, '') + '\nthis.reloadForStaleBuild = reloadForStaleBuild;', context)
  return { context, names, storage, reloads: () => reloads }
}

test('a missing page chunk offline preserves the shell, downloads and current document', async () => {
  const app = environment(false)
  assert.equal(await app.context.reloadForStaleBuild(), false)
  assert.ok(app.names.has('bolt-shell-v12'))
  assert.ok(app.names.has('bolt-offline-v1'))
  assert.equal(app.storage.size, 0)
  assert.equal(app.reloads(), 0)
})

test('online stale-build recovery still reloads once and preserves downloaded music', async () => {
  const app = environment(true)
  assert.equal(await app.context.reloadForStaleBuild(), true)
  assert.equal(app.names.has('bolt-shell-v12'), false)
  assert.ok(app.names.has('bolt-offline-v1'))
  assert.ok(app.names.has('bolt-covers-v1'))
  assert.equal(app.reloads(), 1)
  assert.equal(await app.context.reloadForStaleBuild(), false)
  assert.equal(app.reloads(), 1)
})

test('inline boot recovery also preserves offline caches, including a manual retry', () => {
  const app = environment(false)
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((match) => match[1].includes("var KEY = 'bolt-stale-reload-at'"))[1]
  vm.runInContext(script.replace("window.addEventListener('error'", "window.testRecover = recover; window.addEventListener('error'"), app.context)
  assert.equal(app.context.window.testRecover(false), false)
  assert.equal(app.context.window.testRecover(true), false)
  assert.ok(app.names.has('bolt-shell-v12'))
  assert.equal(app.reloads(), 0)
  assert.equal(app.storage.size, 0)
})
