import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Download, Link2 } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import GenreSelect from '../components/GenreSelect'
import ArtistSelect from '../components/ArtistSelect'
import api from '../services/api'
import { toast } from '../store/toastStore'
import './PreferencesOnboarding.css'

/**
 * Необязательный онбординг после регистрации, три шага:
 *
 * 1. любимые жанры (каталог — теги Last.fm, см. backend/app/lastfm_genres.py);
 * 2. любимые артисты — подсказки зависят от жанров шага 1 (tag.getTopArtists),
 *    плюс поиск по каталогу и YouTube Music;
 * 3. импорт профилей и плейлистов из других сервисов (тот же /import, что и на
 *    странице «Моя музыка»).
 *
 * Пропустить можно ЛЮБОЙ шаг: онбординг остаётся необязательным, всё то же
 * есть в настройках. Предпочтения сохраняются при уходе со второго шага —
 * дальше идёт импорт, который к ним не относится, и терять уже сделанный выбор
 * из-за него нельзя.
 */
const STEPS = [
  { title: 'Что вы любите слушать?', hint: 'Выберите жанры — мы соберём поток под ваш вкус. Это можно изменить в настройках в любой момент.' },
  { title: 'Любимые артисты', hint: 'Подсказки собраны по выбранным жанрам. Нужного нет — найдите поиском.' },
  { title: 'Перенести музыку', hint: 'Вставьте ссылку на профиль, плейлист, альбом или избранное — SoundCloud, Yandex Music или Spotify.' },
]

function PreferencesOnboarding() {
  const navigate = useNavigate()
  const { updatePreferences } = useAuthStore()

  const [step, setStep] = useState(0)
  const [genres, setGenres] = useState([])
  const [artists, setArtists] = useState([])
  const [excludedArtists, setExcludedArtists] = useState([])
  const [detected, setDetected] = useState({ genres: [], artists: [] })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [importUrl, setImportUrl] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(0)

  // Вкус, выведенный из прослушиваний: у пришедшего по инвайту юзера история
  // может быть уже не пустой (импорт, лайки до онбординга).
  useEffect(() => {
    let active = true
    api
      .get('/users/me/taste')
      .then((res) => {
        if (active) {
          setDetected({
            genres: res.data?.genres || [],
            artists: res.data?.artists || [],
          })
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const finish = () => navigate('/')

  /** Сохраняет выбор и уводит на шаг импорта. Пустой выбор не сохраняем:
   *  PUT со пустыми списками затёр бы предпочтения, если юзер уже что-то
   *  выбирал раньше и просто прошёл онбординг мимо. */
  const savePreferences = async () => {
    if (saved || (!genres.length && !artists.length && !excludedArtists.length)) {
      return true
    }
    setSaving(true)
    const result = await updatePreferences(genres, artists, excludedArtists)
    setSaving(false)
    if (!result.success) {
      toast.error(result.error)
      return false
    }
    setSaved(true)
    return true
  }

  const goNext = async () => {
    if (step === 0) {
      setStep(1)
      return
    }
    if (step === 1) {
      if (await savePreferences()) setStep(2)
      return
    }
    finish()
  }

  const skipStep = async () => {
    if (step === 0) {
      setStep(1)
      return
    }
    if (step === 1) {
      // Пропуск артистов не отменяет уже выбранные жанры.
      if (await savePreferences()) setStep(2)
      return
    }
    finish()
  }

  const handlePreview = async () => {
    const url = importUrl.trim()
    if (!url || previewing) return
    setPreviewing(true)
    setPreview(null)
    try {
      const { data } = await api.post('/import/preview', { url })
      setPreview(data)
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Не удалось прочитать ссылку')
    } finally {
      setPreviewing(false)
    }
  }

  const handleImport = async () => {
    const url = importUrl.trim()
    if (!url || importing) return
    setImporting(true)
    try {
      const { data } = await api.post('/import', { url })
      const parts = [`Импортировано треков: ${data.imported}`]
      if (data.matched) parts.push(`подобрано: ${data.matched}`)
      if (data.skipped) parts.push(`пропущено: ${data.skipped}`)
      toast.success(parts.join(', '))
      setImported((count) => count + (data.imported || 0))
      setImportUrl('')
      setPreview(null)
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Не удалось импортировать')
    } finally {
      setImporting(false)
    }
  }

  const nextLabel = () => {
    if (step === 0) return genres.length ? `Далее (${genres.length})` : 'Далее'
    if (step === 1) {
      if (saving) return 'Сохранение...'
      return artists.length ? `Далее (${artists.length})` : 'Далее'
    }
    return 'Готово'
  }

  const busy = saving || importing || previewing

  return (
    <div className="onboarding-container">
      <div className="onboarding-card">
        <div className="onboarding-steps" aria-label={`Шаг ${step + 1} из ${STEPS.length}`}>
          {STEPS.map((_, index) => (
            <span
              key={index}
              className={`onboarding-step-dot ${index === step ? 'active' : ''} ${
                index < step ? 'done' : ''
              }`}
            />
          ))}
          <span className="onboarding-step-counter">
            Шаг {step + 1} из {STEPS.length}
          </span>
        </div>

        <div className="onboarding-header">
          <h1>{STEPS[step].title}</h1>
          <p>{STEPS[step].hint}</p>
        </div>

        {step === 0 && (
          <GenreSelect selected={genres} detected={detected.genres} onChange={setGenres} />
        )}

        {step === 1 && (
          <ArtistSelect
            selected={artists}
            excluded={excludedArtists}
            detected={detected.artists}
            genres={genres}
            onChange={({ artists: nextArtists, excludedArtists: nextExcluded }) => {
              setArtists(nextArtists)
              setExcludedArtists(nextExcluded)
              // Выбор изменился — сохранять придётся заново.
              setSaved(false)
            }}
          />
        )}

        {step === 2 && (
          <div className="onboarding-import">
            <div className="onboarding-import-input">
              <Link2 size={18} />
              <input
                type="url"
                value={importUrl}
                onChange={(e) => {
                  setImportUrl(e.target.value)
                  setPreview(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handlePreview()
                  }
                }}
                placeholder="https://open.spotify.com/playlist/..."
              />
              <button
                type="button"
                className="onboarding-import-check"
                onClick={handlePreview}
                disabled={!importUrl.trim() || previewing}
              >
                {previewing ? 'Читаем...' : 'Проверить'}
              </button>
            </div>

            <ul className="onboarding-import-examples">
              <li>open.spotify.com/playlist/… · /album/… · /track/…</li>
              <li>soundcloud.com/user · /user/sets/playlist</li>
              <li>music.yandex.ru/users/…/playlists/… (нужны cookies, см. «Моя музыка»)</li>
            </ul>

            {preview && (
              <div className="onboarding-preview">
                <div className="onboarding-preview-head">
                  {preview.cover_url && (
                    <img src={preview.cover_url} alt="" className="onboarding-preview-cover" />
                  )}
                  <div>
                    <div className="onboarding-preview-title">
                      {preview.title || 'Без названия'}
                    </div>
                    <div className="onboarding-preview-meta">
                      {preview.source} · треков: {preview.track_count ?? preview.tracks?.length ?? 0}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="onboarding-import-btn"
                  onClick={handleImport}
                  disabled={importing}
                >
                  <Download size={16} />
                  {importing ? 'Импортируем...' : 'Импортировать'}
                </button>
              </div>
            )}

            {imported > 0 && (
              <p className="onboarding-imported">
                <Check size={14} /> Перенесено треков: {imported}. Можно вставить ещё одну ссылку.
              </p>
            )}
          </div>
        )}

        <div className="onboarding-actions">
          {step > 0 && (
            <button
              type="button"
              className="onboarding-back"
              onClick={() => setStep(step - 1)}
              disabled={busy}
            >
              Назад
            </button>
          )}
          <button
            type="button"
            className="onboarding-skip"
            onClick={skipStep}
            disabled={busy}
          >
            Пропустить
          </button>
          <button
            type="button"
            className="onboarding-save"
            onClick={goNext}
            disabled={busy}
          >
            {nextLabel()}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PreferencesOnboarding
