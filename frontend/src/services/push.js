import api from './api'
import { isIOS, isStandalone } from './navigation'

// Web Push: уведомления о новых релизах любимых артистов и напоминание про
// волну (правила рассылки — backend/app/push.py).
//
// На iOS пуши есть только у PWA с домашнего экрана (16.4+): в Safari-вкладке
// PushManager отсутствует, поэтому там предлагаем сначала установить.

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.location.protocol === 'https:'
  )
}

/** Пуши недоступны только потому, что iOS-приложение не установлено. */
export const needsInstallForPush = () => isIOS && !isStandalone

export function pushPermission() {
  return pushSupported() ? Notification.permission : 'unsupported'
}

function keyToBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

/** Подписано ли это устройство. */
export async function isPushEnabled() {
  if (pushPermission() !== 'granted') return false
  try {
    return !!(await currentSubscription())
  } catch {
    return false
  }
}

/**
 * Спрашивает разрешение и подписывает устройство. Вызывать из обработчика
 * нажатия: iOS и Firefox без жеста запрос не покажут.
 * → 'enabled' | 'denied' | 'dismissed' | 'error'
 */
export async function enablePush() {
  if (!pushSupported()) return 'error'
  const permission = await Notification.requestPermission()
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'dismissed'
  try {
    const { data } = await api.get('/push/config')
    const registration = await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyToBytes(data.public_key),
      })
    }
    await api.post('/push/subscribe', subscription.toJSON())
    return 'enabled'
  } catch {
    return 'error'
  }
}

/** Отписывает устройство (и на сервере, и в браузере). */
export async function disablePush() {
  try {
    const subscription = await currentSubscription()
    if (!subscription) return
    await api.post('/push/unsubscribe', { endpoint: subscription.endpoint }, { skipErrorToast: true }).catch(() => {})
    await subscription.unsubscribe()
  } catch {
    // Нет SW или подписки — отписывать нечего.
  }
}

/** Повторно отправляет подписку: браузер мог её обновить (pushsubscriptionchange
 *  без открытой вкладки не долетает до сервера), а сервер — удалить протухшую. */
export async function syncPushSubscription() {
  if (pushPermission() !== 'granted') return
  try {
    const subscription = await currentSubscription()
    if (subscription) {
      await api.post('/push/subscribe', subscription.toJSON(), { skipErrorToast: true })
    }
  } catch {
    // Следующий запуск попробует снова.
  }
}

/** Открыли приложение из уведомления (?push=<вид>) — отметить и убрать метку из адреса. */
export function trackPushOpen() {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('push')
  if (!kind) return
  params.delete('push')
  const query = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  )
  api.post('/push/opened', { kind }, { skipErrorToast: true }).catch(() => {})
}

/** Выход из аккаунта: подписку этого браузера гасим локально — токена уже
 *  нет, а сервер сам удалит её по 410 при следующей отправке. */
export function dropLocalPushSubscription() {
  if (!pushSupported()) return
  currentSubscription()
    .then((subscription) => subscription?.unsubscribe())
    .catch(() => {})
}
