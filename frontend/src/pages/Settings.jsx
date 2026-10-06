import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Sparkles, Disc3, Mic2, Headphones, Palette, Shield, Bug, ChevronRight, LayoutDashboard, LogOut } from 'lucide-react'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import GenreSelect from '../components/GenreSelect'
import ArtistSelect from '../components/ArtistSelect'
import api from '../services/api'
import TwoFactorSettings from '../components/TwoFactorSettings'
import EmailTwoFactorSettings from '../components/EmailTwoFactorSettings'
import TrustedDevices from '../components/TrustedDevices'
import { formatDiag, clearDiag } from '../utils/playerDiag'
import './Settings.css'

// Режимы качества потока: значение из стора + подпись. 'auto' оставляет решение
// за измерениями канала (utils/streamQuality).
const QUALITY_OPTIONS = [
  ['auto', 'Авто'],
  ['low', '64 кбит/с'],
  ['high', '128 кбит/с'],
]

// Разделы настроек — пункты меню. id — сегмент URL (/settings/security): на
// раздел можно дать прямую ссылку, а на телефоне раздел — отдельный экран со
// своим «Назад» в верхней панели.
const SECTIONS = [
  // Жанры и артисты — отдельными разделами: сетка фото артистов и плитки
  // жанров каждая занимает экран, вместе они превращались в простыню.
  { id: 'genres', label: 'Любимые жанры', hint: 'Что вы любите слушать', icon: Disc3 },
  { id: 'artists', label: 'Любимые артисты', hint: 'И похожие на них', icon: Mic2 },
  { id: 'recs', label: 'Рекомендации', hint: 'Новые открытия', icon: Sparkles },
  { id: 'playback', label: 'Воспроизведение', hint: 'Качество звука', icon: Headphones },
  { id: 'appearance', label: 'Оформление', hint: 'Облегчённый режим, GIF', icon: Palette },
  { id: 'security', label: 'Безопасность', hint: 'Двухфакторка, устройства', icon: Shield },
  // Диагностика плеера — отладочный инструмент, обычному пользователю не
  // нужен: лог событий воспроизведения имеет смысл только при разборе багов,
  // о которых сообщили админам.
  { id: 'diag', label: 'Диагностика', hint: 'Журнал плеера', icon: Bug, adminOnly: true },
]

// Граница мобильной раскладки — та же, что у Layout (768px).
const MOBILE_QUERY = '(max-width: 768px)'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  )
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

const sameList = (a = [], b = []) =>
  a.length === b.length && a.every((item, i) => item === b[i])

