import { shallow } from 'zustand/shallow'
import { usePlayerStore } from '../store/playerStore'
import { isDislikedTrack, queueStep } from '../utils/playerQueue'
import HeroDisc from './HeroDisc'
import './FlowDiscArc.css'

const OFFSETS = [-1, 0, 1]
const X = [0, 36]
const MOBILE_X = [0, 58]
const SCALE = [1, 0.68]
const EMPTY_TRACKS = []

function trackKey(track) {
  return track?.id != null ? `${track.source || 'local'}:${track.id}` : track?.cover_url
}

// Stable track keys let each record travel to its new place on a track change.
// Queue previews share the player's shuffle and dislike rules.
export default function FlowDiscArc({ tracks = EMPTY_TRACKS, playing }) {
  const state = usePlayerStore((s) => ({
    currentTrack: s.currentTrack,
    queue: s.queue,
    currentIndex: s.currentIndex,
    isShuffle: s.isShuffle,
    shuffledOrder: s.shuffledOrder,
    currentShuffleIndex: s.currentShuffleIndex,
    dislikedTrackIds: s.dislikedTrackIds,
    dislikedTrackKeys: s.dislikedTrackKeys,
    flowPreload: s.flowPreload,
  }), shallow)
  const candidates = [...(state.flowPreload?.tracks || EMPTY_TRACKS), ...tracks, ...state.queue]
    .filter((track) => !isDislikedTrack(state, track))
  const center = state.currentTrack || candidates[0]
  const used = new Set([trackKey(center)])
  const slots = new Map([[0, center]])

  for (const offset of OFFSETS) {
    if (offset === 0 || !state.currentTrack) continue
    const step = queueStep(state, Math.sign(offset), Math.abs(offset))
    const track = step ? state.queue[step.index] : null
    const key = trackKey(track)
    if (!key || used.has(key)) continue
    slots.set(offset, track)
    used.add(key)
  }

  // Keep the arc populated before playback and at the ends of a short queue.
  for (const offset of [0, 1, -1]) {
    if (slots.get(offset)) continue
    const track = candidates.find((candidate) => {
      const key = trackKey(candidate)
      return key && !used.has(key)
    })
    if (track) used.add(trackKey(track))
    slots.set(offset, track || { id: `placeholder:${offset}` })
  }

  return (
    <div className={`flow-disc-arc${playing ? ' is-playing' : ''}`}>
      {OFFSETS.map((offset) => {
        const distance = Math.abs(offset)
        const direction = Math.sign(offset)
        const track = slots.get(offset)
        return (
          <div
            key={trackKey(track)}
            className={`flow-disc-slot${offset === 0 ? ' is-current' : ''}`}
            style={{
              '--slot-x': `${direction * X[distance]}%`,
              '--slot-mobile-x': `${direction * MOBILE_X[distance]}%`,
              '--slot-y': offset === 0 ? '0%' : '47%',
              '--slot-scale': SCALE[distance],
              '--slot-opacity': 1 - distance * 0.12,
              zIndex: 5 - distance,
            }}
          >
            <div className="flow-disc-position">
              <HeroDisc track={track} preview={offset !== 0 || !state.currentTrack} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
