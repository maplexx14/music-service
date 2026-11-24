import { useEffect, useId, useRef, useState } from 'react'
import { Palette, RotateCcw, X } from '@/components/icons'
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

export function CdPlayerCustomizer({ active = true }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const panelId = useId()
  const visible = open && active

  useEffect(() => { if (!active) setOpen(false) }, [active])
  useEffect(() => {
    if (!visible) return undefined
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
      }
    }
    panelRef.current?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [visible])

  return (
    <div ref={rootRef} className="cd-customizer" hidden={!active} onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button ref={triggerRef} type="button" className="cd-customizer-trigger" aria-expanded={visible} aria-controls={visible ? panelId : undefined} onClick={() => setOpen((value) => !value)}><Palette size={16} aria-hidden="true" />Оформить</button>
      {visible && (
        <section ref={panelRef} id={panelId} className="cd-customizer-panel" tabIndex={-1} aria-labelledby={`${panelId}-title`}>
          <div className="cd-customizer-header">
            <h2 id={`${panelId}-title`}>Мой проигрыватель</h2>
            <button type="button" className="cd-customizer-close" aria-label="Закрыть оформление проигрывателя" onClick={() => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }) }}><X size={18} aria-hidden="true" /></button>
          </div>
          <CdPlayerAppearance />
          <p className="cd-customizer-hint">Сохраняется на этом устройстве</p>
        </section>
      )}
    </div>
  )
}
