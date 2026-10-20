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

/** Переключатель уведомлений этого устройства (раздел «Уведомления»). */
function PushSettings() {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const supported = pushSupported()

  useEffect(() => {
    let active = true
    isPushEnabled().then((value) => active && setEnabled(value))
    return () => {
      active = false
    }
  }, [])

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

  let hint = 'Новые релизы любимых артистов и напоминание про волну — не чаще раза в день, вечером'
  if (!supported) {
    hint = needsInstallForPush()
      ? 'На iPhone уведомления приходят только приложению: добавьте bolt на экран «Домой» и откройте оттуда'
      : 'Этот браузер не поддерживает уведомления'
  } else if (pushPermission() === 'denied') {
    hint = ENABLE_ERRORS.denied
  }

  return (
    <div className="settings-card">
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
