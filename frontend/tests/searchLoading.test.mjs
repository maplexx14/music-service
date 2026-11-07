import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { createStore } from 'zustand/vanilla'

const compile = async (path, loader) => {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const { code } = await transform(source, { format: 'cjs', loader, jsx: 'automatic', target: 'es2020' })
  return new vm.Script(code, { filename: path })
}
const searchScript = await compile('pages/Search.jsx', 'jsx')
const storeScript = await compile('store/searchStore.js', 'js')
const endpoints = ['/search/', '/artists/search', '/search/external/grouped', '/search/external/playlists']
const responses = {
  '/search/': { tracks: [{ id: 1, title: 'Uprising', artist: 'Muse' }], playlists: [{ id: 2, name: 'Local playlist' }] },
  '/artists/search': [{ name: 'Muse' }],
  '/search/external/grouped': {
    top: [{ id: 3, title: 'Muse', artist: 'Artist' }],
    ytmusic: [{ id: 4, title: 'YouTube track', artist: 'Muse' }],
    soundcloud: [{ id: 5, title: 'SoundCloud track', artist: 'Muse' }],
  },
  '/search/external/playlists': [{ id: 6, title: 'External playlist' }],
}

async function mountSearch(initial = {}) {
  const hooks = [], effects = [], timers = new Map(), requests = [], snapshots = []
  let index = 0, timerId = 0, dirty = true, tree
  const sameDeps = (a, b) => a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initialValue) {
      const hook = hooks[index++] ??= { value: initialValue }
      return [hook.value, (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (!Object.is(value, hook.value)) { hook.value = value; dirty = true }
      }]
    },
    useMemo: (factory) => factory(),
    useEffect(callback, deps) {
      const i = index++, previous = hooks[i]
      if (sameDeps(previous?.deps, deps)) return
      const hook = hooks[i] = { deps, cleanup: previous?.cleanup }
      effects.push(() => { hook.cleanup?.(); hook.cleanup = callback() })
    },
  }
  const jsx = (type, props, key) => ({ type, props, key })
  const noop = () => {}
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    zustand: { create(init) {
      const store = createStore(init)
      store.subscribe(() => { dirty = true })
      return Object.assign((selector) => selector(store.getState()), store)
    } },
    '../services/uiSession': { readUiSession: () => null, writeUiSession: noop },
    'react-router-dom': { useNavigate: () => noop, useSearchParams: () => [searchParams], Link: 'Link' },
    'lucide-react': { Download: 'Download' },
    '../services/api': { default: { get(url, options) {
      if (url === '/spotify/status') return Promise.resolve({ data: { configured: true } })
      // Deliberately allow aborted requests to resolve, exercising the page's guards.
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject, done: false }))
    } } },
    '../store/playerStore': {
      usePlayerStore: { getState: () => ({ prefetchTracks: noop }) }, trackIntentHandlers: () => ({}),
    },
    '../services/pageCache': { intentPrefetchHandlers: () => ({}), prefetchArtist: noop, prefetchCache: noop },
    '../components/TrackContextMenu': {
      useTrackContextMenu: () => ({ getProps: () => ({}) }), TrackContextMenu: 'TrackContextMenu',
    },
    '../utils/media': { resolveCoverUrl: (url) => url, handleCoverError: noop },
    '../utils/artists': { artistPath: (name) => `/artists/${name}` },
    '../utils/format': { formatDuration: () => '' },
    '../utils/musicLinks': { parseMusicLink: () => null, linkPagePath: noop },
  }
  const searchParams = new URLSearchParams()
  for (const component of ['Spinner', 'ArtistLink', 'Carousel', 'SourceIcon']) {
    modules[`../components/${component}`] = { default: component }
  }
  modules['../assets/default-cover.webp'] = { default: 'cover.webp' }
  modules['./Search.css'] = {}
  const context = vm.createContext({
    AbortController, console: { error: noop },
    window: { addEventListener: noop, setTimeout(callback) {
      const id = ++timerId; timers.set(id, callback); return id
    }, clearTimeout: (id) => timers.delete(id) },
    require(name) { assert.ok(modules[name], `Unexpected import: ${name}`); return { __esModule: true, ...modules[name] } },
  })
  function run(script) {
    context.module = { exports: {} }
    context.exports = context.module.exports
    script.runInContext(context)
    return context.module.exports
  }
  const { useSearchStore } = run(storeScript)
  modules['../store/searchStore'] = { useSearchStore }
  useSearchStore.setState({ query: 'Muse', ...initial })
  const Search = run(searchScript).default
  function nodes(predicate) {
    function visit(node) {
      if (!node || typeof node !== 'object') return []
      return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(visit)]
    }
    return visit(tree)
  }
  const hasClass = (name) => nodes((node) => node.props?.className === name).length > 0
  function render() {
    dirty = false; index = 0; tree = Search()
    snapshots.push({ loading: nodes((node) => node.type === 'Spinner').length, results: hasClass('search-results') })
    for (const effect of effects.splice(0)) effect()
  }
  async function settle() {
    for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve() }
  }
  async function complete(url, data = responses[url], query = useSearchStore.getState().query.trim(), error) {
    const request = requests.find((item) => !item.done && item.url === url && item.options.params.q === query)
    assert.ok(request, `Missing ${url} request for ${query}`)
    request.done = true
    if (error) request.reject(error)
    else request.resolve({ data })
    await settle()
  }
  await settle()
  return {
    state: useSearchStore.getState, requests, snapshots, settle, render, complete, hasClass,
    loading: () => nodes((node) => node.type === 'Spinner').length,
    titles: () => nodes((node) => node.type === 'h2').map((node) => node.props.children),
    async start() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback() }
      await settle()
    },
  }
}

