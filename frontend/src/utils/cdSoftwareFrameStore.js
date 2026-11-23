// Compressed poses survive scene disposal and page reloads. Keep only two
// appearances/layouts; decoded pixels remain owned by the mounted scene.
const DATABASE = 'cd-software-poses-v1'
const MAX_RECORDS = 2
const MAX_BYTES = 12 * 1024 * 1024
const memory = new Map()
let database
let seedManifest

async function seed(key) {
  if (typeof fetch === 'undefined') return null
  try {
    const version = encodeURIComponent(key.split('|')[0])
    seedManifest ||= fetch(`/cd-player-frames/manifest.json?version=${version}`).then(response => response.ok ? response.json() : {})
    const entry = (await seedManifest)[key]
    if (!entry) return null
    const response = await fetch(`/cd-player-frames/${entry.atlas}`)
    if (!response.ok) return null
    const atlas = await response.blob()
    const record = { ...entry, key, blobs: entry.rectangles.map(() => atlas), bytes: atlas.size }
    remember(key, record)
    return record
  } catch { seedManifest = null; return null }
}

function remember(key, record) {
  memory.delete(key)
  memory.set(key, record)
  while (memory.size > MAX_RECORDS || [...memory.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_BYTES) {
    memory.delete(memory.keys().next().value)
  }
}

function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  database ||= new Promise(resolve => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('poses', { keyPath: 'key' })
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); database = null }
      resolve(db)
    }
    request.onerror = request.onblocked = () => { database = null; resolve(null) }
  })
  return database
}

export const cdSoftwareFrameStore = {
  async get(key) {
    if (memory.has(key)) {
      const record = memory.get(key)
      remember(key, record)
      return record
    }
    const db = await open()
    if (!db) return seed(key)
    const stored = await new Promise(resolve => {
      const request = db.transaction('poses').objectStore('poses').get(key)
      request.onsuccess = () => {
        const record = request.result
        if (record) remember(key, record)
        resolve(record || null)
      }
      request.onerror = () => resolve(null)
    })
    return stored || seed(key)
  },
  async put(key, blobs, geometry = {}) {
    const bytes = blobs.reduce((sum, blob) => sum + blob.size, 0)
    if (bytes > MAX_BYTES) return
    const record = { ...geometry, key, blobs, bytes, savedAt: Date.now() }
    remember(key, record)
    const db = await open()
    if (!db) return
    await new Promise(resolve => {
      const transaction = db.transaction('poses', 'readwrite')
      const store = transaction.objectStore('poses')
      store.put(record)
      const request = store.getAll()
      request.onsuccess = () => {
        const records = request.result.sort((a, b) => b.savedAt - a.savedAt)
        let total = 0
        records.forEach((item, index) => {
          total += item.bytes
          if (index >= MAX_RECORDS || total > MAX_BYTES) store.delete(item.key)
        })
      }
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve()
    })
  },
}
