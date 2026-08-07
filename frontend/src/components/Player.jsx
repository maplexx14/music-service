import React, { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat1, Volume2, Heart, ThumbsDown, ListPlus, Download, AlignLeft } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { useSwipe } from '../hooks/useSwipe'
import ArtistLink from './ArtistLink'
import { toast } from '../store/toastStore'
import { API_URL, SERVER_URL } from '../config'
import './Player.css'
import { useLyrics } from '../hooks/useLyrics'
import { diag, snapshotAudio, playWithDiag } from '../utils/playerDiag'

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
// Прослушивание засчитывается в play_count (сигнал вкуса) ТОЛЬКО после
// реального прослушивания, а не на старте. Иначе в автоплей-«волне» каждый
// поданный трек получал +play независимо от вовлечённости — и скипнутые/
// фоновые треки накапливали play_count, попадали в профиль вкуса и волна
// подавала их ещё чаще (петля обратной связи). Порог симметричен скипу
// (<25% → skip): засчитываем на ≥50% ИЛИ ≥60с (для длинных треков), 25–50%
// остаётся нейтральной зоной — ни плюс, ни минус.
const PLAY_RECORD_RATIO = 0.5
const PLAY_RECORD_MIN_SEC = 60
// Сколько ждём буфер при отложенном переключении, прежде чем переключиться
// как есть. Больше — дольше играет уже «прошлый» трек; меньше — чаще пауза.
const DEFERRED_SWAP_TIMEOUT_MS = 8000

// Зеркало EXTERNAL_STREAM_PREFIX из backend/app/routers/tracks.py: сюда
// stream_track сам редиректит (307) материализованные внешние треки.
// Строя этот URL сразу на фронте, экономим полный round-trip редиректа
// (через tuna-туннель — десятки-сотни мс) плюс SQL-запрос на бэке
// при КАЖДОМ старте внешнего трека.
// ytmusic тоже срезаем напрямую: /ytdlp/stream сам (а) отдаёт архивную копию
// из MinIO, если она есть (см. stream_cached_audio → archived_music_path),
// (б) ставит ленивую архивацию при первом прослушивании. Крюк через
// /tracks/{id}/stream давал ровно те же байты, но ценой лишнего 307 на
// каждом старте — полный round-trip через туннель.
// soulseek в MinIO не архивируется (P2P), но его прокси-эндпоинт прямой.
const DIRECT_STREAM_PREFIX = {
  soulseek: '/soulseek/stream/',
  ytmusic: '/ytdlp/stream/',
}

// Собирает "сырой" src для <audio> из объекта трека — используется и для
// текущего трека, и для ленивой подгрузки следующего.
function resolveRawUrl(track, isExternal) {
  if (!track) return undefined
  // Материализованный в БД трек (числовой id) — всегда через свой бэкенд-эндпоинт
  // стрима: он реконструирует URL провайдера против ТЕКУЩЕГО хоста. Сохранённый
  // в track.stream_url хост зашит на момент сохранения и умирает при переносе
  // деплоя/смене туннеля. У результатов поиска id строковый ("ytmusic:...") —
  // они не в БД, для них stream_url свежий, с текущим хостом.
  if (typeof track.id === 'number') {
    // Внешний источник с известным external_id — минуем /tracks/{id}/stream
    // и его 307-редирект, идём сразу на эндпоинт провайдера (тот же путь,
    // куда редиректит бэк). Фолбэк на старый путь, если external_id нет.
    const directPrefix = DIRECT_STREAM_PREFIX[track.source]
    if (directPrefix && track.external_id) {
      return `${API_URL}${directPrefix}${track.external_id}`
    }
    return `${API_URL}/tracks/${track.id}/stream`
  }
  if (isExternal) return track.stream_url
  if (track.id) return `${API_URL}/tracks/${track.id}/stream`
  if (track.file_path?.startsWith('http')) return track.file_path
  if (track.file_path) {
    return `${SERVER_URL}${track.file_path.startsWith('/') ? '' : '/'}${track.file_path}`
  }
  return undefined
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Длительность из БД (mutagen для локальных файлов, метаданные провайдера
// для внешних) точнее оценки браузера audio.duration: для стриминговых
// Opus/WebM (yt-dlp) и VBR-MP3 без заголовка Xing Chromium регулярно
// определяет длительность неверно (часто ~2x от реальной) — именно отсюда
// «трек в два раза длиннее». audio.currentTime при этом идёт в реальных
// секундах, поэтому берём длительность из БД как источник истины, а
// audio.duration — лишь как фолбэк, когда в БД длительности нет.
function resolveTrackDuration(audio, track) {
  const dbDuration = Number(track?.duration)
  if (Number.isFinite(dbDuration) && dbDuration > 0) return dbDuration
  const mediaDuration = audio?.duration
  return Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0
}

// Повторный load() — не бесплатная операция: он ОТМЕНЯЕТ уже летящий запрос
// за аудио, сбрасывает элемент в HAVE_NOTHING, а в WebKit заодно снимает
// разрешение играть, выданное элементу по жесту. Из-за этого на iOS трек
// «переключался» молча: playAdjacentNow() стартовал новый src синхронно в
// контексте media-key (единственный момент, когда фоновый play() разрешён), а
// следом React-эффект видел readyState === 0 — нормальное состояние ТОЛЬКО ЧТО
// начатой загрузки — принимал его за «данных нет» и рвал загрузку вторым
// load() + play(), уже вне жеста. Система при этом считала, что играет.
//
// Свежая загрузка нужна ровно тогда, когда элемент реально простаивает: src
// есть, данных нет (HAVE_NOTHING) и сеть не работает (NETWORK_IDLE — браузер
// отложил загрузку в фоне либо вытеснил буфер после долгой паузы). Сразу
// после смены src / load() networkState равен NO_SOURCE или LOADING, и в этот
// момент мы не вмешиваемся.
function needsFreshLoad(audio) {
  if (!audio?.src) return false
  return audio.readyState === audio.HAVE_NOTHING && audio.networkState === audio.NETWORK_IDLE
}

// 12 мс тишины (8 кГц, моно, 8 бит) — ровно чтобы дать деке «сыграть» внутри
// жеста и снять с неё ограничение автоплея (см. эффект разблокировки).
const SILENT_WAV =
  'data:audio/wav;base64,UklGRoQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA='

// Прогресс-бар вынесен в отдельный компонент: ТОЛЬКО он подписан на
// currentTime (тикает ~4 раза/сек через timeupdate). Остальной Player без
// этой подписки не перерисовывается на каждом тике — обложка, кнопки,
// лайки и панель плейлистов остаются статичными во время воспроизведения.
function PlayerProgress({ audioRef }) {
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime)
  // isPlaying меняется только по play/pause, не на каждом тике времени, так что
  // подписка не возвращает перерисовки, от которых компонент был отделён.
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const surfaceRef = useRef(null)
  const fillRef = useRef(null)

  const writeProgress = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !(duration > 0)) return
    const pct = `${Math.min(100, (audio.currentTime / duration) * 100)}%`
    surfaceRef.current?.style.setProperty('--player-progress', pct)
    fillRef.current?.style.setProperty('--player-progress', pct)
  }, [audioRef, duration])

  // Ширину заливки двигаем на каждом кадре прямо в DOM, минуя store и React:
  // store тикает раз в секунду (сознательный троттлинг timeupdate), от этого
  // полоса дёргалась секундными шагами. rAF сам замирает в скрытой вкладке,
  // так что фоновые кадры не жгут CPU.
  //
  // На паузе позиция не меняется — вместо вечного цикла пишем один кадр и
  // останавливаемся. Прежде rAF крутился всё время, пока плеер смонтирован,
  // и каждый кадр дёргал пересчёт стилей полосы даже на стоящем треке.
  //
  // Дальнейшие изменения позиции на паузе (seek, смена трека) доезжают сами:
  // инлайновый style ниже пишет ту же переменную из store на каждом рендере.
  // Этот единственный кадр нужен ровно затем, чтобы полоса встала на точную
  // позицию из audio, а не на округлённую store-версию (троттлинг ~1 с).
  useEffect(() => {
    if (!isPlaying) {
      writeProgress()
      return
    }
    let raf
    const tick = () => {
      writeProgress()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, writeProgress])

  const handleSeek = (e) => {
    const audio = audioRef.current
    if (!audio) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = x / rect.width
    if (!(duration > 0)) return
    const newTime = percentage * duration
    audio.currentTime = newTime
    setCurrentTime(newTime)
  }

  const progressPercent = duration ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <>
      <div
        ref={surfaceRef}
        className="player-progress-surface"
        style={{ '--player-progress': `${progressPercent}%` }}
        aria-hidden="true"
      />
      <div className="player-progress-top" onClick={handleSeek}>
        <div className="player-progress-top-track">
          <div
            ref={fillRef}
            className="player-progress-top-fill"
            style={{ '--player-progress': `${progressPercent}%` }}
          >
            <span className="player-progress-time-bubble">{formatTime(currentTime)}</span>
            <span className="player-progress-thumb" />
          </div>
        </div>
        <span className="player-progress-duration">{formatTime(duration)}</span>
      </div>
    </>
  )
}

