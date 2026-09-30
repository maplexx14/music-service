import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ListMusic, Plus, Search, X } from 'lucide-react'
import api from '../services/api'
import { peekCache, writeCache, invalidateCache, playlistCacheKey, LIBRARY_CACHE_KEY } from '../services/pageCache'
import { useAddToPlaylistStore } from '../store/addToPlaylistStore'
import { usePlayerStore } from '../store/playerStore'
import { toast } from '../store/toastStore'
import { haptic, HAPTIC } from '../utils/haptics'
import { plural } from '../utils/format'
import { resolveCoverUrl } from '../utils/media'
import './AddToPlaylistDialog.css'

// Поиск по плейлистам появляется, только когда их столько, что список
// перестаёт помещаться в окно без прокрутки.
const SEARCH_THRESHOLD = 7

// Окно «Добавить в плейлист». Одно на приложение (см. store/addToPlaylistStore):
// открывается со страниц со списками треков и из мини-плеера. На десктопе —
// диалог по центру, на телефоне — нижняя шторка (см. CSS).
function AddToPlaylistDialog() {
  const request = useAddToPlaylistStore((s) => s.request)
  const close = useAddToPlaylistStore((s) => s.close)
  if (!request) return null
  // key — новое окно на каждый трек: состояние строк («добавлено», «уже
  // есть») относится к конкретному треку и не должно переезжать на другой.
  return <Dialog key={request.track?.id ?? 'track'} request={request} onClose={close} />
}

