import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/hooks/useDiscCover.js', import.meta.url), 'utf8')
const cacheSource = await readFile(new URL('../src/utils/coverCache.js', import.meta.url), 'utf8')

async function mount(url = '/cover.jpg', upgradeUrl = null, { known = [], ...options } = {}) {
  const images = [], hooks = []
  let index = 0, result, effects = []
  let props = [url, upgradeUrl, 'auto', options]
  const react = {
    useState(initial) {
      const position = index++
      const state = hooks[position] ||= { value: initial }
      return [state.value, (next) => {
        state.value = typeof next === 'function' ? next(state.value) : next
      }]
    },
    useEffect(fn, deps) {
      const position = index++, previous = hooks[position]
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      hooks[position] = { deps, cleanup: previous?.cleanup }
      effects.push(() => {
        hooks[position].cleanup?.()
        hooks[position].cleanup = fn()
      })
    },
  }
  const context = vm.createContext({
    Image: class {
      constructor() {
        this.naturalWidth = 0
        this.decoded = new Promise((resolve, reject) => {
          this.finishDecode = resolve
          this.failDecode = reject
        })
        images.push(this)
      }
      decode() { return this.decoded }
      load() { this.naturalWidth = 300; this.onload?.() }
    },
  })
  const cache = new vm.SourceTextModule(cacheSource, { context })
  await cache.link(() => {})
  await cache.evaluate()
  for (const url of known) cache.namespace.markCoverReady(url)
  const module = new vm.SourceTextModule(source, { context })
  await module.link((name) => name === '../utils/coverCache' ? cache : new vm.SyntheticModule(Object.keys(react), function () {
    for (const [key, value] of Object.entries(react)) this.setExport(key, value)
  }, { context }))
  await module.evaluate()
  function render() {
    index = 0
    result = module.namespace.useDiscCover(...props)
    for (const effect of effects.splice(0)) effect()
  }
  async function settle() {
    for (let i = 0; i < 5; i++) { await Promise.resolve(); render() }
  }
  render()
  return {
    images,
    cache: cache.namespace,
    get result() { return result.src },
    get settled() { return result.settled },
    get upgradeSettled() { return result.upgradeSettled },
    async props(...next) { props = next; render(); await settle() },
    settle,
    async ready(image = images.at(-1)) {
      image.load()
      image.finishDecode()
      await settle()
    },
    unmount() { for (const hook of hooks) hook.cleanup?.() },
  }
}

test('artwork remains hidden until download and decoding both finish', async () => {
  const app = await mount()
  assert.equal(app.result, null)
  assert.equal(app.settled, false)
  app.images[0].load()
  await app.settle()
  assert.equal(app.result, null)
  app.images[0].finishDecode()
  await app.settle()
  assert.equal(app.result, '/cover.jpg')
  assert.equal(app.settled, true)
})

test('cached compact artwork is visible on the first render without a new download', async () => {
  const app = await mount('/cover.jpg', null, { known: ['/cover.jpg'] })
  assert.equal(app.result, '/cover.jpg')
  assert.equal(app.settled, true)
  assert.equal(app.images.length, 0)
})

test('cached full artwork is visible before effects update the disc state', async () => {
  const app = await mount('/small.jpg', '/full.jpg', { known: ['/full.jpg'], allowUpgrade: false })
  assert.equal(app.result, '/full.jpg')
  assert.equal(app.settled, true)
})

test('missing artwork and failed downloads never reveal a placeholder', async () => {
  const empty = await mount(null)
  assert.equal(empty.images.length, 0)
  assert.equal(empty.result, null)
  assert.equal(empty.settled, true)
  const failed = await mount()
  await failed.settle()
  assert.equal(failed.result, null)
  assert.equal(failed.settled, false)
  failed.images[0].load()
  failed.images[0].failDecode(new Error('Invalid image'))
  await failed.settle()
  assert.equal(failed.result, null)
  assert.equal(failed.settled, true)
})

test('a failed download settles so it cannot block the rest of the stack', async () => {
  const app = await mount()
  app.images[0].onerror()
  await app.settle()
  assert.equal(app.result, null)
  assert.equal(app.settled, true)
})

test('a larger image loads only after the initial artwork and swaps after decode', async () => {
  const app = await mount('/card.jpg', '/full.jpg')
  assert.equal(app.images.length, 1)
  await app.ready()
  assert.equal(app.result, '/card.jpg')
  assert.equal(app.images[1].src, '/full.jpg')
  assert.equal(app.images[1].fetchPriority, 'auto')
  app.images[1].load()
  await app.settle()
  assert.equal(app.result, '/card.jpg')
  app.images[1].finishDecode()
  await app.settle()
  assert.equal(app.result, '/full.jpg')
})

