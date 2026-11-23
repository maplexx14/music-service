import { useMemo, useRef } from 'react'
import TrackTableRow from './TrackTableRow'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import { toast } from '../store/toastStore'
import { getTrackDbId } from '../utils/identifiers'
import '../pages/PlaylistDetail.css'

export default function SearchTrackTable({ tracks, onPlay, trackMenu }) {
  const currentTrackId = usePlayerStore((state) => state.currentTrack?.id)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const likedTrackIds = usePlayerStore((state) => state.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((state) => state.pendingLikeKeys)
  const likedSet = useMemo(() => new Set(likedTrackIds), [likedTrackIds])
  const contextProps = useMemo(() => tracks.map((track) => trackMenu.getProps(track)), [tracks, trackMenu.getProps])
  const actionsRef = useRef(null)
  actionsRef.current = {
    play: onPlay,
    openMenu: trackMenu.open,
    toggleLike: async (track, event) => {
      event.stopPropagation()
      try {
        await usePlayerStore.getState().toggleLikeForTrack(track)
      } catch (error) {
        console.error('Search track like failed:', error)
        toast.error('Не удалось обновить понравившиеся')
      }
    },
  }
  const hasDownloads = tracks.some((track) => track.download_allowed && track.download_url)

  return (
    <div className={`search-desktop-tracks${hasDownloads ? ' search-desktop-tracks--downloads' : ''}`}>
      <table className="tracks-table">
        <colgroup>
          <col />
          <col className="search-track-artist-column" />
          <col className="search-track-album-column" />
          <col className="search-track-duration-column" />
          <col className="search-track-actions-column" />
        </colgroup>
        <tbody>
          {tracks.map((track, index) => {
            const isCurrent = currentTrackId === track.id
            const dbId = getTrackDbId(track)
            const isLiked = likedSet.has(dbId) || pendingLikeKeys.includes(trackLikeKey(track))
            return (
              <TrackTableRow
                key={track.id}
                track={track}
                index={index}
                isCurrent={isCurrent}
                isPlaying={isCurrent && isPlaying}
                isLiked={isLiked}
                showNumber={false}
                showBadges
                showSource
                showDownload
                contextProps={contextProps[index]}
                actionsRef={actionsRef}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
