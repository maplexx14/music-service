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

// Короткий зацикливаемый WAV с тишиной. Собираем байтами, а не base64-строкой:
// строка была бы непрозрачным блобом, в котором не видно ни частоты, ни того,
// что тишина в 8-битном PCM кодируется значением 128, а не нулём (нули дали бы
// постоянное смещение — щелчок на старте и стопе).
//
// Две роли:
//   • разблокировка элемента жестом (см. unlock);
//   • «мост» аудиосессии на время, пока играть нечего (см. holdSession).
// Для обеих нужна ненулевая длительность: нулевой WAV кончается в тот же тик,
// и с ним элемент не успевает ни получить разрешение, ни удержать сессию.
function makeSilenceUrl() {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined') return null
  const sampleRate = 8000
  const samples = sampleRate / 4 // 0.25 с
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // размер fmt-блока
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // моно
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true) // байт/с = rate * channels * bytes
  view.setUint16(32, 1, true) // выравнивание блока
  view.setUint16(34, 8, true) // бит на сэмпл
  ascii(36, 'data')
  view.setUint32(40, samples, true)
  bytes.fill(128, 44) // 8-bit PCM: тишина — это 128
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
}

const SILENCE_URL = makeSilenceUrl()

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

// «Мост» аудиосессии. Отдельный элемент, который крутит тишину в те моменты,
// когда играть по-настоящему нечего, но отдавать сессию нельзя.
//
// Зачем. iOS держит аудиосессию, пока хоть один элемент реально воспроизводит.
// Как только всё замолкает, система через доли секунды сессию закрывает — и с
// этого момента play() без жеста уже не разрешён. Это ровно тот провал, в
// который попадает отложенный переход: трек кончился, следующий ещё грузится,
// и к моменту готовности буфера включать его уже некому. Тишина в этом окне
// удерживает сессию открытой, и запуск настоящего трека по готовности проходит.
//
// Громкость не трогаем и muted не ставим: беззвучный по громкости элемент часть
// версий WebKit за «воспроизведение» не считает и сессию по нему не держит.
// Поэтому тишина честная — нулевая по сигналу, а не приглушённая.
const bridge = createSlot('bridge')
if (bridge) {
  bridge.loop = true
  bridge.preload = 'auto'
}
let bridgeHeld = false

const slotsAndBridge = () => [...slots, bridge].filter(Boolean)

let activeIndex = 0
let sharedVolume = 1
let mounted = false
let unlocked = false
let detachPreloadWatch = null
// Элемент, с которого только что ушли: ждёт finishSwap, чтобы аудиосессия
// не оставалась без владельца ни на один тик.
let pendingRelease = null

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
  for (const el of slotsAndBridge()) {
    if (!el.isConnected) document.body.appendChild(el)
  }
}

// Включить/выключить мост аудиосессии (см. комментарий у bridge).
// Держим его ровно столько, сколько длится окно «играть нечем»: лишняя тишина
// поверх настоящего трека iOS не нравится — она конкурирует за сессию.
export function holdSession() {
  if (!bridge || !SILENCE_URL || bridgeHeld) return
  bridgeHeld = true
  try {
    if (bridge.src !== SILENCE_URL) bridge.src = SILENCE_URL
    bridge.currentTime = 0
    const promise = bridge.play()
    if (promise?.then) {
      promise.then(
        () => diag('bridge:hold', {}),
        (error) => {
          diag('bridge:fail', { name: error?.name })
          bridgeHeld = false
        },
      )
    } else {
      diag('bridge:hold', {})
    }
  } catch {
    bridgeHeld = false
  }
}

export function releaseSession() {
  if (!bridge || !bridgeHeld) return
  bridgeHeld = false
  try {
    bridge.pause()
    diag('bridge:release', {})
  } catch {
    /* noop */
  }
}

