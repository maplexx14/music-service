// Тактильный отклик как в нативных приложениях. navigator.vibrate есть
// только на Android/Chromium. iOS Safari его не отдаёт вообще — там
// включается звуковой fallback: короткий тик через WebAudio, чтобы
// нажатие не было «пустым». Тик играем только когда vibrate нет,
// чтобы Android-пользователи не получали звук поверх вибрации.
let audioCtx = null
let audioUnlocked = false
let audioEnabled = true

function getCtx() {
  if (audioCtx === null) {
    const AC = window.AudioContext || window.webkitAudioContext
    audioCtx = AC ? new AC() : null
  }
  return audioCtx
}

// WebAudio на iOS стартует в suspended, пока нет user gesture.
// Разблокируем на первом касании — дальше можно дергать из кода.
function unlockAudio() {
  const ctx = getCtx()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
  audioUnlocked = true
  window.removeEventListener('touchstart', unlockAudio)
  window.removeEventListener('pointerdown', unlockAudio)
}
if (typeof window !== 'undefined') {
  window.addEventListener('touchstart', unlockAudio, { passive: true })
  window.addEventListener('pointerdown', unlockAudio, { passive: true })
}

// Короткий тик. Чем короче attack/decay, тем ближе к «клику»,
// тем меньше шансов, что iOS сочтёт это музыкой и прервёт плеер.
function playTick(duration, strength) {
  if (!audioEnabled) return
  const ctx = getCtx()
  if (!ctx || ctx.state !== 'running') return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const now = ctx.currentTime
  osc.type = 'square'
  osc.frequency.value = 1800
  gain.gain.setValueAtTime(0.04 * strength, now)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration / 1000)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + duration / 1000)
}

// Успех — двойной тик (аналог паттерна [14, 40, 22]).
function playSuccess() {
  playTick(20, 1)
  setTimeout(() => playTick(30, 1), 50)
}

export function haptic(pattern = 10) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
      return
    }
  } catch {
    /* Some browsers throw on vibrate — не критично, дальше fallback */
  }
  // vibrate нет (iOS Safari) — звуковой тик как замена отклика
  if (typeof window !== 'undefined' && audioUnlocked) {
    if (Array.isArray(pattern)) playSuccess()
    else playTick(pattern < 10 ? 8 : 14, 0.7)
  }
}

export function setHapticSoundEnabled(enabled) {
  audioEnabled = enabled
}

export const HAPTIC = {
  selection: 8,
  light: 12,
  success: [14, 40, 22],
}
