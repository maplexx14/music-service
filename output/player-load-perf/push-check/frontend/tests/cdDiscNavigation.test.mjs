import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdDiscNavigation } from '../src/utils/cdDiscNavigation.js'

function environment(shuffledOrder = [], deferFirst = false) {
  const queue = ['a', 'b', 'c', 'd'].map(id => ({ id }))
  const state = position => ({ queue, currentIndex: shuffledOrder[position] ?? position,
    currentTrack: queue[shuffledOrder[position] ?? position], currentShuffleIndex: position,
    isShuffle: shuffledOrder.length > 0, shuffledOrder })
  const moves = [], applied = [], frames = new Map()
  let sequence = 0, expedited = 0
  const navigation = createCdDiscNavigation({
    initial: state(0), apply: next => applied.push(next.currentTrack.id),
    move(direction, previous, next, done) {
      moves.push({ direction, from: previous.currentTrack.id, to: next.currentTrack.id, done })
      if (deferFirst && moves.length === 1) return false
    },
    expedite() { expedited++ },
    schedule(callback) { frames.set(++sequence, callback); return sequence }, cancel: id => frames.delete(id),
  })
  const tick = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback() }
  return { navigation, moves, applied, frames, state, tick, expedited: () => expedited }
}

test('rapid skips keep the moving belt intact and advance its real visible neighbors toward the latest track', () => {
  const env = environment()
  env.navigation.request(env.state(1))
  env.navigation.request(env.state(2))
  env.navigation.request(env.state(3))
  assert.deepEqual(env.moves.map(({ from, to }) => [from, to]), [['a', 'b']])
  assert.equal(env.expedited(), 2)
  env.moves[0].done()
  env.moves[0].done()
  assert.equal(env.frames.size, 1, 'A queued completion cannot repeat the handoff')
  env.tick()
  env.moves[1].done()
  env.tick()
  env.moves[2].done()
  env.tick()
  assert.deepEqual(env.moves.map(({ from, to }) => [from, to]), [['a', 'b'], ['b', 'c'], ['c', 'd']])
  assert.equal(env.applied.at(-1), 'd')
  assert.equal(env.navigation.isBusy(), false)
})

test('a quick reversal uses the disc that actually arrived instead of the audio state of a skipped request', () => {
  const env = environment()
  env.navigation.request(env.state(1))
  env.navigation.request(env.state(2))
  env.navigation.request(env.state(0))
  env.moves[0].done()
  env.tick()
  assert.deepEqual(env.moves.map(({ direction, from, to }) => [direction, from, to]), [[1, 'a', 'b'], [-1, 'b', 'a']])
  env.moves[1].done()
  env.tick()
  assert.equal(env.applied.at(-1), 'a')
  assert.equal(env.navigation.isBusy(), false)
})

test('catching up follows the shuffled order of the visible queue', () => {
  const env = environment([2, 0, 3, 1])
  env.navigation.request(env.state(3))
  for (let index = 0; index < 3; index++) { env.moves[index].done(); env.tick() }
  assert.deepEqual(env.moves.map(({ from, to }) => [from, to]), [['c', 'a'], ['a', 'd'], ['d', 'b']])
  assert.equal(env.applied.at(-1), 'b')
})

test('disposal cancels pending navigation and ignores the old belt completion', () => {
  const env = environment()
  env.navigation.request(env.state(1))
  env.navigation.dispose()
  env.moves[0].done()
  env.tick()
  assert.deepEqual(env.applied, [])
  assert.equal(env.frames.size, 0)
})

test('a queue that has not committed its next disc is retried without changing the visible track', () => {
  const env = environment([], true)
  env.navigation.request(env.state(1))
  assert.deepEqual(env.applied, [])
  assert.equal(env.frames.size, 1)
  env.tick()
  assert.deepEqual(env.moves.map(({ from, to }) => [from, to]), [['a', 'b'], ['a', 'b']])
  env.moves[1].done()
  env.tick()
  assert.equal(env.applied.at(-1), 'b')
  assert.equal(env.navigation.isBusy(), false)
})
