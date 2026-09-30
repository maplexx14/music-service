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

// Русское согласование числа: plural(1, 'трек', 'трека', 'треков') → «трек»,
// 2 → «трека», 5 и 11–14 → «треков».
export const plural = (n, one, few, many) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
