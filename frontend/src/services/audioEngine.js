// Движок воспроизведения на ДВУХ <audio>-элементах.
//
// Зачем вообще второй элемент. Всё, что ломалось в фоне (выход из PWA,
// заблокированный экран), ломалось в один и тот же момент — на ПЕРЕХОДЕ между
// треками. Одноэлементная схема вынуждена на каждом переходе делать
// `src = ...; load(); play()`, то есть начинать НОВУЮ сетевую загрузку. В фоне
// это самое хрупкое действие из возможных:
//   • load() вне жеста рвёт аудиосессию, а с ней и виджет на экране блокировки;
//   • WebKit в фоне откладывает свежую загрузку (suspend) и может не начать её
//     вовсе — отсюда «трек переключился, обложка есть, часы идут, звука нет»;
//   • play() на «холодном» элементе вне жеста отвергается (NotAllowedError).
// Вся машинерия вокруг (isStalledStart / kickStalled / вотчдог / nudge-seek в
// Player.jsx) — это лечение симптомов именно этой болезни, вплоть до явной
// капитуляции `if (document.hidden) → показать паузу`.
//
// Второй элемент убирает причину: следующий трек догружается ЗАРАНЕЕ, пока
// первый ещё играет. На переходе сети не нужно ничего — нужно лишь позвать
// play() на элементе, у которого данные уже в буфере. Такой play() в фоне
// проходит: элемент «тёплый», аудиосессия не рвётся, load() не вызывается.
//
// Почему элементы живут в модуле, а не в JSX. React перемонтирует и
// перекоммитит что угодно в любой момент, а коммит атрибута src перезапускает
// media load algorithm и убивает уже стартовавший play() (об этом отдельный
// комментарий в Player.jsx — там src уже давно ставится императивно). Модульный
// синглтон снимает этот класс гонок целиком: элементы создаются один раз за
// сессию страницы и не зависят от жизненного цикла компонентов.
//
// Полоса пропускания — отдельная забота. Канал бывает узкий (~140 КБ/с через
// туннель), и качать два потока одновременно значит отобрать байты у играющего
// трека. Поэтому Player зовёт preload() не сразу, а когда текущий трек либо
// докачан целиком, либо вот-вот кончится (см. isFullyBuffered и вызов
// maybePreloadNext).

import { diag, snapshotAudio } from '../utils/playerDiag'

// Пустой (нулевой длины) WAV для «разблокировки» элемента жестом — см. unlock().
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA='

const isIOS =
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  typeof window !== 'undefined' &&
  !window.MSStream

// preload активного элемента: на iOS 'metadata' (исторически подобранное
// значение — не тянуть весь файл до play()), на остальных 'auto'. Заряжаемый
// (idle) элемент всегда 'auto': ему как раз и нужны байты вперёд.
const ACTIVE_PRELOAD = isIOS ? 'metadata' : 'auto'

function createSlot(label) {
  if (typeof Audio === 'undefined') return null
  const el = new Audio()
  el.preload = ACTIVE_PRELOAD
  el.playsInline = true
  // Атрибуты дублируют свойство: старые WebKit читают именно их.
  el.setAttribute('playsinline', '')
  el.setAttribute('webkit-playsinline', '')
  el.setAttribute('data-audio-slot', label)
  return el
}

const slots = [createSlot('a'), createSlot('b')]

let activeIndex = 0
let sharedVolume = 1
let mounted = false
let unlocked = false
let detachPreloadWatch = null

const swapListeners = new Set()
const idleReadyListeners = new Set()

function absolutize(url) {
  if (!url) return null
  try {
    return new URL(url, window.location.href).href
  } catch {
    return null
  }
}

// Короткий хвост URL для лога: полные ссылки на стрим длинные и однообразные,
// а в кольцевом логе диагностики важен каждый символ.
function shortUrl(url) {
  if (!url) return null
  return String(url).slice(-48)
}

export function getActive() {
  return slots[activeIndex]
}

export function getIdle() {
  return slots[1 - activeIndex]
}

// Элементы держим в DOM: часть версий WebKit отказывается отдавать звук
// оторванному от документа media-элементу, а <audio> без controls не занимает
// места и ничего не рисует.
export function mount() {
  if (mounted || typeof document === 'undefined') return
  mounted = true
  for (const el of slots) {
    if (el && !el.isConnected) document.body.appendChild(el)
  }
}