function Settings() {
  const { color, animate, waveGif, setColor, setAnimation, setWaveGif } = useWaveSettingsStore()
  const {
    liteMode,
    toggleLiteMode,
    streamQuality,
    setStreamQuality,
    rememberPlayer,
    toggleRememberPlayer,
    brushIcons,
    toggleBrushIcons,
  } = useUiSettingsStore()
  const { user, updatePreferences, logout } = useAuthStore()
  const [gifError, setGifError] = useState('')

  // Музыкальные предпочтения (инициализируем из профиля пользователя).
  const [prefs, setPrefs] = useState({
    genres: user?.preferred_genres || [],
    artists: user?.preferred_artists || [],
    excludedArtists: user?.excluded_artists || [],
  })
  // Баланс открытия новых артистов. На бэкенде это 0..1, в интерфейсе —
  // проценты приоритета; высокое значение становится целью потока.
  const [discovery, setDiscovery] = useState(
    Math.round((user?.discovery_ratio ?? 0.2) * 100)
  )
  // Профиль приходит асинхронно (checkAuth), и на первом рендере user ещё
  // null — без этого окно оставалось пустым независимо от предпочтений.
  // Только ОДИН раз: дальше user обновляет автосохранение, и ответ на
  // сохранение A, пришедший после клика по B, затёр бы B.
  const prefsLoaded = useRef(false)
  useEffect(() => {
    if (user && !prefsLoaded.current) {
      prefsLoaded.current = true
      setPrefs({
        genres: user.preferred_genres || [],
        artists: user.preferred_artists || [],
        excludedArtists: user.excluded_artists || [],
      })
      setDiscovery(Math.round((user.discovery_ratio ?? 0.2) * 100))
    }
  }, [user])

  // Раскладка: на компьютере меню слева и раздел справа (без раздела в URL —
  // первый); на телефоне /settings — только меню, раздел — отдельный экран.
  const { section: sectionParam } = useParams()
  const isMobile = useIsMobile()
  const sections = SECTIONS.filter((item) => !item.adminOnly || user?.is_admin)
  const requested = sections.find((item) => item.id === sectionParam)
  const active = requested ?? (isMobile ? null : sections[0])

  // Предпочтения живут здесь, а не в разделе: маршрут один (/settings/:section?),
  // компонент при переходах между меню и разделами не размонтируется.
  const prefsDirty =
    !!user &&
    (!sameList(prefs.genres, user.preferred_genres || []) ||
      !sameList(prefs.artists, user.preferred_artists || []) ||
      !sameList(prefs.excludedArtists, user.excluded_artists || []) ||
      discovery !== Math.round((user.discovery_ratio ?? 0.2) * 100))

  // Вкус, выведенный из прослушиваний — тот же профиль, что строит волну:
  // юзер видит, что сервис о нём понял, и может перенести это в свой выбор.
  const [detected, setDetected] = useState({ genres: [], artists: [] })
  useEffect(() => {
    let active = true
    api
      .get('/users/me/taste')
      .then((res) => {
        if (active) {
          setDetected({ genres: res.data?.genres || [], artists: res.data?.artists || [] })
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // Автосохранение вместо кнопки: сетка артистов подгружается при прокрутке
  // бесконечно, и кнопка под ней была недостижима. Сохраняем через паузу
  // после последней правки — серия кликов по артистам уходит одним PUT.
  //
  // lastSaved — то, что уже отправили. Бэкенд нормализует выбор (дубли,
  // неизвестные жанры, потолок в 50), и user может навсегда отличаться от
  // prefs: без этой проверки такой выбор сохранялся бы по кругу. Ошибка
  // тоже не повторяется сама — только на следующей правке.
  const lastSaved = useRef(null)
  const pendingSave = useRef(null)
  const prefsPayload = JSON.stringify([
    prefs.genres,
    prefs.artists,
    prefs.excludedArtists,
    discovery,
  ])

  useEffect(() => {
    if (!prefsDirty || lastSaved.current === prefsPayload) {
      pendingSave.current = null
      return undefined
    }
    const save = async () => {
      pendingSave.current = null
      lastSaved.current = prefsPayload
      const [genres, artists, excludedArtists, ratio] = JSON.parse(prefsPayload)
      const result = await updatePreferences(genres, artists, excludedArtists, ratio / 100)
      if (!result.success) toast.error(result.error)
    }
    pendingSave.current = save
    const timer = setTimeout(save, 800)
    return () => clearTimeout(timer)
  }, [prefsPayload, prefsDirty, updatePreferences])

  // Ушли со страницы раньше паузы — досохраняем, правка не должна теряться.
  useEffect(() => () => pendingSave.current?.(), [])

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

  // Неизвестный раздел (опечатка в ссылке, «Диагностика» без прав) — в меню.
  // Пока профиль не загружен, права неизвестны: не уводим раньше времени.
  if (sectionParam && !requested && user) {
    return <Navigate to="/settings" replace />
  }

  // Выход раньше жил в выпадающем меню профиля; теперь профиль ведёт сюда,
  // и выход — последний пункт меню. Полная перезагрузка на /login, как и
  // раньше: сбрасывает сторы, кэш страниц и плеер прошлого пользователя.
  const handleLogout = () => {
    // Пункт последний в меню, у нижней навигации — легко задеть пальцем.
    if (!window.confirm('Выйти из аккаунта?')) return
    logout()
    window.location.href = '/login'
  }

  const profileCard = user && (
    <div className="settings-profile">
      {user.avatar_url ? (
        <img src={user.avatar_url} alt="" className="settings-profile-avatar" />
      ) : (
        <div className="settings-profile-avatar settings-profile-avatar-placeholder" aria-hidden="true">
          {(user.username || 'U').charAt(0).toUpperCase()}
        </div>
      )}
      <div className="settings-profile-text">
        <div className="settings-profile-name">{user.full_name || user.username}</div>
        {user.email && <div className="settings-profile-email">{user.email}</div>}
      </div>
    </div>
  )

  const menu = (
    <nav className="settings-menu" aria-label="Разделы настроек">
      {profileCard}
      <ul>
        {sections.map(({ id, label, hint, icon: Icon }) => {
          const current = active?.id === id
          return (
            <li key={id}>
              <Link
                to={`/settings/${id}`}
                // На компьютере переключение разделов не копит историю:
                // «Назад» уводит со страницы. На телефоне раздел — экран, и
                // «Назад» возвращает в меню.
                replace={!isMobile}
                className={`settings-menu-item${current ? ' active' : ''}`}
                aria-current={current ? 'page' : undefined}
              >
                <span className="settings-menu-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="settings-menu-text">
                  <span className="settings-menu-label">
                    {label}
                  </span>
                  <span className="settings-menu-hint">{hint}</span>
                </span>
                <ChevronRight className="settings-menu-chevron" size={18} aria-hidden="true" />
              </Link>
            </li>
          )
        })}
      </ul>

      {/* Действия с аккаунтом — отдельной группой: это не разделы настроек,
          а переходы и выход. */}
      <ul className="settings-menu-group">
        {user?.is_admin && (
          <li>
            <Link to="/admin" className="settings-menu-item">
              <span className="settings-menu-icon" aria-hidden="true">
                <LayoutDashboard size={18} />
              </span>
              <span className="settings-menu-text">
                <span className="settings-menu-label">Админ-панель</span>
              </span>
              <ChevronRight className="settings-menu-chevron" size={18} aria-hidden="true" />
            </Link>
          </li>
        )}
        <li>
          <button type="button" className="settings-menu-item settings-menu-danger" onClick={handleLogout}>
            <span className="settings-menu-icon" aria-hidden="true">
              <LogOut size={18} />
            </span>
            <span className="settings-menu-text">
              <span className="settings-menu-label">Выйти</span>
            </span>
          </button>
        </li>
      </ul>
    </nav>
  )

  // Телефон, корень: только меню.
  if (!active) {
    return (
      <div className="page-container">
        <div className="settings-header">
          <h1>Настройки</h1>
        </div>
        {menu}
      </div>
    )
  }

  const activeTab = active.id
  const panelProps = (id) => ({
    className: 'settings-panel',
    role: 'region',
    'aria-label': SECTIONS.find((item) => item.id === id)?.label,
  })

  return (
    <div className="page-container">
      <div className="settings-header">
        {/* На телефоне заголовок экрана — название раздела: «Настройки» уже
            остались в меню позади. */}
        <h1>{isMobile ? active.label : 'Настройки'}</h1>
      </div>

      {/* Жанры и артисты — плитки и сетка фото: им нужна вся ширина, а не
          колонка в 600px, как у разделов с формами. */}
      <div className={`settings-layout${['genres', 'artists'].includes(activeTab) ? ' wide' : ''}`}>
        {!isMobile && menu}
        <div className="settings-content">
          {activeTab === 'genres' && (
            <div {...panelProps('genres')}>
              <div className="settings-card">
                <div className="settings-section-title">Любимые жанры</div>
                <p className="settings-hint settings-section-hint">
                  Выберите то, что вам ближе — это настроит ваш поток. Сохраняется
                  автоматически.
                </p>
                <GenreSelect
                  selected={prefs.genres}
                  detected={detected.genres}
                  onChange={(genres) => setPrefs((prev) => ({ ...prev, genres }))}
                />
              </div>
            </div>
          )}

          {activeTab === 'artists' && (
            <div {...panelProps('artists')}>
              <div className="settings-card">
                <div className="settings-section-title">Любимые артисты</div>
                <p className="settings-hint settings-section-hint">
                  Отметьте артиста — рядом появятся похожие. Нужного нет — найдите
                  поиском. Сохраняется автоматически.
                </p>
                <ArtistSelect
                  selected={prefs.artists}
                  excluded={prefs.excludedArtists}
                  detected={detected.artists}
                  genres={prefs.genres}
                  suggestionLimit={48}
                  onChange={({ artists, excludedArtists }) =>
                    setPrefs((prev) => ({ ...prev, artists, excludedArtists }))
                  }
                />
              </div>
            </div>
          )}

          {activeTab === 'recs' && (
            <div {...panelProps('recs')}>
              <div className="settings-card">
                <div className="settings-section-title">Новые открытия</div>
                <p className="settings-hint settings-section-hint">
                  Влияют на рекомендации и ваш персональный поток. Сохраняется
                  автоматически.
                </p>

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

              </div>
            </div>
          )}

          {activeTab === 'playback' && (
            <div {...panelProps('playback')}>
              <div className="settings-card">
                <div className="settings-row settings-row-quality">
                  <div>
                    <div className="settings-label">Качество звука</div>
                    <div className="settings-hint">
                      64 кбит/с — вдвое меньше трафика. Смена применится со следующего
                      трека: играющий не перезагружается, чтобы не рвать звук
                    </div>
                  </div>
                  <div className="settings-seg" role="group" aria-label="Качество звука">
                    {QUALITY_OPTIONS.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`settings-seg-btn ${streamQuality === value ? 'active' : ''}`}
                        aria-pressed={streamQuality === value}
                        onClick={() => setStreamQuality(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-row">
                  <div>
                    <div className="settings-label">Запоминать плеер</div>
                    <div className="settings-hint">
                      При следующем открытии продолжить с того же трека и места. Очередь
                      хранится 48 часов
                    </div>
                  </div>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={rememberPlayer}
                      onChange={toggleRememberPlayer}
                      aria-label="Запоминать плеер"
                    />
                    <span className="settings-toggle-slider" />
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div {...panelProps('appearance')}>
              <div className="settings-card">
                <div className="settings-row">
                  <div>
                    <div className="settings-label">Облегчённый режим</div>
                    <div className="settings-hint">
                      Отключает анимации и фоновые эффекты, снижая нагрузку на процессор
                    </div>
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
                  <div>
                    <div className="settings-label">Иконки кистью</div>
                    <div className="settings-hint">
                      Иконки нарисованы мазками, как сердце на логотипе
                    </div>
                  </div>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={brushIcons}
                      onChange={toggleBrushIcons}
                      aria-label="Иконки кистью"
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
            </div>
          )}

          {activeTab === 'security' && (
            <div {...panelProps('security')}>
              {/* Сначала способы второго фактора, потом устройства: доверенное
                  устройство — это как раз то, что второй фактор позволяет
                  пропускать при входе. */}
              <TwoFactorSettings />
              <EmailTwoFactorSettings />
              <TrustedDevices />
            </div>
          )}

          {activeTab === 'diag' && (
            <div {...panelProps('diag')}>
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
                      if (!window.confirm('Очистить журнал диагностики?')) return
                      clearDiag()
                      setDiagText('Лог очищен.')
                    }}
                  >
                    Очистить
                  </button>
                </div>
                {diagText !== null && <pre className="settings-diag-log">{diagText}</pre>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Settings