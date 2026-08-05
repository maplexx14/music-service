// Длительность трека в M:SS. Источники иногда отдают её нулём или null
// (у внешнего трека она бывает неизвестна до резолва) — в таком случае
// вызывающий должен ничего не рисовать, поэтому возвращаем пустую строку,
// а не обманчивый «0:00».
export const formatDuration = (seconds) => {
  const total = Math.floor(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return ''
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
