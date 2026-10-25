import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Download, Link2 } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { markOnboardingSeen } from '../services/onboarding'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import defaultCover from '../assets/default-cover.webp'
import GenreSelect from '../components/GenreSelect'
import ArtistSelect from '../components/ArtistSelect'
import ImportCollectionPicker, {
  allCollectionKeys,
  selectedTrackCount,
} from '../components/ImportCollectionPicker'
import { useImportStore, importIsFinal, newImportId } from '../store/importStore'
import { stageCounter } from '../components/ImportProgressModal'
import api from '../services/api'
import { toast } from '../store/toastStore'
import './PreferencesOnboarding.css'

/**
 * Необязательный онбординг после регистрации, три шага:
 *
 * 1. импорт профилей и плейлистов из других сервисов (тот же /import, что и на
 *    странице «Медиатека»);
 * 2. любимые жанры (каталог — теги Last.fm, см. backend/app/lastfm_genres.py);
 * 3. любимые артисты — подсказки зависят от жанров шага 2 (tag.getTopArtists),
 *    плюс поиск по каталогу и YouTube Music.
 *
 * Импорт первым: из новичков возвращаются в основном те, кто перенёс свою
 * музыку, а большая коллекция переносится минутами. Он идёт на сервере, пока
 * юзер выбирает жанры и артистов, и не держит его на месте; по готовности
 * подсказки «по прослушиваниям» перечитываются уже с импортом.
 *
 * Пропустить можно ЛЮБОЙ шаг: онбординг остаётся необязательным, всё то же
 * есть в настройках. Предпочтения сохраняются на выходе с последнего шага.
 */
const STEPS = [
  { title: 'Перенесите свою музыку', hint: 'Вставьте ссылку на профиль, плейлист, альбом или избранное — SoundCloud, Yandex Music, Spotify или Deezer. Перенос пойдёт в фоне, пока вы выбираете жанры и артистов.' },
  { title: 'Что вы любите слушать?', hint: 'Выберите жанры — мы соберём поток под ваш вкус. Это можно изменить в настройках в любой момент.' },
  { title: 'Любимые артисты', hint: 'Подсказки собраны по выбранным жанрам. Нужного нет — найдите поиском.' },
]

const IMPORT_STEP = 0
const GENRE_STEP = 1
const ARTIST_STEP = 2

