import { useState } from 'react'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import './Settings.css'

function Settings() {
  const { color, animate, waveGif, setColor, setAnimation, setWaveGif } = useWaveSettingsStore()
  const [gifError, setGifError] = useState('')

  const handleGifChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.type !== 'image/gif') {
      setGifError('Можно загрузить только GIF файл')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setWaveGif(reader.result)
      setGifError('')
    }
    reader.readAsDataURL(file)
  }

  const handleGifClear = () => {
    setWaveGif(null)
    setGifError('')
  }

  return (
    <div className="page-container">
      <div className="settings-header">
        <h1>Настройки</h1>
        <p>Оформление и поведение виджетов</p>
      </div>

      <div className="settings-card">
        <h2>Моя волна</h2>
        <div className="settings-row">
          <div className="settings-label">Цвет окружности</div>
          <div className="settings-control">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Цвет волны"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="settings-color-text"
              maxLength={7}
            />
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">Анимация окружности</div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={animate}
              onChange={(e) => setAnimation(e.target.checked)}
            />
            <span className="settings-toggle-slider" />
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-label">GIF вместо текста</div>
          <div className="settings-gif">
            {waveGif ? (
              <div className="settings-gif-preview">
                <img src={waveGif} alt="Wave gif" />
                <button type="button" onClick={handleGifClear}>
                  Убрать
                </button>
              </div>
            ) : (
              <label className="settings-gif-upload">
                <input type="file" accept="image/gif" onChange={handleGifChange} />
                Загрузить GIF
              </label>
            )}
            {gifError && <div className="settings-error">{gifError}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings
