import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import './Carousel.css'

// Сколько карточек рисуем сразу и сколько добавляем за шаг догрузки.
const DEFAULT_BATCH = 8
// Запас за правым краем ленты, при заходе в который подгружается следующая
// партия. Карточки успевают смонтироваться и загрузить обложки до того, как
// пользователь до них доскроллит.
const PRELOAD_MARGIN = '0px 400px'

/**
 * Горизонтальная лента карточек с ленивой отрисовкой.
 *
 * В DOM живёт только видимая часть списка: остальное дорисовывается партиями,
 * когда маячок в конце ленты входит в зону предзагрузки. Это важнее, чем
 * кажется — карточка плейлиста тянет обложку, и рисовать сразу все результаты
 * поиска значит выстрелить десятками запросов за обложками, которые никто не
 * увидит.
 *
 * renderItem работает как колбэк .map: он же и проставляет key.
 */
function Carousel({ items, renderItem, batchSize = DEFAULT_BATCH, label, itemWidth }) {
  const trackRef = useRef(null)
  const sentinelRef = useRef(null)
  const [visibleCount, setVisibleCount] = useState(batchSize)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // Новый список (другой запрос в поиске) — снова первая партия. Сброс идёт
  // прямо в рендере, а не в эффекте: в эффекте новый список успел бы
  // отрисоваться со старым visibleCount, то есть десятком лишних карточек с
  // обложками, которые тут же размонтируются.
  const [renderedItems, setRenderedItems] = useState(items)
  if (items !== renderedItems) {
    setRenderedItems(items)
    setVisibleCount(batchSize)
  }

  // Лента при этом остаётся прокрученной на позицию прошлой выдачи — мотаем
  // в начало. Мгновенно: плавная прокрутка по CSS здесь только смазала бы
  // подмену содержимого.
  useEffect(() => {
    if (trackRef.current) trackRef.current.scrollTo({ left: 0, behavior: 'instant' })
  }, [items])

  const updateArrows = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    // Допуск в 1px: при дробном scrollLeft (зум, DPR≠1) точного равенства
    // краю не бывает, и стрелка «вперёд» не гасла бы никогда.
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateArrows()
  }, [updateArrows, items, visibleCount])

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    // Стрелки зависят от ширины ленты: на повороте экрана и ресайзе окна
    // прокрутка может исчезнуть совсем, и стрелки должны погаснуть.
    const observer = new ResizeObserver(updateArrows)
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateArrows])

  // Догрузка: root — сама лента, так что считается горизонтальная видимость
  // внутри неё, а не во вьюпорте страницы.
  useEffect(() => {
    const root = trackRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || visibleCount >= items.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + batchSize, items.length))
        }
      },
      { root, rootMargin: PRELOAD_MARGIN },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [items, visibleCount, batchSize])

  // Шаг стрелки — 80% ширины ленты: на экране остаётся карточка-«якорь» из
  // прошлого экрана, и не теряется ощущение непрерывности списка.
  const scrollByPage = (direction) => {
    const el = trackRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.8 })
  }

  if (items.length === 0) return null

  return (
    <div className="carousel" style={itemWidth ? { '--carousel-item-width': itemWidth } : undefined}>
      <button
        type="button"
        className="carousel-arrow carousel-arrow--prev"
        onClick={() => scrollByPage(-1)}
        disabled={!canScrollLeft}
        aria-label="Назад"
        tabIndex={-1}
      >
        <ChevronLeft size={20} />
      </button>

      <div
        className="carousel-track"
        ref={trackRef}
        onScroll={updateArrows}
        // Лента прокручивается — значит, до неё нужно уметь добраться с
        // клавиатуры, иначе её содержимое доступно только мышью.
        tabIndex={0}
        aria-label={label}
      >
        {items.slice(0, visibleCount).map(renderItem)}
        <div ref={sentinelRef} className="carousel-sentinel" aria-hidden="true" />
      </div>

      <button
        type="button"
        className="carousel-arrow carousel-arrow--next"
        onClick={() => scrollByPage(1)}
        disabled={!canScrollRight}
        aria-label="Вперёд"
        tabIndex={-1}
      >
        <ChevronRight size={20} />
      </button>
    </div>
  )
}

export default Carousel
