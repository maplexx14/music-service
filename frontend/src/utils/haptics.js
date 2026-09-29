// Тактильный отклик как в нативных приложениях. navigator.vibrate есть
// только на Android/Chromium. На iOS его нет, но Safari 18+ сам даёт
// системный «тик», когда переключается <input type="checkbox" switch>, —
// переключаем невидимый свитч через его label. Работает только внутри
// пользовательского жеста (клик, touchend), вне его iOS молчит — это норма.
// Паттерны короткие: «селект» на тапах, «успех» — на действие, которое что-то
// изменило (лайк, добавление в плейлист). iOS-тик один на любой паттерн.
let iosSwitchLabel = null

function iosTick() {
  if (typeof document === 'undefined' || !document.body) return
  if (!iosSwitchLabel) {
    const label = document.createElement('label')
    label.setAttribute('aria-hidden', 'true')
    label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px;top:0'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    label.appendChild(input)
    // Клик по свитчу — служебный: наружу он не всплывает, иначе закрывал бы
    // меню, слушающие click на document.
    label.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('click', (e) => e.stopPropagation())
    document.body.appendChild(label)
    iosSwitchLabel = label
  }
  iosSwitchLabel.click()
}

export function haptic(pattern = 10) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
      return
    }
    iosTick()
  } catch {
    /* Некоторые браузеры бросают на vibrate — не критично */
  }
}

export const HAPTIC = {
  selection: 8,
  light: 12,
  success: [14, 40, 22],
}