for (const last of endpoints) {
  test(`all results stay hidden until ${last} finishes last`, async () => {
    const app = await mountSearch()
    assert.equal(app.loading(), 1, 'The debounce also shows a single loader')
    assert.equal(app.hasClass('no-results'), false)
    await app.start()
    for (const url of endpoints.filter((url) => url !== last)) await app.complete(url)
    assert.ok(app.snapshots.every((snapshot) => snapshot.loading === 1 && !snapshot.results))
    await app.complete(last)
    assert.equal(app.loading(), 0)
    assert.equal(app.hasClass('search-results'), true)
    assert.deepEqual(app.titles(), ['Исполнители', 'Плейлисты', 'Плейлисты сервисов', 'Лучшие совпадения', 'YouTube Music', 'SoundCloud'])
    assert.equal(app.state().cachedQuery, 'Muse')
  })
}

test('an empty search waits for every section, including failed requests', async () => {
  const app = await mountSearch()
  await app.start()
  await app.complete('/search/', { tracks: [], playlists: [] })
  await app.complete('/artists/search', [])
  await app.complete('/search/external/grouped', {})
  assert.equal(app.hasClass('no-results'), false)
  await app.complete('/search/external/playlists', undefined, 'Muse', new Error('Service unavailable'))
  assert.equal(app.loading(), 0)
  assert.equal(app.hasClass('no-results'), true)
})

test('a local failure releases the loader after the other sections settle', async () => {
  const app = await mountSearch()
  await app.start()
  await app.complete('/search/', undefined, 'Muse', new Error('Local failure'))
  for (const url of endpoints.slice(1)) await app.complete(url)
  assert.equal(app.loading(), 0)
  assert.equal(app.hasClass('search-error'), true)
  assert.equal(app.hasClass('search-results'), true)
  assert.equal(app.state().cachedQuery, '')
})

for (const filter of ['library', 'top', 'ytmusic', 'soundcloud']) {
  test(`${filter} waits only for its own results`, async () => {
    const app = await mountSearch({ filter })
    await app.start()
    if (filter === 'library' || filter === 'top') await app.complete('/search/')
    if (filter === 'top') assert.equal(app.loading(), 1, 'Top still needs the external matches')
    if (filter !== 'library') await app.complete('/search/external/grouped')
    assert.equal(app.loading(), 0)
    assert.equal(app.hasClass('search-results'), true)
    app.state().setFilter('all')
    await app.settle()
    assert.equal(app.loading(), 1, 'Switching to all waits for the unfinished upper sections')
    for (const url of endpoints) {
      if (app.requests.some((item) => item.url === url && !item.done)) await app.complete(url)
    }
    assert.equal(app.loading(), 0)
  })
}

test('changing the query hides previous results immediately and ignores cancelled responses', async () => {
  const app = await mountSearch()
  await app.start()
  app.state().setQuery('New')
  app.render()
  assert.equal(app.loading(), 1)
  assert.equal(app.hasClass('search-results'), false)
  await app.start()
  for (const url of endpoints) await app.complete(url, responses[url], 'Muse')
  assert.equal(app.loading(), 1)
  assert.equal(app.state().cachedQuery, '')
  for (const url of endpoints) await app.complete(url, responses[url], 'New')
  assert.equal(app.loading(), 0)
  assert.equal(app.state().resultsQuery, 'New')
  assert.equal(app.state().cachedQuery, 'New')
})

test('a complete cached search opens immediately; a partial search loads again', async () => {
  for (const cachedQuery of ['Muse', '']) {
    const app = await mountSearch({ cachedQuery, resultsQuery: 'Muse', results: responses['/search/'] })
    assert.equal(app.loading(), cachedQuery ? 0 : 1)
    assert.equal(app.hasClass('search-results'), !!cachedQuery)
    await app.start()
    assert.equal(app.requests.length, cachedQuery ? 0 : 4)
  }
})

for (const filter of ['deezer', 'spotify']) {
  test(`${filter} results do not wait for other catalogs or flash while typing`, async () => {
    const app = await mountSearch({ filter })
    assert.equal(app.loading(), 1)
    await app.start()
    await app.complete(`/import/search/${filter}`, [{ id: 9, title: 'Provider track', artist: 'Muse' }])
    assert.equal(app.loading(), 0)
    assert.equal(app.hasClass('search-results'), true)
    app.state().setQuery('New')
    app.render()
    assert.equal(app.loading(), 1)
    assert.equal(app.hasClass('search-results'), false)
    await app.start()
    await app.complete(`/import/search/${filter}`, [], 'New', new Error('Provider unavailable'))
    assert.equal(app.loading(), 0)
    assert.equal(app.hasClass('search-error'), true)
    assert.equal(app.hasClass('no-results'), true)
  })
}
