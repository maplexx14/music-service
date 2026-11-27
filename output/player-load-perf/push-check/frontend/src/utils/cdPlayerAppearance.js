export const CD_BODY_COLORS = [
  { color: '#34393e', label: 'Графит' },
  { color: '#aeb7c2', label: 'Серебро' },
  { color: '#d9cbb4', label: 'Песочный' },
  { color: '#708777', label: 'Шалфей' },
  { color: '#657caa', label: 'Синий' },
  { color: '#aa7787', label: 'Розовый' },
]

export const CD_ACCENT_COLORS = [
  { color: '#c84940', label: 'Красный' },
  { color: '#a259ff', label: 'Фиолетовый' },
  { color: '#6dd9c5', label: 'Мятный' },
  { color: '#70bdff', label: 'Голубой' },
  { color: '#ffc272', label: 'Янтарный' },
  { color: '#ff84b1', label: 'Розовый' },
]

export const CD_FINISHES = [
  { id: 'brushed', label: 'Металл' },
  { id: 'matte', label: 'Матовый' },
  { id: 'glossy', label: 'Глянец' },
]

export const CD_LIDS = [
  { id: 'clear', label: 'Прозрачная' },
  { id: 'smoked', label: 'Дымчатая' },
]

export const DEFAULT_CD_APPEARANCE = Object.freeze({
  bodyColor: CD_BODY_COLORS[0].color,
  accentColor: CD_ACCENT_COLORS[1].color,
  finish: 'brushed',
  lid: 'clear',
})

const colorOrDefault = (value, fallback) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback

// Old or malformed storage must never pass invalid colors into Three.js.
export function normalizeCdAppearance(value) {
  const appearance = value && typeof value === 'object' ? value : {}
  return {
    bodyColor: colorOrDefault(appearance.bodyColor, DEFAULT_CD_APPEARANCE.bodyColor),
    accentColor: colorOrDefault(appearance.accentColor, DEFAULT_CD_APPEARANCE.accentColor),
    finish: CD_FINISHES.some(({ id }) => id === appearance.finish) ? appearance.finish : DEFAULT_CD_APPEARANCE.finish,
    lid: CD_LIDS.some(({ id }) => id === appearance.lid) ? appearance.lid : DEFAULT_CD_APPEARANCE.lid,
  }
}

// Restore graphite for the previous silver/red default. Customized appearances
// remain intact, including silver/red selected again after this revision.
export function restoreCdAppearance(value, version) {
  const appearance = normalizeCdAppearance(value)
  if (version !== 3 && appearance.bodyColor === '#aeb7c2' && appearance.accentColor === '#c84940' &&
      appearance.finish === 'brushed' && appearance.lid === 'clear') {
    return { ...DEFAULT_CD_APPEARANCE }
  }
  return appearance
}
