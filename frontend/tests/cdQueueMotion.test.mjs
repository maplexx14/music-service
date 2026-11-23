import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as clock from '../src/utils/cdAnimationClock.js'

const source = await readFile(new URL('../src/components/CdQueueMotion.jsx', import.meta.url), 'utf8')
const { code } = await transform(source, { format: 'cjs', loader: 'jsx', jsx: 'automatic', target: 'es2020' })
const script = new vm.Script(`(function(module,exports,require){${code}\n})`)
const children = (keys = ['a', 'b', 'c'], metadata = '') => keys.map((key, index) =>
  React.createElement('button', { key, 'data-queue-record': key, 'data-queue-slot': index - 1, title: metadata }))

function mount({ motionClock } = {}) {
  let reads = 0, cancelled = 0, removed = 0
  const rect = { left: 0, top: 0, width: 200, height: 500 }
  const nodes = ['a', 'b', 'c'].map((key, index) => ({
    dataset: { queueRecord: key, queueSlot: String(index - 1) },
    getBoundingClientRect() { reads++; return { left: 0, top: index * 150, width: 100, height: 100 } },
    querySelector() { return null }, querySelectorAll() { return [] }, cloneNode() { return { key, querySelectorAll() { return [] } } },
  }))
  const root = {
    get clientHeight() { reads++; return 500 },
    getBoundingClientRect() { reads++; return rect },
    querySelectorAll() { return nodes }, animate() {},
  }
  const globals = {
    document: { hidden: false, removeEventListener() {} },
    getComputedStyle() {
      reads++
      return { width: '100px', height: '100px', left: '0px', top: '0px', opacity: '1',
        getPropertyValue: name => name === '--queue-slot-scale' ? '1' : '0' }
    },
  }
  const context = vm.createContext(globals)
  const module = { exports: {} }
  script.runInContext(context)(module, module.exports, name => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === '../utils/cdAnimationClock') return motionClock ? { cdAnimationClock: motionClock } : clock
    throw new Error(`Unexpected import ${name}`)
  })
  const props = { active: true, powerSave: false, position: 2, layout: 'arc', children: children() }
  const motion = new module.exports.default(props)
  motion.root.current = root
  motion.entered = motion.inViewport = true
  motion.reduced = { matches: false, removeEventListener() {} }
  const animation = { cancel() { cancelled++ }, onfinish() {} }
  const ghost = { remove() { removed++ } }
  motion.animations.add(animation)
  motion.ghosts.add(ghost)
  return { motion, props, animation, ghost, nodes, counts: () => ({ reads, cancelled, removed }) }
}

test('releasing a held disc transfer does not clone the record that has already entered the player', () => {
  const { motion, props, counts } = mount()
  motion.props = { ...props, position: props.position + 1, children: children(['b', 'c', 'd']) }
  const snapshot = motion.getSnapshotBeforeUpdate({ ...props, active: false })
  assert.equal(snapshot, null)
  assert.equal(counts().reads, 0)
})

test('a queue owned by the shared disc belt cannot create or retain an independent departing ghost', () => {
  const { motion, props, counts } = mount()
  motion.props = { ...props, navigationMotion: false, position: props.position + 1, children: children(['b', 'c', 'd']) }
  const snapshot = motion.getSnapshotBeforeUpdate(props)
  assert.equal(snapshot, null)
  motion.componentDidUpdate(props, null, snapshot)
  assert.equal(motion.ghosts.size, 0)
  assert.deepEqual(counts(), { reads: 0, cancelled: 1, removed: 1 })
})

test('a metadata or artwork rerender preserves the in-flight arc and its departing disc', () => {
  const { motion, props, animation, ghost, counts } = mount()
  motion.props = { ...props, children: children(undefined, 'new metadata') }
  const snapshot = motion.getSnapshotBeforeUpdate(props)
  motion.componentDidUpdate(props, null, snapshot)
  assert.equal(snapshot, null)
  assert.deepEqual(counts(), { reads: 0, cancelled: 0, removed: 0 })
  assert.ok(motion.animations.has(animation))
  assert.ok(motion.ghosts.has(ghost))
})