function PreferencesOnboarding() {
  const navigate = useNavigate()
  const { updatePreferences, user } = useAuthStore()

  // Показан — больше сам не открывается (см. services/onboarding.js).
  useEffect(() => markOnboardingSeen(user?.id), [user?.id])

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
  // Импорты, запущенные с этого экрана: их ход виден строкой на всех шагах.
  const [importIds, setImportIds] = useState([])
  const imports = useImportStore((s) => s.imports)
  const importsCompleted = useImportStore((s) => s.completed)
  // Профиль Yandex Music: какие коллекции импортировать (ключи из превью).
  const [selectedCollections, setSelectedCollections] = useState(new Set())
  const isProfilePreview = preview?.kind === 'profile' && preview.collections?.length > 0

  // Вкус, выведенный из прослушиваний: у пришедшего по инвайту юзера история
  // может быть уже не пустой (импорт, лайки до онбординга). Закончился импорт —
  // перечитываем: перенесённая коллекция и есть лучшая подсказка.
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
  }, [importsCompleted])

  const finish = () => navigate('/')

  /** Сохраняет выбор перед уходом с онбординга. Пустой выбор не сохраняем:
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
    if (step < ARTIST_STEP) {
      setStep(step + 1)
      return
    }
    if (await savePreferences()) finish()
  }

  // Пропуск артистов не отменяет уже выбранные жанры.
  const skipStep = goNext

  const handlePreview = async () => {
    const url = importUrl.trim()
    if (!url || previewing) return
    setPreviewing(true)
    setPreview(null)
    try {
      const { data } = await api.post('/import/preview', { url })
      setPreview(data)
      setSelectedCollections(allCollectionKeys(data))
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Не удалось прочитать ссылку')
    } finally {
      setPreviewing(false)
    }
  }

  /** Запускает импорт и сразу ведёт дальше: ждать его на этом экране не
   *  нужно, ход виден строкой статуса, ошибку покажет стор тостом. */
  const handleImport = () => {
    const url = importUrl.trim()
    if (!url) return
    const id = newImportId()
    useImportStore.getState().start({
      id,
      url,
      collections: isProfilePreview ? [...selectedCollections] : undefined,
      title: preview?.title,
      openModal: false,
    })
    setImportIds((ids) => [...ids, id])
    setImportUrl('')
    setPreview(null)
    setStep(GENRE_STEP)
  }

  const nextLabel = () => {
    if (step === GENRE_STEP) return genres.length ? `Далее (${genres.length})` : 'Далее'
    if (step === ARTIST_STEP) {
      if (saving) return 'Сохранение...'
      return artists.length ? `Готово (${artists.length})` : 'Готово'
    }
    return 'Далее'
  }

  const busy = saving || previewing
  const ownImports = importIds.map((id) => imports[id]).filter(Boolean)

  return (
    <div className="onboarding-container">
      <div className={`onboarding-card ${step !== IMPORT_STEP ? 'wide' : ''}`}>
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

        {ownImports.length > 0 && <ImportStatus imports={ownImports} />}

        {step === GENRE_STEP && (
          <GenreSelect selected={genres} detected={detected.genres} onChange={setGenres} />
        )}

        {step === ARTIST_STEP && (
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

        {step === IMPORT_STEP && (
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
              <li>deezer.com/playlist/… · /album/… · /track/…</li>
              <li>soundcloud.com/user · /user/sets/playlist</li>
              <li>music.yandex.ru/users/login (профиль) · /users/login/playlists/… · /album/…</li>
            </ul>

            {preview && (
              <div className="onboarding-preview">
                <div className="onboarding-preview-head">
                  {preview.cover_url && (
                    <img
                      src={resolveCoverUrl(preview.cover_url) || defaultCover}
                      alt=""
                      className="onboarding-preview-cover"
                      onError={handleCoverError}
                    />
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
                {isProfilePreview && (
                  <ImportCollectionPicker
                    collections={preview.collections}
                    selected={selectedCollections}
                    onChange={setSelectedCollections}
                  />
                )}
                <button
                  type="button"
                  className="btn btn--primary onboarding-import-btn"
                  onClick={handleImport}
                  disabled={isProfilePreview && !selectedCollections.size}
                >
                  <Download size={16} />
                  {isProfilePreview
                    ? `Перенести (${selectedTrackCount(preview, selectedCollections)} треков) и дальше`
                    : 'Перенести и дальше'}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="onboarding-actions">
          {step > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--lg onboarding-back"
              onClick={() => setStep(step - 1)}
              disabled={busy}
            >
              Назад
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--lg onboarding-skip"
            onClick={skipStep}
            disabled={busy}
          >
            Пропустить
          </button>
          <button
            type="button"
            className="btn btn--primary btn--lg onboarding-save"
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

/** Ход импортов, запущенных с онбординга, — видна на всех шагах. Окно
 *  прогресса здесь не открываем: оно закрыло бы выбор жанров. */
function ImportStatus({ imports }) {
  const running = imports.filter((e) => !importIsFinal(e.state))
  const done = imports.filter((e) => e.state.stage === 'done')
  const failed = imports.length - running.length - done.length
  const total = done.reduce((sum, e) => sum + (e.state.imported || 0), 0)

  let text
  if (running.length) {
    const counter = stageCounter(running[0].state)
    text = counter
      ? `Переносим музыку: ${counter[0]} из ${counter[1]}. Можно продолжать.`
      : 'Переносим музыку… Можно продолжать.'
  } else if (done.length) {
    text = `Перенесено треков: ${total}. Подсказки ниже учитывают вашу музыку.`
  } else {
    text = 'Перенос не удался — его можно повторить в «Медиатеке».'
  }

  return (
    <p className={`onboarding-imported onboarding-import-status ${failed && !running.length && !done.length ? 'error' : ''}`} role="status">
      {running.length ? <Download size={14} /> : <Check size={14} />} {text}
    </p>
  )
}

export default PreferencesOnboarding