function Dialog({ request, onClose }) {
  const { track, resolveId, excludePlaylistId } = request
  // Список из кэша вкладки «Моя музыка» рисуется сразу, свежий приезжает фоном.
  const [playlists, setPlaylists] = useState(() => peekCache(LIBRARY_CACHE_KEY) ?? null)
  const [loadError, setLoadError] = useState(false)
  const [query, setQuery] = useState('')
  // Состояние строк по id плейлиста: 'adding' | 'added' | 'exists'.
  const [rowState, setRowState] = useState({})
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [submittingNew, setSubmittingNew] = useState(false)
  const dialogRef = useRef(null)
  const trackIdRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    api
      .get('/playlists/me')
      .then(({ data }) => {
        if (cancelled) return
        setPlaylists(data)
        writeCache(LIBRARY_CACHE_KEY, data)
      })
      .catch((error) => {
        console.error('Error fetching my playlists:', error)
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Фокус внутрь окна и обратно туда, откуда его открыли; Esc закрывает.
  useEffect(() => {
    const previous = document.activeElement
    dialogRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && typeof previous.focus === 'function') previous.focus()
    }
  }, [onClose])

  const visible = useMemo(() => {
    const list = (playlists ?? []).filter((p) => String(p.id) !== String(excludePlaylistId ?? ''))
    const q = query.trim().toLowerCase()
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list
  }, [playlists, excludePlaylistId, query])

  const totalCount = (playlists ?? []).length

  // Числовой id трека в БД. Внешний трек материализуется один раз на окно:
  // повторное нажатие (другой плейлист после «уже есть») не шлёт второй импорт.
  const getTrackId = async () => {
    if (trackIdRef.current !== null) return trackIdRef.current
    const id = resolveId
      ? await resolveId()
      : await usePlayerStore.getState().materializeTrack(track)
    trackIdRef.current = id ?? null
    return trackIdRef.current
  }

  // Плейлист изменился — его страница в кэше и счётчик в библиотеке устарели.
  const markChanged = (playlistId) => {
    invalidateCache(playlistCacheKey(playlistId))
    setPlaylists((prev) => {
      if (!prev) return prev
      const next = prev.map((p) =>
        p.id === playlistId ? { ...p, track_count: (p.track_count || 0) + 1 } : p,
      )
      writeCache(LIBRARY_CACHE_KEY, next)
      return next
    })
  }

  const addTo = async (playlist) => {
    const state = rowState[playlist.id]
    if (state === 'adding' || state === 'added') return
    haptic(HAPTIC.selection)
    setRowState((prev) => ({ ...prev, [playlist.id]: 'adding' }))
    try {
      const id = await getTrackId()
      if (!id) throw new Error('Track has no database id')
      await api.post(`/playlists/${playlist.id}/tracks/${id}`, null, { skipErrorToast: true })
      setRowState((prev) => ({ ...prev, [playlist.id]: 'added' }))
      markChanged(playlist.id)
      haptic(HAPTIC.success)
      toast.success(`Добавлено в «${playlist.name}»`)
      onClose()
    } catch (error) {
      if (error.response?.status === 400) {
        // Окно не закрываем: пользователь, скорее всего, хочет выбрать другой.
        setRowState((prev) => ({ ...prev, [playlist.id]: 'exists' }))
        return
      }
      console.error('Error adding track to playlist:', error)
      setRowState((prev) => ({ ...prev, [playlist.id]: undefined }))
      toast.error('Не удалось добавить трек')
    }
  }

  const createAndAdd = async (e) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || submittingNew) return
    setSubmittingNew(true)
    try {
      const { data: created } = await api.post('/playlists', { name, is_public: true })
      const summary = { ...created, track_count: 0 }
      setPlaylists((prev) => {
        const next = [...(prev ?? []), summary]
        writeCache(LIBRARY_CACHE_KEY, next)
        return next
      })
      const id = await getTrackId()
      if (!id) throw new Error('Track has no database id')
      await api.post(`/playlists/${created.id}/tracks/${id}`, null, { skipErrorToast: true })
      markChanged(created.id)
      haptic(HAPTIC.success)
      toast.success(`Плейлист «${name}» создан, трек добавлен`)
      onClose()
    } catch (error) {
      console.error('Error creating playlist:', error)
      toast.error('Не удалось создать плейлист')
      setSubmittingNew(false)
    }
  }

  const subtitle = [track?.title, track?.artist].filter(Boolean).join(' — ')

  return createPortal(
    <div
      className="atp-backdrop"
      onMouseDown={(e) => {
        // Только тап в саму подложку: события из окна всплывают сюда же.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="atp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atp-title"
        tabIndex={-1}
      >
        <div className="atp-grabber" aria-hidden="true" />
        <header className="atp-header">
          <div className="atp-heading">
            <h2 id="atp-title" className="atp-title">
              Добавить в плейлист
            </h2>
            {subtitle && <p className="atp-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="atp-close" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </header>

        {totalCount >= SEARCH_THRESHOLD && (
          <label className="atp-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Найти плейлист"
              aria-label="Найти плейлист"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}

        <div className="atp-body">
          {creating ? (
            <form className="atp-create-form" onSubmit={createAndAdd}>
              <input
                type="text"
                className="atp-create-input"
                placeholder="Название плейлиста"
                aria-label="Название плейлиста"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={100}
                autoFocus
                enterKeyHint="done"
              />
              <div className="atp-create-actions">
                <button
                  type="button"
                  className="atp-btn atp-btn-ghost"
                  onClick={() => {
                    setCreating(false)
                    setNewName('')
                  }}
                  disabled={submittingNew}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="atp-btn atp-btn-primary"
                  disabled={!newName.trim() || submittingNew}
                >
                  {submittingNew ? 'Создание...' : 'Создать и добавить'}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="atp-row atp-row-create" onClick={() => setCreating(true)}>
              <span className="atp-row-cover atp-row-cover-create" aria-hidden="true">
                <Plus size={22} />
              </span>
              <span className="atp-row-name">Новый плейлист</span>
            </button>
          )}

          {playlists === null && !loadError && (
            <div className="atp-status" role="status">
              Загрузка...
            </div>
          )}
          {playlists === null && loadError && (
            <div className="atp-status">Не удалось загрузить плейлисты</div>
          )}
          {playlists !== null && visible.length === 0 && (
            <div className="atp-status">
              {query.trim() ? 'Ничего не найдено' : 'Плейлистов пока нет — создайте первый'}
            </div>
          )}

          {visible.length > 0 && (
            <ul className="atp-list">
              {visible.map((playlist) => {
                const state = rowState[playlist.id]
                const count = playlist.track_count ?? 0
                return (
                  <li key={playlist.id}>
                    <button
                      type="button"
                      className={`atp-row${state ? ` is-${state}` : ''}`}
                      onClick={() => addTo(playlist)}
                      disabled={state === 'adding' || submittingNew}
                      aria-busy={state === 'adding'}
                    >
                      {playlist.cover_url ? (
                        <img
                          className="atp-row-cover"
                          src={resolveCoverUrl(playlist.cover_url, 'thumb')}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <span className="atp-row-cover" aria-hidden="true">
                          <ListMusic size={20} />
                        </span>
                      )}
                      <span className="atp-row-text">
                        <span className="atp-row-name">{playlist.name}</span>
                        <span className="atp-row-meta">
                          {state === 'exists'
                            ? 'Трек уже в этом плейлисте'
                            : `${count} ${plural(count, 'трек', 'трека', 'треков')}`}
                        </span>
                      </span>
                      <span className="atp-row-status" aria-hidden="true">
                        {state === 'adding' && <span className="atp-spinner" />}
                        {(state === 'added' || state === 'exists') && <Check size={18} />}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default AddToPlaylistDialog
