import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat1, Volume2, Heart, ListPlus, Download } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError, upscaleCover } from '../utils/media'
import { toast } from '../store/toastStore'
import { API_URL, SERVER_URL } from '../config'
import './Player.css'

// Внешний трек (YouTube Music/SoundCloud) резолвится на бэке лениво и иногда
// спотыкается о временный сбой (таймаут/сеть/429 у источника) — бэк в этом
// случае отдаёт 503, а не 404 (см. ytdlp.py: TransientResolveError). Вместо
// немедленного скипа даём треку 2 тихих повторных попытки с нарастающей
// паузой; скипаем сразу только если бэк явно сказал «трек недоступен» (404)
// или ретраи исчерпаны.
const MAX_TRACK_RETRIES = 2
const RETRY_DELAY_MS = 900
// Проверочный range-запрос при ошибке не должен зависать дольше этого —
// иначе зависший probe держит трек в состоянии "буферизуется" бесконечно.
const PROBE_TIMEOUT_MS = 6000
// Ленивая подгрузка следующего трека: начинаем буферизовать его, когда до
// конца текущего осталось <=20с ИЛИ проиграно >=85% — что наступит раньше.
// Окно по остатку масштабируется вниз для коротких треков (40% длительности),
// чтобы они не начинали буферизацию сразу со старта.
const PRELOAD_NEXT_REMAINING_SEC = 20
const PRELOAD_NEXT_REMAINING_RATIO = 0.4
const PRELOAD_NEXT_PROGRESS_RATIO = 0.85

// Собирает "сырой" src для <audio> из объекта трека — используется и для
// текущего трека, и для ленивой подгрузки следующего.
function resolveRawUrl(track, isExternal) {
  if (!track) return undefined
  // Материализованный в БД трек (числовой id) — всегда через свой бэкенд-эндпоинт
  // стрима: он реконструирует URL провайдера против ТЕКУЩЕГО хоста. Сохранённый
  // в track.stream_url хост зашит на момент сохранения и умирает при переносе
  // деплоя/смене туннеля. У результатов поиска id строковый ("ytmusic:...") —
  // они не в БД, для них stream_url свежий, с текущим хостом.
  if (typeof track.id === 'number') return `${API_URL}/tracks/${track.id}/stream`
  if (isExternal) return track.stream_url
  if (track.id) return `${API_URL}/tracks/${track.id}/stream`
  if (track.file_path?.startsWith('http')) return track.file_path
  if (track.file_path) {
    return `${SERVER_URL}${track.file_path.startsWith('/') ? '' : '/'}${track.file_path}`
  }
  return undefined
}

