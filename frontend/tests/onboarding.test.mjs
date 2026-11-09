import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { create } from 'zustand'
import * as jsxRuntime from 'react/jsx-runtime'

const scripts = new Map()
for (const path of ['services/onboarding.js', 'store/authStore.js', 'pages/PreferencesOnboarding.jsx']) {
  const source = await readFile(new URL('../src/' + path, import.meta.url), 'utf8')
  const { code } = await transform(source, {
    format: 'cjs', loader: path.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', target: 'es2020',
  })
  scripts.set(path, new vm.Script('(function (module, exports, require) {\n' + code + '\n})', { filename: path }))
}

const newUser = (extra = {}) => ({
  id: 1, created_at: new Date().toISOString(), onboarding_completed: false,
  preferred_genres: [], preferred_artists: [], excluded_artists: [], ...extra,
})

function browser(server = { user: newUser() }) {
  const storage = new Map(), requests = [], navigations = [], errors = []
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  const context = vm.createContext({ localStorage, window: new EventTarget(), Date })
  function module(path, imports = {}) {
    const loaded = { exports: {} }
    scripts.get(path).runInContext(context)(loaded, loaded.exports, (name) => {
      assert.ok(name in imports, 'Unexpected import: ' + name)
      const exports = imports[name]
      return exports.__esModule ? exports : { __esModule: true, ...exports }
    })
    return loaded.exports
  }
  const api = {
    async get(path) {
      if (path === '/auth/me') return { data: structuredClone(server.user) }
      assert.equal(path, '/users/me/taste')
      return { data: { genres: [], artists: [] } }
    },
    async put(path, data) {
      requests.push({ path, data })
      assert.equal(path, '/users/me/preferences')
      Object.assign(server.user, structuredClone(data))
      return { data: structuredClone(server.user) }
    },
    async post(path) {
      requests.push({ path })
      assert.equal(path, '/users/me/onboarding/complete')
      if (server.complete) await server.complete()
      server.user.onboarding_completed = true
      return { data: structuredClone(server.user) }
    },
  }
  const onboarding = module('services/onboarding.js')
  const { useAuthStore: store } = module('store/authStore.js', {
    zustand: { create },
    '../services/api': { default: api, setApiAuthToken() {}, setDeviceToken() {} },
    './searchStore': { useSearchStore: { getState: () => ({ clearSearch() {} }) } },
    '../services/pageCache': { clearPageCache() {} },
    './playerStore': { invalidateFlowPreload() {} },
    '../services/push': { dropLocalPushSubscription() {} },
    '../services/sessionHandoff': { claimHandoff() {}, shouldClaimHandoff: () => false },
    '../services/uiSession': { clearUiSession() {}, setUiSessionUser() {} },
  })

  function mount() {
    const hooks = [], effects = []
    let index = 0
    const react = {
      useState(initial) {
        const current = index++
        const hook = hooks[current] ||= { value: initial }
        return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next }]
      },
      useEffect(effect, deps) {
        const current = index++
        const previous = hooks[current]
        if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
          hooks[current] = { deps }
          effects.push(effect)
        }
      },
    }
    const useAuthStore = Object.assign(() => store.getState(), { getState: store.getState })
    const { default: Page } = module('pages/PreferencesOnboarding.jsx', {
      react, 'react/jsx-runtime': jsxRuntime,
      'react-router-dom': { useNavigate: () => (path) => navigations.push(path) },
      'lucide-react': { Check: 'check', Download: 'download', Link2: 'link' },
      '../store/authStore': { useAuthStore },
      '../utils/media': { resolveCoverUrl() {}, handleCoverError() {} },
      '../assets/default-cover.webp': { default: '' },
      '../components/GenreSelect': { default: 'genre-select' },
      '../components/ArtistSelect': { default: 'artist-select' },
      '../components/ImportCollectionPicker': { default: 'import-picker', allCollectionKeys() {}, selectedTrackCount() {} },
      '../store/importStore': { useImportStore: (select) => select({ imports: {}, completed: 0 }), importIsFinal() {}, newImportId() {} },
      '../components/ImportProgressModal': { stageCounter() {} },
      '../services/api': { default: api },
      '../store/toastStore': { toast: { error: (message) => errors.push(message) } },
      './PreferencesOnboarding.css': {},
    })
    function find(node, predicate) {
      if (!node || typeof node !== 'object') return null
      if (predicate(node)) return node
      for (const child of [node.props?.children].flat(Infinity)) {
        const match = find(child, predicate)
        if (match) return match
      }
      return null
    }
    function render() {
      index = 0
      const tree = Page()
      for (const effect of effects.splice(0)) effect()
      return tree
    }
    return {
      back() {
        const button = find(render(), (node) => node.props?.className?.includes('onboarding-back'))
        assert.ok(button)
        button.props.onClick()
      },
      selectGenres(genres) {
        const select = find(render(), (node) => node.type === 'genre-select')
        assert.ok(select)
        select.props.onChange(genres)
      },
      async skip() {
        const button = find(render(), (node) => node.props?.className?.includes('onboarding-skip'))
        assert.ok(button)
        await button.props.onClick()
      },
    }
  }
  return { store, onboarding, storage, requests, navigations, errors, mount }
}

