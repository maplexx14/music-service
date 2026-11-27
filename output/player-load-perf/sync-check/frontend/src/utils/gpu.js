// Детект софтверного рендеринга (аппаратное ускорение выключено в браузере,
// GPU в блеклисте, RDP/виртуалка без драйвера). В таком режиме браузер
// растеризует и композитит всё на CPU: blur, WebGL-шейдеры и перерисовка
// крупных слоёв на каждом кадре грузят процессор и дают рывки. Класс
// `no-gpu` на <html> включает облегчённые варианты эффектов (см. index.css) —
// анимации остаются, но только те, что дёшево считаются без видеокарты.

const CACHE_KEY = 'no-gpu'
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen|lavapipe/i

let cached = null

function detect() {
  try {
    const canvas = document.createElement('canvas')
    // failIfMajorPerformanceCaveat: браузер отказывает в контексте, если
    // рендер пойдёт через софтверный фолбэк (Chrome/Firefox). Сам отказ —
    // и есть ответ.
    const gl =
      canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true, powerPreference: 'low-power' }) ||
      canvas.getContext('experimental-webgl', { failIfMajorPerformanceCaveat: true, powerPreference: 'low-power' })
    if (!gl) return true
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return SOFTWARE_RENDERER.test(String(renderer || ''))
  } catch {
    return false
  }
}

export function isSoftwareRendering() {
  if (cached !== null) return cached
  // Результат кэшируем на сессию вкладки: создание WebGL-контекста на старте
  // стоит миллисекунды, повторять его на каждой перезагрузке незачем. Между
  // запусками браузера состояние ускорения может смениться — поэтому не
  // localStorage.
  try {
    const stored = sessionStorage.getItem(CACHE_KEY)
    if (stored === '1' || stored === '0') {
      cached = stored === '1'
      return cached
    }
  } catch {
    // Storage недоступен — просто детектим.
  }
  cached = detect()
  try {
    sessionStorage.setItem(CACHE_KEY, cached ? '1' : '0')
  } catch {
    // Ignore
  }
  return cached
}

export function applyGpuClass() {
  document.documentElement.classList.toggle('no-gpu', isSoftwareRendering())
}
