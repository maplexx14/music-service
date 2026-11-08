import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { trackKeys } from '../src/utils/playerQueue.js'

const source = await readFile(new URL('../src/utils/discTransition.js', import.meta.url), 'utf8')
const context = vm.createContext({})
const module = new vm.SourceTextModule(source, { context })
await module.link(() => new vm.SyntheticModule(['trackKeys'], function () {
  this.setExport('trackKeys', trackKeys)
}, { context }))
await module.evaluate()
const { discNavigationDirection } = module.namespace

const queue = [1, 2, 3, 4].map((id) => ({ id }))
const state = (currentIndex, extra = {}) => ({
  queue, currentTrack: queue[currentIndex], currentIndex,
  isShuffle: false, shuffledOrder: [], currentShuffleIndex: -1, ...extra,
})

test('navigation distinguishes forward skips and backward returns, including multiple skips', () => {
  assert.equal(discNavigationDirection(state(0), state(1)), 1)
  assert.equal(discNavigationDirection(state(2), state(0)), -1)
  assert.equal(discNavigationDirection(state(0), state(3)), 1)
})

test('shuffle direction follows playback order rather than queue indices', () => {
  const shuffle = (index, position) => state(index, {
    isShuffle: true, shuffledOrder: [2, 0, 3, 1], currentShuffleIndex: position,
  })
  assert.equal(discNavigationDirection(shuffle(2, 0), shuffle(0, 1)), 1)
  assert.equal(discNavigationDirection(shuffle(0, 1), shuffle(2, 0)), -1)
})

test('materializing the same external track does not animate a navigation', () => {
  const external = { id: 'ytmusic:abc', source: 'ytmusic', external_id: 'abc' }
  assert.equal(discNavigationDirection(state(0, { currentTrack: external }),
    state(0, { currentTrack: { ...external, id: 99, db_id: 99 } })), 0)
})

test('initial playback, stopped playback and an unrelated queue have no directional exit', () => {
  assert.equal(discNavigationDirection(null, state(0)), 0)
  assert.equal(discNavigationDirection(state(0), { currentTrack: null }), 0)
  assert.equal(discNavigationDirection(state(0), state(0, { currentTrack: { id: 99 } })), 0)
  assert.equal(discNavigationDirection(state(0), state(0)), 0)
})
