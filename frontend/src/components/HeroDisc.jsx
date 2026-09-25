import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../store/playerStore'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './HeroDisc.css'

const DEG = 180 / Math.PI

// Позиция в сторе приходит раз в секунду (в Player это сознательный троттлинг
// timeupdate), поэтому между обновлениями угол доводится по часам. Потолок
// доводки чуть больше секунды: он ограничивает уход вперёд, когда на самом
// деле звук встал на буферизации.
const MAX_EXTRAPOLATION_SEC = 1.2

// Перемотка во время вращения диска шлёт audio.currentTime, а это сетевой
// range-запрос: на каждый градус поворота потоковый источник перезапрашивал бы
// диапазон десятки раз за жест. 120мс — примерно 8 перемоток в секунду: звук
// успевает откликаться на палец, но поток не захлёбывается. Последняя позиция
// доезжает отдельным seek на отпускании, так что точность не теряется.
const SEEK_THROTTLE_MS = 120

// Прогресс 0..1 в градусы: ровно один оборот за трек. Угол квантуем до 0.1° —
// за оборот это 3600 шагов, глазом неотличимо от плавного, но запись в
// style.transform идёт не 60 раз в секунду, а примерно втрое реже.
const ANGLE_STEPS = 3600

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
  // duration — только для первичной отрисовки aria-атрибутов; в кадре
  // актуальное значение читается из getState(), чтобы не тащить подписку.
  const duration = usePlayerStore((s) => s.duration)
  const rootRef = useRef(null)
  const coverRef = useRef(null)
  const dragRef = useRef(null)
  const lastAngleRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)

  const total = readDuration({ duration }, currentTrack)

  // Вращение. currentTime в сторе тикает раз в секунду (timeupdate через
  // троттлинг в Player). Вести угол от него через setState — значит и рывки
  // раз в секунду, и перерисовку главной на каждом тике. Поэтому угол считает
  // rAF-цикл: между тиками позиция доводится по часам, а результат пишется
  // прямо в style.transform. Пока трек на паузе, значение не меняется и записи
  // в DOM не происходит (сравнение с последним углом) — цикл в это время почти
  // бесплатный. rAF сам замирает в скрытой вкладке.
  useEffect(() => {
    if (!currentTrack) return undefined
    const reduced =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    let raf
    // Последняя пара «позиция из стора — момент, когда мы её увидели». По ней
    // оценивается позиция между тиками: без этого диск делал бы один шаг в
    // секунду, а на коротком треке шаг доходит до десятков градусов.
    let sample = { time: -1, at: 0 }

    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const st = usePlayerStore.getState()
      const dur = readDuration(st, st.currentTrack)
      const drag = dragRef.current

      let progress
      if (drag) {
        // Во время жеста позицию ведёт палец, а не audio: перемотка
        // применяется с задержкой, и диск отставал бы от руки.
        progress = drag.progress
      } else if (dur > 0) {
        if (st.currentTime !== sample.time) sample = { time: st.currentTime, at: now }
        // Между обновлениями позицию доводим по часам. Потолок в 1.2с — на
        // буферизации звук стоит, а часы идут: без него диск уезжал бы вперёд
        // и после возобновления прыгал назад.
        const ahead = Math.min((now - sample.at) / 1000, MAX_EXTRAPOLATION_SEC)
        const estimate = st.currentTime + (st.isPlaying ? ahead : 0)
        progress = clamp(estimate / dur, 0, 1)
      } else {
        return
      }

      const root = rootRef.current
      if (root && dur > 0) {
        root.setAttribute('aria-valuenow', String(Math.floor(progress * dur)))
      }
      // prefers-reduced-motion: постоянное вращение — декор, его убираем.
      // Ручной поворот (жест) остаётся: это прямое управление, а не анимация.
      if (reduced && !drag) return

      const el = coverRef.current
      if (!el) return
      const angle = Math.round(progress * ANGLE_STEPS) / (ANGLE_STEPS / 360)
      if (angle === lastAngleRef.current) return
      lastAngleRef.current = angle
      el.style.transform = `rotate(${angle}deg)`
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [currentTrack])

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
    const base = clamp(st.currentTime / dur, 0, 1)
    dragRef.current = {
      pointerId: e.pointerId,
      lastAngle: angle,
      base,
      accum: 0,
      progress: base,
      lastSeekAt: 0,
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

    const now = performance.now()
    if (now - drag.lastSeekAt >= SEEK_THROTTLE_MS) {
      drag.lastSeekAt = now
      st.seekTo(drag.progress * dur)
    }
  }

  const finishDrag = (e) => {
    const drag = dragRef.current
    if (!drag || (e && e.pointerId !== drag.pointerId)) return
    dragRef.current = null
    setIsDragging(false)
    // Финальная перемотка — на отпускании, а не только по троттлингу: иначе
    // последние ~120мс жеста (самая точная его часть) терялись бы.
    const st = usePlayerStore.getState()
    const dur = readDuration(st, st.currentTrack)
    if (dur > 0) st.seekTo(drag.progress * dur)
  }

  // Клавиатура: диск — это слайдер перемотки, стрелки двигают позицию.
  const handleKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const st = usePlayerStore.getState()
    const dur = readDuration(st, st.currentTrack)
    if (!(dur > 0)) return
    e.preventDefault()
    const step = e.shiftKey ? 30 : 5
    st.seekTo(clamp(st.currentTime + (e.key === 'ArrowRight' ? step : -step), 0, dur))
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
        // просим у CDN увеличенную версию, как полноэкранный плеер.
        src={resolveCoverUrl(currentTrack.cover_url, true) || defaultCover}
        alt=""
        draggable={false}
        decoding="async"
        onError={handleCoverError}
      />
    </div>
  )
}

export default HeroDisc
