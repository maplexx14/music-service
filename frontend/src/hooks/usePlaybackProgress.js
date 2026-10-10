import { useLayoutEffect, useRef } from 'react'
import { usePlayerStore } from '../store/playerStore'
import { getActive, getIdle, onSwap } from '../services/audioEngine'
import { PLAYBACK_ANIMATION_ID } from '../utils/frameMeter'

// Полоса прогресса, которую двигает композитор, а не главный поток.
//
// Раньше полосы мини- и полноэкранного плеера писали позицию из <audio> в
// style на каждом кадре (rAF), пока играет музыка, то есть почти всё время:
// главный поток просыпался 60 раз в секунду, а мини-плеер ещё и перекрашивал
// капсулу под backdrop-filter (градиент по CSS-переменной) ~10 раз в секунду.
// Полоса отнимала кадры у прокрутки и анимаций, а любая занятость главного
// потока (рендер экрана, событие медиаэлемента) её замораживала.
//
// Теперь это Web Animation от текущей позиции до конца трека за остаток
// времени, линейно, — её ведёт композитор, как вращение диска в HeroDisc.
// Главный поток только переставляет анимацию, когда звук меняет темп (пуск,
// пауза, буферизация, перемотка, смена трека или скорости — по событиям
// медиаэлементов и стора), и раз в секунду, на тике стора, сверяет её с
// позицией звука.
//
// targets — [{ ref, frame(ratio) → transform }]: элементы и их transform для
// доли трека 0..1. transform этих элементов ведёт только хук: инлайновый
// style с transform от React перебивал бы его. stepped — без анимации,
// позиция только по тикам стора (облегчённый режим и рендер без GPU, где
// композитинг каждого кадра тоже ложится на процессор).
//
// Возвращает ref с hold()/release(): пока полосу тянут пальцем, её ведёт
// жест, а не звук.

// Расхождение анимации со звуком, после которого её переставляем. Меньше не
// трогаем: каждая перестановка — новая анимация.
const DRIFT_SEC = 0.25
const MEDIA_EVENTS = [
  'playing',
  'pause',
  'waiting',
  'seeking',
  'seeked',
  'ratechange',
  'emptied',
  'durationchange',
  'ended',
]

const clamp01 = (value) => Math.min(1, Math.max(0, value))

export function usePlaybackProgress(targets, { stepped = false } = {}) {
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  const controlRef = useRef({ hold() {}, release() {} })

  // Layout-эффект: первая позиция — до первой отрисовки, без кадра с пустой
  // или полной полосой.
  useLayoutEffect(() => {
    let anims = []
    // С какой позиции (сек) и в каком темпе стартовала текущая анимация.
    let anchor = { time: 0, dur: 0, rate: 1, running: false }
    let held = false

    const place = (ratio) => {
      for (const { ref, frame } of targetsRef.current) {
        if (ref.current) ref.current.style.transform = frame(ratio)
      }
    }
    const cancel = () => {
      for (const anim of anims) anim.cancel()
      anims = []
    }
    // Позиция, которую полоса показывает сейчас.
    const shown = () => {
      const elapsed = anims.length ? (Number(anims[0].currentTime) || 0) / 1000 : 0
      return anchor.time + elapsed * anchor.rate
    }

    const start = (time, dur, running, rate) => {
      cancel()
      const ratio = clamp01(time / dur)
      // Инлайновая позиция — под анимацией: на ней полоса и останется, если
      // анимацию отменят или она не запустится.
      place(ratio)
      anchor = { time, dur, rate, running }
      if (!running || stepped) return
      const remaining = (dur - time) / rate
      if (!(remaining > 0)) return
      for (const { ref, frame } of targetsRef.current) {
        const el = ref.current
        if (!el || typeof el.animate !== 'function') continue
        const anim = el.animate([{ transform: frame(ratio) }, { transform: frame(1) }], {
          duration: remaining * 1000,
          easing: 'linear',
          fill: 'forwards',
        })
        anim.id = PLAYBACK_ANIMATION_ID
        anims.push(anim)
      }
    }

    const read = () => {
      const state = usePlayerStore.getState()
      const dur = Number(state.duration)
      // Перемотка заказана, но Player ещё не применил её к элементу: полоса
      // сразу встаёт на цель, а не ждёт события seeking.
      if (state.seekRequest) return { time: state.seekRequest.time, dur, running: false, rate: 1 }
      const audio = getActive()
      if (!audio) return { time: Number(state.currentTime) || 0, dur, running: false, rate: 1 }
      const time = audio.currentTime
      // Время звука ушло вперёд от стоящей полосы — значит, играет, даже если
      // readyState по какой-то причине не дотянулся до HAVE_FUTURE_DATA.
      const advancing = !anchor.running && time - anchor.time > DRIFT_SEC
      const running =
        state.isPlaying &&
        !audio.paused &&
        !audio.seeking &&
        (audio.readyState >= 3 || advancing)
      return { time, dur, running, rate: audio.playbackRate || 1 }
    }

    const sync = (force = false) => {
      if (held) return
      const { time, dur, running, rate } = read()
      if (!(dur > 0) || !Number.isFinite(time)) {
        cancel()
        anchor = { time: 0, dur: 0, rate: 1, running: false }
        place(0)
        return
      }
      if (
        force ||
        running !== anchor.running ||
        dur !== anchor.dur ||
        rate !== anchor.rate ||
        Math.abs(shown() - time) > DRIFT_SEC
      ) {
        start(time, dur, running, rate)
      }
    }

    controlRef.current = {
      hold: () => {
        if (held) return
        const ratio = anchor.dur > 0 ? clamp01(shown() / anchor.dur) : 0
        held = true
        cancel()
        place(ratio)
      },
      release: () => {
        if (!held) return
        held = false
        sync(true)
      },
    }

    sync(true)

    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (
        state.currentTime !== prev.currentTime ||
        state.isPlaying !== prev.isPlaying ||
        state.duration !== prev.duration ||
        state.seekRequest !== prev.seekRequest ||
        state.currentTrack !== prev.currentTrack
      ) {
        sync()
      }
    })

    // Оба слота движка живут всю сессию; события неактивного (прогрев
    // следующего трека) полосу не касаются.
    const slots = [getActive(), getIdle()].filter(Boolean)
    const onMedia = (event) => {
      if (event.target === getActive()) sync()
    }
    for (const el of slots) {
      for (const type of MEDIA_EVENTS) el.addEventListener(type, onMedia)
    }
    // Подмена активного элемента (engine.swapTo) событий на нём может и не
    // дать: src выставлен заранее, при прогреве.
    const offSwap = onSwap(() => sync())
    // В фоне анимация и звук могли разойтись (iOS приостанавливает страницу).
    const onVisible = () => {
      if (!document.hidden) sync(true)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      unsubscribe()
      for (const el of slots) {
        for (const type of MEDIA_EVENTS) el.removeEventListener(type, onMedia)
      }
      offSwap()
      document.removeEventListener('visibilitychange', onVisible)
      cancel()
      controlRef.current = { hold() {}, release() {} }
    }
  }, [stepped])

  return controlRef
}
