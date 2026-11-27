// A real HTTPS byte-stream failure: the first connection stops delivering data
// after 20 seconds of PCM, without EOF or a media error. A reload can recover.
// Certificates live only in the ignored report directory / disposable test APK.
import https from 'node:https'
import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const directory = fileURLToPath(new URL('../../../android/app/build/reports/background-playback/fixture/', import.meta.url))
const sampleRate = 16000
const duration = 480
const bytesPerSecond = sampleRate * 2
const wav = Buffer.alloc(44 + duration * bytesPerSecond)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(sampleRate, 24)
wav.writeUInt32LE(bytesPerSecond, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 0; i < duration * sampleRate; i++) {
  wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 2000), 44 + i * 2)
}
const runs = new Map()
const log = (data) => {
  const line = JSON.stringify({ at: Date.now(), ...data })
  appendFileSync(path.join(directory, 'requests.jsonl'), `${line}\n`)
  console.log(line)
}
https.createServer({
  key: readFileSync(path.join(directory, 'localhost.key')),
  cert: readFileSync(path.join(directory, 'localhost.pem')),
}, (request, response) => {
  const url = new URL(request.url, 'https://10.0.2.2:9143')
  if (url.pathname !== '/stream.wav') { response.writeHead(404).end(); return }
  const run = url.searchParams.get('run') || 'default'
  const count = (runs.get(run) || 0) + 1
  runs.set(run, count)
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
  const start = Number(range?.[1] || 0)
  const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1
  if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${wav.length}` }).end(); return }
  response.writeHead(range ? 206 : 200, {
    'Content-Type': 'audio/wav', 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
  })
  const stalled = count === 1
  const until = stalled ? Math.min(end + 1, 44 + 20 * bytesPerSecond) : end + 1
  log({ run, count, range: request.headers.range, start, end, stalled, bytesSent: Math.max(0, until - start) })
  response.on('close', () => log({ run, count, event: 'close' }))
  if (stalled) {
    response.write(wav.subarray(start, until))
    response.socket.setTimeout(0)
  } else response.end(wav.subarray(start, until))
}).listen(9143, '127.0.0.1', () => console.log('HTTPS stream fixture listening on 127.0.0.1:9143'))
