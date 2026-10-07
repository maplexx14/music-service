import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ChevronDown, Download, SkipBack, SkipForward, Play, Pause, Shuffle, Repeat1, ThumbsDown, AlignLeft, Share } from 'lucide-react'
import LikeHeart from './LikeHeart'
import {
  invalidateFlowPreload,
  postRecommendationEvent,
  trackLikeKey,
  usePlayerStore,
} from '../store/playerStore'
import { useLyrics } from '../hooks/useLyrics'
import { useThemeColor } from '../hooks/useThemeColor'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { haptic, HAPTIC } from '../utils/haptics'
import { skipForward } from '../services/playerTransport'
import { beginCloseMorph, isCoverMorphActive, subscribeCoverMorph } from '../utils/coverMorph'
import { getActive } from '../services/audioEngine'
import { holdHeavyAnimations, morphTransition } from '../services/navigation'
import LyricsPanel from './LyricsPanel'
import ArtistLink from './ArtistLink'
import './FullScreenPlayer.css'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Зазор между обложками в карусели, px. Тот же шаг задаёт CSS через
// --art-gap (ставится инлайном), чтобы JS и вёрстка не разъехались.
const ART_GAP = 24
// Второй тап по обложке в пределах этого окна — лайк.
const DOUBLE_TAP_MS = 300
const SETTLE_MS = 340

// Карусель доезжает из `from` (px) в ноль. Сначала без перехода ставим
// стартовую позицию и форсируем раскладку — иначе браузер склеит два
// присваивания transform и анимации не будет.
function settleStrip(strip, from) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  strip.style.transition = 'none'
  strip.style.transform = from && !reduced ? `translateX(${from}px)` : ''
  if (!from || reduced) return
  strip.getBoundingClientRect()
  strip.style.transition = `transform ${SETTLE_MS}ms var(--ease-out)`
  strip.style.transform = ''
}

// Сердце логотипа поверх обложки при лайке — тот же LikeHeart, что в
// кнопке лайка, с той же анимацией (полоса по мазку, заливка, молния), только
// крупно. Обёртка всплывает и гаснет (CSS), сердце внутри анимирует себя само.
//
// Убирается по таймеру длиной в CSS-анимацию, а не по animationend: в
// облегчённом режиме и при «Уменьшении движения» анимации выключены,
// события нет — и сердце оставалось на обложке навсегда.
const BURST_MS = 1300

function LikeBurst({ onDone }) {
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), BURST_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fullscreen-like-burst" aria-hidden="true">
      <LikeHeart liked burst size={190} />
    </div>
  )
}

// Ползунок — правый край обёртки во всю ширину полосы, сдвинутой на
// (ratio − 1) своей ширины: тот же композитинг, что у scaleX заливки.
function thumbTransform(ratio) {
  return `translateX(${(ratio - 1) * 100}%)`
}

