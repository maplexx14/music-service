import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import './TrustedDevices.css'

/**
 * Устройства, которым доверяет аккаунт.
 *
 * Вход с незнакомого устройства требует код (см. backend/app/trusted_devices.py),
 * поэтому этот список — единственное место, где юзер видит, откуда в аккаунт
 * уже входили, и может забрать доверие обратно: после отзыва вход с того
 * устройства снова потребует подтверждения.
 *
 * Текущее устройство отзывать не предлагаем: полезного эффекта нет (сессия
 * остаётся живой), а следующий свой же вход придётся подтверждать заново.
 */

// Дата ставится сервером в UTC; в интерфейсе нужна локальная и короткая.
// Невалидную дату не показываем вовсе — «Invalid Date» в списке хуже пустоты.
const formatSeen = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function TrustedDevices() {
  const { user, fetchTrustedDevices, revokeTrustedDevice, revokeOtherDevices } = useAuthStore()

  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [revokingAll, setRevokingAll] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const result = await fetchTrustedDevices()
    setLoading(false)
    if (result.success) {
      setDevices(result.devices)
      setError('')
    } else {
      setError(result.error)
    }
  }, [fetchTrustedDevices])

  // Перезагружаем на смену аккаунта: чужой список на экране — утечка того,
  // с каких устройств входил предыдущий юзер.
  useEffect(() => {
    load()
  }, [load, user?.id])

  const handleRevoke = async (device) => {
    setBusyId(device.id)
    setError('')
    const result = await revokeTrustedDevice(device.id)
    setBusyId(null)
    if (!result.success) {
      setError(result.error)
      return
    }
    // Убираем из списка сразу, не дожидаясь перезапроса: строка исчезла на
    // сервере, и держать её на экране — врать юзеру о состоянии.
    setDevices((prev) => prev.filter((item) => item.id !== device.id))
    toast.success('Устройство больше не доверенное')
  }

  const handleRevokeAll = async () => {
    setRevokingAll(true)
    setError('')
    const result = await revokeOtherDevices()
    setRevokingAll(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setDevices((prev) => prev.filter((item) => item.current))
    toast.success(
      result.revoked > 0
        ? `Отозвано устройств: ${result.revoked}`
        : 'Других доверенных устройств не было'
    )
  }

  const others = devices.filter((device) => !device.current)

  return (
    <div className="settings-card">
      <div className="settings-section-title">Доверенные устройства</div>
      <p className="settings-hint settings-section-hint">
        Вход с нового устройства требует код подтверждения. Уже подтверждённые
        устройства входят без кода — отзовите те, которых не узнаёте.
      </p>

      {error && <div className="settings-error">{error}</div>}

      {loading ? (
        <p className="settings-hint">Загрузка...</p>
      ) : devices.length === 0 ? (
        <p className="settings-hint">
          Пока ни одного: этот браузер не сохранил токен устройства, поэтому
          каждый вход будет запрашивать код.
        </p>
      ) : (
        <>
          <ul className="devices-list">
            {devices.map((device) => (
              <li key={device.id} className="devices-item">
                <div className="devices-info">
                  <span className="devices-label">
                    {device.label}
                    {device.current && (
                      <span className="devices-badge">это устройство</span>
                    )}
                  </span>
                  <span className="devices-meta">
                    Последний вход: {formatSeen(device.last_seen_at) || '—'}
                  </span>
                </div>
                {!device.current && (
                  <button
                    type="button"
                    className="settings-save-btn devices-revoke"
                    onClick={() => handleRevoke(device)}
                    disabled={busyId === device.id || revokingAll}
                  >
                    {busyId === device.id ? 'Отзыв...' : 'Отозвать'}
                  </button>
                )}
              </li>
            ))}
          </ul>

          {others.length > 0 && (
            <div className="settings-prefs-actions">
              <button
                type="button"
                className="settings-save-btn devices-revoke-all"
                onClick={handleRevokeAll}
                disabled={revokingAll || busyId !== null}
              >
                {revokingAll ? 'Отзыв...' : 'Отозвать все, кроме текущего'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default TrustedDevices
