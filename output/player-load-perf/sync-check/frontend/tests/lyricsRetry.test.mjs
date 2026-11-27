import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/hooks/useLyrics.js', import.meta.url), 'utf8')

async function mountLyrics(get) {
  let current, now = 0
  const instances = [], timers = []
  function memo(factory, deps) {
    const index = current.index++
    const old = current.hooks[index]
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
      current.hooks[index] = { value: factory(), deps }
    }
    return current.hooks[index].value
  }
  const react = {
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useState(initial) {
      const instance = current, index = instance.index++
      const hook = instance.hooks[index] ||= { value: initial }
      return [hook.value, (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (!Object.is(value, hook.value)) { hook.value = value; instance.dirty = true }
      }]
    },
    useEffect(fn, deps) {
      const instance = current, index = instance.index++
      const old = instance.hooks[index]
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        instance.hooks[index] = { deps, cleanup: old?.cleanup }
        instance.effects.push(() => {
          instance.hooks[index].cleanup?.()
          instance.hooks[index].cleanup = fn()
        })
      }
    },
  }
  const context = vm.createContext({
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, delay) => timers.push({ fn, at: now + delay }),
  })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(async (name) => {
    const exports = name === 'react' ? react : name.endsWith('/api') ? { default: { get } } : { getActive: () => null }
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  function render() {
    for (const instance of instances) {
      if (!instance.dirty) continue
      instance.dirty = false
      current = instance
      instance.index = 0
      instance.result = module.namespace.useLyrics(instance.track)
      for (const effect of instance.effects.splice(0)) effect()
    }
  }
  async function settle() {
    for (let i = 0; i < 15; i++) { render(); await Promise.resolve() }
  }
  return {
    async add(track) {
      const instance = { track, hooks: [], effects: [], dirty: true }
      instances.push(instance)
      await settle()
      return instance
    },
    settle,
    async advance(ms) {
      now += ms
      for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i].at <= now) timers.splice(i, 1)[0].fn()
      }
      await settle()
    },
  }
}

test('one retry honors Retry-After, deduplicates the request and refreshes every lyrics panel', async () => {
  let calls = 0
  const app = await mountLyrics(async () => {
    if (++calls === 1) throw { response: { status: 502, headers: { 'retry-after': '5' } } }
    return { data: { plain: 'Recovered lyrics' } }
  })
  const a = await app.add({ artist: 'A', title: 'Song' })
  const b = await app.add({ artist: 'A', title: 'Song' })
  // The second mounting retries a temporary failure after the cooldown.
  assert.equal(calls, 1)
  a.result.retry()
  await app.settle()
  assert.equal(a.result.loading, true)
  assert.equal(b.result.loading, true)
  await app.advance(4999)
  assert.equal(calls, 1)
  await app.advance(1)
  assert.equal(calls, 2)
  for (const panel of [a, b]) {
    assert.equal(panel.result.plainText, 'Recovered lyrics')
    assert.equal(panel.result.error, null)
    assert.equal(panel.result.loading, false)
  }
})

test('late lyrics from the previous track cannot replace the current lyrics', async () => {
  let finishOld
  const app = await mountLyrics((_url, { params }) => params.title === 'Old'
    ? new Promise((resolve) => { finishOld = resolve })
    : Promise.resolve({ data: { plain: 'Current lyrics' } }))
  const panel = await app.add({ artist: 'A', title: 'Old' })
  panel.track = { artist: 'A', title: 'New' }
  panel.dirty = true
  await app.settle()
  finishOld({ data: { plain: 'Stale lyrics' } })
  await app.settle()
  assert.equal(panel.result.plainText, 'Current lyrics')
})
