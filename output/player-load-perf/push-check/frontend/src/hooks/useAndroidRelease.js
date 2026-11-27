import { useEffect, useState } from 'react'
import { parseAndroidRelease } from '../services/androidRelease'

const CHECK_INTERVAL_MS = 15 * 60 * 1000
let cachedRelease = null
let checkedAt = 0
let pending = null

function fetchRelease() {
  if (cachedRelease && Date.now() - checkedAt < CHECK_INTERVAL_MS) return Promise.resolve(cachedRelease)
  if (pending) return pending

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  pending = fetch('/bolt-version.json', { cache: 'no-store', signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('Android release unavailable')
      const release = parseAndroidRelease(await response.json())
      if (!release) throw new Error('Invalid Android release')
      cachedRelease = release
      checkedAt = Date.now()
      return release
    })
    .finally(() => {
      clearTimeout(timeout)
      pending = null
    })
  return pending
}

export default function useAndroidRelease(enabled = true) {
  const [release, setRelease] = useState(() => cachedRelease)

  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    const check = () => {
      fetchRelease().then((latest) => {
        if (active) setRelease(latest)
      }).catch(() => {
        // Фоновая проверка не мешает слушать музыку при недоступной сети.
      })
    }
    const checkVisible = () => {
      if (!document.hidden) check()
    }
    check()
    const timer = setInterval(checkVisible, CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', checkVisible)
    return () => {
      active = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', checkVisible)
    }
  }, [enabled])

  return release
}