// Разблокировка второго элемента жестом. На iOS право играть выдаётся КАЖДОМУ
// media-элементу отдельно и только в контексте пользовательского жеста. Активный
// элемент получает его сам — первым настоящим play() по нажатию ▶. А вот тот, на
// который мы потом переключимся в фоне, к этому моменту не играл ни разу, и его
// play() из обработчика ended был бы первым — то есть отвергнутым.
//
// Лечится проигрыванием нулевой длины WAV внутри жеста: элемент «засчитывает»
// разрешение, звука при этом нет.
//
// Возвращает true, если попытка состоялась и её больше повторять не нужно.
// Отказ (промис play() отверг) НЕ считается финальным: право могли не выдать
// потому, что жест был «не тем» (скролл, тап по неинтерактивному месту), и
// следующий жест стоит попробовать снова — иначе одна неудачная попытка навсегда
// оставила бы второй элемент немым, а с ним и весь фоновый переход.
export function unlock() {
  if (unlocked) return true
  const idle = getIdle()
  if (!idle) return true
  // Занятый реальным треком элемент не трогаем — подмена src сорвала бы прогрев.
  // Это не отказ: элемент уже живёт своей жизнью, ждём следующего жеста.
  if (idle.src) return false

  const reset = () => {
    // Пока промис висел, элемент могли зарядить настоящим треком (preload).
    // Сбрасываем src ТОЛЬКО если он всё ещё наш тихий заглушечный.
    if (!idle.src || !idle.src.endsWith(SILENT_WAV.slice(-32))) return
    try {
      idle.pause()
      idle.removeAttribute('src')
      idle.load()
    } catch {
      /* noop */
    }
  }

  try {
    idle.src = SILENT_WAV
    const promise = idle.play()
    if (promise?.then) {
      promise.then(
        () => {
          unlocked = true
          diag('engine:unlock:ok', {})
          reset()
        },
        (error) => {
          diag('engine:unlock:fail', { name: error?.name })
          reset()
        },
      )
      // Промис ещё висит — исход узнаем позже. Слушатель жестов снимаем только
      // по факту успеха (см. ниже), поэтому здесь честно говорим «не готово».
      return false
    }
    unlocked = true
    reset()
    return true
  } catch {
    /* элемент не в том состоянии — фолбэк на одноэлементный путь */
    return false
  }
}

// Разблокировку вешаем на жесты страницы в фазе захвата: так она случается ДО
// обработчика клика по кнопке ▶, то есть внутри того же жеста. Слушатели
// снимаем не после первой попытки, а после первой УСПЕШНОЙ.
if (typeof document !== 'undefined') {
  const GESTURES = ['pointerdown', 'touchstart', 'keydown']
  const onGesture = () => {
    unlock()
    if (!unlocked) return
    for (const type of GESTURES) {
      document.removeEventListener(type, onGesture, { capture: true })
    }
  }
  for (const type of GESTURES) {
    document.addEventListener(type, onGesture, { capture: true })
  }
}

// Докачан ли элемент до конца: буфер покрывает длительность. Нужен в двух
// местах — решить, можно ли начинать прогрев следующего трека (не отбираем
// канал у играющего), и решить судьбу элемента после подмены (см. swapTo).
export function isFullyBuffered(el) {
  if (!el) return false
  const duration = el.duration
  if (!Number.isFinite(duration) || duration <= 0) return false
  const buffered = el.buffered
  if (!buffered || buffered.length === 0) return false
  return buffered.end(buffered.length - 1) >= duration - 1
}

function release(el) {
  if (!el) return
  try {
    el.pause()
    el.removeAttribute('src')
    el.load()
  } catch {
    /* noop */
  }
}

function watchPreload(el, abs) {
  detachPreloadWatch?.()
  const stop = () => {
    el.removeEventListener('canplay', onCanPlay)
    el.removeEventListener('error', onError)
    if (detachPreloadWatch === stop) detachPreloadWatch = null
  }
  const onCanPlay = () => {
    diag('preload:ready', { url: shortUrl(abs), rs: el.readyState })
    stop()
    // Готовность заряженного элемента — это и есть настоящий сигнал «следующий
    // трек можно включать мгновенно»: он снимает гейт кнопки/виджета «вперёд».
    idleReadyListeners.forEach((cb) => {
      try {
        cb()
      } catch {
        /* noop */
      }
    })
  }
  const onError = () => {
    diag('preload:error', { url: shortUrl(abs), code: el.error?.code })
    stop()
    // Прогрев не удался — оставляем элемент заряженным, но без данных: isReady
    // вернёт false (readyState не дорос), и переход честно уйдёт на медленный
    // путь со своей загрузкой и своими ретраями вместо ожидания буфера,
    // которого не будет.
  }
  detachPreloadWatch = stop
  el.addEventListener('canplay', onCanPlay)
  el.addEventListener('error', onError)
}

// Заряжает свободный элемент указанным URL и начинает тянуть байты.
// Идемпотентно: повторный вызов с тем же URL ничего не перезапускает.
export function preload(url) {
  const abs = absolutize(url)
  const idle = getIdle()
  if (!abs || !idle) return false
  if (idle.src === abs) return true
  idle.preload = 'auto'
  idle.volume = sharedVolume
  idle.src = abs
  watchPreload(idle, abs)
  try {
    // iOS без явного load() загрузку может не начать вовсе.
    idle.load()
  } catch {
    /* noop */
  }
  diag('preload:start', { url: shortUrl(abs) })
  return true
}

