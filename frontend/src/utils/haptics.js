// Тактильный отклик как в нативных приложениях. navigator.vibrate есть
// только на Android/Chromium. iOS Safari его не отдаёт вообще — там
// включается звуковой fallback: короткий тик через WebAudio, чтобы
// нажатие не было «пустым». Тик играем только когда vibrate нет,
// чтобы Android-пользователи не получали звук поверх вибрации.
//
// ВАЖНО про iOS: AudioContext нужно создавать ВНУТРИ user gesture —
// контекст, созданный заранее, на iOS PWA может навсегда зависнуть в
// suspended. Поэтому getCtx() вызывается из haptic(), а haptic()
// всегда дергается из click/touch-обработчиков. Важно и обратное:
// тик НЕ играет через <audio>-элемент — медиа-сессию трогать нельзя,
// иначе отберём Now Playing у плеера (см. комментарии в audioEngine.js).
let audioCtx = null
let audioEnabled = true

function getCtx() {
  if (audioCtx === null) {
    const AC = window.AudioContext || window.webkitAudioContext
    audioCtx = AC ? new AC() : null
  }
  return audioCtx
}

// Короткий тик. Чем короче attack/decay, тем ближе к «клику».
function playTick(durationMs, gainLevel) {
  if (!audioEnabled) return
  let ctx
  try {
    ctx = getCtx()
  } catch {
    return
  }
  if (!ctx) return
  if (ctx.state === 'suspended') {
    // Мы внутри user gesture (haptic зовут из обработчиков) — resume
    // здесь легален. Текущий тик может не прозвучать, следующий — да.
    ctx.resume().catch(() => {})
    if (ctx.state !== 'running') return
  }
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const now = ctx.currentTime
    osc.type = 'square'
    osc.frequency.value = 1400
    gain.gain.setValueAtTime(gainLevel, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + durationMs / 1000)
  } catch {
    /* WebAudio недоступен — молча пропускаем */
  }
}

// Успех — двойной тик (аналог паттерна [14, 40, 22]).
function playSuccess() {
  playTick(25, 0.12)
  setTimeout(() => playTick(35, 0.12), 55)
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
  if (typeof window === 'undefined') return
  if (Array.isArray(pattern)) playSuccess()
  else playTick(pattern < 10 ? 12 : 18, 0.08)
}

export function setHapticSoundEnabled(enabled) {
  audioEnabled = enabled
}

export const HAPTIC = {
  selection: 8,
  light: 12,
  success: [14, 40, 22],
}
