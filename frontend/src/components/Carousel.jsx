import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useLazyBatch } from '../hooks/useLazyBatch'
import './Carousel.css'

const DEFAULT_BATCH = 8
// Запас считается по горизонтали: у вертикальной оси ленты прокрутки нет.
const PRELOAD_MARGIN = '0px 400px'

/**
 * Горизонтальная лента карточек с ленивой отрисовкой (см. useLazyBatch).
 *
 * renderItem работает как колбэк .map: он же и проставляет key.
 */
function Carousel({ items, renderItem, batchSize = DEFAULT_BATCH, label, itemWidth }) {
  const trackRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // root — сама лента, так что считается горизонтальная видимость внутри неё,
  // а не во вьюпорте страницы.
  const { visibleItems, sentinelRef } = useLazyBatch(items, {
    batchSize,
    rootRef: trackRef,
    rootMargin: PRELOAD_MARGIN,
  })

  // Новый список — лента остаётся прокрученной на позицию прошлой выдачи.
  // Мотаем в начало мгновенно: плавная прокрутка по CSS здесь только смазала бы
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
  }, [updateArrows, items, visibleItems.length])

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    // Стрелки зависят от ширины ленты: на повороте экрана и ресайзе окна
    // прокрутка может исчезнуть совсем, и стрелки должны погаснуть.
    const observer = new ResizeObserver(updateArrows)
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateArrows])

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
        {visibleItems.map(renderItem)}
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
