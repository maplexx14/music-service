import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { useScreen } from '../hooks/useScreen'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './HeroDisc.css'

const DEG = 180 / Math.PI

// Перемотка во время вращения диска шлёт audio.currentTime, а это сетевой
// range-запрос: на каждый градус поворота потоковый источник перезапрашивал бы
// диапазон десятки раз за жест. 120мс — примерно 8 перемоток в секунду: звук
// успевает откликаться на палец, но поток не захлёбывается. Последняя позиция
// доезжает отдельным seek на отпускании, так что точность не теряется.
const SEEK_THROTTLE_MS = 120
// Поворот, с которого жест считается перемоткой, а не касанием: дрожь пальца
// при тапе даёт пару градусов.
const SEEK_MIN_DEG = 6

// Анимация вращения разошлась с позицией звука больше чем на столько —
// переставляем её. Меньше не трогаем: позиция в сторе приходит раз в секунду
// и сама по себе шумит на доли секунды.
const DRIFT_SEC = 0.5
// Позиция в сторе не менялась дольше этого при isPlaying — звук встал на
// буферизации, диск тоже останавливаем.
const STALL_SEC = 1.5

// Длительность: store-версию выставляет Player (для внешних источников он
// считает её точнее, чем audio.duration, — см. resolveTrackDuration). Метка
// трека из БД — фолбэк на первый кадр после смены трека.
function readDuration(state, track) {
  const fromStore = Number(state?.duration)
  if (fromStore > 0) return fromStore
  const fromTrack = Number(track?.duration)
  return fromTrack > 0 ? fromTrack : 0
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

// Диск-пластинка на фоне hero: обложка текущего трека, поворот завязан на
// позицию воспроизведения (полный оборот = весь трек), а сам диск можно
// крутить пальцем/мышью — поворот перематывает трек.
//
// Живёт отдельным компонентом, потому что подписан на currentTrack: главная
// (со всеми полками карточек) на смену трека не перерисовывается.
function HeroDisc() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const heavyCover = usePlayerStore(
    (s) => s.currentTrack?.id != null && s.heavyCoverTrackId === s.currentTrack.id
  )
  // duration — только для первичной отрисовки aria-атрибутов; в кадре
  // актуальное значение читается из getState(), чтобы не тащить подписку.
  const duration = usePlayerStore((s) => s.duration)
  const rootRef = useRef(null)
  // Главная скрыта (открыта другая вкладка) — вращение не крутим.
  const { active: screenActive } = useScreen()
  const coverRef = useRef(null)
  const dragRef = useRef(null)
  // Управление вращением для жеста: hold() останавливает анимацию и отдаёт
  // позицию, на которой диск стоит на экране; resume(сек) запускает её
  // с позиции, куда диск отпустили.
  const spinRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)

  const total = readDuration({ duration }, currentTrack)
  // Вращение перезапускается только на смене трека: стор заменяет объект
  // трека и посреди игры (уточнённые данные), а перезапуск берёт позицию из
  // стора, отстающую до секунды, — диск дёргался бы назад.
  const trackKey = currentTrack?.id ?? currentTrack

  // Вращение — Web Animation от текущего угла до полного оборота за остаток
  // трека. Её крутит композитор, а не главный поток: раньше угол писал
  // rAF-цикл в style.transform, и диск шёл ступеньками (шаг квантования,
  // перезапуск transition на каждом шаге) и замирал, когда главный поток
  // занят — свайпом, рендером экрана, разбором ответа. Главный поток только
  // сверяет анимацию с позицией звука, когда та приходит из стора (раз в
  // секунду), и переставляет её, если разошлись.
  useEffect(() => {
    if (!trackKey || !screenActive) return undefined
    const el = coverRef.current
    if (!el || typeof el.animate !== 'function') return undefined
    // prefers-reduced-motion: постоянное вращение — декор, его убираем.
    // Ручной поворот (жест) остаётся: это прямое управление, а не анимация.
    const reduced =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    let anim = null
    // Позиция (сек), с которой стартовала анимация, и длительность трека.
    let anchor = { time: 0, dur: 0 }
    // Когда позиция в сторе менялась в последний раз — для детекта буферизации.
    let lastTime = -1
    let lastTimeAt = performance.now()
    let stalled = false

    const start = (time, dur, playing) => {
      anim?.cancel()
      anim = null
      el.style.transform = `rotate(${clamp(time / dur, 0, 1) * 360}deg)`
      anchor = { time, dur }
      if (reduced) return
      const remaining = Math.max(0, dur - time)
      if (!(remaining > 0)) return
      anim = el.animate(
        [{ transform: el.style.transform }, { transform: 'rotate(360deg)' }],
        { duration: remaining * 1000, easing: 'linear', fill: 'forwards' },
      )
      if (!playing) anim.pause()
    }

    let wasPlaying = false

    const sync = (state, force = false) => {
      if (dragRef.current) return
      const dur = readDuration(state, state.currentTrack)
      if (!(dur > 0)) return
      const now = performance.now()
      // Свежая позиция — только когда она изменилась: стор обновляется раз в
      // секунду, и между обновлениями значение в нём отстаёт от звука до
      // секунды. Сверять с ним по таймеру нельзя — анимация откатывалась бы
      // назад на каждой проверке, и диск трясся на месте.
      const fresh = state.currentTime !== lastTime
      if (fresh) {
        lastTime = state.currentTime
        lastTimeAt = now
      }
      // Пуск после паузы: позиция придёт только через секунду — отсчёт
      // буферизации начинаем с пуска, а не с последнего обновления.
      if (state.isPlaying && !wasPlaying) lastTimeAt = now
      wasPlaying = state.isPlaying
      rootRef.current?.setAttribute('aria-valuenow', String(Math.floor(state.currentTime)))
      stalled = state.isPlaying && (now - lastTimeAt) / 1000 > STALL_SEC
      const playing = state.isPlaying && !stalled
      const implied = anchor.time + (Number(anim?.currentTime) || 0) / 1000
      if (force || (!anim && !reduced)) {
        start(state.currentTime, dur, playing)
        return
      }
      // Длительность уточнилась (поток догрузился) — тот же угол на экране,
      // новая скорость.
      if (Math.abs(dur - anchor.dur) > DRIFT_SEC) {
        start(Math.min(implied, dur), dur, playing)
        return
      }
      if (fresh && Math.abs(implied - state.currentTime) > DRIFT_SEC) {
        start(state.currentTime, dur, playing)
        return
      }
      if (!anim) return
      if (playing && anim.playState === 'paused') anim.play()
      else if (!playing && anim.playState === 'running') anim.pause()
    }

    spinRef.current = {
      hold: () => {
        const time = anchor.time + (Number(anim?.currentTime) || 0) / 1000
        anim?.cancel()
        anim = null
        if (anchor.dur > 0) el.style.transform = `rotate(${clamp(time / anchor.dur, 0, 1) * 360}deg)`
        return time
      },
      resume: (time) => {
        const state = usePlayerStore.getState()
        const dur = readDuration(state, state.currentTrack)
        if (!(dur > 0)) return
        lastTime = state.currentTime
        lastTimeAt = performance.now()
        wasPlaying = state.isPlaying
        stalled = false
        start(time, dur, state.isPlaying)
      },
    }

    sync(usePlayerStore.getState(), true)
    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (
        state.currentTime !== prev.currentTime ||
        state.isPlaying !== prev.isPlaying ||
        state.duration !== prev.duration
      ) {
        sync(state)
      }
    })
    // Буферизация: позиция в сторе стоит, событий нет — проверяем по таймеру.
    const stallTimer = setInterval(() => sync(usePlayerStore.getState()), 500)
    return () => {
      unsubscribe()
      clearInterval(stallTimer)
      spinRef.current = null
      anim?.cancel()
    }
  }, [trackKey, screenActive])

  // Угол указателя относительно центра диска. Центр берём у корня, а не у
  // картинки: картинка вращается, и её rect описывал бы повёрнутый квадрат.
  const angleAt = (clientX, clientY) => {
    const el = rootRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return (
      Math.atan2(
        clientY - (rect.top + rect.height / 2),
        clientX - (rect.left + rect.width / 2),
      ) * DEG
    )
  }

  const handlePointerDown = (e) => {
    if (e.button > 0) return
    const st = usePlayerStore.getState()
    const dur = readDuration(st, st.currentTrack)
    if (!(dur > 0)) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const angle = angleAt(e.clientX, e.clientY)
    // Палец подхватывает диск там, где он стоит на экране, а не по позиции
    // из стора: та приходит раз в секунду, и диск дёрнулся бы назад.
    const shown = spinRef.current?.hold() ?? st.currentTime
    const base = clamp(shown / dur, 0, 1)
    dragRef.current = {
      pointerId: e.pointerId,
      lastAngle: angle,
      base,
      accum: 0,
      progress: base,
      lastSeekAt: 0,
      turned: false,
    }
    setIsDragging(true)
  }

  const handlePointerMove = (e) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const st = usePlayerStore.getState()
    const dur = readDuration(st, st.currentTrack)
    if (!(dur > 0)) return

    const angle = angleAt(e.clientX, e.clientY)
    let delta = angle - drag.lastAngle
    // Переход через верх диска: 179° → -179° это поворот на 2°, а не на 358°
    // назад. Без нормализации диск в этом месте прыгал бы на пол-оборота.
    if (delta > 180) delta -= 360
    else if (delta < -180) delta += 360
    drag.lastAngle = angle

    // Клампим накопленный угол, а не готовый прогресс: иначе, докрутив до
    // конца трека и повернув обратно, диск «отлипал» бы от пальца, пока не
    // отыграет накопленный перекрут.
    drag.accum = clamp(drag.accum + delta, -drag.base * 360, (1 - drag.base) * 360)
    drag.progress = drag.base + drag.accum / 360
    // Во время жеста угол ведёт палец, а не анимация: перемотка применяется
    // с задержкой, и диск отставал бы от руки.
    if (coverRef.current) coverRef.current.style.transform = `rotate(${drag.progress * 360}deg)`

    if (Math.abs(drag.accum) >= SEEK_MIN_DEG) drag.turned = true
    if (!drag.turned) return
    const now = performance.now()
    if (now - drag.lastSeekAt >= SEEK_THROTTLE_MS) {
      drag.lastSeekAt = now
      st.seekTo(drag.progress * dur, 'disc')
    }
  }

  const finishDrag = (e) => {
    const drag = dragRef.current
    if (!drag || (e && e.pointerId !== drag.pointerId)) return
    dragRef.current = null
    setIsDragging(false)
    const st = usePlayerStore.getState()
    const dur = readDuration(st, st.currentTrack)
    if (!(dur > 0)) return
    // Тап без поворота и жест, который браузер забрал под прокрутку
    // (pointercancel), — не перемотка. Раньше и они перематывали на угол
    // диска: тот считается по анимации, а не по звуку, и случайное касание
    // главной прыгало по треку, после чего WebKit мог замолчать на потоке.
    if (!drag.turned || e?.type === 'pointercancel') {
      spinRef.current?.resume(st.currentTime)
      return
    }
    // Финальная перемотка — на отпускании, а не только по троттлингу: иначе
    // последние ~120мс жеста (самая точная его часть) терялись бы.
    st.seekTo(drag.progress * dur, 'disc')
    spinRef.current?.resume(drag.progress * dur)
  }

  // Клавиатура: диск — это слайдер перемотки, стрелки двигают позицию.
  const handleKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const st = usePlayerStore.getState()
    const dur = readDuration(st, st.currentTrack)
    if (!(dur > 0)) return
    e.preventDefault()
    const step = e.shiftKey ? 30 : 5
    st.seekTo(clamp(st.currentTime + (e.key === 'ArrowRight' ? step : -step), 0, dur), 'disc-key')
  }

  if (!currentTrack) return null

  return (
    <div
      ref={rootRef}
      className={`hero-disc${isDragging ? ' is-dragging' : ''}`}
      // Поворот диска — не pull-to-refresh: жест не должен тянуть обновление
      // главной, когда страница проскроллена в самый верх.
      data-no-pull=""
      role="slider"
      tabIndex={0}
      aria-label="Перемотка трека"
      aria-valuemin={0}
      aria-valuemax={Math.floor(total)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={handleKeyDown}
    >
      <img
        ref={coverRef}
        className="hero-disc-cover"
        // Диск крупный (до 520px), а обложки YouTube приходят 120×120 —
        // просим у CDN увеличенную версию, как полноэкранный плеер. Но только
        // после старта звука (heavyCoverTrackId): до него — card, иначе
        // крупная картинка качалась бы наперегонки с первыми байтами трека.
        src={resolveCoverUrl(currentTrack.cover_url, heavyCover ? 'full' : 'card') || defaultCover}
        alt=""
        draggable={false}
        decoding="async"
        onError={handleCoverError}
      />
    </div>
  )
}

export default HeroDisc
