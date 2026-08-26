import { useEffect, useState } from 'react'
import api from '../services/api'
import GenreSelect from './GenreSelect'
import ArtistSelect from './ArtistSelect'
import './PreferencePicker.css'

/**
 * Переиспользуемый выбор музыкальных предпочтений (жанры + артисты).
 * Контролируемый: value = { genres: string[], artists: string[],
 * excludedArtists: string[] }.
 *
 * Сам выбор живёт в GenreSelect/ArtistSelect — те же компоненты онбординг
 * показывает по одному на шаг. Здесь остаётся композиция для настроек, где
 * оба блока нужны на одной странице, и загрузка вкуса, выведенного из
 * прослушиваний (общего для обоих блоков).
 */
function PreferencePicker({ value, onChange }) {
  const selectedGenres = value?.genres || []
  const selectedArtists = value?.artists || []
  const excludedArtists = value?.excludedArtists || []

  // Вкус, выведенный из прослушиваний — тот же профиль, что строит волну.
  const [detected, setDetected] = useState({ genres: [], artists: [] })

  useEffect(() => {
    let active = true
    api
      .get('/users/me/taste')
      .then((res) => {
        if (active) {
          setDetected({
            genres: res.data?.genres || [],
            artists: res.data?.artists || [],
          })
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="pref-picker">
      <section className="pref-section">
        <h3 className="pref-title">Любимые жанры</h3>
        <p className="pref-subtitle">
          Выберите то, что вам ближе — это настроит ваш поток
        </p>
        <GenreSelect
          selected={selectedGenres}
          detected={detected.genres}
          onChange={(genres) =>
            onChange({ genres, artists: selectedArtists, excludedArtists })
          }
        />
      </section>

      <section className="pref-section">
        <h3 className="pref-title">Любимые артисты</h3>
        <p className="pref-subtitle">
          Начните вводить имя или выберите из подсказок
        </p>
        <ArtistSelect
          selected={selectedArtists}
          excluded={excludedArtists}
          detected={detected.artists}
          genres={selectedGenres}
          onChange={({ artists, excludedArtists: nextExcluded }) =>
            onChange({
              genres: selectedGenres,
              artists,
              excludedArtists: nextExcluded,
            })
          }
        />
      </section>
    </div>
  )
}

export default PreferencePicker
