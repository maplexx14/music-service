import { useEffect, useState } from 'react'
import api from '../services/api'
import {
  disablePush,
  enablePush,
  isPushEnabled,
  needsInstallForPush,
  pushPermission,
  pushSupported,
} from '../services/push'
import { toast } from '../store/toastStore'

const ENABLE_ERRORS = {
  denied: 'Уведомления запрещены в настройках браузера — разрешите их там для этого сайта',
  error: 'Не удалось включить уведомления',
}

const KINDS = [
  ['releases', 'Новые релизы', 'Когда у ваших артистов выходит сингл или альбом'],
  ['reminders', 'Напоминания про волну', 'Если не заходили пару дней — не чаще раза в три дня'],
]

/**
 * Раздел «Уведомления»: подписка этого устройства и какие виды слать.
 * Виды хранятся на сервере у юзера и действуют на всех его устройствах.
 */
function PushSettings() {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prefs, setPrefs] = useState(null)
  const supported = pushSupported()

  useEffect(() => {
    let active = true
    isPushEnabled().then((value) => active && setEnabled(value))
    api
      .get('/push/config')
      .then(({ data }) => active && setPrefs({ releases: data.releases, reminders: data.reminders }))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const toggleKind = async (kind) => {
    const previous = prefs
    const next = { ...prefs, [kind]: !prefs[kind] }
    setPrefs(next)
    try {
      await api.put('/push/prefs', next)
    } catch {
      setPrefs(previous)
    }
  }

  const toggle = async () => {
    setBusy(true)
    if (enabled) {
      await disablePush()
      setEnabled(false)
    } else {
      const result = await enablePush()
      if (result === 'enabled') setEnabled(true)
      else if (ENABLE_ERRORS[result]) toast.error(ENABLE_ERRORS[result])
    }
    setBusy(false)
  }

  const sendTest = async () => {
    setBusy(true)
    try {
      const { data } = await api.post('/push/test')
      if (!data.sent) toast.error('Уведомление не дошло — выключите и включите снова')
    } catch {
      // Ошибку показал общий обработчик api.
    }
    setBusy(false)
  }

  let hint = 'Не чаще раза в день, вечером'
  if (!supported) {
    hint = needsInstallForPush()
      ? 'На iPhone уведомления приходят только приложению: добавьте bolt на экран «Домой» и откройте оттуда'
      : 'Этот браузер не поддерживает уведомления'
  } else if (pushPermission() === 'denied') {
    hint = ENABLE_ERRORS.denied
  }

  return (
    <div className="settings-card">
      <div className="settings-section-title">Уведомления</div>
      <div className="settings-row">
        <div>
          <div className="settings-label">Уведомления на этом устройстве</div>
          <div className="settings-hint">{hint}</div>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggle}
            disabled={!supported || busy}
            aria-label="Уведомления на этом устройстве"
          />
          <span className="settings-toggle-slider" />
        </label>
      </div>
      {prefs &&
        KINDS.map(([kind, label, kindHint]) => (
          <div className="settings-row" key={kind}>
            <div>
              <div className="settings-label">{label}</div>
              <div className="settings-hint">{kindHint}</div>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs[kind]}
                onChange={() => toggleKind(kind)}
                aria-label={label}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
        ))}
      {enabled && (
        <div className="settings-row">
          <div>
            <div className="settings-label">Проверить</div>
            <div className="settings-hint">Пришлём пробное уведомление сюда</div>
          </div>
          <button type="button" className="btn btn--ghost" onClick={sendTest} disabled={busy}>
            Отправить
          </button>
        </div>
      )}
    </div>
  )
}

export default PushSettings