test('navigation snapshots the currently visible positions before React moves the records', () => {
  const { motion, props, counts } = mount()
  motion.props = { ...props, position: 3, children: children(['b', 'c', 'd']) }
  const snapshot = motion.getSnapshotBeforeUpdate(props)
  assert.equal(snapshot.movement, -1)
  assert.equal(snapshot.records.get('b').rect.top, 150)
  assert.equal(snapshot.records.get('a').ghost.key, 'a')
  assert.equal(snapshot.records.get('b').ghost, null)
  assert.ok(counts().reads > 0)
  assert.equal(counts().cancelled, 0)
})

test('replacing a record at the same navigation position still captures an animation snapshot', () => {
  const { motion, props } = mount()
  motion.props = { ...props, children: children(['a', 'new', 'c']) }
  assert.equal(motion.getSnapshotBeforeUpdate(props).movement, 0)
})

for (const change of [{ active: false }, { powerSave: true }, { layout: 'linear' }]) {
  test(`environment change ${JSON.stringify(change)} cancels motion even with unchanged records`, () => {
    const { motion, props, counts } = mount()
    motion.props = { ...props, ...change }
    motion.componentDidUpdate(props, null, null)
    assert.equal(counts().cancelled, 1)
    assert.equal(counts().removed, 1)
    assert.equal(motion.animations.size, 0)
    assert.equal(motion.ghosts.size, 0)
  })
}

test('unmount removes animations and ghosts', () => {
  const { motion, counts } = mount()
  motion.componentWillUnmount()
  assert.equal(counts().cancelled, 1)
  assert.equal(counts().removed, 1)
  assert.equal(motion.entered, false)
})

test('destination planning finishes before any native animation invalidates styles', () => {
  const { motion, props } = mount()
  const events = []
  const node = { animate() { events.push('animate'); return { cancel() {} } } }
  motion.motionStartedAt = 123
  motion.animateRecords = () => {
    events.push('read first')
    motion.play(node, [{ transform: 'none' }], 440)
    events.push('read second')
    motion.play(node, [{ transform: 'none' }], 440)
    assert.deepEqual(events, ['read first', 'read second'])
  }
  motion.componentDidUpdate(props, null, {})
  assert.deepEqual(events, ['read first', 'read second', 'animate', 'animate'])
  assert.equal(motion.animations.size, 2)
  assert.ok([...motion.animations].every(animation => animation.startTime === 123))
  assert.equal(motion.plans, null)
})

test('queue records run on the browser timeline and release their departing ghosts on finish', () => {
  const callbacks = new Set()
  const motionClock = { subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback) } }
  const { motion } = mount({ motionClock })
  motion.clear()
  motion.motionStartedAt = 100
  const animations = [], options = [], removed = []
  const nodes = [0, 1].map(id => ({
    animate(keyframes, timing) {
      options.push(timing)
      const animation = { pause() { this.paused = true }, cancel() { this.cancelled = true } }
      animations.push(animation)
      return animation
    },
    remove() { removed.push(id) },
  }))
  motion.ghosts.add(nodes[1])
  nodes.forEach((node, index) => motion.play(node, [{ transform: 'none' }], 440, 0, index === 1, 'cubic-bezier(0.4, 0, 0.2, 1)'))
  assert.ok(animations.every(animation => !animation.paused && animation.startTime === 100))
  assert.ok(options.every(timing => timing.easing === 'cubic-bezier(0.4, 0, 0.2, 1)'))
  assert.equal(callbacks.size, 0, 'Native queue animations need no JavaScript frames')
  animations.forEach(animation => animation.onfinish())
  assert.ok(animations.every(animation => animation.cancelled))
  assert.equal(callbacks.size, 0)
  assert.equal(motion.animations.size, 0)
  assert.equal(motion.ghosts.size, 0)
  assert.deepEqual(removed, [1])
})

test('an interrupted queue cancels native animations without retaining frame callbacks', () => {
  const callbacks = new Set()
  const motionClock = { subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback) } }
  const { motion } = mount({ motionClock })
  motion.clear()
  motion.motionStartedAt = 100
  let cancelled = false
  motion.play({ animate() { return { pause() {}, cancel() { assert.equal(callbacks.size, 0); cancelled = true } } } }, [{ transform: 'none' }], 440)
  assert.equal(callbacks.size, 0)
  motion.clear()
  assert.equal(callbacks.size, 0)
  assert.equal(cancelled, true)
})
