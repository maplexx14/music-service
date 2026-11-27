import { useEffect, useState } from 'react'
import { isCoverReady, markCoverReady, subscribeCoverReady } from '../utils/coverCache'

// Add artwork only once it can be painted. Loading a larger
// version must not replace the already decoded artwork with an empty image.
function loadCover(url, priority, onReady) {
  const image = new Image()
  let cancelled = false
  image.decoding = 'async'
  image.fetchPriority = priority
  image.onload = async () => {
    try {
      if (typeof image.decode === 'function') await image.decode()
      if (!cancelled) {
        if (image.naturalWidth > 0) {
          onReady(url)
          markCoverReady(url)
        } else onReady(null)
      }
    } catch {
      // A failed image stays hidden; an upgrade keeps the smaller artwork.
      if (!cancelled) onReady(null)
    }
  }
  image.onerror = () => { if (!cancelled) onReady(null) }
  image.src = url
  return () => {
    cancelled = true
    image.onload = null
    image.onerror = null
  }
}

export function useDiscCover(url, upgradeUrl, priority = 'auto', {
  allowUpgrade = true, alternateUpgradeUrl = null,
} = {}) {
  const [cover, setCover] = useState(null)
  const [upgradeAttempt, setUpgradeAttempt] = useState(null)
  // Decoded artwork can paint on the first render, including after remounting
  // a record. Waiting for an effect would briefly clear a cached cover again.
  const cachedSrc = url ? [alternateUpgradeUrl, upgradeUrl, url].find(isCoverReady) : null
  const src = (url && cover?.url === url && cover.src) || cachedSrc || null
  const settled = !url || Boolean(src) || cover?.url === url

  useEffect(() => {
    if (!url) return undefined
    if (isCoverReady(url)) {
      setCover((previous) => previous?.url === url && previous.src ? previous : { url, src: url })
      return undefined
    }
    return loadCover(url, priority, (src) => {
      setCover((previous) => previous?.url === url && previous.src ? previous : { url, src })
    })
  }, [url, priority])

  useEffect(() => {
    if (!url || !upgradeUrl || upgradeUrl === url) return undefined
    let stopLoad = null
    const applyCached = () => {
      const cached = [alternateUpgradeUrl, upgradeUrl].find(isCoverReady)
      if (!cached) return false
      stopLoad?.()
      setCover({ url, src: cached })
      setUpgradeAttempt(upgradeUrl)
      return true
    }
    const unsubscribe = [upgradeUrl, alternateUpgradeUrl]
      .map((candidate) => subscribeCoverReady(candidate, applyCached))
    // Ready artwork costs no bandwidth, even while audio gets its head start.
    if (!applyCached() && settled && allowUpgrade) {
      stopLoad = loadCover(upgradeUrl, 'auto', (src) => {
        setUpgradeAttempt(upgradeUrl)
        if (src) setCover((previous) => previous?.url === url ? { url, src } : previous)
      })
    }
    return () => {
      stopLoad?.()
      for (const stop of unsubscribe) stop()
    }
  }, [url, upgradeUrl, alternateUpgradeUrl, settled, allowUpgrade])

  // A different track must never inherit readiness from the previous artwork.
  return {
    src,
    settled,
    upgradeSettled: !upgradeUrl || upgradeUrl === url || upgradeAttempt === upgradeUrl,
  }
}
