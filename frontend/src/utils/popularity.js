// Популярность трека в 0..1 — для сортировки «всё вместе» на странице
// артиста. Счётчики двух шкал нельзя сравнивать напрямую: у треков медиатеки
// play_count — наш собственный счётчик (сотни прослушиваний уже много), у
// внешних — метрика площадки (views у YouTube Music, playback_count у
// SoundCloud, где сотни означает «никто не слушал»). Сводим обе кривой
// log1p к своей опорной величине; сами величины и обоснование —
// recommendation_scoring.py на бэке (LOCAL/SERVICE_POPULARITY_REFERENCE).
const LOCAL_POPULARITY_REFERENCE = 400
const SERVICE_POPULARITY_REFERENCE = 3_000_000

const ramp = (count, reference) =>
  Math.log1p(Math.max(0, count || 0)) / Math.log1p(reference)

// Внешние треки приходят со строковым id ("ytmusic:…", "soundcloud:…"),
// треки из БД — с числовым.
export const trackPopularity = (track) =>
  typeof track?.id === 'number'
    ? ramp(track.play_count, LOCAL_POPULARITY_REFERENCE)
    : ramp(track.play_count, SERVICE_POPULARITY_REFERENCE)
