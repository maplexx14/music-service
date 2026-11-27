import { useSyncExternalStore } from 'react'

const snapshot = () => navigator.onLine === false
function subscribe(listener) {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  window.addEventListener('pageshow', listener)
  document.addEventListener('visibilitychange', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
    window.removeEventListener('pageshow', listener)
    document.removeEventListener('visibilitychange', listener)
  }
}
export const useOffline = () => useSyncExternalStore(subscribe, snapshot, () => false)
