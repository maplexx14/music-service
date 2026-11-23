import { playerSetupSeen } from './playerSetup'

// Только серверный статус прохождения определяет, нужен ли онбординг.
// Если старый кэш профиля ещё без этого поля, ждём свежий /auth/me.
export function needsOnboarding(user) {
  return Boolean(user?.id) && user.onboarding_completed === false
}

export function needsPlayerSetup(user) {
  return Boolean(user?.id) && user.onboarding_completed === true && user.player_setup_completed === false
}

// Старые аккаунты: настройка плеера давно отмечена завершённой (миграция
// 0038) либо поле ещё не пришло в старом кэше профиля, а коробку такой
// аккаунт не видел ни разу. Ведём его в распаковку один раз, без
// промежуточного окна с кнопкой.
export function needsPlayerSetupReplay(user) {
  return Boolean(user?.id) && user.onboarding_completed === true && user.player_setup_completed !== false &&
    !playerSetupSeen(user.id)
}

export function needsPlayerFlow(user) {
  return needsPlayerSetup(user) || needsPlayerSetupReplay(user)
}

export function onboardingDestination(user) {
  if (needsOnboarding(user)) return '/onboarding'
  if (needsPlayerFlow(user)) return '/onboarding/player'
  return null
}
