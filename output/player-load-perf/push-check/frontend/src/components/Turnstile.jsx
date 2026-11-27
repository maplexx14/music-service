import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

// Виджет Cloudflare Turnstile (каптча на регистрации).
//
// Ключ приходит с бэка (/auth/captcha-config), а не из сборки: см. коммент в
// backend/app/captcha.py. Виджета нет вообще, если каптча на сервере не
// настроена, — решение принимает вызывающая форма.
//
// Токен ОДНОРАЗОВЫЙ и живёт ~5 минут: бэк гасит его при проверке, поэтому
// после любой неудачной отправки формы виджет надо перерисовать. Проще всего
// это сделать сменой prop key на этом компоненте — размонтирование чистит
// виджет само (см. cleanup ниже).

const SCRIPT_ID = 'cf-turnstile-api'
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

// Скрипт один на страницу: повторная вставка тега ломает уже отрисованные
// виджеты. Промис общий, чтобы два монтирования не тянули api.js дважды.
let scriptPromise = null

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve(window.turnstile)
    script.onerror = () => {
      // Сбрасываем промис и убираем тег: иначе один сетевой сбой навсегда
      // оставляет форму без виджета, даже когда сеть уже вернулась.
      scriptPromise = null
      script.remove()
      reject(new Error('turnstile api.js failed to load'))
    }
    document.head.appendChild(script)
  })

  return scriptPromise
}

const Turnstile = forwardRef(function Turnstile({ siteKey, onToken, onError }, ref) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)
  // Колбэки держим в ref: иначе новая функция на каждый рендер формы
  // перезапускала бы эффект и виджет отрисовывался бы заново, теряя
  // уже полученный токен.
  const onTokenRef = useRef(onToken)
  const onErrorRef = useRef(onError)
  const [scriptFailed, setScriptFailed] = useState(false)

  useEffect(() => {
    onTokenRef.current = onToken
    onErrorRef.current = onError
  }, [onToken, onError])

  // Submit читает ответ прямо у конкретного экземпляра Turnstile. Это не
  // зависит от того, успел ли React применить setState из callback, и не
  // может случайно взять hidden input другого виджета на странице.
  useImperativeHandle(ref, () => ({
    getResponse() {
      if (widgetIdRef.current === null || !window.turnstile) return ''
      return window.turnstile.getResponse(widgetIdRef.current) || ''
    },
  }), [])

  useEffect(() => {
    if (!siteKey) return undefined

    // StrictMode в деве монтирует эффект дважды; загрузка асинхронная, так что
    // без этого флага второй проход отрисовал бы виджет в уже снятый узел.
    let cancelled = false

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: 'dark',
          action: 'register',
          callback: (token) => onTokenRef.current?.(token),
          // Токен истёк, не дождавшись отправки формы: снимаем его, чтобы
          // форма не ушла с мёртвым токеном. Виджет запросит проверку заново.
          'expired-callback': () => onTokenRef.current?.(''),
          'error-callback': () => {
            onTokenRef.current?.('')
            onErrorRef.current?.()
          },
        })
      })
      .catch(() => {
        if (cancelled) return
        setScriptFailed(true)
        onErrorRef.current?.()
      })

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        // Без remove() виджет остаётся в DOM Cloudflare'а и следующая
        // отрисовка (после смены key) плодит дубли.
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = null
    }
  }, [siteKey])

  if (scriptFailed) {
    return (
      <p className="auth-hint">
        Не удалось загрузить проверку «я не робот». Отключите блокировщик или
        обновите страницу.
      </p>
    )
  }

  return (
    <div
      className="captcha-widget"
      data-action="turnstile-spin-v1"
      ref={containerRef}
    />
  )
})

export default Turnstile