test('completed onboarding stays closed in a browser with empty storage and no preferences', () => {
  const app = browser()
  assert.equal(app.onboarding.needsOnboarding(newUser({ onboarding_completed: true })), false)
  assert.equal(app.storage.size, 0)
})

test('unfinished onboarding opens regardless of account age, preferences, or an old local seen marker', () => {
  const app = browser()
  app.storage.set('bolt-onboarding-seen', '[1]')
  for (const extra of [
    {},
    { created_at: '2020-01-01T00:00:00Z' },
    { created_at: undefined },
    { preferred_genres: ['rock'], preferred_artists: ['Radiohead'] },
  ]) {
    assert.equal(app.onboarding.needsOnboarding(newUser(extra)), true)
    assert.equal(app.onboarding.needsOnboarding(newUser({ ...extra, onboarding_completed: true })), false)
  }
})

test('onboarding waits until an authenticated profile reports that it is unfinished', () => {
  const app = browser()
  assert.equal(app.onboarding.needsOnboarding(null), false)
  assert.equal(app.onboarding.needsOnboarding({}), false)
  assert.equal(app.onboarding.needsOnboarding(newUser({ onboarding_completed: undefined })), false)
})

test('leaving before the final step keeps onboarding pending in this browser and another one', async () => {
  const server = { user: newUser() }
  const first = browser(server)
  await first.store.getState().finalizeLogin('first-browser')
  await first.mount().skip()
  assert.equal(first.onboarding.needsOnboarding(first.store.getState().user), true)
  assert.equal(first.requests.length, 0)

  const second = browser(server)
  await second.store.getState().finalizeLogin('second-browser')
  assert.equal(second.onboarding.needsOnboarding(second.store.getState().user), true)
})

test('skipping every step persists completion and the next browser does not repeat onboarding', async () => {
  const server = { user: newUser() }
  const first = browser(server)
  await first.store.getState().finalizeLogin('first-browser')
  const page = first.mount()
  await page.skip()
  await page.skip()
  assert.equal(server.user.onboarding_completed, false)
  await page.skip()
  assert.equal(server.user.onboarding_completed, true)
  assert.deepEqual(first.requests.map((request) => request.path), ['/users/me/onboarding/complete'])
  assert.deepEqual(first.navigations, ['/'])

  const second = browser(server)
  await second.store.getState().finalizeLogin('second-browser')
  assert.equal(second.storage.has('bolt-onboarding-seen'), false)
  assert.equal(second.onboarding.needsOnboarding(second.store.getState().user), false)
})

test('a failed completion stays on the final step and can be retried without clearing preferences', async () => {
  const server = {
    user: newUser({ preferred_genres: ['rock'] }),
    complete: async () => { throw new Error('offline') },
  }
  const app = browser(server)
  await app.store.getState().finalizeLogin('browser')
  const page = app.mount()
  await page.skip()
  await page.skip()
  await page.skip()
  assert.equal(app.navigations.length, 0)
  assert.equal(app.errors.length, 1)
  assert.equal(app.store.getState().user.onboarding_completed, false)
  delete server.complete
  await page.skip()
  assert.deepEqual(app.navigations, ['/'])
  assert.deepEqual(server.user.preferred_genres, ['rock'])
})

test('skipping artists saves the chosen genres before explicitly completing onboarding', async () => {
  const server = { user: newUser() }
  const app = browser(server)
  await app.store.getState().finalizeLogin('browser')
  const page = app.mount()
  await page.skip()
  page.selectGenres(['rock'])
  await page.skip()
  await page.skip()
  assert.deepEqual(server.user.preferred_genres, ['rock'])
  assert.equal(app.store.getState().user.onboarding_completed, true)
  assert.deepEqual(app.requests.map((request) => request.path), [
    '/users/me/preferences', '/users/me/onboarding/complete',
  ])
  assert.deepEqual(app.navigations, ['/'])
})

test('a failed completion allows clearing saved genres before retrying the final step', async () => {
  const server = { user: newUser(), complete: async () => { throw new Error('offline') } }
  const app = browser(server)
  await app.store.getState().finalizeLogin('browser')
  const page = app.mount()
  await page.skip()
  page.selectGenres(['rock'])
  await page.skip()
  await page.skip()
  assert.deepEqual(server.user.preferred_genres, ['rock'])
  assert.equal(app.onboarding.needsOnboarding(app.store.getState().user), true)
  assert.equal(app.navigations.length, 0)

  page.back()
  page.selectGenres([])
  await page.skip()
  delete server.complete
  await page.skip()
  assert.deepEqual(server.user.preferred_genres, [])
  assert.equal(app.onboarding.needsOnboarding(app.store.getState().user), false)
  assert.deepEqual(app.navigations, ['/'])
})

test('a completion response cannot mark another signed-in account as completed', async () => {
  let resolve
  const server = { user: newUser(), complete: () => new Promise((done) => { resolve = done }) }
  const app = browser(server)
  await app.store.getState().finalizeLogin('first-account')
  const pending = app.store.getState().completeOnboarding()
  app.store.setState({ token: 'second-account', user: newUser({ id: 2 }) })
  resolve()
  await pending
  assert.equal(app.store.getState().user.id, 2)
  assert.equal(app.store.getState().user.onboarding_completed, false)
})
