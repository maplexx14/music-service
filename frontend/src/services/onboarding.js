// Только серверный статус прохождения определяет, нужен ли онбординг.
// Если старый кэш профиля ещё без этого поля, ждём свежий /auth/me.
export function needsOnboarding(user) {
  return Boolean(user?.id) && user.onboarding_completed === false
}
