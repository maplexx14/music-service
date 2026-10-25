// Связь с Android-оболочкой (android/, мост assets/bridge.js). В браузере и
// PWA всё здесь — пустые вызовы.
import { usePlayerStore } from '../store/playerStore'

export const isAndroidApp = () => typeof window !== 'undefined' && !!window.__boltAndroid

// Действие из ярлыка на иконке приложения: оболочка открывает /?app=<действие>.
export function runAppAction(action) {
  if (action !== 'wave') return
  const st = usePlayerStore.getState()
  // Поток уже идёт — только снять с паузы, не пересоздавая очередь.
  if (st.flowActive && st.currentTrack) {
    if (!st.isPlaying) st.togglePlayPause()
    return
  }
  st.startFlow().catch((error) => console.error('Flow start error:', error))
}

// Лайк и дизлайк на системном плеере (уведомление, экран блокировки):
// оболочке нужно знать, залито ли сердце у текущего трека.
export function sendTrackFeedback(liked, disliked) {
  window.__boltSetFeedback?.(!!liked, !!disliked)
}
