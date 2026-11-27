import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const mediaPath = '/__track-video/audio.m4a'
const viewport = { width: 390, height: 844 }
export const pixelRatio = 3

function mediaResponse(request, audio) {
  const headers = { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes' }
  const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/)
  if (!range) return { headers, body: audio }
  const start = Number(range[1])
  const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1
  if (start > end) {
    return { status: 416, headers: { ...headers, 'content-range': `bytes */${audio.length}` } }
  }
  return {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${audio.length}` },
    body: audio.subarray(start, end + 1),
  }
}

async function prepareContext(context, origin, selected, results, audio, lyrics) {
  const user = {
    id: '3d53d61b-501f-4a7a-a3ec-9392c5a7e5cb',
    username: 'Bolt',
    is_active: true,
    email_verified: true,
    onboarding_completed: true,
    player_setup_completed: true,
    preferred_artists: [],
  }
  const track = { ...selected, id: selected.id.includes(':') ? selected.id : `video:${selected.id}`, stream_url: origin + mediaPath }
  const top = [track, ...results.filter(item => item.id !== selected.id)].slice(0, 6)
  await context.route(url => url.origin === origin && url.pathname === mediaPath, route =>
    route.fulfill(mediaResponse(route.request(), audio)))
  await context.route(url => url.origin === origin && url.pathname.startsWith('/api/'), async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/\/$/, '')
    switch (pathname) {
      case '/api/auth/me': return route.fulfill({ json: user })
      case '/api/lyrics': return route.fulfill({ json: lyrics || {} })
      case '/api/search': return route.fulfill({ json: { tracks: [], playlists: [] } })
      case '/api/search/external/grouped':
        return route.fulfill({ json: { top, ytmusic: [], soundcloud: [] } })
      case '/api/recommendations': return route.fulfill({ json: { tracks: [], playlists: [] } })
      case '/api/playlists/me/liked':
        return route.fulfill({ json: { id: 'video-liked', name: 'Понравившиеся', tracks: [], cover_url: null, is_public: false } })
      case '/api/users/me/player-state': return route.fulfill({ json: { state: null } })
    }
    if (request.method() !== 'GET') return route.fulfill({ json: {} })
    if (/^\/api\/(?:artists\/search|search\/external\/playlists|spotify\/status|tracks\/cover(?:-proxy|\/))/.test(pathname)) {
      const { authorization, ...headers } = request.headers()
      return route.continue({ headers })
    }
    return route.fulfill({ json: [] })
  })
  await context.addInitScript(({ origin, user }) => {
    if (location.origin !== origin) return
    localStorage.setItem('auth-storage', JSON.stringify({ token: 'video-session', user, isAuthenticated: true }))
    localStorage.setItem('cd-player-unboxed:' + user.id, '1')
    const matchMedia = window.matchMedia.bind(window)
    window.matchMedia = query => {
      const result = matchMedia(query)
      if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true })
      return result
    }

    // Advance app rAF callbacks and compositor animations on the capture clock.
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    const pending = new Map()
    const animated = new WeakMap()
    const play = Animation.prototype.play
    const finish = Animation.prototype.finish
    const isSwipe = target => target?.classList.contains('screen') || target?.classList.contains('mobile-nav-global-pill')
    let manual = false
    let nextId = 0

    Animation.prototype.play = function () {
      const result = play.call(this)
      if (manual && isSwipe(this.effect?.target)) {
        animated.set(this, { start: performance.now(), offset: 0 })
        this.playbackRate = 0
      }
      return result
    }
    Animation.prototype.finish = function () {
      if (animated.has(this) && this.playbackRate === 0) this.playbackRate = 1
      return finish.call(this)
    }
    window.requestAnimationFrame = callback => {
      const id = ++nextId
      const entry = { callback, native: null }
      pending.set(id, entry)
      if (!manual) entry.native = request(at => {
        pending.delete(id)
        callback(at)
      })
      return id
    }
    window.cancelAnimationFrame = id => {
      const entry = pending.get(id)
      if (entry?.native != null) cancel(entry.native)
      pending.delete(id)
    }
    window.boltCaptureClock = {
      start() {
        manual = true
        for (const entry of pending.values()) if (entry.native !== null) cancel(entry.native)
      },
      advance() {
        for (const animation of document.getAnimations()) {
          if (animation.playState === 'finished') continue
          let item = animated.get(animation)
          if (!item) {
            // The app controls a tab drag's own animation until release.
            if (isSwipe(animation.effect?.target)) continue
            item = { start: performance.now(), offset: Number(animation.currentTime) || 0 }
            animated.set(animation, item)
            animation.playbackRate = 0
            if (/^cd-.*(spin|playback-tilt)$/.test(animation.id)) animation.effect.updateTiming({ easing: 'linear' })
          }
          const at = item.offset + performance.now() - item.start
          if (at >= animation.effect.getComputedTiming().endTime) animation.finish()
          else animation.currentTime = Math.max(0, at)
        }
      },
      paint(frameMs) {
        for (let step = 1; step <= 2; step++) {
          const batch = [...pending.values()]
          pending.clear()
          for (const { callback } of batch) callback(performance.now() + frameMs * step)
        }
        for (const canvas of document.querySelectorAll('canvas')) {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
          gl?.finish()
        }
      },
    }
  }, { origin, user })
}

async function center(locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
}

async function gesture(page, start, duration, from, to, candidates) {
  const y = await page.evaluate(({ from, to, candidates }) => candidates.find(y =>
    [from, (from + to) / 2, to].every(x => {
      const target = document.elementFromPoint(x, y)
      return target?.closest('.main-content')
        && !target.closest('[data-swipe-ignore],button,input,[role="slider"],.cd-mobile-queue')
    })), { from, to, candidates })
  if (y === undefined) throw new Error('В мобильном интерфейсе не найдена область для свайпа.')
  return { start, release: start + duration, from: { x: from, y }, to: { x: to, y } }
}

async function swipeFrame(cdp, frame, gesture, fps) {
  const start = Math.round(gesture.start * fps)
  const end = Math.round(gesture.release * fps)
  if (frame < start || frame > end) return
  const p = Math.min(1, (frame - start) / (end - start - 1))
  const eased = p ** 3 * (10 + p * (-15 + 6 * p))
  const x = gesture.from.x + (gesture.to.x - gesture.from.x) * eased
  const type = frame === start ? 'touchStart' : frame === end ? 'touchEnd' : 'touchMove'
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: gesture.from.y, id: 1, radiusX: 6, radiusY: 6, force: 1 }],
  })
}

export async function capture(browser, { origin, source, audio, folder, timeline, trackStart, lyrics }) {
  const { fps, sourceDuration, introDuration, openingLead, openAt, closeAt,
    swipeStart, swipeDuration, returnSwipeStart, returnSwipeDuration } = timeline
  const introLength = introDuration - openingLead
  const liveDir = path.join(folder, 'assets', 'live')
  const introDir = path.join(folder, 'assets', 'intro')
  await Promise.all([mkdir(liveDir, { recursive: true }), mkdir(introDir, { recursive: true })])
  const context = await browser.newContext({
    viewport, deviceScaleFactor: pixelRatio, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  })
  try {
    await prepareContext(context, origin, source.selected, source.results, audio, lyrics)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })
    page.setDefaultTimeout(25_000)
    await page.clock.install()
    const dismiss = page.getByRole('button', { name: 'Закрыть подсказку', exact: true })
    await page.addLocatorHandler(dismiss, () => dismiss.tap())
    const later = page.getByRole('button', { name: 'Позже', exact: true })
    await page.addLocatorHandler(page.getByRole('dialog', { name: 'Новая версия для Android', exact: true }), () => later.tap())
    const home = page.locator('.mobile-nav-global-item[href="/"]')
    const search = page.locator('.mobile-nav-global-item[href="/search"]')
    const filter = label => page.locator('.search-filter').filter({ hasText: new RegExp(`^${label}$`) })
    const mini = page.locator('.player-cover-wrap')
    const player = page.locator('.fullscreen-controls .fullscreen-play')
    const lyricsButton = page.locator('.lyrics-btn[title="Текст песни"]:enabled')
    const openLyrics = () => lyricsButton.evaluate(button => button.click())
    const lyricsLines = page.locator('.fullscreen-lyrics-mobile .lyrics-line').first()
    const close = page.locator('.fullscreen-header button[aria-label="Закрыть"]')
    const deck = page.locator('.screen[data-active] .desktop-cd-player')
    const playing = page.locator('.play-pause-btn[aria-label="Пауза"]')
    const selectedTitle = source.selected.title
    let row = page.locator('.search-mobile-tracks:visible .track-item')
      .filter({ has: page.getByAltText(selectedTitle, { exact: true }) })
    if (source.selected.artist) {
      row = row.filter({ has: page.locator('.track-item-artist').filter({ hasText: source.selected.artist }) })
    }
    const title = row.first().locator('.track-item-title')
    const findAudio = () => Array.from(document.querySelectorAll('audio')).find(
      element => !element.paused && element.currentSrc.includes('/__track-video/audio.m4a') && element.readyState >= 3)

    await page.goto(origin + '/search?q=' + encodeURIComponent(source.query), { waitUntil: 'domcontentloaded' })
    await page.locator('.search-input').evaluate(element => element.blur())
    await filter('Лучшие').tap()
    try {
      await Promise.race([
        title.tap(),
        page.getByText('Не удалось загрузить приложение', { exact: true }).waitFor().then(() => {
          throw new Error('Интерфейс Bolt остановился.')
        }),
      ])
    } catch (error) {
      const screen = await page.locator('body').innerText()
      throw new Error(`Трек не появился в мобильном поиске (${page.url()}).\n${screen.slice(0, 900)}\n${pageErrors.join('\n')}\n${error.message}`)
    }
    await playing.waitFor()
    await page.waitForFunction(findAudio, null, { timeout: 25_000 })
    const audioHandle = await page.evaluateHandle(findAudio)
    await audioHandle.evaluate((element, start) => {
      // The browser plays the loaded audio, while the UI reads the position
      // on the frame clock. Encoding can take much longer than playback.
      element.playbackRate = 0.0625
      let position = start
      Object.defineProperties(element, {
        currentTime: { get: () => position, set: time => { position = time }, configurable: true },
        playbackRate: { value: 1, writable: true, configurable: true },
      })
      element.dispatchEvent(new Event('timeupdate'))
    }, trackStart + introLength)
    await home.tap()
    await deck.waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => document.getAnimations().some(animation =>
      animation.id === 'cd-player-playback-tilt' && animation.playState === 'running'))
    const openingSwipe = await gesture(page, swipeStart, swipeDuration, 325, 65, [150, 170, 190, 660, 630])

    await search.tap()
    await filter('Лучшие').tap()
    if (lyrics) await openLyrics()
    else await mini.tap()
    await player.waitFor()
    if (lyrics) await lyricsLines.waitFor()
    await close.tap()
    await player.waitFor({ state: 'detached' })
    const selectedRow = await center(title)
    await filter('Все').tap()
    const best = await center(filter('Лучшие'))
    const miniCover = await center(mini)
    await page.waitForTimeout(650)
    if (await dismiss.isVisible()) await dismiss.tap()

    const cdp = await context.newCDPSession(page)
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50))
    await page.evaluate(() => window.boltCaptureClock.start())
    const count = Math.round(sourceDuration * fps)
    const introCount = Math.round(introDuration * fps)
    const join = count - Math.round(openingLead * fps)
    const end = join + introCount
    const frameMs = 1000 / fps
    const returnPositions = []
    const openFrame = Math.round(openAt * fps)
    const closeFrame = Math.round(closeAt * fps)
    const returnFrame = Math.round(returnSwipeStart * fps)
    const actions = new Map([[70, best]])
    if (!lyrics) actions.set(openFrame, miniCover)
    let closePoint
    let returnSwipe
    const snap = async (directory, frame) => page.screenshot({
      path: path.join(directory, String(frame).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 94,
    })

    for (let frame = 0; frame < end; frame++) {
      const openingFrame = frame - join
      const time = frame / fps
      const position = trackStart + (frame < count ? introLength + time : (frame - count) / fps)
      const stillPlaying = await audioHandle.evaluate((element, position) => {
        element.currentTime = position
        element.dispatchEvent(new Event('timeupdate'))
        return !element.paused && !element.ended
      }, position)
      if (!stillPlaying) throw new Error('Во время записи трек перестал играть.')
      const action = actions.get(frame)
      if (action) await page.touchscreen.tap(action.x, action.y)
      if (lyrics && frame === openFrame) await openLyrics()
      if (frame === closeFrame) {
        closePoint = await center(close)
        await close.evaluate(button => button.click())
      }
      if (frame > 0) await page.clock.runFor(frameMs)
      if (frame === returnFrame) {
        if (await page.locator('.fullscreen-player').count()) {
          throw new Error('Полноэкранный плеер не закрылся перед возвратом на главную.')
        }
        returnSwipe = await gesture(page, returnSwipeStart, returnSwipeDuration, 65, 325, [650, 630, 610, 595, 570, 540, 190, 170])
      }
      if (returnSwipe) await swipeFrame(cdp, frame, returnSwipe, fps)
      await swipeFrame(cdp, openingFrame, openingSwipe, fps)
      await page.evaluate(frameMs => {
        window.boltCaptureClock.advance()
        window.boltCaptureClock.paint(frameMs)
      }, frameMs)

      if (frame >= returnFrame && frame <= returnFrame + Math.round((returnSwipeDuration + .5) * fps)) {
        const position = await page.evaluate(() => {
          const screen = document.querySelector('.screen[data-screen="tab:/"]')
          const active = location.pathname === '/'
          const visible = screen?.style.visibility === 'visible' || screen?.hasAttribute('data-active')
          return { active, homeLeft: visible ? screen.getBoundingClientRect().left : null }
        })
        returnPositions.push({ frame, ...position })
      }
      if (frame === openFrame + 24 && await player.getAttribute('aria-label') !== 'Пауза') {
        throw new Error('Полноэкранный плеер открылся без воспроизведения.')
      }
      if (lyrics && frame === openFrame + 36 && !await lyricsLines.isVisible()) {
        throw new Error('Текст трека не появился в полноэкранном плеере.')
      }
      if (frame === count - 1) {
        const current = await page.locator('.player-left .player-track-title').innerText()
        const onHome = returnPositions.some(position => position.active)
        const showDeck = await deck.isVisible()
        if (!onHome || !showDeck || current.trim() !== selectedTitle) {
          throw new Error(`Во время записи Bolt не вернулся к CD-плееру с выбранным треком (${page.url()}, трек «${current.trim()}»).`)
        }
      }
      if (frame < count) await snap(liveDir, frame)
      if (openingFrame >= 0) await snap(introDir, openingFrame)
      if (frame % 120 === 0) console.log(`Запись интерфейса: ${frame}/${end} кадров`)
    }
    if (!await page.locator('.screen[data-screen="tab:/search"][data-active]').isVisible()) {
      throw new Error('Начальный свайп не открыл поиск.')
    }
    return {
      meta: {
        ...viewport, pixelRatio, fps, count, best, selectedRow, miniCover, closePoint,
        returnSwipe, returnPositions,
      },
      intro: { count: introCount, fps, gesture: openingSwipe },
    }
  } finally {
    await context.close()
  }
}
