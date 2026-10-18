// Онбординг (жанры/артисты) раньше показывался только сразу за переходом по
// ссылке из письма. Ссылка часто открывается в другом браузере (встроенный
// браузер почтовика), и в исходной вкладке юзер входил по паролю мимо
// онбординга — волна холодного старта без единого предпочтения. Поэтому
// новичка без предпочтений ведём на онбординг при любом входе, но один раз:
// пропустивший не должен видеть его на каждом старте.
const SEEN_KEY = 'bolt-onboarding-seen'
const NEW_USER_DAYS = 3

function seenIds() {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')
  } catch {
    return []
  }
}

export function markOnboardingSeen(userId) {
  if (userId == null) return
  try {
    const ids = seenIds()
    if (!ids.includes(userId)) localStorage.setItem(SEEN_KEY, JSON.stringify([...ids, userId]))
  } catch {
    // Хранилище недоступно (приватный режим) — покажем ещё раз, не страшно.
  }
}

export function needsOnboarding(user) {
  if (!user?.id || !user.created_at) return false
  if (user.preferred_genres?.length || user.preferred_artists?.length) return false
  const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86400000
  if (!(ageDays < NEW_USER_DAYS)) return false
  return !seenIds().includes(user.id)
}
