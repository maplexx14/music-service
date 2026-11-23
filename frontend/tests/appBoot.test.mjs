import assert from 'node:assert/strict'
import test from 'node:test'
import { finishAppBoot } from '../src/services/appBoot.js'

function environment(t) {
  const previousWindow = globalThis.window
  const previousObserver = globalThis.MutationObserver
  const state = { content: false, pageLoading: false, deckLoading: false }
  const frames = new Map(), timers = new Map()
  let id = 0, notify, hidden = 0, disconnected = false
  const screen = {
    get firstElementChild() { return state.content ? {} : null },
    querySelector: () => state.pageLoading || state.deckLoading ? {} : null,
  }
  const root = { querySelector: () => screen }
  globalThis.MutationObserver = class {
    constructor(callback) { notify = callback }
    observe() {}
    disconnect() { disconnected = true }
  }
  globalThis.window = {
    __bootSplashHide: () => { hidden += 1 },
    requestAnimationFrame(callback) { const key = ++id; frames.set(key, callback); return key },
    cancelAnimationFrame: (key) => frames.delete(key),
    setTimeout(callback, ms) { const key = ++id; timers.set(key, { callback, ms }); return key },
    clearTimeout: (key) => timers.delete(key),
  }
  t.after(() => { globalThis.window = previousWindow; globalThis.MutationObserver = previousObserver })
  finishAppBoot(root)
  return {
    update(values) { Object.assign(state, values); notify() },
    paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()) },
    expire() { for (const { callback, ms } of [...timers.values()]) { assert.equal(ms, 12000); callback() } },
    get hidden() { return hidden },
    get disconnected() { return disconnected },
  }
}

test('the launch splash waits for the initial page and CD renderer, then leaves a paint before hiding', (t) => {
  const app = environment(t)
  app.update({ content: true, pageLoading: true })
  app.paint()
  assert.equal(app.hidden, 0)
  app.update({ pageLoading: false, deckLoading: true })
  app.paint()
  assert.equal(app.hidden, 0)
  app.update({ deckLoading: false })
  app.paint()
  assert.equal(app.hidden, 0)
  app.paint()
  assert.equal(app.hidden, 1)
  assert.equal(app.disconnected, true)
})

test('a page that suspends again before the next paint keeps the splash', (t) => {
  const app = environment(t)
  app.update({ content: true })
  app.paint()
  app.update({ pageLoading: true })
  app.paint()
  assert.equal(app.hidden, 0)
  app.update({ pageLoading: false })
  app.paint()
  app.paint()
  assert.equal(app.hidden, 1)
})

test('stalled initialization eventually exposes the application retry UI', (t) => {
  const app = environment(t)
  app.update({ content: true, deckLoading: true })
  app.expire()
  assert.equal(app.hidden, 1)
  assert.equal(app.disconnected, true)
  app.update({ deckLoading: false })
  app.paint()
  app.paint()
  assert.equal(app.hidden, 1)
})
