import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/services/audioVisualization.js', import.meta.url), 'utf8')
const settle = (reader, playing = true, frames = 10) => {
  let result
  for (let i = 0; i < frames; i += 1) result = reader.read(0.1, playing)
  return result
}

async function mount({ supported = true, suspended = false } = {}) {
  const listeners = new Map()
  const contexts = []
  const captures = []
  const elements = [0.15, 0.03].map((amplitude, i) => {
    const element = { currentSrc: `/track-${i}.mp3`, paused: false, ended: false, readyState: 4, volume: 1, muted: false, amplitude }
    if (supported) element.captureStream = () => {
      const track = { readyState: 'live', stops: 0, stop() { this.readyState = 'ended'; this.stops += 1 } }
      const stream = { element, getAudioTracks: () => [track], getTracks: () => [track] }
      captures.push({ track, stream })
      return stream
    }
    return element
  })
  let active = elements[0]
  const context = vm.createContext({
    window: { AudioContext: class {
      constructor() { this.state = suspended ? 'suspended' : 'running'; contexts.push(this) }
      resume() { this.state = 'running'; this.resumes = (this.resumes || 0) + 1; return Promise.resolve() }
      suspend() { this.state = 'suspended'; return Promise.resolve() }
      close() { this.state = 'closed'; return Promise.resolve() }
      createMediaElementSource() { assert.fail('The audible output must stay on the original media element') }
      createMediaStreamSource(stream) {
        return { connect(analyser) { analyser.element = stream.element }, disconnect() {} }
      }
      createAnalyser() {
        return { disconnect() {}, getFloatTimeDomainData(samples) {
          for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 ? this.element.amplitude : -this.element.amplitude
        } }
      }
    } },
    document: {
      addEventListener(type, fn) { listeners.set(type, fn) },
      removeEventListener(type) { listeners.delete(type) },
    },
  })
  const engine = new vm.SyntheticModule(['getActive'], function () {
    this.setExport('getActive', () => active)
  }, { context })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => engine)
  await module.evaluate()
  return {
    reader: module.namespace.createWaveformReader(8), contexts, captures, elements, listeners,
    swap() { active = elements[1] },
  }
}

test('waveform follows measured audio energy and falls back to zero on silence', async () => {
  const { reader, elements, contexts, captures } = await mount()
  const first = reader.read(0.1)
  assert.ok(first.level > 0.2 && first.level < 0.3, 'The initial rise is gentle')
  const loud = settle(reader)
  assert.ok(loud.level > 0.59 && loud.level < 0.61)
  assert.ok(loud.values.every((value) => value > 0.56 && value < 0.61))
  elements[0].amplitude = 0
  const releasing = reader.read(0.1)
  assert.ok(releasing.level > 0.45, 'Release lasts longer than attack')
  const quiet = settle(reader, true, 30)
  assert.ok(quiet.level < 0.002)
  assert.ok(quiet.values.every((value) => value < 0.002))
  assert.equal(contexts.length, 1)
  assert.equal(captures.length, 1)
  reader.dispose()
})

test('slot and URL changes discard the previous signal and analyse the active track', async () => {
  const { reader, swap, captures, contexts, elements } = await mount()
  reader.read(0.1)
  swap()
  const next = settle(reader)
  assert.equal(captures[0].track.stops, 1)
  assert.ok(next.values.every((value) => value < 0.12))
  assert.ok(next.level > 0.11 && next.level < 0.13)
  elements[1].currentSrc = '/third.mp3'
  reader.read(0.1)
  assert.equal(captures[1].track.stops, 1)
  assert.equal(captures.length, 3)
  assert.equal(contexts.length, 1)
  reader.dispose()
})

test('pausing stops captured tracks and user gestures cannot restart inactive analysis', async () => {
  const { reader, contexts, captures, listeners } = await mount()
  reader.read(0.1)
  reader.pause()
  assert.equal(captures[0].track.stops, 1)
  assert.equal(contexts[0].state, 'suspended')
  listeners.get('pointerdown')()
  assert.equal(contexts[0].state, 'suspended')
  assert.ok(reader.read(0.1, false).values.every((value) => value === 0))
  reader.read(0.1)
  await Promise.resolve()
  assert.equal(contexts[0].state, 'running')
  assert.equal(captures.length, 2)
  reader.dispose()
  assert.equal(contexts[0].state, 'closed')
  assert.equal(listeners.size, 0)
})

test('missing capture support leaves playback untouched and a static waveform', async () => {
  const { reader, contexts, elements } = await mount({ supported: false })
  const { values, level } = reader.read(0.1)
  assert.equal(reader.supported, false)
  assert.equal(level, 0)
  assert.ok(values.every((value) => value === 0))
  assert.equal(contexts.length, 0)
  assert.equal(elements[0].paused, false)
  assert.equal(elements[0].currentSrc, '/track-0.mp3')
  reader.dispose()
})

test('buffering, mute and ended media cannot produce a playing waveform', async () => {
  for (const patch of [{ readyState: 1 }, { muted: true }, { volume: 0 }, { paused: true }, { ended: true }]) {
    const { reader, elements, contexts } = await mount()
    Object.assign(elements[0], patch)
    assert.equal(reader.read(0.1).level, 0)
    assert.equal(contexts.length, 0)
    reader.dispose()
  }
})

test('ended capture tracks are recreated for Firefox without replacing the player', async () => {
  const { reader, captures, elements } = await mount()
  reader.read(0.1)
  captures[0].track.readyState = 'ended'
  assert.ok(settle(reader).level > 0.5)
  assert.equal(captures.length, 2)
  assert.equal(elements[0].paused, false)
  reader.dispose()
})

test('analysis resumes after a browser context interruption while the track keeps playing', async () => {
  const { reader, contexts, captures } = await mount()
  reader.read(0.1)
  contexts[0].state = 'suspended'
  reader.read(0.1)
  await Promise.resolve()
  assert.equal(contexts[0].state, 'running')
  assert.equal(captures.length, 1)
  assert.ok(settle(reader).level > 0.5)
  reader.dispose()
})