function Player() {
  const {
    currentTrack,
    isPlaying,
    volume,
    currentTime,
    duration,
    togglePlayPause,
    nextTrack,
    previousTrack,
    setCurrentTime,
    setDuration,
    setVolume,
    openFullScreen,
    isRepeatOne,
    isShuffle,
    toggleRepeatOne,
    toggleShuffle,
    likedTrackIds,
    fetchLikedTracks,
    toggleTrackLike,
    materializeCurrentTrack,
    prefetchNext,
    seekRequest,
    clearSeekRequest,
  } = usePlayerStore()

  const audioRef = useRef(null)
  const blobUrlRef = useRef(null)
  // Скрытый <audio preload="none">, который буферизирует следующий трек
  // очереди, когда текущий подходит к концу — без него оставался бы только
  // фоновый прогрев резолва на бэке (prefetchNext), а не реальная буферизация
  // байтов в браузере.
  const nextAudioRef = useRef(null)
  const nextBlobUrlRef = useRef(null)
  // id трека, для которого уже запущена ленивая подгрузка следующего — чтобы
  // не запускать её повторно на каждом timeupdate.
  const preloadTriggeredForRef = useRef(null)
  const lastRecordedTrackIdRef = useRef(null)
  // Токен актуальности резолва audioSrc (см. эффект ниже) — защита от того,
  // что устаревший (для уже пропущенного трека) fetch применит свой результат
  // позже, чем актуальный.
  const resolveTokenRef = useRef({})
  // Счётчик тихих ретраев текущего трека и хендл отложенного повтора —
  // при ошибке внешнего трека не скипаем сразу, а даём 1-2 попытки.
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  const [audioSrc, setAudioSrc] = useState(null)
  // Спиннер на время резолва/загрузки потока внешнего трека — иначе долгий
  // (но живой) резолв YouTube Music выглядит как зависший плеер.
  const [isBuffering, setIsBuffering] = useState(false)
  const [loadingLike, setLoadingLike] = useState(false)
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false)
  const [playlists, setPlaylists] = useState([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [loadingPlaylists, setLoadingPlaylists] = useState(false)
  const [addError, setAddError] = useState('')
  const isExternalTrack = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(currentTrack?.source)
  // Числовой id БД: db_id (после материализации) или сам id у локальных/списочных.
  const dbTrackId =
    currentTrack?.db_id ?? (typeof currentTrack?.id === 'number' ? currentTrack.id : null)
  // С треком можно взаимодействовать, если он в БД или его можно туда добавить.
  const canInteract = dbTrackId !== null || isExternalTrack

  // Ленивая подгрузка следующего трека: пока не наступил порог — буфер
  // остаётся пустым (preload="none"), браузер не трогает файл следующего
  // трека. При приближении к концу текущего переключаем скрытый <audio> на
  // preload="auto" и задаём ему src следующего трека — начинается фоновая
  // буферизация без видимого запроса от пользователя.
  const triggerNextPreload = () => {
    const trackId = currentTrack?.id
    if (trackId == null || preloadTriggeredForRef.current === trackId) return
    const next = usePlayerStore.getState().getNextTrack()
    if (!next) return
    preloadTriggeredForRef.current = trackId

    const nextIsExternal = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(next.source)
    const rawUrl = resolveRawUrl(next, nextIsExternal)
    if (!rawUrl) return

    const nextAudio = nextAudioRef.current
    if (!nextAudio) return

    if (nextBlobUrlRef.current) {
      URL.revokeObjectURL(nextBlobUrlRef.current)
      nextBlobUrlRef.current = null
    }

    const isOurApi = !nextIsExternal && (rawUrl.startsWith(API_URL) || rawUrl.startsWith(SERVER_URL))
    const swActive = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller
    nextAudio.preload = 'auto'
    if (isOurApi && !swActive) {
      fetch(rawUrl, { headers: { 'tuna-skip-browser-warning': '1', 'ngrok-skip-browser-warning': '1' } })
        .then((r) => r.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob)
          nextBlobUrlRef.current = url
          nextAudio.src = url
          nextAudio.load()
        })
        .catch(() => {})
    } else {
      nextAudio.src = rawUrl
      nextAudio.load()
    }
  }

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => {
      setCurrentTime(audio.currentTime)
      const remainingWindow = Math.min(
        PRELOAD_NEXT_REMAINING_SEC,
        audio.duration * PRELOAD_NEXT_REMAINING_RATIO
      )
      if (
        audio.duration &&
        (audio.duration - audio.currentTime <= remainingWindow ||
          audio.currentTime / audio.duration >= PRELOAD_NEXT_PROGRESS_RATIO)
      ) {
        triggerNextPreload()
      }
    }
    const updateDuration = () => setDuration(audio.duration)
    const handleEnded = () => {
      if (usePlayerStore.getState().isRepeatOne) {
        audio.currentTime = 0
        audio.play().catch(() => {})
      } else {
        nextTrack()
      }
    }

    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('loadedmetadata', updateDuration)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('loadedmetadata', updateDuration)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [currentTrack?.id, setCurrentTime, setDuration, nextTrack])

  useEffect(() => {
    if (dbTrackId) {
      fetchLikedTracks().catch((error) => {
        console.error('Error checking liked status:', error)
      })
    }
  }, [dbTrackId, fetchLikedTracks])

  // Resolve audio URL. audio-sw.js подставляет заголовок для обхода
  // предупреждения Tuna на уровне сети, так что <audio> обычно может грузить
  // src напрямую и стримить файл нативными Range-запросами (трек начинает
  // играть почти сразу, без ожидания полной закачки). Пока SW ещё не взял
  // страницу под контроль (самый первый визит до активации) — как и раньше,
  // подстраховываемся ручным fetch+blob с нужным заголовком.
  //
  // При быстром скипе несколько таких резолвов оказываются в полёте
  // одновременно (fetch трека A ещё не завершился, а currentTrack уже B,
  // потом C). Без проверки актуальности резолв A мог применить свой blob
  // через setAudioSrc уже ПОСЛЕ того как currentTrack стал C — визуально это
  // выглядело как "проскочивший" (уже пропущенный) трек на миг заигрывает,
  // а потом резко обрывается, когда его перебивает следующий резолв.
  // resolveTokenRef фиксирует, какой резолв последний актуальный — устаревшие
  // просто игнорируют свой результат.
  useEffect(() => {
    if (!currentTrack) {
      resolveTokenRef.current = {}
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setAudioSrc(undefined)
      return
    }

    const rawUrl = resolveRawUrl(currentTrack, isExternalTrack)

    if (!rawUrl) {
      resolveTokenRef.current = {}
      setAudioSrc(undefined)
      return
    }

    const isOurApi = !isExternalTrack && (rawUrl.startsWith(API_URL) || rawUrl.startsWith(SERVER_URL))
    const swActive = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    const token = {}
    resolveTokenRef.current = token

    if (isOurApi && !swActive) {
      setAudioSrc(null)
      fetch(rawUrl, { headers: { 'tuna-skip-browser-warning': '1', 'ngrok-skip-browser-warning': '1' } })
        .then((r) => r.blob())
        .then((blob) => {
          if (resolveTokenRef.current !== token) {
            // Трек уже сменился, пока грузился этот blob — не применяем
            // устаревший результат, иначе на миг заиграет пропущенный трек.
            return
          }
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setAudioSrc(url)
        })
        .catch(() => {
          if (resolveTokenRef.current === token) setAudioSrc(rawUrl)
        })
    } else {
      setAudioSrc(rawUrl)
    }

    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [currentTrack?.id, currentTrack?.file_path, currentTrack?.stream_url, isExternalTrack, API_URL, SERVER_URL])

  // Reload audio when track changes
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    // Новый трек — сбрасываем счётчик ретраев и отменяем висящий отложенный
    // повтор от предыдущего трека.
    retryCountRef.current = 0
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    setIsBuffering(false)

    // Сам load() тут не нужен: смена src (через audioSrc, см. эффект выше)
    // уже запускает алгоритм загрузки ресурса сама по себе — явный load()
    // здесь означал повторную полную загрузку того же потока (раньше element
    // ещё и пересоздавался целиком из-за key={currentTrack?.id}, отсюда и
    // третий "дубль" запроса). Громкость на persistent-элементе не сбрасывается
    // сама, но выставляем явно для надёжности.
    audio.volume = usePlayerStore.getState().volume
    setCurrentTime(0)
    setDuration(0)
    setShowAddToPlaylist(false)
    setAddError('')
    setSelectedPlaylistId('')

    // Сбрасываем состояние ленивой подгрузки следующего трека — новый трек
    // ещё не приблизился к концу, буферизировать пока нечего.
    preloadTriggeredForRef.current = null
    if (nextBlobUrlRef.current) {
      URL.revokeObjectURL(nextBlobUrlRef.current)
      nextBlobUrlRef.current = null
    }
    const nextAudio = nextAudioRef.current
    if (nextAudio) {
      nextAudio.removeAttribute('src')
      nextAudio.preload = 'none'
      nextAudio.load()
    }
  }, [currentTrack?.id, setCurrentTime, setDuration])

  // Отменяем висящий ретрай и освобождаем буфер предзагрузки при
  // размонтировании плеера.
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      if (nextBlobUrlRef.current) {
        URL.revokeObjectURL(nextBlobUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    const handleLoad = () => {
      setDuration(audio.duration)
    }

    const handleCanPlay = () => {
      if (isPlaying) {
        audio.play().catch(err => {
          console.error('Error playing audio:', err)
        })
      }
    }

    const handleError = (e) => {
      console.error('Audio error:', e)
      console.error('Audio error code:', audio.error?.code)
      console.error('Audio error message:', audio.error?.message)
      console.error('Audio src:', audio.src)
      console.error('Current track:', currentTrack)
    }

    audio.addEventListener('loadedmetadata', handleLoad)
    audio.addEventListener('canplay', handleCanPlay)
    audio.addEventListener('error', handleError)

    if (isPlaying && audio.readyState >= 2) {
      audio.play().catch(err => {
        console.error('Error playing audio:', err)
      })
    } else if (!isPlaying) {
      audio.pause()
    }

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoad)
      audio.removeEventListener('canplay', handleCanPlay)
      audio.removeEventListener('error', handleError)
    }
  }, [isPlaying, currentTrack, setDuration])

  // Как только заиграл текущий трек — прогреваем следующий в очереди на бэке
  // и, если играет «Моя волна», подтягиваем следующую порцию потока.
  useEffect(() => {
    if (!currentTrack) return
    prefetchNext()
    usePlayerStore.getState().extendFlowIfNeeded()
  }, [currentTrack?.id, prefetchNext])

  useEffect(() => {
    if (!isPlaying || !currentTrack) return
    if (!canInteract) return
    // Стабильный ключ: у внешних трек id меняется после материализации.
    const playKey = currentTrack.external_id ?? currentTrack.id
    if (lastRecordedTrackIdRef.current === playKey) return
    lastRecordedTrackIdRef.current = playKey
    ;(async () => {
      try {
        const id = dbTrackId ?? (await materializeCurrentTrack())
        if (id) await api.post(`/tracks/${id}/play`)
      } catch (error) {
        console.error('Error recording play:', error)
      }
    })()
  }, [currentTrack?.id, currentTrack?.external_id, isPlaying, canInteract, dbTrackId, materializeCurrentTrack])

  useEffect(() => {
    const audio = audioRef.current
    if (audio) {
      audio.volume = volume
    }
  }, [volume])

  // Перемотка, инициированная из полноэкранного плеера (у него нет доступа к
  // <audio>). Применяем к элементу и сбрасываем запрос.
  useEffect(() => {
    if (!seekRequest) return
    const audio = audioRef.current
    if (audio && !isNaN(seekRequest.time)) {
      audio.currentTime = seekRequest.time
    }
    clearSeekRequest()
  }, [seekRequest, clearSeekRequest])

  // Media Session API — инфо о треке в системном виджете проигрывания (экран
  // блокировки, шторка, медиаклавиши). Метаданные обновляем при смене трека.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack) {
      navigator.mediaSession.metadata = null
      return
    }
    const artwork = isExternalTrack
      ? upscaleCover(currentTrack.cover_url)
      : resolveCoverUrl(currentTrack.cover_url)
    const artworkUrl = artwork
      ? new URL(artwork, window.location.origin).href
      : new URL(defaultCover, window.location.origin).href

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: currentTrack.title || 'Неизвестный трек',
      artist: currentTrack.artist || '',
      album: currentTrack.album || '',
      artwork: [
        { src: artworkUrl, sizes: '512x512', type: 'image/png' },
      ],
    })
  }, [
    currentTrack?.id,
    currentTrack?.title,
    currentTrack?.artist,
    currentTrack?.album,
    currentTrack?.cover_url,
    isExternalTrack,
  ])

  // Обработчики кнопок системного виджета. Регистрируем один раз.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const seekBy = (offset) => {
      const audio = audioRef.current
      if (!audio) return
      audio.currentTime = Math.min(
        audio.duration || Infinity,
        Math.max(0, audio.currentTime + offset),
      )
    }
    const handlers = {
      play: () => {
        if (!usePlayerStore.getState().isPlaying) togglePlayPause()
      },
      pause: () => {
        if (usePlayerStore.getState().isPlaying) togglePlayPause()
      },
      previoustrack: () => previousTrack(),
      nexttrack: () => nextTrack(),
      seekbackward: (d) => seekBy(-(d.seekOffset || 10)),
      seekforward: (d) => seekBy(d.seekOffset || 10),
      seekto: (d) => {
        const audio = audioRef.current
        if (audio && d.seekTime != null) audio.currentTime = d.seekTime
      },
    }
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action, handler)
      } catch {
        // Некоторые действия могут не поддерживаться браузером — игнорируем.
      }
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          ms.setActionHandler(action, null)
        } catch {
          /* noop */
        }
      }
    }
  }, [togglePlayPause, previousTrack, nextTrack])

  // Статус воспроизведения в виджете (play/pause индикатор).
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = currentTrack
      ? isPlaying
        ? 'playing'
        : 'paused'
      : 'none'
  }, [isPlaying, currentTrack?.id])

  // Позиция/длительность — прогресс-бар в системном виджете.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
    if (!duration || isNaN(duration) || !isFinite(duration)) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(currentTime, duration),
        playbackRate: 1,
      })
    } catch {
      /* значения вне диапазона — пропускаем */
    }
  }, [currentTime, duration])

  if (!currentTrack) {
    return null
  }

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleSeek = (e) => {
    const audio = audioRef.current
    if (!audio) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = x / rect.width
    const newTime = percentage * duration
    audio.currentTime = newTime
    setCurrentTime(newTime)
  }

  const handleLike = async () => {
    if (!canInteract || loadingLike) return

    setLoadingLike(true)
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (id) await toggleTrackLike(id)
    } catch (error) {
      console.error('Error toggling like:', error)
    } finally {
      setLoadingLike(false)
    }
  }

  const isLiked = dbTrackId ? likedTrackIds.includes(dbTrackId) : false

  const handleOpenAddToPlaylist = async () => {
    if (!canInteract) return
    setShowAddToPlaylist((prev) => !prev)
    setAddError('')

    if (playlists.length === 0 && !loadingPlaylists) {
      setLoadingPlaylists(true)
      try {
        const response = await api.get('/playlists/me')
        setPlaylists(response.data)
      } catch (error) {
        setAddError('Не удалось загрузить плейлисты')
      } finally {
        setLoadingPlaylists(false)
      }
    }
  }

  const handleAddToPlaylist = async () => {
    if (!selectedPlaylistId) {
      setAddError('Выберите плейлист')
      return
    }
    setAddError('')
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (!id) {
        setAddError('Не удалось добавить трек')
        return
      }
      await api.post(`/playlists/${selectedPlaylistId}/tracks/${id}`)
      setShowAddToPlaylist(false)
    } catch (error) {
      setAddError(error.response?.data?.detail || 'Не удалось добавить трек')
    }
  }

  // Ошибка <audio> у внешнего трека: только подтверждённый бэком 404 означает,
  // что трек действительно недоступен. 503/сетевой обрыв/таймаут CDN и ошибка
  // декодирования не должны показываться пользователю как «трек недоступен».
  // Для временных сбоев даём MAX_TRACK_RETRIES тихих попыток: перечитываем src через
  // audio.load(), показывая спиннер, и только когда попытки исчерпаны —
  // сдаёмся и переходим к следующему треку.
  const handleAudioError = () => {
    const audio = audioRef.current
    const trackAtError = currentTrack
    console.error('Audio element error:', audio?.error)
    console.error('Track:', trackAtError)
    console.error('Audio src:', audio?.src)

    if (!isExternalTrack || !audio?.src) return

    const mediaError = audio.error
    const isFatal = mediaError?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED

    const giveUp = (unavailable = false) => {
      setIsBuffering(false)
      toast.error(
        unavailable
          ? `Трек недоступен: ${trackAtError.title}`
          : `Не удалось воспроизвести трек: ${trackAtError.title}`
      )
      nextTrack()
    }

    if (retryCountRef.current >= MAX_TRACK_RETRIES) {
      giveUp()
      return
    }

    // Быстрый пробный запрос — если бэк прямо сейчас отвечает 404 (трек
    // окончательно недоступен), ретраить бессмысленно, скипаем сразу вместо
    // того чтобы жечь все попытки на заведомо мёртвый трек. Range 0-1 вместо
    // HEAD: /stream/ отдаёт StreamingResponse, а у неё нет автоматического
    // укорачивания тела под HEAD, так что HEAD рискует утянуть весь файл.
    const scheduleRetry = () => {
      retryCountRef.current += 1
      setIsBuffering(true)
      retryTimeoutRef.current = setTimeout(() => {
        // Трек могли сменить, пока ждали — не трогаем уже неактуальный <audio>.
        if (usePlayerStore.getState().currentTrack?.id !== trackAtError?.id) return
        const el = audioRef.current
        if (!el) return
        el.load()
      }, RETRY_DELAY_MS * retryCountRef.current)
    }

    const controller = new AbortController()
    const probeTimer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    fetch(audio.src, { headers: { Range: 'bytes=0-1' }, signal: controller.signal })
      .then((res) => {
        clearTimeout(probeTimer)
        res.body?.cancel().catch(() => {})
        if (res.status === 404) {
          giveUp(true)
          return
        }
        // MEDIA_ERR_SRC_NOT_SUPPORTED может быть следствием 503/502 с HTML
        // вместо аудио. Это не «трек недоступен», но повтор формата бессмысленен.
        if (isFatal) {
          giveUp()
          return
        }
        // 503 (временный сбой резолва) или любой другой код — повторяем.
        scheduleRetry()
      })
      .catch(() => {
        clearTimeout(probeTimer)
        // Запрос не прошёл (сеть/CORS/таймаут) — не знаем причину, считаем
        // временной и всё равно ретраим, а не скипаем молча. Для неподдержи-
        // ваемого формата повтор бессмысленен, но его статус мы не получили.
        if (isFatal) giveUp()
        else scheduleRetry()
      })
  }

  return (
    <div className="player">
      <div className="player-progress-top" onClick={handleSeek}>
        <div className="player-progress-top-track">
          <div
            className="player-progress-top-fill"
            style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
          >
            <span className="player-progress-time-bubble">{formatTime(currentTime)}</span>
            <span className="player-progress-thumb" />
          </div>
        </div>
        <span className="player-progress-duration">{formatTime(duration)}</span>
      </div>
      <audio
        ref={audioRef}
        src={audioSrc || undefined}
        preload="auto"
        crossOrigin="anonymous"
        onError={handleAudioError}
        onCanPlay={() => {
          // Раз дошли до canplay — источник рабочий, ретраи для этой сессии
          // трека больше не нужны, скрываем спиннер.
          retryCountRef.current = 0
          setIsBuffering(false)
          if (isPlaying) {
            audioRef.current?.play().catch(err => {
              console.error('Play error:', err)
            })
          }
        }}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
      />
      {/* Скрытый плеер для ленивой буферизации следующего трека — начинает
          грузиться только когда triggerNextPreload() выставит ему src. */}
      <audio ref={nextAudioRef} preload="none" crossOrigin="anonymous" style={{ display: 'none' }} />

      <div className="player-left">
        <button
          type="button"
          className="player-cover-wrap"
          onClick={openFullScreen}
          aria-label="Открыть плеер на весь экран"
        >
          <img
            src={isExternalTrack ? upscaleCover(currentTrack.cover_url) || defaultCover : resolveCoverUrl(currentTrack.cover_url) || defaultCover}
            alt={currentTrack.title}
            className="player-cover"
            onError={handleCoverError}
          />
          {isExternalTrack && isBuffering && (
            <div className="player-cover-buffering" role="status" aria-label="Загрузка трека">
              <div className="player-cover-buffering-spinner" />
            </div>
          )}
        </button>
        <div className="player-info">
          <div className="player-track-title">{currentTrack.title}</div>
          <div className="player-track-artist">
            {isExternalTrack && isBuffering ? 'Загрузка…' : currentTrack.artist}
          </div>
        </div>
        {canInteract && (
          <>
            <button
              className={`like-btn ${isLiked ? 'liked' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                handleLike()
              }}
              disabled={loadingLike}
              title={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
            >
              <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
            </button>
            <button
              className="add-btn"
              onClick={(event) => {
                event.stopPropagation()
                handleOpenAddToPlaylist()
              }}
              title="Добавить в плейлист"
            >
              <ListPlus size={18} />
            </button>
          </>
        )}
        {isExternalTrack && currentTrack.download_allowed && currentTrack.download_url && (
          <a
            className="add-btn"
            href={currentTrack.download_url}
            target="_blank"
            rel="noreferrer"
            title="Скачать"
            onClick={(event) => event.stopPropagation()}
          >
            <Download size={18} />
          </a>
        )}
      </div>

      {showAddToPlaylist && (
        <div className="playlist-add-panel">
          <div className="playlist-add-title">Добавить в плейлист</div>
          {loadingPlaylists ? (
            <div className="playlist-add-loading">Загрузка...</div>
          ) : playlists.length === 0 ? (
            <div className="playlist-add-empty">Нет плейлистов</div>
          ) : (
            <select
              className="playlist-add-select"
              value={selectedPlaylistId}
              onChange={(e) => setSelectedPlaylistId(e.target.value)}
            >
              <option value="">Выберите плейлист</option>
              {playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </select>
          )}
          {addError && <div className="playlist-add-error">{addError}</div>}
          <div className="playlist-add-actions">
            <button className="playlist-add-cancel" onClick={() => setShowAddToPlaylist(false)}>
              Отмена
            </button>
            <button className="playlist-add-confirm" onClick={handleAddToPlaylist}>
              Добавить
            </button>
          </div>
        </div>
      )}

      <div className="player-center">
        <div className="player-controls">
          <button
            type="button"
            className={`control-btn ${isShuffle ? 'active' : ''}`}
            onClick={toggleShuffle}
            title={isShuffle ? 'Выключить случайный порядок' : 'Случайный порядок'}
          >
            <Shuffle size={20} />
          </button>
          <button type="button" className="control-btn" onClick={previousTrack} aria-label="Предыдущий">
            <SkipBack size={20} />
          </button>
          <button className="play-pause-btn" onClick={togglePlayPause} aria-label={isPlaying ? 'Пауза' : 'Играть'}>
            {isPlaying ? (
              <Pause size={24} fill="currentColor" />
            ) : (
              <Play size={24} fill="currentColor" style={{ marginLeft: 2 }} />
            )}
          </button>
          <button type="button" className="control-btn" onClick={nextTrack} aria-label="Следующий">
            <SkipForward size={20} />
          </button>
          <button
            type="button"
            className={`control-btn ${isRepeatOne ? 'active' : ''}`}
            onClick={toggleRepeatOne}
            title={isRepeatOne ? 'Выключить повтор трека' : 'Повторять трек'}
          >
            <Repeat1 size={20} />
          </button>
        </div>
      </div>

      <div className="player-right">
        <div className="volume-control">
          <Volume2 size={20} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="volume-slider"
          />
        </div>
      </div>
    </div>
  )
}

export default Player
