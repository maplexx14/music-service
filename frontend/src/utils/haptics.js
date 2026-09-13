// Тактильный отклик как в нативных приложениях. navigator.vibrate есть
// только на Android/Chromium (iOS PWA его не отдаёт — там откат молчит,
// это норма). Паттерны короткие: «селект» на тапах, «успех» — на действие,
// которое что-то изменило (лайк, добавление в плейлист).
export function haptic(pattern = 10) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch {
    /* iOS/Some browsers throw on vibrate — не критично */
  }
}

export const HAPTIC = {
  selection: 8,
  light: 12,
  success: [14, 40, 22],
}
