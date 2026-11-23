import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { create } from 'zustand'
import * as jsxRuntime from 'react/jsx-runtime'
import { icons } from './helpers/icons.mjs'

const scripts = new Map()
for (const path of ['services/onboarding.js', 'services/playerSetup.js', 'store/authStore.js', 'pages/PreferencesOnboarding.jsx', 'pages/PlayerSetup.jsx', 'components/PlayerSetupScreen.jsx']) {
  const source = await readFile(new URL('../src/' + path, import.meta.url), 'utf8')
  const { code } = await transform(source, {
    format: 'cjs', loader: path.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic', target: 'es2020',
  })
  scripts.set(path, new vm.Script('(function (module, exports, require) {\n' + code + '\n})', { filename: path }))
}

const newUser = (extra = {}) => ({
  id: 1, created_at: new Date().toISOString(), onboarding_completed: false, player_setup_completed: false,
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
      if (path === '/auth/register') throw server.registrationError
      if (path === '/users/me/player-setup/complete') {
        if (server.setupComplete) await server.setupComplete()
        server.user.player_setup_completed = true
        return { data: structuredClone(server.user) }
      }
      assert.equal(path, '/users/me/onboarding/complete')
      if (server.complete) await server.complete()
      server.user.onboarding_completed = true
      return { data: structuredClone(server.user) }
    },
  }
  const setupProgress = module('services/playerSetup.js')
  const onboarding = module('services/onboarding.js', { './playerSetup': setupProgress })
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

  function mount(page = 'PreferencesOnboarding') {
    const hooks = [], effects = []
    let index = 0
    const react = {
      useState(initial) {
        const current = index++
        const hook = hooks[current] ||= { value: typeof initial === 'function' ? initial() : initial }
        return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next }]
      },
      useRef(initial) {
        const current = index++
        return hooks[current] ||= { current: initial }
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
    const useAuthStore = Object.assign((select) => select ? select(store.getState()) : store.getState(), { getState: store.getState })
    const { default: PlayerSetupScreen } = module('components/PlayerSetupScreen.jsx', {
      react, 'react/jsx-runtime': jsxRuntime,
      'lucide-react': { ArrowRight: 'arrow' },
  '@/components/icons': icons,
      './CdPlayerAppearance': { default: 'cd-appearance' },
      './UnboxPlayer': { default: 'unbox-player' },
      '../assets/bolt-wordmark.webp': { default: '' },
      '../styles/controls.css': {},
      '../pages/PlayerSetup.css': {},
    })
    const { default: Page } = module(`pages/${page}.jsx`, {
      react, 'react/jsx-runtime': jsxRuntime,
      'react-router-dom': { useNavigate: () => (path) => navigations.push(path) },
      'lucide-react': { Check: 'check', Download: 'download', Link2: 'link', ArrowRight: 'arrow', PackageOpen: 'package' },
  '@/components/icons': icons,
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
      './PlayerSetup.css': {},
      '../services/playerSetup': setupProgress,
      '../store/uiSettingsStore': { useUiSettingsStore: { setState() {} } },
      '../components/CdPlayerAppearance': { default: 'cd-appearance' },
      '../components/UnboxPlayer': { default: 'unbox-player' },
      '../components/PlayerSetupScreen': { default: PlayerSetupScreen },
      '../assets/bolt-wordmark.webp': { default: '' },
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
      const root = Page()
      const tree = root.type === PlayerSetupScreen ? PlayerSetupScreen(root.props) : root
      for (const effect of effects.splice(0)) effect()
      return tree
    }
    return {
      render,
      unbox() {
        const box = find(render(), (node) => node.type === 'unbox-player')
        assert.ok(box)
        box.props.onUnboxed()
      },
      customize() {
        const box = find(render(), (node) => node.type === 'unbox-player')
        assert.ok(box)
        box.props.onReady()
      },
      async finishSetup() {
        const button = find(render(), (node) => node.props?.className?.includes('player-setup-finish'))
        assert.ok(button)
        await button.props.onClick()
      },
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
  return { store, onboarding, setupProgress, storage, requests, navigations, errors, mount }
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
  assert.deepEqual(first.navigations, ['/onboarding/player'])

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
  assert.deepEqual(app.navigations, ['/onboarding/player'])
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
  assert.deepEqual(app.navigations, ['/onboarding/player'])
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
  assert.deepEqual(app.navigations, ['/onboarding/player'])
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

test('music onboarding precedes unboxing; old profiles see the box exactly once', () => {
  const app = browser()
  assert.equal(app.onboarding.onboardingDestination(newUser()), '/onboarding')
  assert.equal(app.onboarding.needsPlayerSetup(newUser()), false)
  assert.equal(app.onboarding.onboardingDestination(newUser({ onboarding_completed: true })), '/onboarding/player')

  // Старый аккаунт (заведён до выката коробки) уже «настроен» миграцией, но
  // коробку не видел: один раз попадает в распаковку, после отметки — больше нет.
  const oldUser = newUser({ created_at: '2026-01-01T00:00:00Z', onboarding_completed: true, player_setup_completed: true })
  assert.equal(app.onboarding.onboardingDestination(oldUser), '/onboarding/player')
  app.setupProgress.markPlayerSetupSeen(oldUser.id)
  assert.equal(app.onboarding.onboardingDestination(oldUser), null)
  assert.equal(app.onboarding.needsPlayerSetupReplay(oldUser), false)

  // Старый кэш профиля без поля player_setup_completed — тоже старый аккаунт.
  const unknownFieldUser = newUser({ id: 2, created_at: '2026-01-01T00:00:00Z', onboarding_completed: true, player_setup_completed: undefined })
  assert.equal(app.onboarding.onboardingDestination(unknownFieldUser), '/onboarding/player')
  app.setupProgress.markPlayerSetupSeen(unknownFieldUser.id)
  assert.equal(app.onboarding.onboardingDestination(unknownFieldUser), null)

  for (const user of [null, {}]) {
    assert.equal(app.onboarding.onboardingDestination(user), null)
  }
})

test('customization follows extraction, reload resumes the stage, completion survives another browser', async () => {
  const server = { user: newUser({ onboarding_completed: true }) }
  const app = browser(server)
  await app.store.getState().finalizeLogin('first-browser')
  const page = app.mount('PlayerSetup')
  page.unbox()
  assert.equal(app.setupProgress.readPlayerSetupStage(1), 'unboxed')
  assert.equal(app.setupProgress.readPlayerSetupStage(2), 'boxed')
  assert.equal(app.requests.length, 0)
  page.customize()
  assert.equal(app.setupProgress.readPlayerSetupStage(1), 'customize')
  const reopened = app.mount('PlayerSetup')
  await reopened.finishSetup()
  assert.equal(app.store.getState().user.player_setup_completed, true)
  assert.equal(app.setupProgress.readPlayerSetupStage(1), 'boxed')
  assert.deepEqual(app.requests.map((request) => request.path), ['/users/me/player-setup/complete'])
  assert.deepEqual(app.navigations, ['/'])
  const other = browser(server)
  await other.store.getState().finalizeLogin('other-browser')
  assert.equal(other.onboarding.onboardingDestination(other.store.getState().user), null)
})

test('failed setup completion keeps the unpacked player available and retries successfully', async () => {
  const server = { user: newUser({ onboarding_completed: true }), setupComplete: async () => { throw new Error('offline') } }
  const app = browser(server)
  await app.store.getState().finalizeLogin('browser')
  const page = app.mount('PlayerSetup')
  page.unbox()
  page.customize()
  await page.finishSetup()
  assert.equal(app.store.getState().user.player_setup_completed, false)
  assert.equal(app.setupProgress.readPlayerSetupStage(1), 'customize')
  assert.equal(app.navigations.length, 0)
  delete server.setupComplete
  await page.finishSetup()
  assert.equal(app.store.getState().user.player_setup_completed, true)
  assert.deepEqual(app.navigations, ['/'])
})

test('a delayed player setup response cannot complete a different signed-in account', async () => {
  let resolve
  const app = browser({ user: newUser({ onboarding_completed: true }), setupComplete: () => new Promise((done) => { resolve = done }) })
  await app.store.getState().finalizeLogin('first')
  const pending = app.store.getState().completePlayerSetup()
  app.store.setState({ token: 'second', user: newUser({ id: 2, onboarding_completed: true }) })
  resolve()
  const result = await pending
  assert.equal(result.success, false)
  assert.equal(app.store.getState().user.player_setup_completed, false)
})

test('registration translates FastAPI email validation into a renderable message', async () => {
  const app = browser({ user: newUser(), registrationError: {
    response: { status: 422, data: { detail: [{
      type: 'value_error', loc: ['body', 'email'],
      msg: 'value is not a valid email address', input: 'qa@example',
    }] } },
  } })
  const result = await app.store.getState().register('qa', 'qa@example', 'password', 'captcha')
  assert.equal(result.success, false)
  assert.equal(result.error, 'Проверьте адрес почты')
  assert.equal(app.store.getState().isAuthenticated, false)
})

test('registration keeps malformed API errors and unavailable captcha safe to render', async () => {
  for (const [status, detail, expected] of [
    [422, [{ loc: ['body', 'username'], msg: 'too short' }], 'Проверьте данные регистрации и попробуйте ещё раз'],
    [400, { message: 'invalid input' }, 'Проверьте данные регистрации и попробуйте ещё раз'],
    [503, 'Captcha temporarily unavailable', 'Проверка «я не робот» сейчас недоступна — попробуйте ещё раз'],
    [400, 'Captcha verification failed', 'Подтвердите, что вы не робот, и повторите отправку'],
  ]) {
    const app = browser({ user: newUser(), registrationError: { response: { status, data: { detail } } } })
    const result = await app.store.getState().register('qa', 'qa@example.com', 'password', 'captcha')
    assert.equal(result.success, false)
    assert.equal(result.error, expected)
  }
})
