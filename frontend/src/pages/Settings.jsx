import { useEffect, useState } from 'react'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import PreferencePicker from '../components/PreferencePicker'
import TwoFactorSettings from '../components/TwoFactorSettings'
import EmailTwoFactorSettings from '../components/EmailTwoFactorSettings'
import TrustedDevices from '../components/TrustedDevices'
import { formatDiag, clearDiag } from '../utils/playerDiag'
import './Settings.css'

function Settings() {
  const { color, animate, waveGif, setColor, setAnimation, setWaveGif } = useWaveSettingsStore()
  const { liteMode, toggleLiteMode } = useUiSettingsStore()
  const { user, updatePreferences } = useAuthStore()
  const [gifError, setGifError] = useState('')

  // Музыкальные предпочтения (инициализируем из профиля пользователя).
  const [prefs, setPrefs] = useState({
    genres: user?.preferred_genres || [],
    artists: user?.preferred_artists || [],
    excludedArtists: user?.excluded_artists || [],
  })
  // Баланс открытия новых артистов. На бэкенде это 0..1, в интерфейсе —
  // проценты приоритета; высокое значение становится целью потока. Отдельным
  // состоянием, а не внутри prefs: PreferencePicker пересобирает свой объект из
  // трёх известных ему полей и лишний ключ потерялся бы на первом же клике.
  const [discovery, setDiscovery] = useState(
    Math.round((user?.discovery_ratio ?? 0.2) * 100)
  )
  const [savingPrefs, setSavingPrefs] = useState(false)

  // Профиль приходит асинхронно (checkAuth), и на первом рендере user ещё
  // null — без этого окно оставалось пустым независимо от предпочтений.
  useEffect(() => {
    if (user) {
      setPrefs({
        genres: user.preferred_genres || [],
        artists: user.preferred_artists || [],
        excludedArtists: user.excluded_artists || [],
      })
      setDiscovery(Math.round((user.discovery_ratio ?? 0.2) * 100))
    }
  }, [user])

  const handleSavePrefs = async () => {
    setSavingPrefs(true)
    const result = await updatePreferences(
      prefs.genres,
      prefs.artists,
      prefs.excludedArtists,
      discovery / 100,
    )
    setSavingPrefs(false)
    if (result.success) {
      toast.success('Предпочтения сохранены')
    } else {
      toast.error(result.error)
    }
  }

  const handleGifChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.type !== 'image/gif') {
      setGifError('Можно загрузить только GIF файл')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setWaveGif(reader.result)
      setGifError('')
    }
    reader.readAsDataURL(file)
  }

  const handleGifClear = () => {
    setWaveGif(null)
    setGifError('')
  }

  // Диагностика плеера. Баги воспроизведения проявляются на iOS с
  // заблокированным экраном, где нет ни консоли, ни devtools, поэтому лог
  // событий media-элемента пишется на устройство (см. utils/playerDiag) и
  // читается здесь — уже ПОСЛЕ того, как проблема воспроизвелась.
  const [diagText, setDiagText] = useState(null)

  const handleShowDiag = () => {
    const text = formatDiag()
    setDiagText(text || 'Лог пуст — включите музыку и повторите проблему.')
  }

  const handleCopyDiag = async () => {
    try {
      await navigator.clipboard.writeText(formatDiag())
      toast.success('Лог скопирован')
    } catch {
      toast.error('Не удалось скопировать — выделите текст вручную')
    }
  }

  return (
    <div className="page-container">
      <div className="settings-header">
        <h1>Настройки</h1>
        <p>Оформление и поведение виджетов</p>
      </div>

      <div className="settings-card">
        <div className="settings-section-title">Музыкальные предпочтения</div>
        <p className="settings-hint settings-section-hint">
          Влияют на рекомендации и ваш персональный поток
        </p>
        <PreferencePicker value={prefs} onChange={setPrefs} />

        <div className="settings-balance">
          <div className="settings-balance-head">
            <div className="settings-label">Приоритет новых артистов</div>
            <div className="settings-hint">
              Насколько активно поднимать релевантные треки артистов, которых
              вы ещё не слушали. При высоком значении поток сначала старается
              выполнить эту цель, а при нехватке новых кандидатов использует
              знакомые треки. Чем ниже значение, тем больше места в порции
              достаётся тому, что вы уже отметили как понравившееся; на
              максимуме таких треков в потоке не будет вовсе.
            </div>
          </div>
          <div className="settings-balance-values">
            <span className="settings-balance-new">{discovery}% приоритета</span>
            <span className="settings-balance-known">
              {discovery < 50 ? 'Больше знакомого' : 'Больше открытий'}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={discovery}
            onChange={(event) => setDiscovery(Number(event.target.value))}
            className="settings-balance-slider"
            style={{ '--balance-fill': `${discovery}%` }}
            aria-label="Приоритет новых артистов в рекомендациях"
          />
          <div className="settings-balance-scale">
            <span>Точнее по знакомому</span>
            <span>Смелее открывать новое</span>
          </div>
        </div>

        <div className="settings-prefs-actions">
          <button
            type="button"
            className="settings-save-btn"
            onClick={handleSavePrefs}
            disabled={savingPrefs}
          >
            {savingPrefs ? 'Сохранение...' : 'Сохранить предпочтения'}
          </button>
        </div>
      </div>

      <TwoFactorSettings />
      <EmailTwoFactorSettings />
      <TrustedDevices />

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-label">Облегчённый режим</div>
            <div className="settings-hint">Отключает анимации и фоновые эффекты, снижая нагрузку на процессор</div>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={liteMode}
              onChange={toggleLiteMode}
              aria-label="Облегчённый режим"
            />
            <span className="settings-toggle-slider" />
          </label>
        </div>

    
        <div className="settings-row">
          <div className="settings-label">GIF вместо текста</div>
          <div className="settings-gif">
            {waveGif ? (
              <div className="settings-gif-preview">
                <img src={waveGif} alt="Wave gif" />
                <button type="button" onClick={handleGifClear}>
                  Убрать
                </button>
              </div>
            ) : (
              <label className="settings-gif-upload">
                <input type="file" accept="image/gif" onChange={handleGifChange} />
                Загрузить GIF
              </label>
            )}
            {gifError && <div className="settings-error">{gifError}</div>}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-section-title">Диагностика плеера</div>
        <p className="settings-hint settings-section-hint">
          Журнал событий воспроизведения на этом устройстве. Чтобы поймать
          проблему: очистите лог, включите музыку, заблокируйте экран,
          воспроизведите сбой — и вернитесь сюда.
        </p>
        <div className="settings-prefs-actions">
          <button type="button" className="settings-save-btn" onClick={handleShowDiag}>
            Показать лог
          </button>
          <button type="button" className="settings-save-btn" onClick={handleCopyDiag}>
            Скопировать
          </button>
          <button
            type="button"
            className="settings-save-btn"
            onClick={() => {
              clearDiag()
              setDiagText('Лог очищен.')
            }}
          >
            Очистить
          </button>
        </div>
        {diagText !== null && (
          <pre className="settings-diag-log">{diagText}</pre>
        )}
      </div>
    </div>
  )
}

export default Settings
