import { Palette, RotateCcw } from '@/components/icons'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import { CD_ACCENT_COLORS, CD_BODY_COLORS, CD_FINISHES, CD_LIDS, DEFAULT_CD_APPEARANCE } from '../utils/cdPlayerAppearance'
import './CdPlayerAppearance.css'

const contrastText = (color) => {
  const value = Number.parseInt(color.slice(1), 16)
  const red = value >> 16
  const green = (value >> 8) & 255
  const blue = value & 255
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 150 ? '#111214' : '#ffffff'
}

export default function CdPlayerAppearance({ showAccentColors = true }) {
  const appearance = useUiSettingsStore((s) => s.cdPlayerAppearance)
  const setAppearance = useUiSettingsStore((s) => s.setCdPlayerAppearance)
  const resetAppearance = useUiSettingsStore((s) => s.resetCdPlayerAppearance)
  const isDefault = Object.entries(DEFAULT_CD_APPEARANCE).every(([key, value]) => appearance[key] === value)

  return (
    <div className="cd-appearance-controls">
      <fieldset className="cd-appearance-field">
        <legend>Цвет корпуса</legend>
        <div className="cd-appearance-body-colors">
          {CD_BODY_COLORS.map(({ color, label }) => (
            <button key={color} type="button" className="cd-appearance-color" style={{ '--cd-option-color': color, '--cd-option-text': contrastText(color) }} aria-label={`Корпус: ${label}`} aria-pressed={appearance.bodyColor === color} onClick={() => setAppearance({ bodyColor: color })}>
              {label}
            </button>
          ))}
        </div>
        <label className="cd-appearance-custom-color">
          <span>Свой цвет</span>
          <input type="color" value={appearance.bodyColor} onChange={(event) => setAppearance({ bodyColor: event.target.value })} aria-label="Свой цвет корпуса" />
        </label>
      </fieldset>
      <fieldset className="cd-appearance-field">
        <legend>Материал корпуса</legend>
        <div className="cd-appearance-segments">
          {CD_FINISHES.map(({ id, label }) => (
            <button key={id} type="button" data-finish={id} aria-pressed={appearance.finish === id} onClick={() => setAppearance({ finish: id })}>{label}</button>
          ))}
        </div>
      </fieldset>
      {showAccentColors && (
        <fieldset className="cd-appearance-field">
          <legend>Кнопки</legend>
          <div className="cd-appearance-accent-colors">
            {CD_ACCENT_COLORS.map(({ color, label }) => (
              <button key={color} type="button" className="cd-appearance-accent" style={{ backgroundColor: color }} aria-label={`Кнопки: ${label}`} title={label} aria-pressed={appearance.accentColor === color} onClick={() => setAppearance({ accentColor: color })} />
            ))}
            <label className="cd-appearance-accent-custom" title="Свой цвет кнопок">
              <Palette size={17} aria-hidden="true" />
              <input type="color" value={appearance.accentColor} onChange={(event) => setAppearance({ accentColor: event.target.value })} aria-label="Свой цвет кнопок" />
            </label>
          </div>
        </fieldset>
      )}
      <fieldset className="cd-appearance-field">
        <legend>Крышка</legend>
        <div className="cd-appearance-segments">
          {CD_LIDS.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={appearance.lid === id} onClick={() => setAppearance({ lid: id })}>{label}</button>
          ))}
        </div>
      </fieldset>
      <button type="button" className="cd-appearance-reset" disabled={isDefault} onClick={resetAppearance}><RotateCcw size={14} aria-hidden="true" />Вернуть исходный вид</button>
    </div>
  )
}
