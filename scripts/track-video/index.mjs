import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'
import { capture } from './capture.mjs'
import { downloadAudio, httpUrl, lookupLyrics, resolveTrack } from './source.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
function makeTimeline(withLyrics) {
  const closeAt = withLyrics ? 5.85 : 4.4
  const timeline = {
    fps: 60, sourceDuration: closeAt + 2, introDuration: 2, openingLead: .45,
    swipeStart: 1.2, swipeDuration: .25, openAt: 2.7,
    closeAt, returnSwipeStart: closeAt + .55, returnSwipeDuration: .45,
  }
  const frames = Math.round((timeline.introDuration - timeline.openingLead + timeline.sourceDuration) * timeline.fps)
  return { ...timeline, frames, filmDuration: frames / timeline.fps }
}

function findFfmpeg() {
  const profile = process.env.USERPROFILE
  const existing = profile && path.join(profile, '.codex', 'tmp', 'bolt-video-tools', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  const candidates = process.env.FFMPEG_PATH ? [process.env.FFMPEG_PATH] : ['ffmpeg', existing].filter(Boolean)
  for (const ffmpeg of candidates) {
    if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0) return ffmpeg
  }
  throw new Error('FFmpeg не найден. Добавьте ffmpeg в PATH или укажите FFMPEG_PATH.')
}

function runFfmpeg(ffmpeg, args) {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-y', ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || 'FFmpeg завершился с ошибкой.')
  return result.stderr
}

async function prepareAudio(ffmpeg, origin, source, work) {
  const input = path.join(work, 'download')
  const file = path.join(work, 'track.m4a')
  let failure
  for (const candidate of source.audioChoices) {
    try {
      await downloadAudio(origin, candidate, input)
      const log = runFfmpeg(ffmpeg, ['-i', input, '-map', '0:a:0', '-c:a', 'aac', '-ar', '44100', '-b:a', '192k', '-movflags', '+faststart', file])
      const [, hh, mm, ss] = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/) ?? []
      const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
      if (!Number.isFinite(seconds)) throw new Error('Не удалось прочитать длительность трека.')
      return { file, seconds }
    } catch (error) {
      failure = error
    }
  }
  throw new Error(`Не удалось загрузить аудио «${source.selected.title}» (${failure.message}).`)
}

function makeSoundtrack(ffmpeg, input, start, duration, output) {
  runFfmpeg(ffmpeg, [
    '-loglevel', 'error', '-ss', String(start), '-i', input, '-t', String(duration),
    '-af', `afade=d=0.012,afade=t=out:st=${(duration - .025).toFixed(3)}:d=0.025,volume=-4dB`,
    '-c:a', 'aac', '-b:a', '192k', output,
  ])
}