test('an unsuccessful upgrade preserves the smaller artwork', async () => {
  const app = await mount('/card.jpg', '/full.jpg')
  await app.ready()
  app.images[1].load()
  app.images[1].failDecode(new Error('Invalid full image'))
  await app.settle()
  assert.equal(app.result, '/card.jpg')
  assert.equal(app.upgradeSettled, true)
})

test('a full-quality cover can recover a failed compact cover', async () => {
  const app = await mount('/small.jpg', '/full.jpg')
  assert.equal(app.upgradeSettled, false)
  app.images[0].onerror()
  await app.settle()
  assert.equal(app.result, null)
  assert.equal(app.images[1].src, '/full.jpg')
  await app.ready()
  assert.equal(app.result, '/full.jpg')
  assert.equal(app.upgradeSettled, true)
})

test('a late decode from a previous track cannot reveal the wrong artwork', async () => {
  const app = await mount('/old.jpg')
  const old = app.images[0]
  old.load()
  await app.props('/new.jpg', null)
  old.finishDecode()
  await app.settle()
  assert.equal(app.result, null)
  await app.ready()
  assert.equal(app.result, '/new.jpg')
})

test('changing tracks clears readiness and cancels a pending quality upgrade', async () => {
  const app = await mount('/old-card.jpg', '/old-full.jpg')
  await app.ready()
  const oldFull = app.images[1]
  oldFull.load()
  await app.props('/new.jpg', null)
  assert.equal(app.result, null)
  await app.ready()
  oldFull.finishDecode()
  await app.settle()
  assert.equal(app.result, '/new.jpg')
})

test('promoting a preview to the current record never downgrades ready artwork', async () => {
  const app = await mount('/card.jpg', '/full.jpg')
  await app.ready()
  await app.ready()
  await app.props('/card.jpg', '/full.jpg', 'high')
  assert.equal(app.result, '/full.jpg')
  assert.equal(app.images.length, 2, 'decoded artwork needs no new request on promotion')
  await app.settle()
  assert.equal(app.result, '/full.jpg')
})

test('a prewarmed full cover is reused before compact artwork or audio permission arrives', async () => {
  const app = await mount('/card.jpg', '/full.jpg', { known: ['/full.jpg'], allowUpgrade: false })
  await app.settle()
  assert.equal(app.result, '/full.jpg')
  assert.equal(app.settled, true)
  assert.equal(app.upgradeSettled, true)
  assert.equal(app.images.length, 1, 'reuse must not request full artwork')
  await app.ready(app.images[0])
  assert.equal(app.result, '/full.jpg', 'late compact artwork must not downgrade it')
})

test('fullscreen artwork readiness updates the disc while new downloads are gated', async () => {
  const app = await mount('/card.jpg', '/full.jpg', { allowUpgrade: false })
  await app.ready()
  assert.equal(app.images.length, 1)
  app.cache.markCoverReady('/full.jpg')
  await app.settle()
  assert.equal(app.result, '/full.jpg')
  assert.equal(app.upgradeSettled, true)
  assert.equal(app.images.length, 1)
})

test('a decoded larger fullscreen variant replaces a pending disc upgrade without a downgrade', async () => {
  const app = await mount('/card.jpg', '/full.jpg', { alternateUpgradeUrl: '/hero.jpg' })
  await app.ready()
  const full = app.images[1]
  full.load()
  app.cache.markCoverReady('/hero.jpg')
  await app.settle()
  assert.equal(app.result, '/hero.jpg')
  full.finishDecode()
  await app.settle()
  assert.equal(app.result, '/hero.jpg')
  assert.equal(app.upgradeSettled, true)
})

test('previous-track readiness and unmounted subscriptions cannot update the disc', async () => {
  const app = await mount('/old-small.jpg', '/old-full.jpg', { allowUpgrade: false })
  await app.ready()
  await app.props('/new-small.jpg', '/new-full.jpg', 'auto', { allowUpgrade: false })
  app.cache.markCoverReady('/old-full.jpg')
  await app.settle()
  assert.equal(app.result, null)
  await app.ready()
  app.unmount()
  app.cache.markCoverReady('/new-full.jpg')
  await app.settle()
  assert.equal(app.result, '/new-small.jpg')
})

test('unmounting during decoding discards the result', async () => {
  const app = await mount()
  const image = app.images[0]
  image.load()
  app.unmount()
  image.finishDecode()
  await app.settle()
  assert.equal(app.result, null)
})
