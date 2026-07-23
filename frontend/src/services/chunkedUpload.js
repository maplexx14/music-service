import api from './api'

const MAX_RETRIES = 3
const RETRY_BASE_DELAY = 1000
const CHUNK_TIMEOUT = 30000

function getStorageKey(uploadId) {
  return `chunked-upload:${uploadId}`
}

function saveProgress(uploadId, data) {
  try {
    localStorage.setItem(getStorageKey(uploadId), JSON.stringify(data))
  } catch { /* quota exceeded — non-critical */ }
}

function loadProgress(uploadId) {
  try {
    const raw = localStorage.getItem(getStorageKey(uploadId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function clearProgress(uploadId) {
  localStorage.removeItem(getStorageKey(uploadId))
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Chunked file upload with resume and retry support.
 *
 * Usage:
 *   const uploader = new ChunkedUpload(file, { title, artist, ... })
 *   uploader.onProgress = (loaded, total, chunkIdx, totalChunks) => { ... }
 *   await uploader.upload()
 *   // on abort: uploader.abort()
 */
export class ChunkedUpload {
  constructor(file, metadata, { chunkSize = 512 * 1024, onProgress } = {}) {
    this.file = file
    this.metadata = metadata
    this.chunkSize = chunkSize
    this.onProgress = onProgress || (() => {})
    this.totalChunks = Math.ceil(file.size / chunkSize)
    this.uploadId = null
    this._aborted = false
    this._controller = null
  }

  abort() {
    this._aborted = true
    if (this._controller) this._controller.abort()
  }

  async upload() {
    this._aborted = false

    // Try to resume from saved progress
    const saved = this._findResumableSession()
    if (saved) {
      this.uploadId = saved.upload_id
      const status = await this._checkStatus(saved.upload_id)
      if (status) {
        return this._uploadChunks(status.received_chunks)
      }
    }

    // Init new session
    const initRes = await api.post('/tracks/upload/init', {
      filename: this.file.name,
      file_size: this.file.size,
      chunk_size: this.chunkSize,
    }, { timeout: CHUNK_TIMEOUT })

    this.uploadId = initRes.data.upload_id
    saveProgress(this.uploadId, {
      upload_id: this.uploadId,
      filename: this.file.name,
      file_size: this.file.size,
    })

    return this._uploadChunks([])
  }

  async _uploadChunks(alreadyUploaded) {
    const uploadedSet = new Set(alreadyUploaded)
    let uploadedCount = uploadedSet.size

    for (let i = 0; i < this.totalChunks; i++) {
      if (this._aborted) throw new Error('Upload aborted')
      if (uploadedSet.has(i)) continue

      await this._uploadChunkWithRetry(i)
      uploadedCount++
      this.onProgress(
        Math.min(uploadedCount * this.chunkSize, this.file.size),
        this.file.size,
        i,
        this.totalChunks,
      )
    }

    // Complete
    const res = await api.post('/tracks/upload/complete', {
      upload_id: this.uploadId,
      title: this.metadata.title,
      artist: this.metadata.artist,
      album: this.metadata.album || null,
      genre: this.metadata.genre || null,
    }, { timeout: 60000 })

    clearProgress(this.uploadId)
    return res.data
  }

  async _uploadChunkWithRetry(chunkIndex) {
    let lastError
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (this._aborted) throw new Error('Upload aborted')
      try {
        const start = chunkIndex * this.chunkSize
        const end = Math.min(start + this.chunkSize, this.file.size)
        const blob = this.file.slice(start, end)

        const formData = new FormData()
        formData.append('upload_id', this.uploadId)
        formData.append('chunk_index', chunkIndex)
        formData.append('file', blob, this.file.name)

        this._controller = new AbortController()

        await api.post('/tracks/upload/chunk', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: CHUNK_TIMEOUT,
          signal: this._controller.signal,
          skipErrorToast: true,
        })
        return
      } catch (err) {
        if (this._aborted || err.name === 'CanceledError' || err.name === 'AbortError') {
          throw new Error('Upload aborted')
        }
        lastError = err
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt))
        }
      }
    }
    throw lastError
  }

  async _checkStatus(uploadId) {
    try {
      const res = await api.get(`/tracks/upload/status/${uploadId}`, { timeout: 10000 })
      return res.data
    } catch {
      clearProgress(uploadId)
      return null
    }
  }

  _findResumableSession() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('chunked-upload:')) {
        try {
          const data = JSON.parse(localStorage.getItem(key))
          if (data.filename === this.file.name && data.file_size === this.file.size) {
            return data
          }
        } catch { /* corrupt entry */ }
      }
    }
    return null
  }
}

/**
 * Decide whether to use chunked upload based on file size.
 * Files <= 2MB use the simple single-request upload.
 */
export function shouldUseChunkedUpload(file) {
  return file.size > 2 * 1024 * 1024
}
