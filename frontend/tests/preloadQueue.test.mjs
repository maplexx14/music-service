import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/services/preloadQueue.js', import.meta.url), 'utf8')
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function environment({ nativeIdle = true } = {}) {
  const timers = new Map(), idleTasks = new Map(), holds = new Set()
  let id = 0, held = false
  const document = new EventTarget()
  document.hidden = false
  const window = {
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key },
    clearTimeout(key) { timers.delete(key) },
  }
  if (nativeIdle) {
    window.requestIdleCallback = (fn) => { const key = ++id; idleTasks.set(key, { fn }); return key }
    window.cancelIdleCallback = (key) => idleTasks.delete(key)
  }
  const context = vm.createContext({ window, document })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => new vm.SyntheticModule(['heavyAnimationsHeld', 'onHeavyAnimationsHold'], function () {
    this.setExport('heavyAnimationsHeld', () => held)
    this.setExport('onHeavyAnimationsHold', (fn) => { holds.add(fn); return () => holds.delete(fn) })
  }, { context }))
  await module.evaluate()
  const run = (tasks) => {
    const entry = tasks.entries().next().value
    assert.ok(entry, 'Expected scheduled task')
    tasks.delete(entry[0])
    entry[1].fn()
  }
  return {
    timers, idleTasks, holds,
    start: module.namespace.preloadInIdle,
    delay: () => run(timers),
    idle: () => run(nativeIdle ? idleTasks : timers),
    hold(value) { held = value; for (const fn of holds) fn(value) },
    hide(value) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')) },
  }
}

for (const nativeIdle of [true, false]) {
  test(`preloading waits for the first screen and runs one import at a time (idle=${nativeIdle})`, async () => {
    const app = await environment({ nativeIdle })
    const calls = []
    let finish
    const cancel = app.start([
      () => { calls.push('first'); return new Promise((resolve) => { finish = resolve }) },
      () => calls.push('second'),
    ])
    assert.equal(app.timers.values().next().value.ms, 800)
    assert.equal(app.idleTasks.size, 0)
    app.delay()
    app.idle()
    await tick()
    assert.deepEqual(calls, ['first'])
    assert.equal(app.idleTasks.size + app.timers.size, 0)
    finish()
    await tick()
    app.idle()
    await tick()
    assert.deepEqual(calls, ['first', 'second'])
    assert.equal(app.idleTasks.size + app.timers.size, 0)
    cancel()
    assert.equal(app.holds.size, 0)
  })
}

test('swiping and backgrounding cancel scheduled imports and resume only when both end', async () => {
  const app = await environment()
  const calls = []
  const cancel = app.start([() => calls.push('loaded')])
  app.delay()
  app.hold(true)
  assert.equal(app.idleTasks.size, 0)
  app.hide(true)
  app.hold(false)
  assert.equal(app.idleTasks.size, 0)
  app.hide(false)
  assert.equal(app.idleTasks.size, 1)
  app.hide(true)
  assert.equal(app.idleTasks.size, 0)
  app.hide(false)
  app.idle()
  await tick()
  assert.deepEqual(calls, ['loaded'])
  cancel()
})

test('failed imports do not block the queue and cleanup prevents further work', async () => {
  const app = await environment()
  let calls = 0
  const cancel = app.start([() => { throw new Error('offline') }, () => calls++])
  app.delay()
  app.idle()
  await tick()
  assert.equal(app.idleTasks.size, 1)
  cancel()
  app.hold(true)
  app.hold(false)
  app.hide(true)
  app.hide(false)
  assert.equal(app.idleTasks.size + app.timers.size, 0)
  assert.equal(calls, 0)
})

test('an import resolving after unmount cannot start the next import', async () => {
  const app = await environment()
  let finish
  let calls = 0
  const cancel = app.start([
    () => new Promise((resolve) => { finish = resolve }),
    () => calls++,
  ])
  app.delay()
  app.idle()
  await tick()
  cancel()
  finish()
  await tick()
  assert.equal(calls, 0)
  assert.equal(app.idleTasks.size + app.timers.size, 0)
})