async function render(browser, ffmpeg, work, soundtrack, movie, recording, timeline) {
  const { fps, frames, filmDuration } = timeline
  await Promise.all([
    copyFile(new URL('camera.js', import.meta.url), path.join(work, 'camera.js')),
    writeFile(path.join(work, 'frames.js'),
      `window.BOLT_CAPTURE = ${JSON.stringify(recording.meta)};\nwindow.BOLT_INTRO = ${JSON.stringify(recording.intro)};\nwindow.BOLT_EDITION = ${JSON.stringify(timeline)};\n`),
    writeFile(path.join(work, 'film.html'),
      '<!doctype html><meta charset="utf-8"><canvas id="film"></canvas><script src="frames.js"></script><script src="camera.js"></script>'),
  ])
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  let ffmpegProcess
  try {
    await page.goto(pathToFileURL(path.join(work, 'film.html')).href)
    if (pageErrors.length) throw new Error(pageErrors.join('\n'))
    await page.evaluate(() => window.ready)
    ffmpegProcess = spawn(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg', '-i', 'pipe:0',
      '-i', soundtrack, '-map', '0:v:0', '-map', '1:a:0',
      '-vf', 'scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-t', String(filmDuration), '-movflags', '+faststart', movie,
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let log = ''
    ffmpegProcess.stderr.on('data', part => { log += part })
    const done = new Promise((resolve, reject) => {
      ffmpegProcess.once('error', reject)
      ffmpegProcess.once('close', code => code === 0 ? resolve() : reject(new Error(log || `FFmpeg: код ${code}`)))
    })
    done.catch(() => {})
    const stdin = ffmpegProcess.stdin
    const streamDone = finished(stdin, { cleanup: true })
    streamDone.catch(() => {})
    for (let frame = 0; frame < frames; frame++) {
      const jpeg = await page.evaluate(async time => {
        await window.renderFrame(time)
        return document.getElementById('film').toDataURL('image/jpeg', .98).split(',')[1]
      }, frame / fps)
      await Promise.race([done, new Promise((resolve, reject) =>
        stdin.write(Buffer.from(jpeg, 'base64'), error => error ? reject(error) : resolve()))])
      if (frame % 120 === 0) console.log(`Монтаж: ${frame}/${frames} кадров`)
    }
    stdin.end()
    await Promise.all([done, streamDone])
    if (pageErrors.length) throw new Error(pageErrors.join('\n'))
  } finally {
    if (ffmpegProcess && ffmpegProcess.exitCode === null) ffmpegProcess.kill()
    await page.close()
  }
}

function parseStart(value) {
  if (value === undefined) return undefined
  const [first, second] = value.split(':')
  const start = /^\d+(?:\.\d+)?$/.test(value) ? Number(value)
    : /^\d+:[0-5]\d(?:\.\d+)?$/.test(value) ? Number(first) * 60 + Number(second) : NaN
  if (!Number.isFinite(start)) throw new Error('Укажите --start в секундах или в формате ММ:СС.')
  return start
}

const help = `Создать вертикальный ролик Bolt по названию или ссылке на трек.

  npm run track-video -- "ONDA ANDAR — cachalot"
  npm run track-video -- "https://music.youtube.com/watch?v=Zrq71nOI3C4" --start 1:06

  --start <секунды|ММ:СС>  Начало фрагмента трека
  --output <файл.mp4>      Путь для MP4 (по умолчанию output/track-videos/)
  --bolt-url <URL>         Адрес запущенного Bolt (по умолчанию http://localhost)
  --help                   Показать справку
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, start: { type: 'string' },
      output: { type: 'string', short: 'o' }, 'bolt-url': { type: 'string' },
    },
  })
  if (values.help) return console.log(help)
  const input = positionals.join(' ').trim()
  if (!input) throw new Error('Укажите название или ссылку на трек. Справка: npm run track-video -- --help')
  const requestedStart = parseStart(values.start)
  const origin = httpUrl(values['bolt-url'] || process.env.BOLT_URL || 'http://localhost').origin
  const ffmpeg = findFfmpeg()
  const source = await resolveTrack(origin, input)
  const { title, artist } = source.selected
  const label = [artist, title].filter(Boolean).join(' — ')
  const slug = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 100)
  const output = path.resolve(values.output || path.join(root, 'output', 'track-videos', `bolt-${slug || 'track'}-9x16.mp4`))
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Имя выходного файла должно заканчиваться на .mp4.')
  await mkdir(path.dirname(output), { recursive: true })
  const work = await mkdtemp(path.join(path.dirname(output), '.track-video-'))
  let browser
  try {
    console.log(`Трек: ${label}`)
    const audio = await prepareAudio(ffmpeg, origin, source, work)
    source.selected.duration = audio.seconds
    const lyrics = await lookupLyrics(source.selected).catch(error => {
      console.warn(`Не удалось проверить текст (${error.message}). Показываю обложку.`)
      return null
    })
    const timeline = makeTimeline(Boolean(lyrics))
    const latest = Math.floor((audio.seconds - timeline.filmDuration) * 1000) / 1000
    const trackStart = requestedStart ?? Math.round(Math.min(audio.seconds * .55, latest) * 1000) / 1000
    if (trackStart < 0 || trackStart > latest) {
      throw new Error(`Выберите точку, после которой в треке остаётся минимум ${timeline.filmDuration} с.`)
    }
    console.log(lyrics ? 'В полноэкранном плеере будет текст трека.' : 'В полноэкранном плеере будет обложка.')
    console.log(`Фрагмент от ${trackStart.toFixed(2)} с`)
    const soundtrack = path.join(work, 'soundtrack.m4a')
    makeSoundtrack(ffmpeg, audio.file, trackStart, timeline.filmDuration, soundtrack)
    const options = { headless: true, args: ['--allow-file-access-from-files', '--disable-background-networking', '--force-color-profile=srgb', '--enable-unsafe-swiftshader'] }
    const executablePath = process.env.BROWSER_PATH || process.env.EDGE_PATH
    try {
      browser = await chromium.launch(executablePath ? { ...options, executablePath } : { ...options, channel: 'msedge' })
    } catch (error) {
      if (executablePath) throw error
      browser = await chromium.launch({ ...options, channel: 'chrome' }).catch(() => {
        throw new Error('Установите Edge или Chrome либо укажите BROWSER_PATH.')
      })
    }
    const recording = await capture(browser, {
      origin, source, audio: await readFile(audio.file), folder: work, timeline, trackStart, lyrics,
    })
    const movie = path.join(work, 'track.mp4')
    await render(browser, ffmpeg, work, soundtrack, movie, recording, timeline)
    await rename(movie, output)
    console.log(`Готово: ${output}`)
  } finally {
    try {
      await browser?.close()
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
