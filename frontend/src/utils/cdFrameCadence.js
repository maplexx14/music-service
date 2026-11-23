// Chassis motion gets every display refresh. Resting playback keeps its rate
// budget; core count must not turn hardware-accelerated motion into 24 fps.
export function createCdFrameCadence() {
  let nextPlaybackDraw = 0
  return {
    shouldRender(at, fps = 60, immediate = false, moving = false) {
      if (moving) return true
      const interval = 1000 / fps
      if (!immediate && at + 1 < nextPlaybackDraw) return false
      nextPlaybackDraw = immediate || nextPlaybackDraw === 0 ? at + interval
        : nextPlaybackDraw + interval * Math.max(1, Math.floor((at - nextPlaybackDraw) / interval) + 1)
      return true
    },
  }
}
