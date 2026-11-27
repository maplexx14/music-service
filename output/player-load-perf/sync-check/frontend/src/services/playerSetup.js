const STAGES = ['boxed', 'unboxed', 'customize']
const keyFor = (userId) => `cd-player-setup:${userId}`
// Отметка «распаковку уже видел». Нужна старым аккаунтам: у них настройка
// плеера отмечена завершённой ещё до появления коробки, и без этой метки они
// проходили бы распаковку при каждом входе.
const replayKeyFor = (userId) => `cd-player-unboxed:${userId}`

export function readPlayerSetupStage(userId) {
  if (!userId) return 'boxed'
  try {
    const saved = localStorage.getItem(keyFor(userId))
    return STAGES.includes(saved) ? saved : 'boxed'
  } catch {
    return 'boxed'
  }
}

export function savePlayerSetupStage(userId, stage) {
  if (!userId || !STAGES.includes(stage)) return
  try { localStorage.setItem(keyFor(userId), stage) } catch { /* Keep the flow usable without storage. */ }
}

export function clearPlayerSetupStage(userId) {
  try { localStorage.removeItem(keyFor(userId)) } catch { /* Completion is saved in the account. */ }
}

export function playerSetupSeen(userId) {
  if (!userId) return true
  try {
    return localStorage.getItem(replayKeyFor(userId)) === '1'
  } catch {
    return true
  }
}

export function markPlayerSetupSeen(userId) {
  if (!userId) return
  try { localStorage.setItem(replayKeyFor(userId), '1') } catch { /* Repeat visit is not fatal. */ }
}

export function forgetPlayerSetupSeen(userId) {
  try { localStorage.removeItem(replayKeyFor(userId)) } catch { /* Nothing to forget. */ }
}
