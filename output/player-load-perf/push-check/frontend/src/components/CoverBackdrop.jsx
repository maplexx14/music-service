import { useEffect, useMemo } from 'react'
import { resolveCoverUrl } from '../utils/media'
import { useCoverTint } from '../hooks/useThemeColor'
import { heroImageStyle, useHeroCover } from '../hooks/useHeroCover'
import { useScreen } from '../hooks/useScreen'

// Фон страниц с шапкой (исполнитель, альбом, плейлисты, «Понравившиеся») —
// как у полноэкранного плеера: приглушённый цвет обложки (useCoverTint),
// поверх зерно и затемнение книзу, а на телефоне — сама обложка во весь
// верх экрана, растворяющаяся в этот цвет. Обложка, что не годится на весь
// экран (превью клипа 16:9, мелкая), остаётся квадратом в шапке. Стили —
// .cover-backdrop в Artist.css.
export function useCoverBackdrop(coverUrl) {
  const thumb = resolveCoverUrl(coverUrl, 'thumb')
  const tint = useCoverTint(thumb)
  const heroInfo = useHeroCover(resolveCoverUrl(coverUrl, 'hero'), { guessOnChange: true })
  const hero = useMemo(() => (heroInfo ? { ...heroInfo, thumb } : null), [heroInfo, thumb])
  return { tint, hero }
}

// art — своя картинка во весь верх вместо обложки (сердце «Понравившихся»
// без обложки); у страницы тогда тоже has-cover-hero.
// Верх сердца «Понравившихся» (--hero-c1/--hero-c2 в Artist.css).
const ART_THEME_COLOR = '#8f45f5'

// iOS в PWA сама темнит зону под часами по theme-color, а у приложения он
// почти чёрный — над обложкой во весь верх выходила тёмная полоса. Пока
// страница на экране, статус-бар в цвет её шапки; уходим — возвращаем.
function useHeaderThemeColor(color) {
  const { active } = useScreen()
  useEffect(() => {
    if (!active || !color) return undefined
    const meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) return undefined
    const previous = meta.getAttribute('content')
    meta.setAttribute('content', color)
    return () => meta.setAttribute('content', previous)
  }, [active, color])
}

function CoverBackdrop({ tint, hero, art }) {
  useHeaderThemeColor(art ? ART_THEME_COLOR : hero ? tint : null)
  return (
    <div className="cover-backdrop" aria-hidden="true">
      {/* Новый цвет проявляется слоем поверх нейтрального (opacity ведёт
          композитор), а не transition background-color по всей странице. */}
      {tint && <div key={tint} className="cover-backdrop-tint" style={{ backgroundColor: tint }} />}
      {art ? (
        <div className="cover-backdrop-hero">{art}</div>
      ) : hero && (
        <div className="cover-backdrop-hero">
          <img
            key={hero.url}
            className="cover-backdrop-hero-img"
            src={hero.url}
            style={heroImageStyle(hero)}
            alt=""
            data-no-fade=""
            decoding="async"
            draggable={false}
          />
        </div>
      )}
    </div>
  )
}

export default CoverBackdrop
