import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  invalidateFlowPreload,
  postRecommendationEvent,
  recordRecommendationImpression,
  usePlayerStore,
} from '../store/playerStore'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat1, Volume2, Heart, ThumbsDown, ListPlus, Download, AlignLeft } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { useSwipe } from '../hooks/useSwipe'
import ArtistLink from './ArtistLink'
import { toast } from '../store/toastStore'
import { API_URL, SERVER_URL } from '../config'
import './Player.css'
import { useLyrics } from '../hooks/useLyrics'
import { diag, snapshotAudio, playWithDiag } from '../utils/playerDiag'
import * as engine from '../services/audioEngine'

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
// За сколько секунд до конца трека начинать прогрев следующего во второй
// <audio>, если текущий ещё не докачан целиком. Запас должен покрывать
// холодный резолв на бэке (yt-dlp — единицы секунд) плюс загрузку первых
// килобайт через узкий канал.
const PRELOAD_LEAD_SEC = 45
// Запас буфера у играющего трека, при котором можно начинать качать следующий,
// не отбирая у него полосу. Раньше ждали полной докачки — но на длинном треке
// и узком канале она наступает поздно, а фоновый переход теперь ЖЁСТКО требует
// готового буфера (см. playAdjacentNow): опоздавший прогрев означает не «чуть
// медленнее», а «переход не состоялся». Полминуты запаса — компромисс: текущий
// трек уже вне опасности, а у следующего есть время догрузиться.
const PRELOAD_MIN_BUFFER_SEC = 30
// Через сколько после подмены проверить, что элемент реально поехал. Должно
// пережить паузу между play() и первыми кадрами (на устройстве — до ~0.8 с даже
// на полностью загруженном буфере), но не тянуться так долго, чтобы виджет
// успел наврать.
const SWAP_VERIFY_MS = 2500
// Последний аварийный потолок handoff. Нормально предыдущий элемент отпускается
// по `playing` или продвижению currentTime; один таймер здесь ненадёжен, потому
// что скрытую страницу iOS может заморозить надолго.
const SWAP_RELEASE_MAX_MS = 3000
// Прослушивание засчитывается в play_count (сигнал вкуса) ТОЛЬКО после
// реального прослушивания, а не на старте. Иначе в автоплей-«волне» каждый
// поданный трек получал +play независимо от вовлечённости — и скипнутые/
// фоновые треки накапливали play_count, попадали в профиль вкуса и волна
// подавала их ещё чаще (петля обратной связи). Порог симметричен скипу
// (<25% → skip): засчитываем на ≥50% ИЛИ ≥60с (для длинных треков), 25–50%
// остаётся нейтральной зоной — ни плюс, ни минус.
const PLAY_RECORD_RATIO = 0.5
const PLAY_RECORD_MIN_SEC = 60

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

// Источники, чей поток резолвится на бэке лениво (в отличие от локальных
// файлов). Один список на весь модуль — раньше он был размножен по вызовам.
const EXTERNAL_SOURCES = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud']

