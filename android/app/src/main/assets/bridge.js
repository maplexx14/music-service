// Мост веб-приложения с оболочкой Android. Выполняется до скриптов страницы.
//
// WebView не умеет того, что сайт получает в установленной PWA: системного
// плеера (уведомление, экран блокировки, кнопки гарнитуры) и «Поделиться».
// Поэтому navigator.mediaSession и navigator.share подменяются своими и
// пересылают всё в нативную часть через BoltAndroid.postMessage.
(function () {
  if (window.__boltAndroid) return
  var bridge = window.BoltAndroid
  if (!bridge || typeof bridge.postMessage !== 'function') return
  window.__boltAndroid = true
  // Только оболочки с handlePageBack могут обходить историю WebView.
  window.__boltNativeBack = true

  function send(msg) {
    try {
      bridge.postMessage(JSON.stringify(msg))
    } catch (e) {
      /* мост недоступен — сайт работает как в браузере */
    }
  }

  // Приложение ведёт себя как установленная PWA: без плашки установки,
  // с теми же отступами под таб-баром.
  var origMatchMedia = window.matchMedia
  window.matchMedia = function (query) {
    var mql = origMatchMedia.call(window, query)
    if (/display-mode\s*:\s*standalone/.test(String(query))) {
      try {
        Object.defineProperty(mql, 'matches', { value: true })
      } catch (e) {
        /* старый WebView может не разрешать переопределение MediaQueryList */
      }
    }
    return mql
  }
  function addStandaloneStyle() {
    var style = document.createElement('style')
    style.textContent = 'html:root{--safe-bottom:max(env(safe-area-inset-bottom,0px),12px)}'
    ;(document.head || document.documentElement).appendChild(style)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addStandaloneStyle)
  } else {
    addStandaloneStyle()
  }

  function absUrl(src) {
    try {
      return new URL(src, location.href).href
    } catch (e) {
      return ''
    }
  }

  if (typeof window.MediaMetadata !== 'function') {
    window.MediaMetadata = function MediaMetadata(init) {
      init = init || {}
      this.title = init.title || ''
      this.artist = init.artist || ''
      this.album = init.album || ''
      this.artwork = init.artwork || []
    }
  }

  var handlers = {}
  var metadata = null
  var playbackState = 'none'

  function sendMetadata() {
    if (!metadata) {
      send({ t: 'meta', v: null })
      return
    }
    var art = metadata.artwork || []
    var last = art.length ? art[art.length - 1] : null
    send({
      t: 'meta',
      v: {
        title: String(metadata.title || ''),
        artist: String(metadata.artist || ''),
        album: String(metadata.album || ''),
        artwork: last && last.src ? absUrl(last.src) : '',
      },
    })
  }

  var session = {
    get metadata() {
      return metadata
    },
    set metadata(value) {
      metadata = value || null
      sendMetadata()
    },
    get playbackState() {
      return playbackState
    },
    set playbackState(value) {
      playbackState = String(value)
      send({ t: 'state', v: playbackState })
    },
    setActionHandler: function (action, handler) {
      if (typeof handler === 'function') handlers[action] = handler
      else delete handlers[action]
      send({ t: 'actions', v: Object.keys(handlers) })
    },
    setPositionState: function (state) {
      if (!state) {
        send({ t: 'pos', d: 0, p: 0, r: 0 })
        return
      }
      var duration = Number(state.duration)
      var position = Number(state.position || 0)
      if (!(duration >= 0) || !(position >= 0) || position > duration) {
        throw new TypeError('Invalid position state')
      }
      var rate = state.playbackRate == null ? 1 : Number(state.playbackRate)
      send({ t: 'pos', d: duration, p: position, r: rate })
    },
    setMicrophoneActive: function () {},
    setCameraActive: function () {},
  }
  try {
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
  } catch (e) {
    /* старый WebView может не разрешать подмену mediaSession */
  }

  // Кнопки уведомления, экрана блокировки и гарнитуры.
  window.__boltMediaAction = function (action, seekTime) {
    var handler = handlers[action]
    if (!handler) return false
    try {
      var details = { action: action }
      if (typeof seekTime === 'number') details.seekTime = seekTime
      handler(details)
    } catch (e) {
      /* ошибка обработчика страницы не должна уронить нативный вызов */
    }
    return true
  }

  // Залито ли сердце у текущего трека — для кнопок лайка на системном плеере.
  window.__boltSetFeedback = function (liked, disliked) {
    send({ t: 'feedback', liked: !!liked, disliked: !!disliked })
  }

  // Системный лист «Поделиться» вместо копирования в буфер.
  try {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: function (data) {
        data = data || {}
        send({
          t: 'share',
          title: String(data.title || ''),
          text: String(data.text || ''),
          url: data.url ? absUrl(data.url) : '',
        })
        return Promise.resolve()
      },
    })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: function () {
        return true
      },
    })
  } catch (e) {
    /* подмена share недоступна — страница использует браузерный fallback */
  }
})()
