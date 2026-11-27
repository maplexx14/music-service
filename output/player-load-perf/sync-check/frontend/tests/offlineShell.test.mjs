import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { offlineUiAssets } from '../scripts/offline-ui-manifest.mjs'

test('offline player manifest includes transitive modules, styles and artwork without unrelated pages', () => {
  const chunk = (name, facade, imports = [], css = [], assets = []) => ({ type: 'chunk', fileName: name, facadeModuleId: facade, imports, viteMetadata: { importedCss: new Set(css), importedAssets: new Set(assets) } })
  const files = offlineUiAssets({
    'home.js': chunk('home.js', 'C:/app/src/pages/Home.jsx', ['deck.js', 'shared.js'], ['home.css']),
    'deck.js': chunk('deck.js', 'C:/app/src/components/DesktopCdPlayer.jsx', ['shared.js'], ['deck.css'], ['cover.webp']),
    'scene.js': chunk('scene.js', 'C:/app/src/utils/cdDeckScene.js', ['shared.js']),
    'shared.js': chunk('shared.js', '', ['home.js']),
    'admin.js': chunk('admin.js', 'C:/app/src/pages/Admin.jsx'),
    'external.js': chunk('external.js', 'C:/app/src/pages/ExternalPlaylist.jsx', ['shared.js'], ['external.css']),
    'link.js': chunk('link.js', 'C:/app/src/pages/LinkPlaylist.jsx', ['shared.js'], ['link.css']),
    'geometry.js': { type: 'asset', fileName: 'assets/cdGeometry.worker-test.js' },
    'assets/fflate.module-test.js': chunk('assets/fflate.module-test.js', ''),
  })
  for (const name of ['home.js', 'deck.js', 'scene.js', 'shared.js', 'home.css', 'deck.css', 'cover.webp', 'external.js', 'external.css', 'link.js', 'link.css']) assert.ok(files.includes('/' + name), name)
  assert.equal(files.includes('/admin.js'), false)
  assert.ok(files.includes('/assets/cdGeometry.worker-test.js'))
  assert.ok(files.includes('/assets/fflate.module-test.js'))
})

const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
function worker() {
  const stores = new Map()
  const keyOf = (path) => new URL(typeof path === 'string' ? path : path.url, 'https://bolt.test').href
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const entries = stores.get(name)
      return {
        match: async (path) => entries.get(keyOf(path))?.clone(),
        put: async (path, response) => entries.set(keyOf(path), response.clone()),
        delete: async (path) => entries.delete(keyOf(path)),
        keys: async () => [...entries.keys()].map((path) => new Request(path)),
        add: async (path) => {
          const response = await context.fetch(path)
          if (!response.ok) throw new Error('Asset unavailable')
          entries.set(keyOf(path), response.clone())
        },
      }
    },
    async match(path) {
      for (const entries of stores.values()) if (entries.has(keyOf(path))) return entries.get(keyOf(path)).clone()
    },
  }
  const context = vm.createContext({
    caches, Response, Request, URL, Set, Headers, Promise,
    importScripts() {}, self: { location: { origin: 'https://bolt.test' }, addEventListener() {} },
    fetch: async (path) => path === '/offline-ui.json'
      ? new Response(JSON.stringify(['/assets/home.js', '/assets/scene.js']))
      : new Response('asset', { headers: { 'Content-Type': 'image/webp' } }),
  })
  vm.runInContext(sw, context)
  return { context, caches, stores }
}

test('a new shell is committed only after the lazy player files have been cached', async () => {
  const app = worker()
  await app.context.cacheShell(new Response('<script src="/assets/main.js"></script>'))
  assert.ok(await app.caches.match('/'))
  assert.ok(await app.caches.match('/assets/main.js'))
  assert.ok(await app.caches.match('/assets/home.js'))
  assert.ok(await app.caches.match('/assets/scene.js'))
})

test('a failed player download preserves the previous working shell', async () => {
  const app = worker()
  const cache = await app.caches.open('bolt-shell-v13')
  await cache.put('/', new Response('previous working shell'))
  const fetch = app.context.fetch
  app.context.fetch = (path) => path === '/assets/scene.js' ? Promise.resolve(new Response('', { status: 503 })) : fetch(path)
  await assert.rejects(app.context.cacheShell(new Response('<script src="/assets/main.js"></script>')))
  assert.equal(await (await cache.match('/')).text(), 'previous working shell')
})

test('player atlases can be read without network and retain only four appearances', async () => {
  const app = worker()
  for (let i = 0; i < 6; i++) await app.context.playerFrameResponse(new Request(`https://bolt.test/cd-player-frames/body-${i}.webp`))
  const cache = await app.caches.open('bolt-player-frames-v1')
  assert.equal((await cache.keys()).length, 4)
  app.context.fetch = () => { throw new Error('Offline') }
  const response = await app.context.playerFrameResponse(new Request('https://bolt.test/cd-player-frames/body-5.webp'))
  assert.equal(await response.text(), 'asset')
})