// Разблокировка жестом. На iOS право играть выдаётся КАЖДОМУ media-элементу
// отдельно и только в контексте пользовательского жеста. Активный элемент
// получает его сам — первым настоящим play() по нажатию ▶. А вот тот, на который
// мы потом переключимся в фоне, и мост аудиосессии к этому моменту не играли ни
// разу: их первый play() пришёлся бы уже на фон — то есть был бы отвергнут.
//
// Лечится проигрыванием короткой тишины внутри жеста: элемент «засчитывает»
// разрешение, слышно при этом ничего.
//
// Возвращает всегда true: попытка ровно одна за сессию страницы.
//
// Ретраи «на случай неудачного жеста» отсюда убраны, и намеренно. Каждый заход
// проигрывает тишину, а iOS отдаёт Now Playing тому элементу, который зазвучал
// последним — и, пока мы эту тишину глушим, виджет остаётся привязан к
// замолчавшему элементу: на экране блокировки ▶ вместо ⏸ и мёртвая шкала
// перемотки поверх честно играющего трека. Прежний код выставлял `unlocked`
// только внутри .then, поэтому синхронная проверка после вызова всегда видела
// false, слушатели жестов не снимались, и тишина переигрывалась на КАЖДОМ
// касании экрана.
//
// Цена одной попытки невелика: даже если разрешение не выдали, подмена элемента
// в фоне всё равно работает — она идёт из обработчика ended/медиакнопки, где
// аудиосессия жива и не прерывалась.
export function unlock() {
  if (unlocked) return true
  unlocked = true
  if (!SILENCE_URL) return true
  // Если реальное воспроизведение уже идёт — не вмешиваемся вовсе. Красть у
  // него сессию ради разрешения, которое ему уже не нужно, значит ровно и
  // сломать виджет.
  if (slots.some((el) => el && !el.paused)) return true

  for (const el of [getIdle(), bridge]) {
    // Занятый элемент не трогаем: подмена src сорвала бы прогрев.
    if (!el || el.src) continue
    // Освобождаем ПОЛНОСТЬЮ, мост в том числе: элемент с висящим тихим src —
    // готовый кандидат в Now Playing. Мосту src вернёт holdSession, когда он
    // реально понадобится.
    const reset = () => {
      if (el.src !== SILENCE_URL) return
      try {
        el.pause()
        el.removeAttribute('src')
        el.load()
      } catch {
        /* noop */
      }
    }
    try {
      el.src = SILENCE_URL
      const promise = el.play()
      if (promise?.then) {
        promise.then(
          () => {
            diag('engine:unlock:ok', {})
            reset()
          },
          (error) => {
            diag('engine:unlock:fail', { name: error?.name })
            reset()
          },
        )
      } else {
        reset()
      }
    } catch {
      /* элемент не в том состоянии — фоновая подмена обойдётся без разрешения */
    }
  }
  return true
}

// Разблокировку вешаем на первый же жест страницы, в фазе захвата: так она
// случается ДО обработчика клика по кнопке ▶, то есть внутри того же жеста.
if (typeof document !== 'undefined') {
  const GESTURES = ['pointerdown', 'touchstart', 'keydown']
  const onGesture = () => {
    unlock()
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

// Сколько секунд непрерывного буфера есть впереди текущей позиции. Мера
// «насколько спокойно себя чувствует играющий трек»: пока запас велик, можно
// без ущерба для него начинать качать следующий.
export function bufferedAhead(el) {
  if (!el) return 0
  const buffered = el.buffered
  if (!buffered || buffered.length === 0) return 0
  const position = el.currentTime
  for (let i = 0; i < buffered.length; i += 1) {
    if (buffered.start(i) <= position && position <= buffered.end(i)) {
      return buffered.end(i) - position
    }
  }
  return 0
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
  // Тот же порог, что в isReady: HAVE_CURRENT_DATA означает лишь «первый кадр
  // есть» — стартовав на нём, элемент немедленно уходит в waiting, а в фоне
  // waiting неотличим от тишины. Нужен запас вперёд.
  if (idle.readyState < idle.HAVE_FUTURE_DATA) return null

  const previous = getActive()
  activeIndex = 1 - activeIndex
  detachPreloadWatch?.()

  // Старый элемент НЕ глушим здесь. iOS не отдаёт аудиосессию другому элементу,
  // пока приложение в фоне: если замолчать до старта нового, сессия схлопнется,
  // и новый элемент получит play:ok, playing и paused=false — но конвейер не
  // поедет, currentTime останется на нуле, звука не будет (проверено на
  // устройстве: rs=4, ct=0 десять секунд подряд). Поэтому перекрываем — сначала
  // поёт новый, и только после этого отпускаем старый (см. finishSwap).
  pendingRelease = previous

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

// Завершение подмены: глушим элемент, с которого ушли. Зовётся ПОСЛЕ того, как
// новый элемент действительно запел, — на этом и держится непрерывность сессии.
// Идемпотентно: лишний вызов ничего не делает.
export function finishSwap() {
  const previous = pendingRelease
  pendingRelease = null
  if (!previous) return
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
  diag('swap:finish', { ...snapshotAudio(previous) })
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