// Заряжен ли свободный элемент этим URL (независимо от готовности данных) —
// защита от повторного прогрева того же трека.
export function hasPrimedSrc(url) {
  const abs = absolutize(url)
  const idle = getIdle()
  return Boolean(abs && idle && idle.src === abs)
}

// Готов ли свободный элемент играть этот URL прямо сейчас, без обращения к
// сети. HAVE_FUTURE_DATA (3), а не HAVE_CURRENT_DATA (2): нужен не «первый
// кадр», а возможность играть дальше — иначе подмена приведёт к мгновенному
// waiting, что в фоне равно тишине.
export function isReady(url) {
  const abs = absolutize(url)
  const idle = getIdle()
  if (!abs || !idle || idle.src !== abs) return false
  return idle.readyState >= idle.HAVE_FUTURE_DATA
}

// Подмена активного элемента на заряженный. Возвращает элемент, который зовущей
// стороне остаётся только play() — СИНХРОННО, в том же жесте (ended / кнопка
// виджета). Возвращает null, если заряженного буфера нет: тогда вызывающий код
// идёт старым путём (src + load + play на активном элементе).
export function swapTo(url) {
  const abs = absolutize(url)
  const idle = getIdle()
  if (!abs || !idle || idle.src !== abs) return null
  if (idle.readyState < idle.HAVE_CURRENT_DATA) return null

  const previous = getActive()
  activeIndex = 1 - activeIndex
  detachPreloadWatch?.()

  if (previous) {
    try {
      previous.pause()
    } catch {
      /* noop */
    }
    // Недокачанный элемент продолжал бы тянуть байты и отбирать канал у только
    // что стартовавшего трека — на узком туннеле это слышно как запинки.
    // Докачанный оставляем: сеть он больше не занимает, зато остаётся заряженным
    // на «предыдущий трек» — кнопка ◀ виджета тоже сработает без загрузки.
    if (!isFullyBuffered(previous)) release(previous)
  }

  idle.preload = ACTIVE_PRELOAD
  idle.volume = sharedVolume
  // Свежепрогретый элемент стоит на нуле, и трогать его позицию не нужно —
  // seek по только что открытому потоку WebKit переживает плохо (перезапрос
  // диапазона, залипание в seeking). А вот элемент, оставленный «на предыдущий
  // трек», доиграл до конца: без сброса позиции play() на нём мгновенно
  // выстрелил бы ended и перещёлкнул трек дальше. Сбрасываем только его —
  // он заведомо докачан целиком (иначе его бы освободили), так что перемотка
  // локальная, без обращения к сети.
  if (idle.currentTime > 0) {
    try {
      idle.currentTime = 0
    } catch {
      /* элемент в несовместимом состоянии — стартуем как есть */
    }
  }
  diag('engine:swap', { url: shortUrl(abs), ...snapshotAudio(idle) })
  swapListeners.forEach((cb) => {
    try {
      cb()
    } catch {
      /* noop */
    }
  })
  return idle
}

// Подписка на подмену активного элемента: Player по ней перевешивает
// слушатели событий на новый элемент. Возвращает функцию отписки.
export function onSwap(cb) {
  swapListeners.add(cb)
  return () => swapListeners.delete(cb)
}

// Подписка на «заряженный элемент догрузился» — снимает гейт скипа вперёд.
export function onIdleReady(cb) {
  idleReadyListeners.add(cb)
  return () => idleReadyListeners.delete(cb)
}

// Громкость держим общей: после подмены новый активный элемент должен играть
// так же громко, как предыдущий.
export function setVolume(value) {
  sharedVolume = Math.max(0, Math.min(1, Number(value) || 0))
  for (const el of slots) {
    if (el) el.volume = sharedVolume
  }
}

// Сброс прогрева, который перестал быть актуальным: очередь сменилась и
// заряженный трек не является ни следующим, ни предыдущим. Важно не «на
// будущее», а прямо сейчас — заряженный элемент может всё ещё тянуть байты, а
// на узком канале это отбирает полосу у играющего трека ради потока, который
// никто не услышит.
//
// keepUrls — URL-ы, ради которых элемент стоит сохранить. Их два, потому что
// оставшийся от прошлого трека буфер делает мгновенной кнопку ◀: сразу после
// перехода новый трек ещё не докачан и до его конца далеко, так что прогрев
// следующего всё равно не стартует — слот в это время простаивает, и пусть уж
// он простаивает заряженным.
export function clearStalePreload(keepUrls) {
  const idle = getIdle()
  if (!idle?.src) return
  const keep = (Array.isArray(keepUrls) ? keepUrls : [keepUrls])
    .map(absolutize)
    .filter(Boolean)
  if (keep.includes(idle.src)) return
  diag('preload:drop', { url: shortUrl(idle.src) })
  detachPreloadWatch?.()
  release(idle)
}
