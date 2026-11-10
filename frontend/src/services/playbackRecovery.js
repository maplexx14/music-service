// APK-only recovery of a stream that stopped advancing after playback began.
// The existing Player watchdog calls tick(); no additional background timer.
export function createPlaybackRecovery({ audio, isCurrent, wantsPlayback, play, onRecover }) {
  let position = audio.currentTime
  let advancedAt = Date.now()
  let progressAt = Date.now()
  let attempts = 0
  let recoveryPosition = null
  let restoreMetadata = null
  let interrupted = false

  const clearRestore = () => {
    if (restoreMetadata) audio.removeEventListener('loadedmetadata', restoreMetadata)
    restoreMetadata = null
  }
  const cancel = () => {
    clearRestore()
    recoveryPosition = null
    attempts = 0
    position = audio.currentTime
    advancedAt = Date.now()
  }
  const observePosition = () => {
    if (!isCurrent() || restoreMetadata || audio.seeking) return
    const next = audio.currentTime
    if (Math.abs(next - position) < 0.01) return
    position = next
    advancedAt = Date.now()
    // 'playing' alone does not prove recovery: require actual media progress.
    if (recoveryPosition != null && next >= recoveryPosition + 3) {
      attempts = 0
      recoveryPosition = null
    }
  }
  const noteProgress = () => { progressAt = Date.now() }
  const noteSeek = () => { advancedAt = Date.now() }
  const notePause = () => {
    interrupted = position > 0 || recoveryPosition != null
    cancel()
  }
  const notePlay = () => { interrupted = false; advancedAt = Date.now() }
  audio.addEventListener('timeupdate', observePosition)
  audio.addEventListener('progress', noteProgress)
  audio.addEventListener('seeking', noteSeek)
  audio.addEventListener('pause', notePause)
  audio.addEventListener('play', notePlay)

  return {
    cancel,
    isRestoring: () => restoreMetadata != null,
    wasInterrupted: () => interrupted,
    tick() {
      if (!isCurrent() || !wantsPlayback() || audio.paused || audio.ended || !audio.src) {
        cancel()
        return false
      }
      observePosition()
      // While metadata is pending, the startup watchdog must not reload at 0.
      const pending = restoreMetadata != null
      const target = pending ? recoveryPosition : audio.currentTime
      if (!(target > 0)) return pending
      const now = Date.now()
      if (navigator.onLine === false || attempts >= 3 ||
          now - advancedAt < Math.min(12000 * 2 ** attempts, 24000) ||
          now - progressAt < 8000) return pending

      clearRestore()
      const source = audio.src
      recoveryPosition = target
      attempts += 1
      advancedAt = progressAt = now
      const restore = () => {
        clearRestore()
        if (!isCurrent() || audio.src !== source || !wantsPlayback() || audio.paused) return
        try { audio.currentTime = target } catch { /* Retry only on a later watchdog tick. */ }
        position = audio.currentTime
        advancedAt = Date.now()
      }
      restoreMetadata = restore
      audio.addEventListener('loadedmetadata', restore)
      onRecover({ position: target, attempt: attempts })
      audio.load()
      // Chromium remembers a seek made before metadata as its default start
      // position. Also restore on metadata for media formats that need it.
      // This preserves the position even if the user pauses during the load.
      try { audio.currentTime = target } catch { /* Metadata callback will retry. */ }
      play()
      return true
    },
    dispose() {
      clearRestore()
      audio.removeEventListener('timeupdate', observePosition)
      audio.removeEventListener('progress', noteProgress)
      audio.removeEventListener('seeking', noteSeek)
      audio.removeEventListener('pause', notePause)
      audio.removeEventListener('play', notePlay)
    },
  }
}
