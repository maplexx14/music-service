import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BadgeCheck, ExternalLink, Music, X } from 'lucide-react'
import api from '../services/api'
import { useCensorDialogStore } from '../store/censorDialogStore'
import { toast } from '../store/toastStore'
import { formatDuration } from '../utils/format'
import './AddToPlaylistDialog.css'
import './CensorOverrideDialog.css'

// Привязка зацензуренного трека к оригиналу на SoundCloud (только админ).
// Часть русских треков по закону РФ заменена цензурными версиями, и по
// метаданным это не определить — админ выбирает оригинал из кандидатов или
// вставляет ссылку сам. Дальше оригинал играет везде: поиск, поток,
// рекомендации, библиотека (см. backend app/censorship.py).
export default function CensorOverrideDialog() {
  const track = useCensorDialogStore((s) => s.track)
  const close = useCensorDialogStore((s) => s.close)
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(false)
  const [link, setLink] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!track) return undefined
    let cancelled = false
    setCandidates([])
    setLink('')
    setLoading(true)
    api
      .get('/censorship/candidates', {
        params: { title: track.title, artist: track.artist, duration: Math.round(track.duration || 0) },
        skipErrorToast: true,
      })
      .then((response) => {
        if (!cancelled) setCandidates(response.data || [])
      })
      .catch((error) => console.error('Censor candidates failed:', error))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [track])

  useEffect(() => {
    if (!track) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [track, close])

  if (!track) return null

  const linkOriginal = async (soundcloud) => {
    if (!soundcloud || saving) return
    setSaving(true)
    try {
      const response = await api.post('/censorship/overrides', {
        video_id: track.external_id,
        title: track.title,
        artist: track.artist,
        soundcloud,
      })
      toast.success(`Теперь играет оригинал: ${response.data.original_title}`)
      close()
    } catch (error) {
      console.error('Censor override failed:', error)
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (e) => {
    e.preventDefault()
    linkOriginal(link.trim())
  }

  return createPortal(
    <div
      className="atp-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="atp-dialog" role="dialog" aria-modal="true" aria-labelledby="censor-title">
        <div className="atp-header">
          <div className="atp-heading">
            <div className="atp-title" id="censor-title">Оригинал без цензуры</div>
            <div className="atp-subtitle">
              {track.artist} — {track.title}
            </div>
          </div>
          <button type="button" className="atp-close" onClick={close} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>

        <form className="atp-create-form" onSubmit={onSubmit}>
          <input
            className="atp-create-input"
            type="url"
            inputMode="url"
            placeholder="Ссылка на трек в SoundCloud"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={saving}
          />
          <div className="atp-create-actions">
            <button type="submit" className="atp-btn atp-btn-primary" disabled={!link.trim() || saving}>
              Привязать
            </button>
          </div>
        </form>

        <div className="atp-body">
          <div className="censor-hint">Или выберите залив из найденных на SoundCloud</div>
          {loading ? (
            <div className="atp-status">Ищем на SoundCloud…</div>
          ) : candidates.length === 0 ? (
            <div className="atp-status">Похожих заливов не нашлось — вставьте ссылку</div>
          ) : (
            <ul className="atp-list">
              {candidates.map((candidate) => (
                <li key={candidate.id} className="censor-row">
                  <button
                    type="button"
                    className="atp-row"
                    onClick={() => linkOriginal(candidate.id)}
                    disabled={saving}
                  >
                    {candidate.cover_url ? (
                      <img className="atp-row-cover" src={candidate.cover_url} alt="" loading="lazy" />
                    ) : (
                      <span className="atp-row-cover"><Music size={20} /></span>
                    )}
                    <span className="atp-row-text">
                      <span className="atp-row-name">{candidate.title}</span>
                      <span className="atp-row-meta">
                        {candidate.official && <BadgeCheck size={13} className="censor-official" aria-label="Аккаунт артиста" />}
                        {candidate.uploader} · {formatDuration(candidate.duration)}
                      </span>
                    </span>
                  </button>
                  <a
                    className="censor-listen"
                    href={candidate.permalink}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Послушать «${candidate.title}» на SoundCloud`}
                  >
                    <ExternalLink size={18} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
