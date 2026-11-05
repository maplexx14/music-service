import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { getSwipePhase, onSwipePhase, setSwipePhase } from '../src/utils/swipeActivity.js'

const BUILD = '2026-11-05T20:00'
const REPORT_KEY = 'bolt-frame-meter-report'
const source = await readFile(new URL('../src/utils/frameMeter.js', import.meta.url), 'utf8')
const { code } = await transform(source, {
  format: 'cjs', target: 'es2020',
  define: { 'import.meta.env.VITE_BUILD_TIME': JSON.stringify(BUILD) },
})
const script = new vm.Script(code, { filename: 'frameMeter.js' })

function mountMeter(report) {
  const storage = new Map(report ? [[REPORT_KEY, JSON.stringify(report)]] : [])
  const listeners = new Map()
  const frames = []
  let now = 0
  const modules = {
    '../store/playerStore': { usePlayerStore: { getState: () => ({ isPlaying: false }), subscribe: () => () => {} } },
    '../services/pressFeedback': { PRESSABLE: 'button', SCROLLABLE: '.screen-scroll' },
    '../services/fastTap': { fastTapReleasedAt: () => 0, isFastTapClick: () => false },
    './swipeActivity': { getSwipePhase, onSwipePhase },
  }
  const module = { exports: {} }
  script.runInContext(vm.createContext({
    module, exports: module.exports,
    require(name) { assert.ok(modules[name], `Unexpected import: ${name}`); return modules[name] },
    performance: { now: () => now },
    Element: class {},
    document: {
      hidden: false, documentElement: { classList: { contains: () => false } }, querySelector: () => null,
      addEventListener(name, fn) { listeners.set(name, fn) },
      removeEventListener(name) { listeners.delete(name) },
    },
    window: { location: { pathname: '/search' }, devicePixelRatio: 3, addEventListener() {}, removeEventListener() {} },
    screen: { width: 390, height: 844 },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    sessionStorage: { getItem: () => null },
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout() { return 1 }, clearTimeout() {},
  }))
  return {
    ...module.exports,
    frame(time) { now = time; const pending = frames.splice(0); pending.forEach((fn) => fn(time)) },
    touch(type) { listeners.get(type)?.({ touches: [], type, timeStamp: now }) },
    report: () => JSON.parse(storage.get(REPORT_KEY)),
    cleanup() { module.exports.setFrameMeterEnabled(false); setSwipePhase(null) },
  }
}

test('Short gesture samples contribute to both the report table and its totals', () => {
  const app = mountMeter({
    build: BUILD, startedAt: Date.now(),
    stats: {
      'покой · search': { frames: 55, janky: 1, missed: 1, long: 0, worst: 28 },
      'жест · liked': { frames: 12, janky: 2, missed: 6, long: 2, worst: 68 },
    },
  })
  const report = app.formatFrameMeter()
  assert.match(report, /Всего: 67 кадров, рывков 4\.5%, пропущено кадров 9\.5%/)
  assert.match(report, /жест · liked \| 12 \| 16\.7% \| 33\.3% \| 2 \| 68мс/)
  assert.ok(report.startsWith(`Сборка: ${BUILD} UTC\n`))
})

test('A new build cannot label measurements from an older build as its own', (t) => {
  const app = mountMeter({
    build: '2026-11-04T20:00', startedAt: Date.now() - 60000,
    stats: { 'жест · home': { frames: 100, janky: 10, missed: 20, long: 5, worst: 90 } },
  })
  t.after(app.cleanup)
  assert.equal(app.formatFrameMeter(), '')
  app.setFrameMeterEnabled(true)
  app.frame(100)
  app.frame(117)
  const report = app.formatFrameMeter()
  assert.match(report, /Всего: 1 кадров, рывков 0\.0%, пропущено кадров 0\.0%/)
  assert.doesNotMatch(report, /жест · home/)
  assert.equal(app.report().build, BUILD)
})

test('A released swipe remains a settle after the touch activity timeout, with separate preparation and hold phases', (t) => {
  const app = mountMeter()
  t.after(app.cleanup)
  app.setFrameMeterEnabled(true)
  app.frame(100)
  app.touch('touchmove')
  setSwipePhase('prepare')
  app.frame(116)
  setSwipePhase('settle')
  app.frame(250)
  setSwipePhase('hold')
  app.frame(267)
  setSwipePhase(null)
  app.frame(284)
  app.formatFrameMeter()
  const { stats, worst } = app.report()
  assert.equal(stats['свайп: подготовка доезда · search'].frames, 1)
  assert.equal(stats['свайп: доезд · search'].worst, 134)
  assert.equal(stats['свайп: удержание · search'].frames, 1)
  assert.equal(stats['покой · search'].frames, 1)
  assert.match(worst[0].ev, /свайп: подготовка доезда/)
  assert.match(worst[0].ev, /свайп: доезд/)
})