function PlayerInner() {
  // Определяем платформу для iOS-специфичной логики
  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream

  // Атомарные селекторы вместо деструктуризации всего store: подписка на
  // весь store означала перерисовку всего Player на КАЖДОМ изменении любого
  // поля — включая currentTime, тикающий 4 раза/сек всё время
  // воспроизведения. currentTime здесь сознательно НЕ выбирается — он нужен
  // только PlayerProgress (см. выше); экшены в zustand стабильны по ссылке.
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const duration = usePlayerStore((s) => s.duration)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const nextTrack = usePlayerStore((s) => s.nextTrack)
  const previousTrack = usePlayerStore((s) => s.previousTrack)
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const openFullScreen = usePlayerStore((s) => s.openFullScreen)
  const isRepeatOne = usePlayerStore((s) => s.isRepeatOne)
  const isShuffle = usePlayerStore((s) => s.isShuffle)
  const toggleRepeatOne = usePlayerStore((s) => s.toggleRepeatOne)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const dislikedTrackIds = usePlayerStore((s) => s.dislikedTrackIds)
  const fetchDislikedTracks = usePlayerStore((s) => s.fetchDislikedTracks)
  const toggleTrackDislike = usePlayerStore((s) => s.toggleTrackDislike)
  const materializeCurrentTrack = usePlayerStore((s) => s.materializeCurrentTrack)
  const prefetchNext = usePlayerStore((s) => s.prefetchNext)

  const { syncedLines, plainText } = useLyrics(currentTrack)
  const hasLyrics = syncedLines.length > 0 || plainText.length > 0
  const seekRequest = usePlayerStore((s) => s.seekRequest)
  const clearSeekRequest = usePlayerStore((s) => s.clearSeekRequest)
  // Версия-счётчик резолвов растёт, когда прогрев следующего трека завершается —
  // подписка заставляет пересчитать canSkipNext (гейт кнопки «следующий»).
  const resolvedPrefetchVersion = usePlayerStore((s) => s.resolvedPrefetchVersion)

  // --- Два аудиоэлемента (деки A/B) ---
  //
  // Раньше элемент был один, и переключение трека означало смену src на нём:
  // элемент сбрасывался в HAVE_NOTHING, начиналась загрузка с нуля, и между
  // треками возникало окно тишины в секунды. На iOS с заблокированным экраном
  // это окно и есть корень всех бед: WebKit разрешает воспроизведение элементу,
  // которому это разрешение выдал жест, но НОВУЮ загрузку в фоне откладывает, а
  // молчащий элемент теряет аудиосессию — вместе с виджетом на экране блокировки.
  // Все предыдущие заплатки (детектор стойла, микро-seek, гейты) лечили симптомы
  // этого окна, не убирая его.
  //
  // Деки убирают окно как класс: пока дека A играет, дека B молча буферизует
  // следующий трек. Переключение — это `B.play()` на уже загруженных данных:
  // ни смены src, ни load(), ни ожидания сети. Обе деки заранее «разблокированы»
  // жестом (см. unlockDecks), поэтому play() на них законен и в фоне.
  //
  // audioRef указывает на активную деку — весь остальной код плеера (прогресс,
  // перемотка, вотчдог, Media Session, обработка ошибок) работает через него и
  // про деки не знает.
  const deckARef = useRef(null)
  const deckBRef = useRef(null)
  const audioRef = useRef(null)
  const activeDeckRef = useRef('a')
  const unlockedDecksRef = useRef(new Set())
  // Отложенное переключение: цель грузится на свободной деке, пока играет
  // текущая (см. playAdjacentNow).
  const pendingSwapRef = useRef(null)
  const getActiveDeck = () => (activeDeckRef.current === 'a' ? deckARef.current : deckBRef.current)
  const getIdleDeck = () => (activeDeckRef.current === 'a' ? deckBRef.current : deckARef.current)
  // Обработчики событий живут на конкретном элементе и переживают смену активной
  // деки (эффект переподпишется только на следующем рендере). Всё, что меняет
  // общее состояние, обязано игнорировать события НЕактивной деки — иначе,
  // например, pause старой деки при переключении погасил бы store.isPlaying и
  // остановил только что начатый трек.
  const isActiveDeck = (el) => !!el && el === audioRef.current
  // Стабильные ref-колбэки. Инлайновый колбэк React пересоздаёт каждый рендер и
  // потому отвязывает/привязывает ref заново — audioRef.current на миг
  // обнулялся бы на каждом рендере, а по нему сверяются все обработчики.
  const setDeckA = useCallback((el) => {
    deckARef.current = el
    if (activeDeckRef.current === 'a') audioRef.current = el
  }, [])
  const setDeckB = useCallback((el) => {
    deckBRef.current = el
    if (activeDeckRef.current === 'b') audioRef.current = el
  }, [])

  const lastRecordedTrackIdRef = useRef(null)
  // Токен актуальности резолва audioSrc (см. эффект ниже) — защита от того,
  // что устаревший (для уже пропущенного трека) fetch применит свой результат
  // позже, чем актуальный.
  const resolveTokenRef = useRef({})
  // Счётчик тихих ретраев текущего трека и хендл отложенного повтора —
  // при ошибке внешнего трека не скипаем сразу, а даём 1-2 попытки.
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  // «Беззвучный старт»: трек, начавший играть в скрытой вкладке, может идти
  // без звука (конвейер работает, currentTime тикает, аудиовыход не
  // подключён) — из JS это состояние НЕ детектируется. Лечит seek. Флаг
  // помечает рискованный старт; nudge-ref — один авто-seek на трек.
  const silentStartRiskRef = useRef(false)
  const bgNudgeForRef = useRef(null)
  // Кап перезапусков зависшей загрузки по событиям stalled/suspend: каждый
  // kick качает трек с нуля — на честно медленной сети бесконечные рестарты
  // сделали бы только хуже. Сбрасывается на 'playing' и на смене трека.
  const stallKickCountRef = useRef(0)
  const [audioSrc, setAudioSrc] = useState(null)
  // Спиннер на время резолва/загрузки потока внешнего трека — иначе долгий
  // (но живой) резолв YouTube Music выглядит как зависший плеер.
  const [isBuffering, setIsBuffering] = useState(false)
  const [loadingLike, setLoadingLike] = useState(false)
  const [loadingDislike, setLoadingDislike] = useState(false)
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

  // Гейт скипа вперёд: пока резолв следующего трека на бэке не завершён,
  // кнопку «следующий»/свайп-влево/виджет блокируем — чтобы не прыгать на ещё
  // не подгруженный трек. Подписка на resolvedPrefetchVersion выше заставляет
  // пересчитать canSkipNext на завершении резолва; на смене трека — рендер
  // и так происходит. Конец очереди/локальный трек — готов всегда (см.
  // isNextTrackReady). Естественное окончание трека (handleEnded) гейт НЕ
  // трогает — там переход штатный, не пользовательский скип.
  // isNextTrackReady читает актуальный store; resolvedPrefetchVersion в
  // зависимостях подписки гарантирует пересчёт при завершении резолва.
  const canSkipNext = resolvedPrefetchVersion >= 0 && usePlayerStore.getState().isNextTrackReady()

  // Пользовательский скип вперёд (кнопка/свайп): выполняем только если
  // следующий трек готов. Готовность читаем из store в момент вызова —
  // защита от устаревшего замыкания в обработчиках свайпа.
  const handleSkipForward = () => {
    if (!usePlayerStore.getState().isNextTrackReady()) return
    nextTrack()
  }

  // Горизонтальный свайп по области трека переключает треки (только тач).
  // ВАЖНО: хук вызывается здесь, до раннего `if (!currentTrack) return null`,
  // иначе на рендере без трека он пропускается и число хуков «прыгает»
  // (React error #310: Rendered more hooks than during the previous render).
  const swipeHandlers = useSwipe({
    onSwipeLeft: handleSkipForward,
    onSwipeRight: previousTrack,
    threshold: 60,
  })

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const syncPositionState = () => {
      if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
      const mediaDuration = resolveTrackDuration(audio, currentTrack)
      if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration: mediaDuration,
          position: Math.min(Math.max(audio.currentTime, 0), mediaDuration),
          playbackRate: audio.playbackRate || 1,
        })
      } catch {
        /* Источник мог смениться между событиями media element. */
      }
    }
    // Троттлинг timeupdate до ~1 раза/сек: браузер шлёт событие ~4 раза/сек,
    // но прогресс-бару и системному виджету хватает секундной точности —
    // минус 3/4 store-апдейтов и React-рендеров во время воспроизведения.
    // В скрытой вкладке setCurrentTime пропускаем совсем (прогресс не виден,
    // рендеры в фоне жгут CPU/батарею зря), а syncPositionState оставляем —
    // он питает виджет на экране блокировки. При возврате на вкладку
    // позиция синхронизируется через visibilitychange ниже.
    let lastTickSecond = -1
    const updateTime = () => {
      if (!isActiveDeck(audio)) return
      maybeRecordPlay(audio)
      const sec = Math.floor(audio.currentTime)
      if (sec === lastTickSecond) return
      lastTickSecond = sec
      if (!document.hidden) setCurrentTime(audio.currentTime)
      syncPositionState()
    }
    // Зависший старт: play() уже принят (paused === false), а currentTime
    // замер на нуле. Две разновидности, у каждой своё лекарство:
    //   1) данные не загрузились (readyState < HAVE_CURRENT_DATA) — браузер
    //      в фоне отложил/бросил загрузку нового src; лечит только
    //      перезапуск загрузки load() + play();
    //   2) данные ЕСТЬ, но конвейер декодирования замер (readyState >= 2,
    //      paused false, время стоит) — так выглядит старт src в скрытой
    //      вкладке; лечит микро-seek — ровно то, что делал ручной тык в
    //      прогресс-бар. load() тут вреден: он сбрасывает уже загруженный
    //      буфер и может застрять снова.
    // «paused-ретраи» обе формы не видят: элемент формально «играет».
    //
    // ВАЖНО: «данных ещё нет» — это НЕ зависание. Через узкий туннель
    // (~140 КБ/с) трек честно грузится несколько секунд, и раньше watchdog
    // принимал это за stall: kickStalled() звал load(), тот РВАЛ уже летящий
    // запрос (в логах nginx — серия 499 каждые ~3 с) и начинал качать с нуля.
    // Старт 3.5-МБ трека растягивался на ~25 с вместо ~2 с. Поэтому «замерло»
    // определяем по нативному событию progress (браузер шлёт его, пока байты
    // идут): загрузка считается зависшей, только если байты не приходили
    // NO_PROGRESS_STALL_MS.
    const NO_PROGRESS_STALL_MS = 8000
    let lastProgressAt = Date.now()
    const noteProgress = () => {
      lastProgressAt = Date.now()
    }
    const isStalledStart = () =>
      !audio.paused &&
      audio.currentTime === 0 &&
      Date.now() - lastProgressAt > NO_PROGRESS_STALL_MS
    const kickStalled = () => {
      if (audio.readyState >= audio.HAVE_CURRENT_DATA) {
        try {
          audio.currentTime = 0.01
        } catch {
          /* элемент мог быть в несовместимом состоянии — играем дальше */
        }
        playWithDiag(audio, 'kickStalled:seek')
        return
      }
      // Данных нет — помочь мог бы только load(), но в фоне он смертелен:
      // не-жестовый load() воспроизведение не вернёт (iOS его не разрешит),
      // зато оборвёт аудиосессию, а с ней и виджет на экране блокировки —
      // «нет аудио» и поход в PWA. Вместо самолечения честно показываем паузу:
      // на виджете появляется рабочая ▶, её нажатие уже жест, и handlers.play
      // делает ровно то же самое, но легально.
      if (document.hidden) {
        syncSystemPlaybackState('paused')
        return
      }
      audio.load()
      playWithDiag(audio, 'kickStalled:load')
    }
    // Вкладка снова видима — догоняем прогресс-бар и возобновляем воспроизведение,
    // если должно было играть. На мобильных браузерах audio может быть приостановлен
    // при уходе в фон (переключение приложения, блокировка экрана).
    const handleVisibility = () => {
      if (!document.hidden) {
        setCurrentTime(audio.currentTime)
        const { isPlaying: playing } = usePlayerStore.getState()
        if (playing && audio.paused && !audio.ended) {
          // После длительного отсутствия на вкладке буфер мог быть вытеснен.
          // play() на пустом буфере молча ничего не делает — нужен load().
          if (needsFreshLoad(audio)) {
            audio.load()
          }
          playWithDiag(audio, 'visibility:resume')
        } else if (playing && isStalledStart()) {
          kickStalled()
        } else if (playing && silentStartRiskRef.current && !audio.paused) {
          // Трек стартовал в фоне — мог играть беззвучно (см. silentStartRiskRef).
          // Форграунд-seek на текущую позицию переподключает аудиовыход —
          // автоматизация ручного «тыка в прогресс-бар». Слышимый эффект —
          // микрозапинка ~50 мс, только один раз при возврате в приложение.
          silentStartRiskRef.current = false
          try {
            audio.currentTime = Math.max(0.01, audio.currentTime - 0.05)
          } catch {
            /* noop */
          }
        }
      }
    }
    const updateDuration = () => {
      const mediaDuration = resolveTrackDuration(audio, currentTrack)
      if (mediaDuration > 0) {
        setDuration(mediaDuration)
        syncPositionState()
      }
    }
    const syncSystemPlaybackState = (state) => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = state
      }
    }
    // 'playing' (реально пошли кадры), а не 'play' (лишь вызвали play()):
    // при зависшей загрузке play-событие стреляет сразу, и виджет врал бы
    // «играет» про молчащий элемент — с тикающим временем от экстраполяции.
    // Загрузка нового src перестала прогрессировать. Таймеры в фоне браузер
    // троттлит до ~1 раза/мин, а события media-элемента приходят без
    // задержек — это единственный быстрый сигнал «после ended ничего не
    // грузится», из-за которого раньше следующий трек висел до ручного skip.
    const handleLoadStall = () => {
      if (!isActiveDeck(audio)) return
      if (!usePlayerStore.getState().isPlaying) return
      if (!isStalledStart()) return
      if (stallKickCountRef.current >= 3) return // дальше — вотчдог/пользователь
      stallKickCountRef.current += 1
      kickStalled()
    }
    const handlePlaying = () => {
      if (!isActiveDeck(audio)) return
      stallKickCountRef.current = 0
      syncSystemPlaybackState('playing')
      // Старт в скрытой вкладке — риск беззвучного воспроизведения.
      // Сразу пробуем авто-seek (то же, что ручной тык в прогресс-бар):
      // если браузер честно исполняет фоновый seek — звук чинится ещё в
      // фоне. Один nudge на трек: seek сам триггерит повторный 'playing',
      // без guard'а получился бы цикл.
      //
      // iOS сюда НЕ попадает. «Беззвучный фоновый старт» — болезнь
      // Chromium-подобных движков, а в WebKit ровно этот микро-seek фоновый
      // старт ломает: перемотка по свежеоткрытому потоку (Opus/WebM от yt-dlp
      // без индекса перемотки) заставляет перезапросить диапазон, и элемент
      // остаётся в seeking — система считает, что играет, звука нет. На экране
      // блокировки это бьёт по каждому треку: там КАЖДЫЙ старт — фоновый.
      if (document.hidden && !isIOS) {
        silentStartRiskRef.current = true
        const trackId = usePlayerStore.getState().currentTrack?.id
        if (trackId != null && bgNudgeForRef.current !== trackId) {
          bgNudgeForRef.current = trackId
          try {
            audio.currentTime = Math.max(0.01, audio.currentTime - 0.05)
          } catch {
            /* noop */
          }
        }
      } else {
        // Видимый (заведомо здоровый) старт снимает флаг риска — иначе
        // давний фоновый старт нуджил бы и все последующие треки.
        silentStartRiskRef.current = false
      }
    }
    const handlePause = () => {
      // Событие неактивной деки: её глушит переключение (см. playAdjacentNow),
      // и принимать это за пользовательскую паузу нельзя — иначе смена трека
      // сама себя останавливала бы.
      if (!isActiveDeck(audio)) return
      syncSystemPlaybackState(currentTrack ? 'paused' : 'none')
      // Пауза не всегда наша: её ставит система (звонок, аудиофокус ушёл другому
      // приложению, отключились наушники, iOS усыпил страницу). В этих случаях
      // store оставался с isPlaying === true, и дальше всё врало: в приложении
      // горела кнопка «пауза» у молчащего плеера, первое нажатие на неё только
      // приводило состояние в согласие (играть начинало лишь второе), а вотчдог
      // считал трек играющим. Приводим store к факту.
      //
      // Отсеиваем чужие pause-события. Смена src (playAdjacentNow) тоже гасит
      // элемент и ставит pause в очередь — но к моменту нашего обработчика
      // элемент уже сброшен в HAVE_NOTHING и заново запущен, так что оба
      // признака ниже отличают настоящую паузу от служебной. Иначе синхронизация
      // сама убивала бы только что начатое переключение.
      if (!audio.paused || audio.ended) return
      if (audio.readyState === audio.HAVE_NOTHING) return
      const state = usePlayerStore.getState()
      if (state.isPlaying) state.togglePlayPause()
    }
    // Источник сменился (audio.src = ... / load()) — элемент сброшен и ещё
    // ничего не играет. Пока не придёт настоящее 'playing', система не должна
    // считать, что мы играем: iOS в состоянии playbackState === 'playing'
    // экстраполирует позицию из последнего setPositionState и крутит часы на
    // экране блокировки поверх молчащего элемента. Раньше 'playing' оставался
    // от ПРЕДЫДУЩЕГО трека и не сбрасывался никогда (store.isPlaying всё ещё
    // true), отсюда и «время идёт, обложка есть, звука нет». Честный 'paused'
    // вдобавок возвращает на виджете рабочую кнопку ▶ — её нажатие жест, и
    // play() в нём разрешён даже в фоне.
    const handleEmptied = () => {
      // Прогрев свободной деки тоже шлёт emptied — к состоянию воспроизведения
      // это отношения не имеет.
      if (!isActiveDeck(audio)) return
      syncSystemPlaybackState(currentTrack ? 'paused' : 'none')
      // Новый источник — детектору зависания нужно начать отсчёт заново, иначе
      // он судит свежую загрузку по активности ПРЕДЫДУЩЕГО трека.
      //
      // Именно здесь ломался скип после ~10 секунд игры. lastProgressAt
      // обновляется по событию progress, а progress перестаёт приходить, как
      // только трек догрузился целиком (дальше WebKit шлёт suspend и молчит).
      // Через NO_PROGRESS_STALL_MS = 8 с после этого isStalledStart() начинает
      // давать true для ЛЮБОГО состояния с currentTime === 0 — а смена src
      // обнуляет currentTime. В результате первый же suspend новой загрузки
      // (WebKit шлёт его сразу, когда откладывает загрузку в фоне) попадал в
      // handleLoadStall, тот звал kickStalled() → audio.load() + play() уже вне
      // жеста — то есть ровно тот сценарий, что мы убрали из React-эффекта,
      // только заходящий с другой стороны. Отсюда и порог «до 10 секунд
      // работает»: пока трек ещё качается, progress идёт и детектор молчит.
      //
      // Естественные переходы (ended) не страдали: у доигравшего трека
      // progress приходил незадолго до конца, lastProgressAt был свежий.
      noteProgress()
      stallKickCountRef.current = 0
    }
    const handleEnded = () => {
      if (!isActiveDeck(audio)) return
      // Трек доиграл, пока ждали буфер отложенного переключения: очередь уже
      // сдвинута, ждать больше нечего — отдаём звук цели немедленно, иначе
      // handleEnded увёл бы плеер ещё на один трек вперёд.
      const pending = pendingSwapRef.current
      if (pending) {
        cancelPendingSwap()
        diag('swap:endedWhileDeferred', snapshotAudio(pending.deck))
        finishSwap(pending.deck, audio, 'swap:next:endedDeferred')
        return
      }
      if (usePlayerStore.getState().isRepeatOne) {
        audio.currentTime = 0
        playWithDiag(audio, 'repeatOne')
      } else {
        // Следующий трек стартует СИНХРОННО, в контексте обработчика ended:
        // ended — продолжение жеста, запустившего воспроизведение, и только
        // такой play() мобильный браузер разрешает в фоне. Путь через
        // nextTrack() → рендер → эффект → play() теряет жестовый контекст
        // (NotAllowedError). Store обновляем следом — эффект src увидит тот
        // же URL и не перезапустит воспроизведение.
        playAdjacentNow(1)
        nextTrack()
      }
    }

    // Вотчдог «переключился, но не заиграл». Две формы отказа:
    // 1) play() отвергнут (paused === true) — просто повторяем play();
    // 2) play() принят, но загрузка зависла (paused === false, данных нет) —
    //    нужен load()+play(), см. isStalledStart. Форму 2 кикаем только после
    //    2 подряд «застрявших» тиков (~6 с активной вкладки), чтобы не рвать
    //    честную медленную буферизацию (холодный резолв — единицы секунд).
    // Ретраим ТОЛЬКО старт с нуля (currentTime === 0): паузу от ОС посреди
    // трека (звонок, аудиофокус у другого приложения) не трогаем.
    // ponytail: в фоне интервал троттлится до ~1 раза/мин — авто-recovery там
    // не мгновенный; мгновенный путь — кнопка ▶ виджета (жест).
    let stalledTicks = 0
    const watchdog = setInterval(() => {
      const { isPlaying: playing } = usePlayerStore.getState()
      if (!playing || !audio.src || audio.ended) {
        stalledTicks = 0
        return
      }
      if (audio.paused && audio.currentTime === 0) {
        stalledTicks = 0
        playWithDiag(audio, 'watchdog:retry')
        return
      }
      if (isStalledStart()) {
        stalledTicks += 1
        if (stalledTicks >= 2) {
          stalledTicks = 0
          kickStalled()
        }
      } else {
        stalledTicks = 0
      }
    }, 3000)

    audio.addEventListener('timeupdate', updateTime)
    // progress/loadstart питают детектор зависания (см. isStalledStart):
    // пока браузер докладывает о новых байтах, загрузка живая — рвать её
    // load()'ом нельзя, даже если трек ещё не начал играть.
    audio.addEventListener('progress', noteProgress)
    audio.addEventListener('loadstart', noteProgress)
    audio.addEventListener('canplay', noteProgress)
    document.addEventListener('visibilitychange', handleVisibility)
    audio.addEventListener('loadedmetadata', updateDuration)
    audio.addEventListener('durationchange', updateDuration)
    audio.addEventListener('canplay', updateDuration)
    audio.addEventListener('seeked', syncPositionState)
    audio.addEventListener('ratechange', syncPositionState)
    // syncPositionState на playing: iOS требует setPositionState ДО того,
    // как система «признает» воспроизведение — иначе виджет на экране
    // блокировки не появляется. timeupdate стреляет слишком поздно.
    audio.addEventListener('playing', () => { handlePlaying(); syncPositionState() })
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('emptied', handleEmptied)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('stalled', handleLoadStall)
    audio.addEventListener('suspend', handleLoadStall)

    // Диагностика: полная лента событий элемента. Обработчиков воспроизведения
    // здесь нет — только запись, — так что на поведение плеера это не влияет,
    // зато после бага на заблокированном экране видно, где именно порвалась
    // цепочка loadstart → progress → canplay → playing.
    const DIAG_EVENTS = [
      'loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'playing',
      'pause', 'waiting', 'stalled', 'suspend', 'emptied', 'abort', 'ended',
      'error', 'seeking', 'seeked', 'ratechange',
    ]
    const logMediaEvent = (event) => diag(event.type, snapshotAudio(audio))
    DIAG_EVENTS.forEach((type) => audio.addEventListener(type, logMediaEvent))
    const logVisibility = () => diag('visibility', snapshotAudio(audio))
    document.addEventListener('visibilitychange', logVisibility)

    // Слушатели переезжают на новую деку уже ПОСЛЕ того, как переключение её
    // запустило (свап синхронный, эффект — на следующем рендере), поэтому её
    // события playing/canplay/loadedmetadata мы гарантированно пропустили.
    // Приводим производное состояние к факту, иначе на играющем треке виджет
    // остаётся с 'paused', а длительность и позиция — от предыдущего.
    if (!audio.paused && audio.readyState >= audio.HAVE_CURRENT_DATA) {
      syncSystemPlaybackState('playing')
      setIsBuffering(false)
    }
    updateDuration()
    syncPositionState()

    return () => {
      DIAG_EVENTS.forEach((type) => audio.removeEventListener(type, logMediaEvent))
      document.removeEventListener('visibilitychange', logVisibility)
      clearInterval(watchdog)
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('progress', noteProgress)
      audio.removeEventListener('loadstart', noteProgress)
      audio.removeEventListener('canplay', noteProgress)
      document.removeEventListener('visibilitychange', handleVisibility)
      audio.removeEventListener('loadedmetadata', updateDuration)
      audio.removeEventListener('durationchange', updateDuration)
      audio.removeEventListener('canplay', updateDuration)
      audio.removeEventListener('seeked', syncPositionState)
      audio.removeEventListener('ratechange', syncPositionState)
      audio.removeEventListener('playing', handlePlaying)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('emptied', handleEmptied)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('stalled', handleLoadStall)
      audio.removeEventListener('suspend', handleLoadStall)
    }
  }, [currentTrack?.id, setCurrentTime, setDuration, nextTrack])

  useEffect(() => {
    if (dbTrackId) {
      fetchLikedTracks().catch((error) => {
        console.error('Error checking liked status:', error)
      })
      fetchDislikedTracks().catch((error) => {
        console.error('Error checking disliked status:', error)
      })
    }
  }, [dbTrackId, fetchLikedTracks, fetchDislikedTracks])

  // Всегда отдаём URL непосредственно постоянному <audio>. Blob-источник не
  // имеет HTTP Range/Content-Range, поэтому iOS считает его неперематываемым и
  // отключает системную шкалу времени и часть remote-команд.
  useEffect(() => {
    resolveTokenRef.current = {}
    setAudioSrc(resolveRawUrl(currentTrack, isExternalTrack))
  }, [currentTrack, isExternalTrack])

  // src на <audio> ставим императивно и ТОЛЬКО при реальном изменении, а не
  // JSX-атрибутом. Причина: handleEnded и хендлеры системного виджета
  // выставляют src и зовут play() синхронно, в контексте жеста (ended /
  // media-key) — только такой play() мобильный браузер разрешает в фоне.
  // Если после этого React закоммитит src атрибутом (даже той же строкой),
  // спека перезапускает media load algorithm — уже стартовавший play()
  // абортируется, а повторный play() из эффекта идёт вне жеста →
  // NotAllowedError → трек «переключился», но молчит. Проверка на равенство
  // делает коммит того же src no-op'ом и не трогает живое воспроизведение.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!audioSrc) {
      if (audio.src) {
        audio.removeAttribute('src')
        audio.load()
      }
      return
    }
    const abs = new URL(audioSrc, window.location.href).href
    // Отложенное переключение: store уже показывает новый трек, но играет ещё
    // предыдущий, а цель грузится на свободной деке. Тронуть здесь src активной
    // деки значило бы оборвать этот звук — то есть вернуть окно тишины, ради
    // устранения которого отсрочка и сделана.
    if (pendingSwapRef.current?.url === abs) return
    const srcChanged = audio.src !== abs
    if (srcChanged) audio.src = abs
    // iOS Safari: explicit load() is required to start downloading.
    // Without it, iOS may not begin fetching the audio data.
    if (srcChanged && isIOS) {
      audio.load()
    }
    if (usePlayerStore.getState().isPlaying && audio.paused) {
      playWithDiag(audio, 'effect:srcChanged')
    }
  }, [audioSrc])

  // Прогрев следующего трека на свободной деке — то, ради чего деки и заведены.
  // Зовём при смене трека, при завершении резолва на бэке
  // (resolvedPrefetchVersion) и после разблокировки деки. У внешнего трека до
  // конца резолва URL ещё отдаёт 503 — пока бэк не подтвердил готовность, греть
  // нечего, дождёмся сигнала.
  const warmIdleDeck = useCallback(() => {
    const idle = getIdleDeck()
    if (!idle) return
    // На свободной деке грузится цель отложенного переключения — перебивать её
    // прогревом нельзя, иначе переключение не состоится никогда.
    if (pendingSwapRef.current) return
    // Дека сейчас проигрывает тишину разблокировки — её src трогать нельзя,
    // прогрев довызовется сам по завершении процедуры.
    if (idle.src === SILENT_WAV) return
    const state = usePlayerStore.getState()
    if (!state.currentTrack || !state.isNextTrackReady()) return
    const next = state.getNextTrack(1)
    if (!next) return
    const nextIsExternal = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(next.source)
    const url = resolveRawUrl(next, nextIsExternal)
    if (!url) return
    const abs = new URL(url, window.location.href).href
    if (idle.src === abs) return
    idle.src = abs
    idle.load()
    diag('preload:start', { trackId: next.id })
  }, [])

  useEffect(() => {
    warmIdleDeck()
  }, [currentTrack?.id, resolvedPrefetchVersion, warmIdleDeck])

  // «Разблокировка» дек жестом пользователя.
  //
  // WebKit выдаёт разрешение играть не странице, а КОНКРЕТНОМУ media-элементу, и
  // только когда play() случился внутри пользовательского жеста. Дальше элемент
  // хранит это разрешение навсегда, в том числе после смены src. Активная дека
  // получает его сама (пользователь нажал play), а вот свободная стартует уже
  // без жеста — при переключении трека, — и без этой процедуры её play() в фоне
  // отвергается. Проигрываем на ней 12 мс тишины: этого достаточно.
  //
  // Слушатель намеренно НЕ одноразовый и снимается только когда обе деки
  // разблокированы. На первом тапе по приложению трека ещё нет, Player
  // возвращает null и элементов не существует — одноразовый слушатель сгорел бы
  // впустую. Разблокировать пробуем на каждом жесте, пока не выйдет.
  useEffect(() => {
    const unlockDeck = (name, deck) => {
      if (!deck || unlockedDecksRef.current.has(name)) return
      // Активную деку не трогаем: своё разрешение она получает от настоящего
      // play() пользователя, а вмешательство сорвало бы играющий трек.
      if (deck === audioRef.current) return
      // Разблокируем на том src, который на деке уже есть: прогретый буфер
      // сохраняется, стоимость процедуры — мгновение muted-воспроизведения и
      // возврат currentTime к нулю. Тишина нужна только когда греть ещё нечего.
      const usingPlaceholder = !deck.src
      if (usingPlaceholder) deck.src = SILENT_WAV
      // Глушим всегда: незаглушённый старт второй деки iOS воспринял бы как
      // заявку на аудиосессию и прервал бы играющий трек.
      deck.muted = true
      const restore = (ok) => {
        if (ok) unlockedDecksRef.current.add(name)
        // Пока процедура шла (play() асинхронный), дека могла стать активной —
        // переключением трека. Тогда она уже играет нужный трек, и pause() со
        // сбросом src остановили бы его: ровно это и заставляло жать play вручную.
        // Размьютить, впрочем, обязаны в любом случае, иначе трек идёт беззвучно.
        deck.muted = false
        if (deck === audioRef.current) {
          diag('unlock:deckWentLive', { deck: name })
          return
        }
        deck.pause()
        if (usingPlaceholder) {
          deck.removeAttribute('src')
          warmIdleDeck()
        } else {
          // Буфер трека остаётся, отматываем только позицию.
          try {
            deck.currentTime = 0
          } catch {
            /* поток без seekable-диапазона — перемотка не нужна */
          }
        }
      }
      deck
        .play()
        .then(() => {
          diag('unlock:ok', { deck: name, placeholder: usingPlaceholder })
          restore(true)
        })
        .catch((error) => {
          diag('unlock:fail', { deck: name, placeholder: usingPlaceholder, name: error?.name })
          restore(false)
        })
    }
    const unlock = () => {
      unlockDeck('a', deckARef.current)
      unlockDeck('b', deckBRef.current)
      if (unlockedDecksRef.current.size >= 2) {
        window.removeEventListener('pointerdown', unlock)
        window.removeEventListener('keydown', unlock)
      }
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [warmIdleDeck])

  // Переход на соседний трек очереди. Store обновляется отдельно вызывающей
  // стороной; эффект audioSrc увидит тот же URL на активной деке и ничего не
  // перезапустит.
  //
  // Быстрый путь (ради него всё и затевалось): трек уже буферизуется на
  // свободной деке — переключение это просто play() на готовых данных. Ни смены
  // src, ни load(), ни сетевого ожидания, а значит и без окна тишины, в котором
  // iOS отбирал аудиосессию.
  //
  // deferIfCold — для случая, когда прогрев не успел (классика: два скипа
  // подряд, ведь прогрев следующего стартует только ПОСЛЕ первого). Раньше это
  // означало немедленный свап на пустую деку, то есть ровно ту тишину, ради
  // устранения которой всё и делалось. Вместо этого не трогаем играющую деку:
  // грузим цель на свободной и переключаемся, когда данные готовы. Трек
  // сменится на секунду-другую позже, но звук не прервётся, а сессия и виджет
  // останутся живы. При естественном конце трека откладывать некуда — там
  // играть уже нечего, идём напрямую.
  const finishSwap = (idle, active, label) => {
    // Активную деку переназначаем ДО остановки старой: обработчики событий
    // сверяются с audioRef (см. isActiveDeck), и без этого пауза старой деки
    // прилетела бы в handlePause как «пользователь остановил воспроизведение».
    activeDeckRef.current = activeDeckRef.current === 'a' ? 'b' : 'a'
    audioRef.current = idle
    idle.volume = usePlayerStore.getState().volume
    // Деку могла перехватить разблокировка (она играет muted и не с нуля) —
    // без этого трек пошёл бы беззвучно и с середины.
    idle.muted = false
    if (idle.currentTime > 0) {
      try {
        idle.currentTime = 0
      } catch {
        /* seekable ещё пуст — стартуем как есть */
      }
    }
    playWithDiag(idle, label)
    // Старую деку освобождаем только после старта новой: одновременно звучащих
    // дек быть не должно, но и глушить старую до того, как новая подхватила,
    // нельзя — иначе получаем ту самую паузу в звуке.
    active.pause()
  }

  const cancelPendingSwap = () => {
    const pending = pendingSwapRef.current
    if (!pending) return
    pendingSwapRef.current = null
    pending.deck.removeEventListener('canplay', pending.onReady)
    clearTimeout(pending.timer)
  }

  const playAdjacentNow = (offset, { deferIfCold = false } = {}) => {
    const active = getActiveDeck()
    const idle = getIdleDeck()
    if (!active || !idle) return
    const next = usePlayerStore.getState().getNextTrack(offset)
    if (!next) return
    const nextIsExternal = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(next.source)
    const url = resolveRawUrl(next, nextIsExternal)
    if (!url) return
    const abs = new URL(url, window.location.href).href
    const preloaded = idle.src === abs && idle.readyState >= idle.HAVE_CURRENT_DATA
    const direction = offset > 0 ? 'next' : 'prev'
    cancelPendingSwap()
    diag('swap:start', {
      offset,
      preloaded,
      deferred: !preloaded && deferIfCold,
      idleRs: idle.readyState,
      ...snapshotAudio(active),
    })

    if (preloaded) {
      finishSwap(idle, active, `swap:${direction}:warm`)
      return
    }

    if (idle.src !== abs) idle.src = abs
    idle.load()

    // Играющую деку не трогаем — переключимся, когда цель будет готова.
    if (deferIfCold && !active.paused) {
      const onReady = () => {
        cancelPendingSwap()
        finishSwap(idle, active, `swap:${direction}:deferred`)
      }
      // Потолок ожидания: если данные так и не пришли, переключаемся как есть —
      // лучше пауза, чем застрявший на месте плеер.
      const timer = setTimeout(() => {
        cancelPendingSwap()
        diag('swap:deferTimeout', snapshotAudio(idle))
        finishSwap(idle, active, `swap:${direction}:cold`)
      }, DEFERRED_SWAP_TIMEOUT_MS)
      pendingSwapRef.current = { deck: idle, url: abs, onReady, timer }
      idle.addEventListener('canplay', onReady, { once: true })
      return
    }

    finishSwap(idle, active, `swap:${direction}:cold`)
  }

  // Reload audio when track changes
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    // Новый трек — сбрасываем счётчик ретраев и отменяем висящий отложенный
    // повтор от предыдущего трека.
    retryCountRef.current = 0
    stallKickCountRef.current = 0
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
    // НЕ ноль: длительность берём сразу из трека (в БД она точнее, чем оценка
    // браузера). Обнуление осталось от одного элемента, где её тут же
    // восстанавливал loadedmetadata новой загрузки. У прогретой деки эти события
    // отгремели, пока она была свободной, так что восстанавливать было некому:
    // duration оставалась нулём, из-за чего перемотка в начале трека умножала
    // позицию на ноль и прыгала в самое начало.
    setDuration(resolveTrackDuration(audio, currentTrack))
    setShowAddToPlaylist(false)
    setAddError('')
    setSelectedPlaylistId('')

  }, [currentTrack?.id, setCurrentTime, setDuration])

  // Отменяем висящий ретрай и отложенное переключение при размонтировании.
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      const pending = pendingSwapRef.current
      if (pending) {
        pending.deck.removeEventListener('canplay', pending.onReady)
        clearTimeout(pending.timer)
        pendingSwapRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    const handleLoad = () => {
      setDuration(resolveTrackDuration(audio, currentTrack))
    }

    const handleCanPlay = () => {
      if (isPlaying && audio.paused) {
        playWithDiag(audio, 'canplay')
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

    if (isPlaying) {
      // play() вызываем СРАЗУ, не дожидаясь canplay и без проверки readyState.
      // Раньше при смене трека readyState сбрасывался в 0, ветка с
      // readyState >= 2 не срабатывала, и старт целиком зависел от события
      // canplay. Но в ФОНОВОЙ вкладке браузер откладывает загрузку медиа
      // до явного play() — canplay без него не наступал, и перелистывание
      // трека из системного виджета зависало (взаимная блокировка:
      // play ждал canplay, canplay ждал play). Немедленный play() форсирует
      // загрузку и сам стартует, как только данные готовы (промис висит
      // до готовности). AbortError гасим: он означает штатное прерывание
      // висящего play() новой сменой src (быстрое перелистывание треков),
      // а handleCanPlay выше остаётся страховкой и повторит попытку.
      //
      // После длительной паузы браузер может вытеснить буфер аудио
      // (readyStateHAVE_ENOUGH_DATA). В этом случае play() молча не
      // воспроизводит — нужен явный load() для повторной загрузки данных.
      //
      // Но ТОЛЬКО если элемент действительно простаивает (см. needsFreshLoad).
      // Прежняя проверка `readyState < HAVE_CURRENT_DATA` срабатывала и на
      // абсолютно здоровой, только что начатой загрузке: playAdjacentNow()
      // (ended / кнопки виджета) стартует новый src синхронно в жестовом
      // контексте, а этот эффект прилетает следом, через микротаск, и видит
      // readyState === 0. Вызванный тут load() рвал летящий запрос, а
      // следующий за ним play() шёл уже вне жеста — в фоне iOS его
      // блокировал. Итог: трек «переключился» (обложка, длительность,
      // тикающие часы на экране блокировки), но не звучит. Именно этот путь
      // отрабатывает при каждом переходе на треке с заблокированным экраном.
      if (needsFreshLoad(audio)) {
        audio.load()
      }
      // Элемент уже стартовал (paused === false) — повторный play() ничего не
      // добавляет: он вернёт тот же висящий промис. Зависший старт лечит
      // вотчдог/kickStalled, а не ещё один play().
      if (audio.paused) {
        // AbortError — штатное прерывание play() новой сменой src (быстрое
        // перелистывание). NotAllowedError — браузер заблокировал play() из-за
        // autoplay-политики (мобильный фон / отсутствие жеста); handleCanPlay
        // или handleVisibility повторят попытку позже. Оба исхода теперь видны
        // в диагностическом логе (см. playerDiag).
        playWithDiag(audio, 'effect:isPlaying')
      }
    } else {
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

  // Запись play — не на старте, а по достижении порога реального прослушивания
  // (см. PLAY_RECORD_RATIO). Вызывается из timeupdate-листенера (а НЕ из
  // эффекта с зависимостью от currentTime) — благодаря этому Player больше
  // не подписан на currentTime и не перерисовывается 4 раза/сек.
  // Состояние читаем императивно из store и самого <audio>; guard по ref
  // гарантирует одну запись на трек.
  const maybeRecordPlay = (audio) => {
    const state = usePlayerStore.getState()
    const track = state.currentTrack
    if (!state.isPlaying || !track) return
    const dbId = track.db_id ?? (typeof track.id === 'number' ? track.id : null)
    const external = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(track.source)
    if (dbId === null && !external) return
    const dur = audio.duration
    const listenedEnough =
      audio.currentTime >= PLAY_RECORD_MIN_SEC ||
      (Number.isFinite(dur) && dur > 0 && audio.currentTime / dur >= PLAY_RECORD_RATIO)
    if (!listenedEnough) return
    // Стабильный ключ: у внешних трек id меняется после материализации.
    const playKey = track.external_id ?? track.id
    if (lastRecordedTrackIdRef.current === playKey) return
    lastRecordedTrackIdRef.current = playKey
    ;(async () => {
      try {
        const id = dbId ?? (await state.materializeCurrentTrack())
        if (id) await api.post(`/tracks/${id}/play`)
      } catch (error) {
        console.error('Error recording play:', error)
      }
    })()
  }

  useEffect(() => {
    // Обе деки: свободная станет активной при следующем переключении, и
    // громкость на ней должна быть уже правильной.
    for (const deck of [deckARef.current, deckBRef.current]) {
      if (deck) deck.volume = volume
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
  // setPositionState вызываем здесь же — iOS требует его ДО начала воспроизведения,
  // иначе виджет на экране блокировки не появляется.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
      try {
        navigator.mediaSession.setPositionState()
      } catch {
        /* Не все реализации поддерживают очистку позиции без аргументов. */
      }
      return
    }
    const artwork = resolveCoverUrl(currentTrack.cover_url)
    const artworkUrl = artwork
      ? new URL(artwork, window.location.origin).href
      : new URL(defaultCover, window.location.origin).href

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: currentTrack.title || 'Неизвестный трек',
      artist: currentTrack.artist || '',
      album: currentTrack.album || '',
      // WebKit стабильнее принимает одно изображение, чем несколько записей
      // с одним и тем же URL, но разными заявленными размерами.
      artwork: [{ src: artworkUrl }],
    })

    // setPositionState при смене трека: длительность берём из БД (точная),
    // позиция = 0 (трек только что начался). iOS/Android используют это для
    // шкалы времени на экране блокировки — без него виджет может не появиться.
    const mediaDuration = Number(currentTrack.duration)
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: mediaDuration,
          position: 0,
          playbackRate: 1,
        })
      } catch {
        /* noop — не все браузеры поддерживают */
      }
    }
  }, [
    currentTrack?.id,
    currentTrack?.title,
    currentTrack?.artist,
    currentTrack?.album,
    currentTrack?.cover_url,
    currentTrack?.duration,
    isExternalTrack,
  ])

  // Обработчики кнопок системного виджета. Регистрируем один раз.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const syncPositionState = (audio) => {
      const mediaDuration = resolveTrackDuration(audio, usePlayerStore.getState().currentTrack)
        || Number(usePlayerStore.getState().duration)
      if (!ms.setPositionState || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return
      try {
        ms.setPositionState({
          duration: mediaDuration,
          position: Math.min(Math.max(audio.currentTime, 0), mediaDuration),
          playbackRate: audio.playbackRate || 1,
        })
      } catch {
        /* iOS может отклонить позицию во время смены источника */
      }
    }
    const seekBy = (offset) => {
      const audio = audioRef.current
      if (!audio) return
      const nextTime = Math.min(
        Math.max(audio.currentTime + offset, 0),
        Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + offset,
      )
      audio.currentTime = nextTime
      setCurrentTime(nextTime)
      syncPositionState(audio)
    }
    // Можно ли ПРЯМО СЕЙЧАС менять источник по команде виджета.
    //
    // Ключевое ограничение iOS: аудиосессию (ту самую, из-за которой на экране
    // блокировки вообще есть виджет) система держит за страницей, только пока
    // элемент находится в осмысленном состоянии — играет либо сознательно
    // поставлен на паузу. Смена src элемент сбрасывает; если он к этому моменту
    // ещё НИ РАЗУ не зазвучал (предыдущее переключение всё ещё качает трек),
    // сессии нет, и новый фоновый старт система не разрешает. Виджет тогда не
    // «замирает», а пропадает совсем («нет аудио»), и вернуть звук можно только
    // открыв PWA. Ровно это ловится при двух скипах подряд: первый уходит с
    // играющего трека и проходит, второй — с ещё молчащего.
    //
    // ПАУЗА — законное состояние, а не «молчит, значит сессии нет»: виджет на
    // паузе виден, сессия жива, и next/prev обязаны работать. Проверять здесь
    // `!audio.paused` (как было в первой версии этого гейта) означало намертво
    // заблокировать переключение у поставившего на паузу — кнопки виджета не
    // делали ничего до открытия PWA. Отличает одно от другого не пауза, а
    // наличие данных: у сознательной паузы буфер и позиция есть, у зависшего
    // старта — нет.
    //
    // На видимой странице ограничение не нужно: там сессия восстанавливается
    // по любому касанию, а гейт только мешал бы листать очередь.
    const canSwapSourceNow = () => {
      const audio = audioRef.current
      if (!audio || !document.hidden) return true
      const ok = audio.readyState >= audio.HAVE_CURRENT_DATA
        && (audio.paused || audio.currentTime > 0)
      if (!ok) diag('gate:swapBlocked', snapshotAudio(audio))
      return ok
    }
    const handlers = {
      play: async () => {
        const audio = audioRef.current
        if (!audio) return
        try {
          // Зависший старт (play() принят, время замерло на нуле): повторный
          // play() вернёт тот же висящий промис. С данными в буфере лечит
          // микро-seek (как ручной тык в прогресс-бар), без данных — load()
          // в жестовом контексте (см. kickStalled в эффекте плеера).
          if (needsFreshLoad(audio)) {
            // Долгая пауза (особенно в фоне): iOS освобождает буфер и сам
            // медиа-ресурс, элемент остаётся с src, но пустой. play() на пустом
            // элементе резолвится молча — звука нет, а виджет уже показывает
            // «играет» и крутит часы. Нужен load(), и здесь он законен: мы
            // внутри жеста (нажатие ▶ на виджете) — единственное место, где
            // load() в фоне и разрешён, и безопасен для аудиосессии.
            audio.load()
          } else if (!audio.paused && audio.currentTime === 0) {
            if (audio.readyState >= audio.HAVE_CURRENT_DATA) {
              try {
                audio.currentTime = 0.01
              } catch {
                /* noop */
              }
            } else {
              audio.load()
            }
          }
          await playWithDiag(audio, 'widget:play')
          if (!usePlayerStore.getState().isPlaying) togglePlayPause()
        } catch (error) {
          console.error('System play action failed:', error)
        }
      },
      pause: () => {
        diag('widget:pause', snapshotAudio(audioRef.current))
        audioRef.current?.pause()
        if (usePlayerStore.getState().isPlaying) togglePlayPause()
      },
      // Как и в handleEnded: src+play() синхронно в контексте media-key
      // события, ДО обновления store. Иначе play() уходил в React-эффект вне
      // жестового контекста, фоновая вкладка его блокировала — трек в виджете
      // «переключался», но не играл.
      previoustrack: () => {
        diag('widget:previoustrack', snapshotAudio(audioRef.current))
        if (!canSwapSourceNow()) return
        playAdjacentNow(-1, { deferIfCold: true })
        usePlayerStore.getState().previousTrack()
      },
      nexttrack: () => {
        diag('widget:nexttrack', snapshotAudio(audioRef.current))
        if (!canSwapSourceNow()) return
        // Тот же гейт, что и на кнопке: не прыгаем на ещё не подгруженный трек.
        // Гейт действует и в фоне — там он даже важнее: прыжок на трек, резолв
        // которого на бэке ещё не готов, означает секунды тишины, а тишина в
        // фоне стоит потерянной аудиосессии (см. canSwapSourceNow). Отказ же
        // ничего не ломает: текущий трек продолжает играть, а гейт открывается
        // сам, как только доедет прогрев (_pollPrefetchReady, потолок ~24 с).
        // Заодно пинаем прогрев, чтобы следующее нажатие сработало раньше.
        if (!usePlayerStore.getState().isNextTrackReady()) {
          diag('gate:nextNotReady', {})
          usePlayerStore.getState().prefetchNext()
          return
        }
        playAdjacentNow(1, { deferIfCold: true })
        usePlayerStore.getState().nextTrack()
      },
      seekto: (details) => {
        const audio = audioRef.current
        if (!audio || !Number.isFinite(details.seekTime)) return

        const seekTime = Math.min(
          Math.max(details.seekTime, 0),
          Number.isFinite(audio.duration) ? audio.duration : details.seekTime,
        )
        if (details.fastSeek && typeof audio.fastSeek === 'function') {
          audio.fastSeek(seekTime)
        } else {
          audio.currentTime = seekTime
        }
        setCurrentTime(seekTime)
        syncPositionState(audio)
      },
    }
    const registerHandlers = () => {
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          ms.setActionHandler(action, handler)
        } catch {
          // Некоторые действия могут не поддерживаться браузером — игнорируем.
        }
      }
    }

    // iOS определяет набор кнопок Control Center в момент начала нативного
    // воспроизведения. Ранняя регистрация часто оставляет next/previous серыми.
    registerHandlers()
    const audio = audioRef.current
    audio?.addEventListener('playing', registerHandlers)

    return () => {
      audio?.removeEventListener('playing', registerHandlers)
      for (const action of Object.keys(handlers)) {
        try {
          ms.setActionHandler(action, null)
        } catch {
          /* noop */
        }
      }
    }
    // currentTrack?.id в зависимостях обязателен: при старте приложения
    // Player возвращает null (нет трека) и <audio> ещё не смонтирован, поэтому
    // на первом (и единственном, если deps стабильны) запуске audioRef.current
    // был null и слушатель 'playing' не навешивался — из-за чего обработчики
    // prev/next/seek не перерегистрировались после начала воспроизведения и
    // оставались неактивными в системном виджете. Перезапуск на смене трека
    // навешивает слушатель на реальный <audio> и заново регистрирует хендлеры.
  }, [currentTrack?.id, togglePlayPause, setCurrentTime])

  // Статус воспроизведения в виджете (play/pause индикатор).
  // 'playing' здесь НЕ выставляем: это делает только реальное событие play
  // элемента (handlePlay выше). Если после ended следующий трек не смог
  // стартовать в фоне (NotAllowedError/стойл загрузки), store.isPlaying всё
  // ещё true — форс 'playing' из него заставлял виджет показывать «играет»
  // и тикать время (ОС экстраполирует positionState) при полной тишине.
  // Честный 'paused' вдобавок даёт на экране блокировки рабочую кнопку ▶:
  // её нажатие — жест, audio.play() в нём разрешён и звук возвращается.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack) {
      navigator.mediaSession.playbackState = 'none'
    } else if (!isPlaying) {
      navigator.mediaSession.playbackState = 'paused'
    }
  }, [isPlaying, currentTrack?.id])

  // Позиция/длительность — прогресс-бар в системном виджете. Потиковую
  // синхронизацию делает timeupdate-листенер (syncPositionState в updateTime);
  // этот эффект покрывает только смену трека/длительности — без зависимости
  // от currentTime, чтобы не перерисовывать Player на каждом тике.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
    const audio = audioRef.current
    const mediaDuration = resolveTrackDuration(audio, currentTrack) || Number(duration)
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration: mediaDuration,
        position: Math.min(
          Math.max(audio?.currentTime ?? usePlayerStore.getState().currentTime, 0),
          mediaDuration,
        ),
        playbackRate: audio?.playbackRate || 1,
      })
    } catch {
      /* значения вне диапазона — пропускаем */
    }
  }, [duration, currentTrack?.id, currentTrack?.duration])

  if (!currentTrack) {
    return null
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
  const isDisliked = dbTrackId ? dislikedTrackIds.includes(dbTrackId) : false

  // Дизлайк = «не хочу это слышать»: помечаем трек и сразу уходим на
  // следующий. Повторное нажатие (трек уже дизлайкнут) только снимает метку,
  // не переключая: пользователь мог вернуться и передумать.
  const handleDislike = async () => {
    if (!canInteract || loadingDislike) return

    setLoadingDislike(true)
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (!id) return
      const wasDisliked = usePlayerStore.getState().dislikedTrackIds.includes(id)
      await toggleTrackDislike(id)
      if (!wasDisliked) nextTrack()
    } catch (error) {
      console.error('Error toggling dislike:', error)
      toast.error('Не удалось отметить трек')
    } finally {
      setLoadingDislike(false)
    }
  }

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

    if (!audio?.src) return

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
        // Повтор с новым URL обходит закэшированный сетевой ответ и заставляет
        // backend заново разрешить временный URL внешнего провайдера.
        const rawRetryUrl = resolveRawUrl(trackAtError, isExternalTrack)
        if (rawRetryUrl) {
          const retryUrl = new URL(rawRetryUrl, window.location.href)
          retryUrl.searchParams.set('_media_retry', String(Date.now()))
          setAudioSrc(retryUrl.href)
        } else {
          el.load()
        }
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
        // 2xx/3xx: URL живой, бэкенд отвечает валидным аудио.
        // НЕ делаем retry — он убьёт текущий <audio> load и создаст
        // бесконечный цикл: probe OK → retry → new src → error → probe OK → ...
        if (res.status < 400) return
        // 4xx/5xx: CDN URL мог протухнуть или сервер упал —
        // новый URL может восстановить поток.
        scheduleRetry()
      })
      .catch(() => {
        clearTimeout(probeTimer)
        // Запрос не прошёл (сеть/CORS/таймаут) — пробуем с другим URL.
        scheduleRetry()
      })
  }

  return (
    <div className="player">
      <PlayerProgress audioRef={audioRef} />
      {/* src намеренно НЕ атрибут JSX: им управляет эффект audioSrc выше,
          чтобы React-коммит не перезапускал media load поверх синхронного
          старта из handleEnded/виджета. */}
      {/* Две деки. Играет всегда одна (на неё смотрит audioRef), вторая молча
          догружает следующий трек. preload="auto" теперь обязателен и на iOS:
          прежнее "metadata" берегло трафик, но именно оно и оставляло
          переключение без буфера — ради чего деки и появились. */}
      {['a', 'b'].map((deck) => (
        <audio
          key={deck}
          ref={deck === 'a' ? setDeckA : setDeckB}
          preload="auto"
          playsInline
          onError={(event) => {
            // Ошибка прогрева свободной деки не должна ни скипать трек, ни
            // показывать ошибку: играющая дека в порядке. Переключение на
            // этот трек само уйдёт на холодный путь и разберётся уже там.
            if (!isActiveDeck(event.currentTarget)) {
              diag('preload:error', { code: event.currentTarget?.error?.code })
              // Сломалась цель отложенного переключения — ждать её буфер
              // бессмысленно. Переключаемся сразу: обработка ошибки (ретраи,
              // скип на 404) отработает уже на активной деке, как обычно.
              const pending = pendingSwapRef.current
              if (pending?.deck === event.currentTarget) {
                cancelPendingSwap()
                finishSwap(pending.deck, getActiveDeck(), 'swap:next:errorDeferred')
              }
              return
            }
            handleAudioError(event)
          }}
          onCanPlay={(event) => {
            if (!isActiveDeck(event.currentTarget)) {
              diag('preload:canplay', {})
              return
            }
            // Раз дошли до canplay — источник рабочий, ретраи для этой сессии
            // трека больше не нужны, скрываем спиннер.
            retryCountRef.current = 0
            setIsBuffering(false)
            if (isPlaying) {
              playWithDiag(audioRef.current, 'jsx:onCanPlay')
            }
          }}
          onWaiting={(event) => {
            if (isActiveDeck(event.currentTarget)) setIsBuffering(true)
          }}
          onPlaying={(event) => {
            if (isActiveDeck(event.currentTarget)) setIsBuffering(false)
          }}
        />
      ))}
      <div className="player-left" {...swipeHandlers}>
        <button
          type="button"
          className="player-cover-wrap"
          onClick={() => openFullScreen(false)}
          aria-label="Открыть плеер на весь экран"
        >
          <img
            src={resolveCoverUrl(currentTrack.cover_url) || defaultCover}
            alt={currentTrack.title}
            className="player-cover"
            loading="lazy"
            decoding="async"
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
            {isExternalTrack && isBuffering ? (
              'Загрузка…'
            ) : (
              <ArtistLink artist={currentTrack.artist} className="player-artist-names" />
            )}
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
              className={`dislike-btn ${isDisliked ? 'disliked' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                handleDislike()
              }}
              disabled={loadingDislike}
              title={isDisliked ? 'Убрать отметку «не нравится»' : 'Не нравится'}
              aria-pressed={isDisliked}
            >
              <ThumbsDown size={18} fill={isDisliked ? 'currentColor' : 'none'} />
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
            <Shuffle size={20} fill={isShuffle ? 'currentColor' : 'none'} />
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
          <button
            type="button"
            className="control-btn"
            onClick={handleSkipForward}
            disabled={!canSkipNext}
            aria-label="Следующий"
            title={canSkipNext ? 'Следующий' : 'Следующий трек ещё загружается'}
          >
            <SkipForward size={20} />
          </button>
          <button
            type="button"
            className={`control-btn ${isRepeatOne ? 'active' : ''}`}
            onClick={toggleRepeatOne}
            title={isRepeatOne ? 'Выключить повтор трека' : 'Повторять трек'}
          >
            <Repeat1 size={20} fill={isRepeatOne ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>

      <div className="player-right">
        <button
          className={`lyrics-btn${hasLyrics ? '' : ' disabled'}`}
          onClick={(event) => {
            event.stopPropagation()
            if (hasLyrics) openFullScreen(true)
          }}
          disabled={!hasLyrics}
          title={hasLyrics ? 'Текст песни' : 'Текст не найден'}
        >
          <AlignLeft size={18} />
        </button>
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

const Player = React.memo(PlayerInner)

export default Player


