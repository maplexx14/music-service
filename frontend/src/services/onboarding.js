import { playerSetupSeen } from './playerSetup'

// Только серверный статус прохождения определяет, нужен ли онбординг.
// Если старый кэш профиля ещё без этого поля, ждём свежий /auth/me.
export function needsOnboarding(user) {
  return Boolean(user?.id) && user.onboarding_completed === false
}

export function needsPlayerSetup(user) {
  return Boolean(user?.id) && user.onboarding_completed === true && user.player_setup_completed === false
}

// Дата выката распаковки: аккаунты старше неё коробку не видели (миграция
// 0038 пометила их настройку завершённой). Аккаунты, созданные позже, уже
// проходили распаковку в новом флоу, им повтор не нужен — это же условие
// делает повтор идемпотентным между браузерами.
const UNBOXING_ROLLOUT = Date.parse('2026-11-21T00:00:00Z')

// Старые аккаунты: настройка плеера давно отмечена завершённой (либо поле ещё
// не пришло в старом кэше профиля), аккаунт заведён до выката коробки, и в
// этом браузере распаковку ещё не показывали. Ведём в коробку без
// промежуточного окна с кнопкой.
export function needsPlayerSetupReplay(user) {
  if (!user?.id || user.onboarding_completed !== true || user.player_setup_completed === false) return false
  const created = Date.parse(user.created_at || '')
  if (!Number.isFinite(created) || created >= UNBOXING_ROLLOUT) return false
  return !playerSetupSeen(user.id)
}

export function needsPlayerFlow(user) {
  return needsPlayerSetup(user) || needsPlayerSetupReplay(user)
}

// Завершённую распаковку можно повторить из админской диагностики, не меняя
// серверный статус онбординга. Обычным пользователям query-параметр маршрута
// не открывает служебный сценарий.
export function canReplayPlayerSetup(user) {
  return Boolean(user?.is_admin) && user.onboarding_completed === true && !needsPlayerFlow(user)
}

export function onboardingDestination(user) {
  if (needsOnboarding(user)) return '/onboarding'
  if (needsPlayerFlow(user)) return '/onboarding/player'
  return null
}