// Прогресс-блок вынесен в отдельный компонент: только он подписан на
// currentTime. Остальной полноэкранный плеер (обложка, кнопки, жесты) не
// перерисовывается на каждом тике воспроизведения.
//
// Store тикает раз в секунду (троттлинг timeupdate в Player), и полоса,
// нарисованная по нему, прыгала секундными шагами. Пока играет, двигаем её
// каждый кадр прямо из <audio> (как мини-плеер) — через transform: scaleX,
// это только композитинг, без раскладки и перерисовки.
function FullScreenProgress() {
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const seekTo = usePlayerStore((s) => s.seekTo)
  const fillRef = useRef(null)
  const thumbRef = useRef(null)
  // Протяжка ползунка: доля под пальцем, пока он не отпущен. Перематываем
  // один раз, на отпускании, — серия перемоток по потоку в WebKit залипает
  // в seeking (см. kickStalled в Player).
  const dragRef = useRef(null)
  const [dragRatio, setDragRatio] = useState(null)

  const playedRatio = duration ? Math.min(1, currentTime / duration) : 0
  const ratio = dragRatio ?? playedRatio

  useEffect(() => {
    if (!isPlaying || !(duration > 0)) return undefined
    let raf
    const tick = () => {
      const audio = getActive()
      if (audio && fillRef.current && !dragRef.current) {
        const r = Math.min(1, audio.currentTime / duration)
        fillRef.current.style.transform = `scaleX(${r})`
        if (thumbRef.current) thumbRef.current.style.transform = thumbTransform(r)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, duration])

  const ratioAt = (e, rect) => Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))

  const handlePointerDown = (e) => {
    if (!duration || e.button > 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    dragRef.current = { pointerId: e.pointerId, rect }
    setDragRatio(ratioAt(e, rect))
  }

  const handlePointerMove = (e) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    setDragRatio(ratioAt(e, drag.rect))
  }

  const finishDrag = (e) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    const next = ratioAt(e, drag.rect)
    setDragRatio(null)
    // Касание отобрала система — позицию не трогаем.
    if (e.type === 'pointercancel' || !duration) return
    seekTo(next * duration, 'fullscreen-bar')
  }

  return (
    <div className="fullscreen-progress">
      <div
        className={`fullscreen-progress-bar${dragRatio != null ? ' is-dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        role="slider"
        aria-label="Перемотка"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration || 0)}
        aria-valuenow={Math.floor(currentTime || 0)}
      >
        <div className="fullscreen-progress-track">
          <div ref={fillRef} className="fullscreen-progress-fill" style={{ transform: `scaleX(${ratio})` }} />
        </div>
        <div ref={thumbRef} className="fullscreen-progress-thumb" style={{ transform: thumbTransform(ratio) }} />
      </div>
      <div className="fullscreen-progress-time">
        <span>{formatTime(dragRatio != null ? dragRatio * duration : currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>

    </div>
  )
}

function FullScreenPlayer() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const previousTrack = usePlayerStore((s) => s.previousTrack)
  const nextTrack = usePlayerStore((s) => s.nextTrack)
  const closeFullScreen = usePlayerStore((s) => s.closeFullScreen)
  const isRepeatOne = usePlayerStore((s) => s.isRepeatOne)
  const isShuffle = usePlayerStore((s) => s.isShuffle)
  const toggleRepeatOne = usePlayerStore((s) => s.toggleRepeatOne)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const dislikedTrackIds = usePlayerStore((s) => s.dislikedTrackIds)
  const fetchDislikedTracks = usePlayerStore((s) => s.fetchDislikedTracks)
  const toggleTrackDislike = usePlayerStore((s) => s.toggleTrackDislike)
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)
  const materializeCurrentTrack = usePlayerStore((s) => s.materializeCurrentTrack)
  const karaokeMode = usePlayerStore((s) => s.karaokeMode)
  const prevTrack = usePlayerStore((s) => s.getPrevTrack())
  const upNext = usePlayerStore((s) => s.getNextTrack(1))
  const [loadingLike, setLoadingLike] = useState(false)
  const [loadingDislike, setLoadingDislike] = useState(false)
  // Свайп вниз двигает плеер напрямую через style, без стейта: setState на
  // каждый touchmove перерисовывал весь плеер каждый кадр жеста.
  const playerRef = useRef(null)
  const [isClosing, setIsClosing] = useState(false)
  // Обложка скрыта, пока летит её морф-клон (мини-плеер ⇄ фуллскрин) —
  // иначе под клоном была бы вторая картинка.
  const [coverHidden, setCoverHidden] = useState(isCoverMorphActive)
  const [lyricsMode, setLyricsMode] = useState(false)
  const gestureRef = useRef(null)
  const stripRef = useRef(null)
  // Смещение карусели в момент, когда свайп переключил трек: с него новая
  // обложка доезжает на место (см. эффект на смену трека).
  const swipeDxRef = useRef(0)
  const lastSlidesRef = useRef(null)
  const lastTapRef = useRef(0)
  const [burst, setBurst] = useState(0)
  // Обложка переезжает влево и уменьшается, текст проявляется справа —
  // одним морфом, а не скачком раскладки (см. morphTransition).
  // artReturn — обложка вернулась после текста: на телефоне она проявляется
  // (класс was-compact), но не при открытии плеера, где летит морф обложки.
  const [artReturn, setArtReturn] = useState(false)
  const toggleLyrics = () =>
    morphTransition('lyrics', () =>
      flushSync(() => {
        setArtReturn(lyricsMode)
        setLyricsMode(!lyricsMode)
      }),
    )

  // Keep the initial layout in sync with the way fullscreen was opened.
  // Karaoke mode always starts with lyrics; a plain cover click always resets them.
  useEffect(() => {
    setLyricsMode(Boolean(karaokeMode))
  }, [karaokeMode])

  const { syncedLines, plainText, loading: lyricsLoading } = useLyrics(currentTrack)
  const hasLyrics = syncedLines.length > 0 || plainText.length > 0

  const coverUrl = useMemo(
    () => resolveCoverUrl(currentTrack?.cover_url, true) || defaultCover,
    [currentTrack?.cover_url],
  )

  // Фон плеера и статус-бар Android — в приглушённый цвет обложки.
  // Средний цвет — по миниатюре: цвет тот же, а hi-res 1000×1000 drawImage
  // декодировал бы синхронно в главном потоке — замер на iPhone 13 ловил
  // кадры по 200–280 мс на каждой смене трека в открытом плеере.
  const tint = useThemeColor(
    true,
    resolveCoverUrl(currentTrack?.cover_url, 'thumb') || coverUrl,
  )

  // Смена трека — карусель доезжает: обложка, что была соседом справа
  // (вперёд) или слева (назад), уже стоит в центре, а полосу сдвигаем туда,
  // где эта обложка была на экране, и отпускаем в ноль. Переключение
  // кнопками — тот же сдвиг на шаг, свайпом — от точки, где отпустил палец.
  useLayoutEffect(() => {
    const strip = stripRef.current
    const last = lastSlidesRef.current
    const dx = swipeDxRef.current
    swipeDxRef.current = 0
    if (!strip || !last || last.id === currentTrack?.id) return
    const id = currentTrack?.id
    const dir = id === last.nextId ? 1 : id === last.prevId ? -1 : 0
    settleStrip(strip, dir ? dx + dir * (strip.offsetWidth + ART_GAP) : 0)
  }, [currentTrack?.id])

  // Соседи на момент последнего рендера — по ним эффект выше узнаёт
  // направление. Идёт после него: тот читает ещё прошлые значения.
  useLayoutEffect(() => {
    lastSlidesRef.current = { id: currentTrack?.id, prevId: prevTrack?.id, nextId: upNext?.id }
  })

  // Закрытие — чистый CSS-drawer (.is-closing уезжает вниз, страница под
  // ним живая), обложка морфится обратно в мини-плеер клоном поверх слайда
  // (FLIP, без View Transitions — на iOS PWA VT-снапшоты затемняли экран).
  const startClose = () => {
    if (isClosing) return
    setIsClosing(true)
    beginCloseMorph()
    setTimeout(closeFullScreen, 350)
  }

  useEffect(() => subscribeCoverMorph((count) => setCoverHidden(count > 0)), [])

  // Плеер непрозрачен и закрывает экран целиком: WebGL-фон главной под ним
  // не виден, но рисовал 30 кадров/с всё время, пока плеер открыт.
  useEffect(() => holdHeavyAnimations(), [])

  // Пока фуллскрин открыт, страница под ним не прокручивается вовсе —
  // ни тачем, ни колесом, ни клавиатурой. Классический симптом «тяну
  // плеер вниз, а позади ползёт главная» — это скролл документа за
  // fixed-оверлеем.
  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const prevHtml = root.style.overflow
    const prevBody = body.style.overflow
    root.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => {
      root.style.overflow = prevHtml
      body.style.overflow = prevBody
    }
  }, [])

  // Тач по плееру не должен скроллить ничего, кроме текстов песни
  // (они прокручиваются намеренно, см. touch-action: pan-y у
  // .fullscreen-lyrics-mobile). preventDefault обязан идти через
  // НЕпассивный листener — синтетические onTouchMove React пассивны,
  // и preventDefault в них не работает.
  useEffect(() => {
    const SCROLLABLE = '.fullscreen-lyrics-mobile, .fullscreen-lyrics-desktop, .lyrics-panel'
    let inScrollable = false
    const onStart = (e) => {
      inScrollable = Boolean(e.target.closest?.(SCROLLABLE))
    }
    const onMove = (e) => {
      if (!inScrollable && e.target.closest?.('.fullscreen-player')) e.preventDefault()
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
    }
  }, [])

  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return
    // Протяжка ползунка перемотки — не свайп карусели и не закрытие плеера.
    if (e.target.closest?.('[role="slider"]')) {
      gestureRef.current = null
      return
    }
    const t = e.touches[0]
    gestureRef.current = { x: t.clientX, y: t.clientY, axis: null, t0: performance.now() }
  }

  const handleTouchMove = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (!g.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (g.axis === 'y' && playerRef.current) {
      const st = playerRef.current.style
      st.transition = 'none'
      st.transform = dy > 0 ? `translateY(${dy}px)` : ''
    }
    // Горизонтальный свайп тащит карусель за пальцем; если соседа в эту
    // сторону нет — с сопротивлением.
    if (g.axis === 'x' && stripRef.current) {
      const hasNeighbor = dx < 0 ? upNext : prevTrack
      const x = hasNeighbor ? dx : dx * 0.3
      stripRef.current.style.transition = 'none'
      stripRef.current.style.transform = `translateX(${x}px)`
      g.dx = x
    }
  }

  const handleTouchEnd = (e) => {
    const g = gestureRef.current
    if (!g) return
    const t = e.changedTouches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    const elapsed = performance.now() - g.t0
    gestureRef.current = null
    if (g.axis === 'x') {
      const strip = stripRef.current
      const fast = Math.abs(dx) > 30 && Math.abs(dx) / elapsed > 0.5
      const hasNeighbor = dx < 0 ? upNext : prevTrack
      if (!hasNeighbor || (Math.abs(dx) < 60 && !fast)) {
        if (strip) settleStrip(strip, g.dx || 0)
        return
      }
      haptic(HAPTIC.selection)
      const fromId = currentTrack.id
      swipeDxRef.current = g.dx || 0
      if (dx < 0) handleSkipForward()
      else previousTrack()
      // Переход могли отложить (следующий трек ещё грузится) — тогда
      // обложка возвращается на место.
      if (usePlayerStore.getState().currentTrack?.id === fromId) {
        swipeDxRef.current = 0
        if (strip) settleStrip(strip, g.dx || 0)
      }
    } else if (g.axis === 'y' && (dy >= 120 || (dy > 30 && dy / elapsed > 0.11))) {
      haptic(HAPTIC.light)
      // Морф обложки меряет её на текущей, оттянутой позиции — поэтому сначала
      // startClose, потом снимаем инлайновый сдвиг. Класс .is-closing приходит
      // в том же кадре, и переход едет вниз от точки, где отпустил палец.
      startClose()
      releaseDrag()
    } else if (g.axis === 'y') {
      releaseDrag()
    }
  }

  // Инлайн-стили жеста снимаются — CSS-переход плеера возвращает его на место
  // (или увозит вниз под .is-closing).
  const releaseDrag = () => {
    const st = playerRef.current?.style
    if (!st) return
    st.transition = ''
    st.transform = ''
  }

  const handleTouchCancel = () => {
    const g = gestureRef.current
    gestureRef.current = null
    if (g?.axis === 'y') releaseDrag()
    if (g?.axis === 'x' && stripRef.current) settleStrip(stripRef.current, g.dx || 0)
  }

  const isExternalTrack = ['jamendo', 'soulseek', 'ytmusic', 'soundcloud'].includes(currentTrack?.source)
  const dbTrackId =
    currentTrack?.db_id ?? (typeof currentTrack?.id === 'number' ? currentTrack.id : null)
  const canInteract = dbTrackId !== null || Boolean(currentTrack?.source)

  // Переключение идёт через Player (services/playerTransport): только он умеет
  // подменить элемент на прогретый буфер следующего трека, а заодно дотягивает
  // хвост постраничной очереди (queuePager). Прямой nextTrack() — лишь фолбэк.
  const handleSkipForward = () => skipForward(nextTrack)

  useEffect(() => {
    const checkLikedStatus = async () => {
      if (!dbTrackId) return
      try {
        await fetchLikedTracks()
        await fetchDislikedTracks()
      } catch (error) {
        console.error('Error checking liked status:', error)
      }
    }

    checkLikedStatus()
  }, [dbTrackId, fetchLikedTracks, fetchDislikedTracks])

  if (!currentTrack) return null

  const handleLike = async () => {
    if (!canInteract || loadingLike) return

    if (!isLiked) setBurst((n) => n + 1)
    setLoadingLike(true)
    haptic(HAPTIC.success)
    postRecommendationEvent(currentTrack, isLiked ? 'unlike' : 'like')
    invalidateFlowPreload()
    try {
      // Внешний трек материализуется внутри — сердечко зальётся сразу
      // через pendingLikeKeys, не дожидаясь сети.
      await toggleLikeForTrack(currentTrack)
    } catch (error) {
      console.error('Error toggling like:', error)
    } finally {
      setLoadingLike(false)
    }
  }

  // Дизлайк: помечаем и уходим на следующий трек (как в Player.jsx). Повторное
  // нажатие только снимает метку — пользователь мог передумать.
  const handleDislike = async () => {
    if (!canInteract || loadingDislike) return

    setLoadingDislike(true)
    // «Был ли дизлайк» решаем ДО сети: у трека без db_id метки быть не могло.
    // Дизлайкаемый трек фиксируем до переключения — nextTrack() меняет
    // currentTrack, а материализовать нужно именно СТАРЫЙ.
    const wasDislikedBefore = dbTrackId
      ? usePlayerStore.getState().dislikedTrackIds.includes(dbTrackId)
      : false
    const dislikedTrack = currentTrack
    postRecommendationEvent(currentTrack, isDisliked ? 'undislike' : 'dislike')
    invalidateFlowPreload()
    // Уход на следующий трек — сразу, не дожидаясь материализации и сети:
    // кнопка обязана отзываться мгновенно, сеть догонит в фоне.
    if (!wasDislikedBefore) handleSkipForward()
    try {
      const id = dbTrackId ?? (await materializeTrack(dislikedTrack))
      if (!id) return
      await toggleTrackDislike(id, dislikedTrack)
    } catch (error) {
      console.error('Error toggling dislike:', error)
    } finally {
      setLoadingDislike(false)
    }
  }

  // Сердечко залито, если трек в likedTrackIds, ЛИБО его лайк сейчас летит
  // (внешний трек до материализации: pendingLikeKeys).
  const isLiked =
    (dbTrackId ? likedTrackIds.includes(dbTrackId) : false) ||
    pendingLikeKeys.includes(trackLikeKey(currentTrack))
  const isDisliked = dbTrackId ? dislikedTrackIds.includes(dbTrackId) : false

  // Двойной тап по обложке — лайк, как в Instagram: только ставит, не
  // снимает. По уже лайкнутому треку сердце просто вспыхивает ещё раз.
  const handleArtTap = () => {
    const now = performance.now()
    if (now - lastTapRef.current > DOUBLE_TAP_MS) {
      lastTapRef.current = now
      return
    }
    lastTapRef.current = 0
    if (!canInteract) return
    if (isLiked) {
      haptic(HAPTIC.light)
      setBurst((n) => n + 1)
    } else {
      handleLike()
    }
  }

  // Ссылка на страницу трека (/track/:id). Системный «Поделиться», где он
  // есть (телефоны), иначе — ссылка в буфер.
  //
  // У внешнего трека id в БД ещё нет — материализуем. Это сеть, а Safari
  // пускает share()/clipboard только сразу после тапа: после ожидания он
  // откажет (NotAllowedError). Тогда просим нажать ещё раз — db_id уже
  // вшит в currentTrack, и второй тап пройдёт без сети.
  const handleShare = async () => {
    const track = currentTrack
    let id = dbTrackId
    const waited = !id
    if (!id) {
      try {
        id = await materializeCurrentTrack()
      } catch (error) {
        console.error('Error materializing track for share:', error)
      }
    }
    if (!id) {
      toast.error('Не удалось получить ссылку')
      return
    }
    const url = `${window.location.origin}/track/${id}`
    const text = [track.artist, track.title].filter(Boolean).join(' — ')
    const retry = () => toast.info('Ссылка готова — нажмите «Поделиться» ещё раз')
    if (navigator.share) {
      try {
        await navigator.share({ title: track.title, text, url })
      } catch (error) {
        // AbortError — пользователь закрыл шторку, это не ошибка.
        if (error?.name === 'NotAllowedError') retry()
      }
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Ссылка скопирована')
    } catch {
      if (waited) retry()
      else toast.error('Не удалось скопировать')
    }
  }

  // Соседние обложки карусели. Ключ — id трека: при переключении <img>
  // переезжает между слотами, а не перезагружается.
  const slides = [
    prevTrack && { track: prevTrack, slot: -1 },
    { track: currentTrack, slot: 0 },
    upNext && { track: upNext, slot: 1 },
  ]
    .filter(Boolean)
    .map((slide, i, all) => ({
      ...slide,
      // Один трек может стоять в очереди дважды — тогда ключ со слотом.
      key: all.some((other, j) => j !== i && other.track.id === slide.track.id)
        ? `${slide.track.id}:${slide.slot}`
        : String(slide.track.id),
    }))

  return (
    <div
      className={`fullscreen-player${isClosing ? ' is-closing' : ''}${lyricsMode ? ' has-lyrics' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      ref={playerRef}
      style={{
        '--fs-tint': tint || undefined,
        '--art-gap': `${ART_GAP}px`,
      }}
    >
      <div className="fullscreen-header">
        <button className="fullscreen-icon" onClick={startClose} aria-label="Закрыть">
          <ChevronDown size={22} />
        </button>
        <img className="fullscreen-logo" src="/logoBoltwo.webp" alt="Логотип" />
        <button type="button" className="fullscreen-icon" onClick={handleShare} aria-label="Поделиться">
          <Share size={20} />
        </button>
      </div>

      <div className="fullscreen-body">
        <div className="fullscreen-content">
          <div
            className={`fullscreen-art${lyricsMode ? ' compact' : ''}${artReturn ? ' was-compact' : ''}`}
            onClick={handleArtTap}
          >
            <div className="fullscreen-art-strip" ref={stripRef}>
              {slides.map(({ track, slot, key }) => {
                const thumb = resolveCoverUrl(track.cover_url, 'thumb')
                return (
                  <img
                    key={key}
                    className={slot ? 'fullscreen-art-side' : 'is-current'}
                    style={{
                      '--slot': slot,
                      visibility: coverHidden && !slot ? 'hidden' : undefined,
                      // Подложка — маленькая обложка из мини-плеера и списков,
                      // она уже в кэше. Полноразмерная идёт через прокси бэкенда
                      // и бывает в сотни КБ: пока она качается, вместо серого
                      // квадрата видна та же обложка, только мягче.
                      backgroundImage: thumb ? `url("${thumb}")` : undefined,
                    }}
                    // Соседям хватает маленькой: они едва видны по краям, а
                    // полноразмерные качались бы при каждой смене трека вместе
                    // со стартом звука. Полную обложка получает, став текущей,
                    // — до её загрузки браузер показывает прежнюю картинку.
                    src={slot ? thumb || defaultCover : coverUrl}
                    alt={slot ? '' : currentTrack.title}
                    aria-hidden={slot ? 'true' : undefined}
                    // Без проявления (services/imageFade): под картинкой уже
                    // лежит подложка-миниатюра, и фейд из нуля гасил бы её
                    // вместе с картинкой — обложка моргала при открытии.
                    data-no-fade=""
                    // Декодирование hi-res вне главного потока: синхронное
                    // при отрисовке замораживало кадр на смене трека.
                    decoding="async"
                    draggable={false}
                    onError={handleCoverError}
                  />
                )
              })}
            </div>
            {burst > 0 && <LikeBurst key={burst} onDone={() => setBurst(0)} />}
          </div>

          <div className="fullscreen-info">
            <div>
              <div className="fullscreen-track-name">{currentTrack.title}</div>
              <ArtistLink
                artist={currentTrack.artist}
                className="fullscreen-artist"
                onNavigate={closeFullScreen}
              />
            </div>
          </div>

          {/* Desktop: lyrics appear to the right of art+info */}
          {lyricsMode && (
            <div className="fullscreen-lyrics-desktop">
              <LyricsPanel />
            </div>
          )}
        </div>

        {/* Mobile: lyrics appear below info, above progress */}
        {lyricsMode && (
          <div className="fullscreen-lyrics-mobile">
            <LyricsPanel showOnlyText />
          </div>
        )}
      </div>

      <FullScreenProgress />

      <div className="fullscreen-controls">
        <button
          type="button"
          className={`fullscreen-icon fullscreen-dislike ${isDisliked ? 'active' : ''}`}
          onClick={handleDislike}
          disabled={!canInteract || loadingDislike}
          aria-pressed={isDisliked}
          aria-label={isDisliked ? 'Убрать отметку «не нравится»' : 'Не нравится'}
        >
          <ThumbsDown size={22} fill={isDisliked ? 'currentColor' : 'none'} />
        </button>
        {/* Перемотка и плей — одна капсула, как мини-плеер. */}
        <div className="fullscreen-transport">
          <button className="fullscreen-icon" onClick={previousTrack} aria-label="Назад">
            <SkipBack size={26} fill="currentColor" />
          </button>
          <button className="fullscreen-play" onClick={togglePlayPause} aria-label={isPlaying ? 'Пауза' : 'Играть'}>
            {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
          </button>
          <button className="fullscreen-icon" onClick={handleSkipForward} aria-label="Вперёд" title="Вперёд">
            <SkipForward size={26} fill="currentColor" />
          </button>
        </div>
        <button
          type="button"
          className={`fullscreen-icon fullscreen-like ${isLiked ? 'active' : ''}`}
          onClick={handleLike}
          disabled={!canInteract || loadingLike}
          aria-pressed={isLiked}
          aria-label={isLiked ? 'Убрать из понравившихся' : 'Добавить в понравившиеся'}
        >
          <LikeHeart size={24} liked={!!isLiked} />
        </button>
      </div>

      <div className="fullscreen-tools">
        <button
          type="button"
          className={`fullscreen-tool ${isRepeatOne ? 'active' : ''}`}
          onClick={toggleRepeatOne}
          aria-pressed={isRepeatOne}
          aria-label={isRepeatOne ? 'Выключить повтор трека' : 'Повторять трек'}
        >
          <Repeat1 size={22} />
        </button>
        <button
          type="button"
          className={`fullscreen-tool${lyricsMode ? ' active' : ''}`}
          onClick={toggleLyrics}
          disabled={!hasLyrics && !lyricsLoading}
          aria-pressed={lyricsMode}
          aria-label={lyricsMode ? 'Скрыть текст' : 'Показать текст'}
          title={hasLyrics ? undefined : 'Текст не найден'}
        >
          <AlignLeft size={22} />
        </button>
        {isExternalTrack && currentTrack.download_allowed && currentTrack.download_url && (
          <a
            className="fullscreen-tool"
            href={currentTrack.download_url}
            target="_blank"
            rel="noreferrer"
            aria-label="Скачать"
          >
            <Download size={22} />
          </a>
        )}
        <button
          type="button"
          className={`fullscreen-tool ${isShuffle ? 'active' : ''}`}
          onClick={toggleShuffle}
          aria-pressed={isShuffle}
          aria-label={isShuffle ? 'Выключить случайный порядок' : 'Случайный порядок'}
        >
          <Shuffle size={22} />
        </button>
      </div>

    </div>
  )
}

export default FullScreenPlayer



