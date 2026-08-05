import { useCallback, useEffect, useState } from 'react'

// Сколько карточек рисуем сразу и сколько добавляем за шаг догрузки.
const DEFAULT_BATCH = 12
// Запас до конца списка, при заходе в который подгружается следующая партия:
// карточки успевают смонтироваться и вытянуть обложки до того, как
// пользователь до них доскроллит.
const DEFAULT_MARGIN = '400px'

/**
 * Постраничная отрисовка длинного списка по мере прокрутки.
 *
 * В DOM живёт только видимая часть: остальное дорисовывается партиями, когда
 * маячок в конце списка входит в зону предзагрузки. Данные при этом уже все на
 * руках — экономим не сеть под них, а разметку и, главное, обложки: каждая
 * карточка тянет картинку, и рисовать сразу всю медиатеку значит выстрелить
 * сотней запросов за тем, что никто не увидит.
 *
 * rootRef — скроллящийся контейнер, если список прокручивается не страницей
 * (горизонтальная лента). По умолчанию считается видимость во вьюпорте.
 *
 * keepRendered — не возвращаться к первой партии при смене списка. Нужно там,
 * где список правится на месте (создание, удаление): схлопывать из-за одной
 * такой правки всё уже отрисованное незачем. По умолчанию новый список — это
 * новая выдача, и счётчик сбрасывается.
 *
 * Маячок ставится сразу после списка: sentinelRef нужно повесить на пустой
 * элемент-сосед, а не на последнюю карточку.
 */
export function useLazyBatch(
  items,
  { batchSize = DEFAULT_BATCH, rootRef, rootMargin = DEFAULT_MARGIN, keepRendered = false } = {},
) {
  // Маячок держим в состоянии, а не в useRef: секция со списком может
  // отмонтироваться и вернуться (переключение вкладок на главной), а смену
  // ref.current эффект не замечает — наблюдатель остался бы висеть на узле,
  // которого в документе больше нет, и догрузка молча переставала бы работать.
  const [sentinel, setSentinel] = useState(null)
  const sentinelRef = useCallback((node) => setSentinel(node), [])
  const [visibleCount, setVisibleCount] = useState(batchSize)

  // Новый список (другой поисковый запрос) — снова первая партия. Сброс идёт
  // прямо в рендере, а не в эффекте: в эффекте новый список успел бы
  // отрисоваться со старым visibleCount, то есть десятком лишних карточек с
  // обложками, которые тут же размонтируются.
  const [renderedItems, setRenderedItems] = useState(items)
  if (items !== renderedItems) {
    setRenderedItems(items)
    if (!keepRendered) setVisibleCount(batchSize)
  }

  useEffect(() => {
    if (!sentinel || visibleCount >= items.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + batchSize, items.length))
        }
      },
      { root: rootRef?.current ?? null, rootMargin },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel, items, visibleCount, batchSize, rootRef, rootMargin])

  return {
    visibleItems: items.slice(0, visibleCount),
    sentinelRef,
    hasMore: visibleCount < items.length,
  }
}

export default useLazyBatch