// URL соседнего трека очереди. Общая точка для прогрева (engine.preload),
// подмены элементов (playAdjacentNow) и гейта скипа: все трое должны говорить
// про ОДИН и тот же URL, иначе «заряжено» и «сейчас включим» разъезжаются.
function nextTrackUrl(offset = 1) {
  const next = usePlayerStore.getState().getNextTrack(offset)
  if (!next) return null
  return resolveRawUrl(next, EXTERNAL_SOURCES.includes(next.source)) || null
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

  const audioRef = useRef(null)
  // Активный <audio> живёт не в JSX, а в модульном движке (services/audioEngine):
  // два элемента, второй заранее догружает следующий трек, чтобы переход в фоне
  // не требовал новой сетевой загрузки. audioRef остаётся указателем на
  // АКТИВНЫЙ элемент — весь код ниже работает с ним как раньше.
  //
  // Инициализация в теле рендера, а не в эффекте: эффекты ниже читают
  // audioRef.current сразу, а бегут они позже первого рендера — ленивая
  // инициализация здесь гарантирует, что к моменту их запуска указатель уже
  // ведёт на живой элемент.
  if (audioRef.current === null) audioRef.current = engine.getActive()
  // Растёт при подмене активного элемента: заставляет эффекты, навешивающие
  // слушатели, перевеситься на новый элемент.
  const [swapVersion, setSwapVersion] = useState(0)
  // Растёт, когда заряженный элемент догрузился — пересчитывает гейт скипа.
  const [idleReadyVersion, setIdleReadyVersion] = useState(0)

  useEffect(() => {
    engine.mount()
    audioRef.current = engine.getActive()
    const offSwap = engine.onSwap(() => {
      // Указатель обновляем синхронно, прямо в момент подмены: swapTo зовётся
      // из жестового контекста (ended / кнопка виджета), и код после него
      // должен видеть уже новый активный элемент, не дожидаясь ре-рендера.
      audioRef.current = engine.getActive()
      setSwapVersion((v) => v + 1)
    })
    const offIdleReady = engine.onIdleReady(() => {
      setIdleReadyVersion((v) => v + 1)
      // Буфер следующего трека доехал — если переход был отложен (кончился трек
      // в фоне, играть было нечего), доигрываем его прямо сейчас.
      resumeDeferredRef.current?.()
    })
    return () => {
      offSwap()
      offIdleReady()
    }
  }, [])

  const lastRecordedTrackIdRef = useRef(null)
  const recommendationImpressionRef = useRef(null)
  // Токен актуальности источника (см. эффект ниже) — защита от того,
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
  // Таймер проверки «подменённый элемент реально поехал» (см. verifySwapStarted).
  const swapVerifyTimerRef = useRef(null)
  // Страховочный таймер отпускания предыдущего элемента, если 'playing' на
  // новом так и не придёт (см. playAdjacentNow).
  const swapReleaseTimerRef = useRef(null)
  // Досрочное отпускание предыдущего элемента, минуя ожидание 'playing'. Нужно
  // проверке мёртвого конвейера: она наступает раньше страховочного таймера, и
  // без отмены тот выстрелил бы позже и переобъявил «играю» поверх честной паузы.
  const swapReleaseNowRef = useRef(null)
  // Всегда актуальная ссылка на handleAudioError. Слушатель 'error' вешается
  // в эффекте (элемент больше не в JSX), а сам обработчик пересоздаётся на
  // каждом рендере — через ref эффект зовёт свежую версию, не переподписываясь.
  const audioErrorRef = useRef(null)
  // Переход, отложенный из-за незагруженного следующего трека (см.
  // playAdjacentNow / handleEnded). Флаг + функция доигрывания, которую зовёт
  // движок по факту догрузки буфера.
  const pendingAdvanceRef = useRef(false)
  const resumeDeferredRef = useRef(null)
  // URL вместе с владельцем-треком. При swapTo активный <audio> меняется
  // синхронно, а React ещё может держать в состоянии URL предыдущего трека.
  // Без trackId эффект ниже успевал записать старый URL в новый слот и отменял
  // ручной skip.
  const [audioSource, setAudioSource] = useState(null)
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
  const isExternalTrack = EXTERNAL_SOURCES.includes(currentTrack?.source)
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
  //
  // Второе основание готовности — заряженный движком элемент: если следующий
  // трек уже догружен в буфер, скипать можно независимо от того, что думает
  // бэковый прогрев (буфер — более сильный сигнал, чем «резолв завершён»).
  // idleReadyVersion в подписке пересчитывает гейт по факту догрузки.
  const canSkipNext =
    (resolvedPrefetchVersion >= 0 && usePlayerStore.getState().isNextTrackReady()) ||
    (idleReadyVersion >= 0 && engine.isReady(nextTrackUrl()))

  // Пользовательский скип вперёд (кнопка/свайп): выполняем только если
  // следующий трек готов. Готовность читаем из store в момент вызова —
  // защита от устаревшего замыкания в обработчиках свайпа.
  const handleSkipForward = async () => {
    // Следующего трека нет, но плейлист загружен не весь (см. queuePager):
    // дотягиваем хвост и уходим вперёд по нему. Проактивная догрузка обычно
    // успевает раньше, так что сюда попадаем, только если запрос ещё летит
    // или упал. Экран здесь видимый — асинхронность безопасна, жестовый
    // контекст нужен лишь для фонового старта.
    if (!usePlayerStore.getState().getNextTrack(1)) {
      if (!usePlayerStore.getState().queuePager) return
      // Тот же хвост может ждать отложенный переход после ended: оба вызова
      // получают ОДИН промис догрузки и просыпаются вместе. Если за это время
      // трек сменился — переход уже состоялся без нас, и второй сдвиг очереди
      // промотал бы лишний трек.
      const fromId = usePlayerStore.getState().currentTrack?.id
      if (!(await usePlayerStore.getState().extendQueueIfNeeded(true))) return
      if (usePlayerStore.getState().currentTrack?.id !== fromId) return
    }
    if (!usePlayerStore.getState().isNextTrackReady() && !engine.isReady(nextTrackUrl())) return
    if (!playAdjacentNow(1)) return
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

    // Слушатели этого эффекта живут на КОНКРЕТНОМ элементе. При подмене
    // (engine.swapTo) активным становится другой, а отписка от прежнего
    // случится только на следующем рендере — и в это окно прежний элемент ещё
    // успевает выстрелить pause/emptied/ended: его прямо в swapTo и
    // останавливают, и освобождают. Без этой проверки такие события правили бы
    // ОБЩЕЕ состояние: виджет на экране блокировки уходил бы в 'paused' поверх
    // только что начавшегося трека, а 'ended' от старого элемента промотал бы
    // очередь на лишний трек.
    const isLive = () => engine.getActive() === audio

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
      if (!isLive()) return
      maybeRecordPlay(audio)
      const sec = Math.floor(audio.currentTime)
      if (sec === lastTickSecond) return
      lastTickSecond = sec
      if (!document.hidden) setCurrentTime(audio.currentTime)
      syncPositionState()
      maybePreloadNext(audio)
    }
    // Прогрев следующего трека во ВТОРОЙ <audio> — то, ради чего затевался
    // движок: к моменту перехода данные уже в буфере, и в фоне переключение
    // не зависит ни от load(), ни от новой сетевой загрузки.
    //
    // Момент старта прогрева выбран по полосе, а не по времени: канал бывает
    // узкий (~140 КБ/с через туннель), и качать два потока разом значит отобрать
    // байты у играющего трека — он начнёт запинаться. Поэтому греем, только
    // когда играющему треку сеть уже почти не нужна (докачан целиком либо есть
    // запас PRELOAD_MIN_BUFFER_SEC вперёд) либо когда до конца осталось меньше
    // PRELOAD_LEAD_SEC — там прогрев важнее возможной запинки в последние
    // секунды: без него фоновый переход просто не состоится.
    const maybePreloadNext = (el) => {
      const state = usePlayerStore.getState()
      if (!state.isPlaying) return
      // На повторе одного трека переход никуда не ведёт — качать следующий
      // значит зря отнимать полосу у того, что играет по кругу.
      if (state.isRepeatOne) return
      const url = nextTrackUrl(1)
      if (!url || engine.hasPrimedSrc(url)) return
      const trackDuration = resolveTrackDuration(el, state.currentTrack)
      const nearEnd =
        trackDuration > 0 && trackDuration - el.currentTime <= PRELOAD_LEAD_SEC
      const comfortable =
        engine.isFullyBuffered(el) || engine.bufferedAhead(el) >= PRELOAD_MIN_BUFFER_SEC
      if (!nearEnd && !comfortable) return
      engine.preload(url)
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
      // Микро-seek лечит замерший конвейер в Chromium, но в WebKit он его
      // ЛОМАЕТ — ровно как описано в handlePlaying ниже: перемотка по свежему
      // потоку (Opus/WebM от yt-dlp, без индекса перемотки) заставляет
      // перезапросить диапазон, и элемент залипает в seeking. На устройстве это
      // видно прямо в логе: `kickStalled:seek ... seeking=true` на молчащем
      // треке, после чего он молчит и дальше. В фоне на iOS не делаем ничего:
      // честно показываем паузу, и рабочая ▶ на виджете чинит всё жестом.
      if (isIOS && document.hidden) {
        diag('kickStalled:skip:ios', snapshotAudio(audio))
        syncSystemPlaybackState('paused')
        return
      }
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
      if (!isLive()) return
      if (!document.hidden) {
        // Вернулись на видимый экран с отложенным переходом (трек кончился в
        // фоне, буфера не было). Здесь старт с нуля уже безопасен — доигрываем.
        if (pendingAdvanceRef.current) {
          diag('deferred:foreground', {})
          if (playAdjacentNow(1)) {
            nextTrack()
            return
          }
        }
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
      if (!isLive()) return
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
      if (!isLive()) return
      if (!usePlayerStore.getState().isPlaying) return
      if (!isStalledStart()) return
      if (stallKickCountRef.current >= 3) return // дальше — вотчдог/пользователь
      stallKickCountRef.current += 1
      kickStalled()
    }
    const handlePlaying = () => {
      if (!isLive()) return
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
      if (!isLive()) return
      syncSystemPlaybackState(currentTrack ? 'paused' : 'none')
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
      if (!isLive()) return
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
      // Доигравший СТАРЫЙ элемент (его оставили заряженным на «предыдущий
      // трек») тоже шлёт ended — но очередь по нему двигать нельзя, иначе один
      // переход промотал бы сразу два трека.
      if (!isLive()) return
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
        //
        // Очередь двигаем ТОЛЬКО если старт реально состоялся. В фоне без
        // загруженного буфера playAdjacentNow отказывает (см. его комментарий):
        // тогда остаёмся на текущем треке, элемент по ended сам встаёт на паузу
        // (виджет показывает рабочую ▶), а переход доигрывается автоматически,
        // как только прогрев догрузится.
        //
        // Конец очереди — не всегда конец плейлиста: страница грузит треки
        // постранично, и хвост может быть ещё не загружен (см. queuePager в
        // playerStore). Тогда дотягиваем его и доигрываем переход по приезде —
        // тем же отложенным путём, что и при неготовом буфере.
        //
        // Штатное завершение (тянуть неоткуда) остаётся как было: nextTrack()
        // сам переведёт store в паузу, иначе плеер навсегда остался бы в
        // состоянии «играю» без звука.
        if (!usePlayerStore.getState().getNextTrack(1)) {
          if (usePlayerStore.getState().queuePager) {
            pendingAdvanceRef.current = true
            // Сессию держим тишиной, пока летит запрос: отдать её сейчас значит
            // остаться без права на play() к моменту, когда хвост приедет.
            engine.holdSession()
            diag('ended:queueExtend', {})
            resumeAfterQueueExtend()
          } else {
            nextTrack()
          }
        } else if (playAdjacentNow(1)) {
          nextTrack()
        } else {
          pendingAdvanceRef.current = true
          // Пока ждём буфер, держим аудиосессию тишиной: если отдать её сейчас,
          // то к моменту готовности следующего трека включать его будет уже
          // некому — play() без жеста iOS не разрешит (см. holdSession).
          engine.holdSession()
          diag('ended:deferred', {})
        }
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
      if (!isLive()) return
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

    // Бывшие JSX-атрибуты <audio>: элемент уехал в движок, поэтому те же
    // обработчики навешиваем здесь руками.
    //
    // Ошибку прокидываем через ref: handleAudioError замыкает актуальный
    // currentTrack и пересоздаётся каждый рендер, а этот эффект
    // переподписывается заметно реже — прямая ссылка застревала бы на треке,
    // который был текущим в момент подписки.
    const handleElementError = (event) => {
      if (!isLive()) return
      audioErrorRef.current?.(event)
    }
    const handleSourceCanPlay = () => {
      if (!isLive()) return
      // Раз дошли до canplay — источник рабочий, ретраи для этой сессии
      // трека больше не нужны, скрываем спиннер.
      retryCountRef.current = 0
      setIsBuffering(false)
      if (usePlayerStore.getState().isPlaying && audio.paused) {
        playWithDiag(audio, 'listener:canplay')
      }
    }
    const handleWaiting = () => {
      if (!isLive()) return
      setIsBuffering(true)
    }
    // Один именованный обработчик 'playing' вместо анонимной стрелки: снять
    // с элемента можно только ту же ссылку, что вешал. Раньше вешалась стрелка,
    // а снимался handlePlaying — то есть не снималось ничего. Пока элемент
    // умирал вместе с компонентом, это сходило с рук; теперь элементы живут всю
    // сессию страницы, и каждая переподписка эффекта добавляла бы ещё один
    // висящий слушатель поверх старых.
    const handlePlayingSync = () => {
      if (!isLive()) return
      handlePlaying()
      setIsBuffering(false)
      // syncPositionState на playing: iOS требует setPositionState ДО того,
      // как система «признает» воспроизведение — иначе виджет на экране
      // блокировки не появляется. timeupdate стреляет слишком поздно.
      syncPositionState()
    }

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
    audio.addEventListener('canplay', handleSourceCanPlay)
    audio.addEventListener('waiting', handleWaiting)
    audio.addEventListener('error', handleElementError)
    audio.addEventListener('seeked', syncPositionState)
    audio.addEventListener('ratechange', syncPositionState)
    audio.addEventListener('playing', handlePlayingSync)
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

    // playAdjacentNow стартует трек синхронно, а этот эффект переподписывается
    // только на следующем рендере — часть событий элемента к этому моменту уже
    // прошла. Приводим производное состояние к факту, иначе на играющем треке
    // виджет остаётся с 'paused', а длительность и позиция — от предыдущего.
    if (!audio.paused && audio.readyState >= audio.HAVE_CURRENT_DATA) {
      syncSystemPlaybackState('playing')
      setIsBuffering(false)
    }
    // Детектор зависания начинает отсчёт заново. Обычно это делает handleEmptied
    // по смене источника, но при подмене элемента (swapTo) ни emptied, ни
    // loadstart не стреляют: src на этом элементе выставили раньше, во время
    // прогрева. Без сброса свежий элемент судили бы по активности ПРЕДЫДУЩЕГО:
    // у докачанного трека progress перестаёт приходить задолго до конца, и через
    // NO_PROGRESS_STALL_MS isStalledStart() начинал бы давать true сразу после
    // подмены (currentTime у нового элемента как раз ноль) — вотчдог принял бы
    // нормальный старт за стойл и дёрнул kickStalled на живом треке.
    noteProgress()
    stallKickCountRef.current = 0
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
      audio.removeEventListener('canplay', handleSourceCanPlay)
      audio.removeEventListener('waiting', handleWaiting)
      audio.removeEventListener('error', handleElementError)
      audio.removeEventListener('seeked', syncPositionState)
      audio.removeEventListener('ratechange', syncPositionState)
      audio.removeEventListener('playing', handlePlayingSync)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('emptied', handleEmptied)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('stalled', handleLoadStall)
      audio.removeEventListener('suspend', handleLoadStall)
    }
  }, [currentTrack?.id, setCurrentTime, setDuration, nextTrack, swapVersion])

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
    setAudioSource({
      trackId: currentTrack?.id ?? null,
      url: resolveRawUrl(currentTrack, isExternalTrack),
    })
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
    // После swapVersion audioRef уже указывает на новый слот, но audioSource
    // может ещё принадлежать предыдущему треку до следующего React-рендера.
    // В этот промежуточный момент ничего не трогаем: swapTo уже выставил
    // правильный URL и начал play() в исходном событии skip/ended.
    if (!audioSource || audioSource.trackId !== (currentTrack?.id ?? null)) return
    if (!audioSource.url) {
      if (audio.src) {
        audio.removeAttribute('src')
        audio.load()
      }
      return
    }
    const abs = new URL(audioSource.url, window.location.href).href
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
    // После swapTo новый слот уже получил правильный URL из preload(). Не
    // запускаем этот эффект повторно только из-за swapVersion: состояние React
    // в этот момент ещё может содержать URL предыдущего трека.
  }, [audioSource, currentTrack?.id])

  // Пере-объявление системе «сейчас играет вот этот элемент».
  //
  // Зачем. Кнопка на виджете iOS питается НЕ нашим mediaSession.playbackState —
  // WebKit публикует Now Playing по собственным переходам media-элементов
  // (начал играть / встал на паузу), а playbackState для него в лучшем случае
  // подсказка. Отсюда и остаточная поломка после разведения подмены во времени:
  // новый элемент запел в t, а в t+~170 мс мы глушим прежний (finishSwap) и мост
  // (releaseSession) — и ПОСЛЕДНИМ переходом, который увидела система, оказался
  // pause чужого элемента. Звук идёт, шкала едет (её двигает наш setPositionState
  // на каждом timeupdate, он работает и в фоне), а кнопка застревает на ▶.
  // Прежний код на это отвечал только `playbackState = 'playing'` — и, как видно
  // на устройстве, безрезультатно.
  //
  // Лечится повторным play() на уже играющем элементе. По спеке это почти no-op:
  // при paused === false play() лишь резолвит промис, ни событий, ни перезапуска
  // загрузки, ни сброса позиции. Но WebKit проходит через ту же точку, где
  // обновляет Now Playing, и публикует уже НАШ элемент со ставкой «играет».
  // Звать строго ПОСЛЕ глушения соседей: иначе последним переходом снова
  // окажется их pause.
  const reassertNowPlaying = (el, where) => {
    // Молчащий элемент пере-объявлять нечего: если он на паузе, честное 'paused'
    // на виджете — правда, а play() тут запустил бы звук, которого не просили.
    if (!el || el.paused) return
    if (!usePlayerStore.getState().isPlaying) return
    playWithDiag(el, where)
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = 'playing'
    const mediaDuration = resolveTrackDuration(el, usePlayerStore.getState().currentTrack)
    if (!navigator.mediaSession.setPositionState || !(mediaDuration > 0)) return
    try {
      navigator.mediaSession.setPositionState({
        duration: mediaDuration,
        position: Math.min(Math.max(el.currentTime, 0), mediaDuration),
        playbackRate: el.playbackRate || 1,
      })
    } catch {
      /* значения вне диапазона — пропускаем */
    }
  }

  // Синхронный (в контексте текущего жеста/события) старт соседнего трека
  // очереди прямо на <audio>-элементе — общий путь для естественного конца
  // трека (ended) и кнопок next/prev системного виджета. Store после этого
  // обновляется отдельно вызывающей стороной; эффект src выше увидит тот же
  // URL и ничего не перезапустит.
  //
  // Быстрый путь — подмена элемента (engine.swapTo): если движок заранее
  // догрузил этот трек во второй <audio>, играть можно немедленно, без
  // обращения к сети. Именно это чинит фон: в скрытой вкладке / на
  // заблокированном экране нам больше не нужно ни load(), ни успешная загрузка
  // нового потока — только play() на уже тёплом элементе.
  //
  // Медленный путь (буфера нет) РАЗРЕШЁН ТОЛЬКО НА ВИДИМОМ ЭКРАНЕ. В фоне он
  // даёт ровно тот отказ, ради которого всё это писалось: iOS принимает play()
  // и рапортует системе «играем», но поток не начинает грузиться — на экране
  // блокировки идёт время (ОС экстраполирует его из setPositionState), а звука
  // нет. Молчаливое «играет» хуже, чем не переключиться вовсе: очередь уезжает
  // вперёд, трек считается прослушанным, и вернуть звук можно только руками.
  // Поэтому в фоне вместо старта с нуля запускаем прогрев и честно отвечаем
  // «не смог» — вызывающая сторона не двигает очередь.
  //
  // Возвращает true, если воспроизведение действительно начато.
  const playAdjacentNow = (offset) => {
    const next = usePlayerStore.getState().getNextTrack(offset)
    if (!next) return false
    const url = resolveRawUrl(next, EXTERNAL_SOURCES.includes(next.source))
    if (!url) return false

    const primed = engine.swapTo(url)
    if (primed) {
      pendingAdvanceRef.current = false
      primed.volume = usePlayerStore.getState().volume
      diag('swap:primed', { offset, ...snapshotAudio(primed) })
      // Старый элемент отпускаем не здесь, а по факту того, что новый реально
      // запел. Это вторая итерация исправления, и первая была неверной: я
      // считал, что достаточно вызвать play() нового ДО pause() старого в одном
      // тике — «намерение играть регистрируется синхронно». Лог с устройства
      // это опроверг: play:call 55.484 → swap:finish 55.492 → playing 55.651,
      // то есть между вызовом и реальным стартом ~170 мс, и всё это окно не
      // играл никто. WebKit за него терял Now Playing — звук шёл из нового
      // элемента, а виджет показывал состояние брошенного: ▶ поверх играющего
      // трека и мёртвая шкала перемотки.
      //
      // Перекрытие на iOS слышно (volume у media-элемента там только для
      // чтения, см. swapTo) — доли секунды двух треков сразу. Размен
      // сознательный: muted вместо volume вернул бы поломку, потому что
      // приглушённый элемент iOS владельцем сессии не считает.
      //
      // `playing` в фоне WebKit иногда теряется, а setTimeout скрытой страницы
      // троттлится вплоть до десятков секунд. Поэтому отпускаем предыдущий по
      // любому доказательству старта: playing либо продвижению currentTime.
      // Таймер остаётся последней страховкой.
      //
      // Отпускание разделено надвое. releaseNow — только освобождение (глушим
      // прежний элемент и мост). releasePrevious — то же плюс пере-объявление
      // «играю» на новом: оно уместно ровно там, где новый элемент реально
      // запел. Проверка мёртвого конвейера зовёт releaseNow напрямую — ей
      // переобъявлять нечего, там как раз пауза правдива.
      const startedAt = primed.currentTime
      let released = false
      let releaseTimer = null
      const releaseOnProgress = () => {
        if (primed.currentTime > startedAt) releasePrevious()
      }
      const releaseNow = () => {
        if (released) return false
        released = true
        primed.removeEventListener('playing', releasePrevious)
        primed.removeEventListener('timeupdate', releaseOnProgress)
        clearTimeout(releaseTimer)
        if (swapReleaseTimerRef.current === releaseTimer) {
          swapReleaseTimerRef.current = null
        }
        if (swapReleaseNowRef.current === releaseNow) {
          swapReleaseNowRef.current = null
        }
        engine.finishSwap(primed)
        engine.releaseSession()
        return true
      }
      const releasePrevious = () => {
        if (!releaseNow()) return
        // finishSwap и releaseSession — это pause() на ЧУЖИХ элементах, и для
        // системы они выглядят как «воспроизведение остановилось»: виджет уходит
        // в ▶ поверх честно звучащего трека (шкала при этом живая — её кормит
        // наш setPositionState). Возвращаем правду последним переходом.
        reassertNowPlaying(primed, 'swap:reassertPlay')
      }
      primed.addEventListener('playing', releasePrevious)
      primed.addEventListener('timeupdate', releaseOnProgress)
      clearTimeout(swapReleaseTimerRef.current)
      releaseTimer = setTimeout(releasePrevious, SWAP_RELEASE_MAX_MS)
      swapReleaseTimerRef.current = releaseTimer
      swapReleaseNowRef.current = releaseNow
      playWithDiag(primed, `swap:${offset > 0 ? 'next' : 'prev'}:primed`)
      verifySwapStarted(primed)
      return true
    }

    if (document.hidden) {
      diag('swap:refused:bg', { offset })
      // Отказ не должен быть тупиком: заряжаем элемент прямо сейчас, чтобы
      // следующая попытка (авто по onIdleReady либо повторное нажатие) прошла
      // уже быстрым путём. Отметку отложенного перехода при отказе НЕ снимаем —
      // иначе доигрывать по готовности буфера было бы некому.
      engine.preload(url)
      return false
    }

    const audio = audioRef.current
    if (!audio) return false
    pendingAdvanceRef.current = false
    diag('swap:start', { offset, ...snapshotAudio(audio) })
    audio.src = url
    audio.load()
    playWithDiag(audio, `swap:${offset > 0 ? 'next' : 'prev'}`)
    // Мост держал сессию, пока элемент перезагружался с нуля, и отпускаем мы его
    // только теперь — по той же причине, что и выше: любой промежуток без
    // играющего элемента iOS считает концом воспроизведения.
    engine.releaseSession()
    return true
  }

  // Проверка, что подменённый элемент реально поехал. Событие 'playing' тут не
  // доказательство: на устройстве оно приходило вместе с play:ok на элементе,
  // у которого currentTime потом десять секунд стоял на нуле. Media Session при
  // этом показывала «играю», ОС крутила часы, экстраполируя позицию, — и именно
  // так выглядит жалоба «время идёт, звука нет».
  //
  // Молчащий плеер сам по себе мы отсюда починить не можем (в фоне на iOS
  // легальных ходов не осталось), но врать системе перестаём: честный 'paused'
  // возвращает на экране блокировки рабочую ▶, а её нажатие — уже жест, в
  // котором разрешено всё.
  const verifySwapStarted = (el) => {
    const startedAt = el.currentTime
    clearTimeout(swapVerifyTimerRef.current)
    swapVerifyTimerRef.current = setTimeout(() => {
      if (engine.getActive() !== el) return
      if (!usePlayerStore.getState().isPlaying) return
      if (el.currentTime > startedAt) {
        // Трек поехал. Заодно перепроверяем, что виджет это отражает: событие
        // 'playing' могло прийти на элемент раньше, чем эффект успел навесить на
        // него слушатели (после подмены между play() и ре-рендером бывает
        // несколько десятков миллисекунд), и тогда 'playing' некому было
        // поймать — на экране блокировки осталась бы ▶ поверх звучащего трека,
        // а с ней и мёртвая шкала перемотки: iOS рисует её только под активное
        // воспроизведение и только по свежему setPositionState.
        //
        // Пере-объявляем через reassertNowPlaying, а не одним playbackState:
        // на iOS кнопку виджета двигают переходы самого элемента, и голый
        // playbackState её не переубеждает (см. комментарий у хелпера). Это
        // вторая линия обороны на случай, если 'playing' не пришло вовсе и
        // reassert из releasePrevious не отработал.
        diag('swap:reassert', snapshotAudio(el))
        reassertNowPlaying(el, 'swap:verify:reassertPlay')
        return
      }
      diag('swap:deadPipeline', snapshotAudio(el))
      // Подмена не поехала — отпускаем предыдущий элемент прямо сейчас и снимаем
      // страховочный таймер: он выстрелил бы позже этой проверки и переобъявил
      // «играю» поверх паузы, которую мы ставим ниже.
      swapReleaseNowRef.current?.()
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused'
      }
    }, SWAP_VERIFY_MS)
  }

  // Отложенный переход: трек доиграл в фоне, а следующий ещё не загрузился.
  // Очередь при этом НЕ двигаем — иначе виджет показал бы следующий трек, под
  // который нечего играть (ровно симптом «время идёт, звука нет»). Элемент по
  // событию ended сам встаёт на паузу, виджет показывает рабочую ▶, а переход
  // доигрывается автоматически, как только движок догрузит буфер.
  resumeDeferredRef.current = () => {
    if (!pendingAdvanceRef.current) return
    diag('deferred:resume', {})
    if (playAdjacentNow(1)) nextTrack()
  }

  // Очередь кончилась, но плейлист — нет: страница успела загрузить только
  // первые страницы треков (ленивая подгрузка по прокрутке). Дотягиваем хвост
  // и доигрываем переход.
  //
  // Быстрый путь (буфер следующего уже заряжен) здесь невозможен по построению:
  // трека в очереди не было, а значит и греть было нечего. Поэтому после
  // приезда хвоста играем обычным путём — на видимом экране он и стартует
  // загрузку. В фоне playAdjacentNow откажет и запустит прогрев, а доигрывание
  // случится по onIdleReady, как и при любом другом отложенном переходе.
  const resumeAfterQueueExtend = async () => {
    // Трек, с которого уходим. Запрос асинхронный, и за время его полёта
    // очередь могла уехать сама: тот же хвост ждёт кнопка «вперёд» (оба вызова
    // получают ОДИН промис догрузки и проснутся вместе). Без этой отметки оба
    // двинули бы очередь, и переход промотал бы два трека вместо одного.
    const fromId = usePlayerStore.getState().currentTrack?.id
    const grew = await usePlayerStore.getState().extendQueueIfNeeded(true)
    // Пока летел запрос, пользователь мог нажать паузу или включить другой
    // трек — тогда доигрывать этот переход уже нельзя.
    if (!pendingAdvanceRef.current) return
    if (usePlayerStore.getState().currentTrack?.id !== fromId) {
      // Очередь уже уехала без нас: переход состоялся другим путём. Снимаем
      // отметку и мост — держать сессию тишиной больше незачем.
      diag('queueExtend:superseded', {})
      pendingAdvanceRef.current = false
      engine.releaseSession()
      return
    }
    if (!grew) {
      // Хвоста нет — плейлист правда кончился. Отпускаем сессию и честно
      // встаём на паузу, иначе тишина моста играла бы вечно.
      diag('queueExtend:empty', {})
      pendingAdvanceRef.current = false
      engine.releaseSession()
      nextTrack()
      return
    }
    diag('queueExtend:resume', {})
    if (playAdjacentNow(1)) {
      nextTrack()
      return
    }
    // Старт отказал (фон без буфера) — переход остаётся отложенным и доиграется
    // по onIdleReady. Чтобы этому событию было откуда взяться, заряжаем движок:
    // playAdjacentNow делает это сам только на фоновой ветке, а здесь отказ мог
    // прийти и по другой причине.
    prefetchNext()
    const url = nextTrackUrl(1)
    if (url) engine.preload(url)
  }

  // Reload audio when track changes
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    // Новый трек — сбрасываем счётчик ретраев и отменяем висящий отложенный
    // повтор от предыдущего трека.
    retryCountRef.current = 0
    stallKickCountRef.current = 0
    // Трек сменился — отложенный переход (если он был) больше не актуален:
    // он относился к предыдущей позиции в очереди. Вместе с ним отпускаем и
    // мост аудиосессии, иначе тишина осталась бы играть вечно.
    pendingAdvanceRef.current = false
    engine.releaseSession()
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    setIsBuffering(false)

    // Очередь могла перестроиться (пользователь выбрал другой список/трек), и
    // заряженный в движке трек больше не следующий. Такой прогрев не только
    // бесполезен — он продолжает качать байты и отбирает полосу у того, что
    // сейчас играет.
    engine.clearStalePreload(nextTrackUrl(1))

    // Сам load() тут не нужен: смена src (через audioSource, см. эффект выше)
    // уже запускает алгоритм загрузки ресурса сама по себе — явный load()
    // здесь означал повторную полную загрузку того же потока (раньше element
    // ещё и пересоздавался целиком из-за key={currentTrack?.id}, отсюда и
    // третий "дубль" запроса). Громкость на persistent-элементе не сбрасывается
    // сама, но выставляем явно для надёжности.
    audio.volume = usePlayerStore.getState().volume
    setCurrentTime(0)
    // Длительность берём сразу из трека (в БД она точнее оценки браузера).
    // Прежнее обнуление оставляло окно, в котором duration === 0 — а на нулевой
    // длительности перемотка умножает позицию на ноль и прыгает в самое начало.
    setDuration(resolveTrackDuration(audio, currentTrack))
    setShowAddToPlaylist(false)
    setAddError('')
    setSelectedPlaylistId('')

  }, [currentTrack?.id, setCurrentTime, setDuration])

  // Отменяем висящий ретрай при размонтировании.
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }
      clearTimeout(swapVerifyTimerRef.current)
      clearTimeout(swapReleaseTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    // См. isLive в эффекте выше: подменённый элемент не должен продолжать
    // управлять воспроизведением. Здесь это особенно важно — handleCanPlay
    // зовёт play(), и на освобождаемом элементе он запустил бы второй звук
    // поверх только что начавшегося трека.
    const isLive = () => engine.getActive() === audio

    const handleLoad = () => {
      if (!isLive()) return
      setDuration(resolveTrackDuration(audio, currentTrack))
    }

    const handleCanPlay = () => {
      if (!isLive()) return
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
  }, [isPlaying, currentTrack, setDuration, swapVersion])

  // Как только заиграл текущий трек — прогреваем следующий в очереди на бэке
  // и, если играет «Моя волна», подтягиваем следующую порцию потока.
  useEffect(() => {
    if (!currentTrack) return
    prefetchNext()
    usePlayerStore.getState().extendFlowIfNeeded()
    // То же для плейлиста, загруженного постранично: хвост очереди дотягиваем
    // заранее, за несколько треков до конца загруженного (см. queuePager).
    // Именно этот вызов и убирает паузу на границе страницы — к моменту
    // перехода следующий трек уже в очереди и прогрет, а аварийный путь в
    // handleEnded остаётся только на случай упавшего запроса.
    usePlayerStore.getState().extendQueueIfNeeded()
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
    const external = EXTERNAL_SOURCES.includes(track.source)
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
    postRecommendationEvent(track, 'play', Math.max(0, Math.min(1, audio.currentTime / (dur || track.duration || 1))))
    invalidateFlowPreload()
    ;(async () => {
      try {
        const id = dbId ?? (await state.materializeCurrentTrack())
        if (id) await api.post(`/tracks/${id}/play`)
      } catch (error) {
        console.error('Error recording play:', error)
      }
    })()
  }

  // In Flow the currently selected item is the visible recommendation. A
  // server delivery alone is not an impression: confirm it only when the
  // player actually switches to that track.
  useEffect(() => {
    if (!currentTrack?.recommendation_id || currentTrack.recommendation_surface !== 'flow') return
    const key = `${currentTrack.recommendation_id}:${currentTrack.recommendation_position}:${currentTrack.id}`
    if (recommendationImpressionRef.current === key) return
    recommendationImpressionRef.current = key
    recordRecommendationImpression(currentTrack, { trigger: 'current_track' })
  }, [
    currentTrack?.id,
    currentTrack?.recommendation_id,
    currentTrack?.recommendation_position,
    currentTrack?.recommendation_surface,
  ])

  // Громкость — на оба элемента движка: после подмены новый активный должен
  // играть так же громко, как предыдущий (иначе трек «начинается тише»).
  useEffect(() => {
    engine.setVolume(volume)
  }, [volume])

  // Перемотка, инициированная из полноэкранного плеера (у него нет доступа к
  // <audio>). Запрос привязан к треку: если пользователь успел нажать skip,
  // старую перемотку нельзя применять прямо перед загрузкой нового src — у
  // потоковых источников это оставляет media element в состоянии seeking.
  useEffect(() => {
    if (!seekRequest) return
    const audio = audioRef.current
    if (
      seekRequest.trackId === currentTrack?.id &&
      audio &&
      !isNaN(seekRequest.time)
    ) {
      audio.currentTime = seekRequest.time
    }
    clearSeekRequest(seekRequest.id)
  }, [seekRequest, currentTrack?.id, clearSeekRequest])

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
    //
    // Фолбэк на длительность самого элемента обязателен: у внешних треков
    // (ytmusic/soundcloud) в БД её может не быть вовсе, и прежний код тогда
    // не звал setPositionState совсем — а без позиции iOS шкалу не рисует и
    // перематывать не даёт. resolveTrackDuration знает оба источника и
    // предпочитает точный.
    const mediaDuration = resolveTrackDuration(audioRef.current, currentTrack)
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: mediaDuration,
          position: Math.min(Math.max(audioRef.current?.currentTime || 0, 0), mediaDuration),
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
    const handlers = {
      play: async () => {
        const audio = audioRef.current
        if (!audio) return
        // Отложенный переход (трек кончился в фоне, следующий не был загружен):
        // нажатие ▶ — самый явный запрос «продолжай». Играем следующий, если
        // его буфер уже доехал. Если ещё нет — не стартуем с нуля (в фоне это
        // и даёт «время идёт, звука нет»), а доводим прогрев: доигрывание
        // случится автоматически по onIdleReady.
        if (pendingAdvanceRef.current) {
          diag('widget:play:deferred', {})
          if (playAdjacentNow(1)) {
            usePlayerStore.getState().nextTrack()
            if (!usePlayerStore.getState().isPlaying) togglePlayPause()
            return
          }
          const url = nextTrackUrl(1)
          if (url) engine.preload(url)
          return
        }
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
        // Пауза по кнопке — явный отказ от воспроизведения: отложенный переход
        // отменяем и сессию отпускаем, иначе тишина продолжила бы играть, а
        // догрузившийся буфер сам запустил бы трек поверх паузы.
        pendingAdvanceRef.current = false
        engine.releaseSession()
        if (usePlayerStore.getState().isPlaying) togglePlayPause()
      },
      // Как и в handleEnded: src+play() синхронно в контексте media-key
      // события, ДО обновления store. Иначе play() уходил в React-эффект вне
      // жестового контекста, фоновая вкладка его блокировала — трек в виджете
      // «переключался», но не играл.
      previoustrack: () => {
        diag('widget:previoustrack', snapshotAudio(audioRef.current))
        // Очередь двигаем только вслед за реально начавшимся звуком: в фоне без
        // загруженного буфера playAdjacentNow откажет и запустит прогрев, а
        // текущий трек продолжит играть. Повторное нажатие пройдёт быстро.
        if (!playAdjacentNow(-1)) return
        usePlayerStore.getState().previousTrack()
      },
      nexttrack: () => {
        diag('widget:nexttrack', snapshotAudio(audioRef.current))
        // Очередь кончилась, но плейлист загружен не весь (см. queuePager):
        // дотягиваем хвост. Синхронно тут ничего не сделать — запрос
        // асинхронный, а жестовый контекст до его конца не доживёт.
        //
        // Мост тишины и pendingAdvance тут НЕ ставим, в отличие от ended:
        // текущий трек сейчас играет, сессия жива и в подпорке не нуждается, а
        // тишина поверх звучащего трека конкурирует с ним за сессию (см.
        // holdSession). Ведём себя как гейт ниже: молча готовим переход, и
        // повторное нажатие пройдёт уже быстрым путём.
        if (!usePlayerStore.getState().getNextTrack(1)) {
          if (!usePlayerStore.getState().queuePager) return
          diag('widget:queueExtend', {})
          usePlayerStore.getState().extendQueueIfNeeded(true).then((grew) => {
            if (!grew) return
            const nextUrl = nextTrackUrl(1)
            usePlayerStore.getState().prefetchNext()
            if (nextUrl) engine.preload(nextUrl)
          })
          return
        }
        // Тот же гейт, что и на кнопке: не прыгаем на ещё не подгруженный трек.
        // Гейт действует и в фоне — там он даже важнее: прыжок на трек, резолв
        // которого на бэке ещё не готов, означает секунды тишины. Отказ же
        // ничего не ломает: текущий трек продолжает играть, а гейт открывается
        // сам, как только доедет прогрев (_pollPrefetchReady, потолок ~24 с).
        // Заодно пинаем прогрев, чтобы следующее нажатие сработало раньше.
        //
        // Заряженный движком буфер гейт открывает сразу и минуя бэковый
        // прогрев: если байты следующего трека уже лежат во втором элементе,
        // ждать нечего — это и есть та готовность, ради которой гейт заводился.
        const url = nextTrackUrl(1)
        if (!engine.isReady(url) && !usePlayerStore.getState().isNextTrackReady()) {
          diag('gate:nextNotReady', {})
          usePlayerStore.getState().prefetchNext()
          // Прогрев по-хорошему стартует по таймеру воспроизведения, но раз
          // пользователь уже жмёт «вперёд» — заряжаем второй элемент немедленно,
          // не дожидаясь окна по полосе. Следующее нажатие сработает мгновенно.
          if (url) engine.preload(url)
          return
        }
        // Фоновое правило («стартуем только на загруженном буфере») живёт внутри
        // playAdjacentNow — там же, где выбирается подмена или загрузка с нуля.
        if (!playAdjacentNow(1)) return
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
      stop: () => {
        diag('widget:stop', snapshotAudio(audioRef.current))
        audioRef.current?.pause()
        pendingAdvanceRef.current = false
        engine.releaseSession()
        if (usePlayerStore.getState().isPlaying) togglePlayPause()
      },
    }

    // Перемотка ±N секунд кнопками виджета. Регистрируем ТОЛЬКО не на iOS:
    // там Control Center, увидев seekbackward/seekforward, подменяет ими
    // кнопки предыдущего/следующего трека — то есть перемотка появляется
    // ценой пропуска треков. На iOS перемотка и так доступна: шкала виджета
    // работает через seekto (он зарегистрирован выше), а положение бегунка
    // питает setPositionState.
    if (!isIOS) {
      handlers.seekbackward = (details) => seekBy(-(details?.seekOffset || 10))
      handlers.seekforward = (details) => seekBy(details?.seekOffset || 10)
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
    // swapVersion — по той же причине: после подмены слушатель 'playing' нужен
    // на новом активном элементе, на старом он уже бесполезен.
  }, [currentTrack?.id, togglePlayPause, setCurrentTime, swapVersion])

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
    postRecommendationEvent(currentTrack, isLiked ? 'unlike' : 'like')
    invalidateFlowPreload()
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (id) await toggleTrackLike(id, currentTrack)
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
    const wasDislikedBeforeMaterialize = dbTrackId
      ? usePlayerStore.getState().dislikedTrackIds.includes(dbTrackId)
      : false
    postRecommendationEvent(
      currentTrack,
      wasDislikedBeforeMaterialize ? 'undislike' : 'dislike',
    )
    invalidateFlowPreload()
    try {
      const id = dbTrackId ?? (await materializeCurrentTrack())
      if (!id) return
      const wasDisliked = usePlayerStore.getState().dislikedTrackIds.includes(id)
      await toggleTrackDislike(id, currentTrack)
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
          setAudioSource({ trackId: trackAtError?.id ?? null, url: retryUrl.href })
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
  audioErrorRef.current = handleAudioError

  return (
    <div className="player">
      <PlayerProgress audioRef={audioRef} />
      {/* <audio> здесь больше нет: оба элемента живут в services/audioEngine,
          вне дерева React. Причина — не эстетика, а фон: React волен
          перемонтировать поддерево и перекоммитить атрибуты в любой момент, а
          коммит src перезапускает media load algorithm и убивает уже
          стартовавший play(). Пока элемент был в JSX, от этого спасались тем,
          что src ставили императивно; с двумя элементами (текущий + заряженный
          следующим треком) держать их в дереве стало нечем — их время жизни
          принципиально длиннее любого компонента. Слушатели навешиваются в
          эффектах выше и переезжают на новый элемент по swapVersion. */}
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
        {(canInteract || (isExternalTrack && currentTrack.download_allowed && currentTrack.download_url)) && (
          <div className="player-track-actions">
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
