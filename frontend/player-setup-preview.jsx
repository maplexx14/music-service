import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ChevronRight,
  Disc3,
  Heart,
  Home,
  Library,
  Play,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import PlayerSetupScreen from './src/components/PlayerSetupScreen'
import boltWordmark from './src/assets/bolt-wordmark.webp'
import playerInviteLogo from './src/assets/player-invite-logo.jpg'
import { useUiSettingsStore } from './src/store/uiSettingsStore'
import { DEFAULT_CD_APPEARANCE, normalizeCdAppearance } from './src/utils/cdPlayerAppearance'
import './player-setup-preview.css'

const params = new URLSearchParams(window.location.search)
const requestedStage = params.get('stage')
const hasDirectStage = ['boxed', 'unboxed', 'customize'].includes(requestedStage)
const initialStage = hasDirectStage ? requestedStage : 'boxed'
const requestedScroll = params.get('scroll')
const directSetup = hasDirectStage || params.get('audience') === 'new'

const mixes = [
  { title: 'Для вас', subtitle: 'Lana Del Rey, The Weeknd', tone: 'violet', glyph: 'B' },
  { title: 'Микс дня', subtitle: 'Tame Impala, Men I Trust', tone: 'sunset', glyph: '24' },
  { title: 'На повторе', subtitle: 'То, что хочется включить снова', tone: 'blue', glyph: '↻' },
  { title: 'Тихий вечер', subtitle: 'Спокойная музыка без спешки', tone: 'green', glyph: '≈' },
]

const recent = [
  { title: 'After Hours', artist: 'The Weeknd', tone: 'red' },
  { title: 'Currents', artist: 'Tame Impala', tone: 'purple' },
  { title: 'Charm', artist: 'Clairo', tone: 'cream' },
]

// Preview changes are kept in memory, including when served on the app's origin.
useUiSettingsStore.setState({
  cdPlayerAppearance: { ...DEFAULT_CD_APPEARANCE },
  setCdPlayerAppearance: (patch) => useUiSettingsStore.setState((state) => ({
    cdPlayerAppearance: normalizeCdAppearance({ ...state.cdPlayerAppearance, ...patch }),
  })),
  resetCdPlayerAppearance: () => useUiSettingsStore.setState({ cdPlayerAppearance: { ...DEFAULT_CD_APPEARANCE } }),
})

function ExistingApp({ promptOpen, completed, onOpenSetup, onClosePrompt }) {
  return <main className="existing-preview-shell">
    <header className="existing-preview-header">
      <img src={boltWordmark} alt="BOLT" />
      <nav aria-label="Разделы">
        <button className="is-active" type="button"><Home size={18} />Главная</button>
        <button type="button"><Search size={18} />Поиск</button>
        <button type="button"><Library size={18} />Моя музыка</button>
      </nav>
      <button className="existing-preview-avatar" type="button" aria-label="Профиль">М</button>
    </header>

    <div className="existing-preview-layout">
      <aside className="existing-preview-sidebar">
        <p>Коллекция</p>
        <button type="button"><Heart size={17} />Любимые треки</button>
        <button type="button"><Disc3 size={17} />Альбомы</button>
        <div className="existing-preview-playlist">
          <span>Ваш плейлист</span>
          <strong>Ночные поездки</strong>
          <small>38 треков</small>
        </div>
      </aside>

      <section className="existing-preview-home" aria-label="Главная">
        {completed && <div className="existing-preview-success" role="status">
          <span><Sparkles size={17} />Проигрыватель добавлен. Оформление можно изменить в настройках.</span>
          <button type="button" onClick={onOpenSetup}>Посмотреть</button>
        </div>}

        {!completed && <button className="existing-preview-inline-card" type="button" onClick={onOpenSetup}>
          <span className="existing-preview-inline-icon"><Disc3 size={22} /></span>
          <span><strong>Ваш персональный проигрыватель готов</strong><small>Распакуйте и выберите оформление</small></span>
          <ChevronRight size={20} />
        </button>}

        <div className="existing-preview-greeting">
          <span>Вторник, 18 ноября</span>
          <h1>С возвращением, Максим</h1>
        </div>

        <section className="existing-preview-section">
          <div className="existing-preview-section-title"><h2>Подобрано для вас</h2><button type="button">Показать всё</button></div>
          <div className="existing-preview-mixes">
            {mixes.map((mix) => <button className="existing-preview-mix" type="button" key={mix.title}>
              <span className={`existing-preview-cover is-${mix.tone}`}><b>{mix.glyph}</b><i><Play size={18} fill="currentColor" /></i></span>
              <strong>{mix.title}</strong>
              <small>{mix.subtitle}</small>
            </button>)}
          </div>
        </section>

        <section className="existing-preview-section">
          <div className="existing-preview-section-title"><h2>Недавно слушали</h2></div>
          <div className="existing-preview-recent">
            {recent.map((item) => <button type="button" key={item.title}>
              <span className={`existing-preview-album is-${item.tone}`}><Disc3 size={30} /></span>
              <span><strong>{item.title}</strong><small>{item.artist}</small></span>
              <Play size={17} fill="currentColor" />
            </button>)}
          </div>
        </section>
      </section>
    </div>

    {promptOpen && <div className="existing-preview-overlay" role="presentation">
      <section className="existing-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="existing-preview-dialog-title">
        <button className="existing-preview-dialog-close" type="button" aria-label="Закрыть" onClick={onClosePrompt}><X size={19} /></button>
        <div className="existing-preview-dialog-art" aria-hidden="true">
          <img src={playerInviteLogo} alt="" />
        </div>
        <div className="existing-preview-dialog-copy">
          <span className="existing-preview-kicker"><Sparkles size={14} />Обновление для вашего аккаунта</span>
          <h2 id="existing-preview-dialog-title">Ваш проигрыватель готов</h2>
          <p>Мы собрали для вас персональный CD‑проигрыватель. Библиотека, лайки и история прослушиваний уже на месте.</p>
          <button className="existing-preview-dialog-cta" type="button" onClick={onOpenSetup}>Получить проигрыватель<ChevronRight size={19} /></button>
          <small>Распаковка и оформление займут меньше минуты.</small>
        </div>
      </section>
    </div>}
  </main>
}

function Preview() {
  const [view, setView] = useState(directSetup ? 'setup' : 'home')
  const [promptOpen, setPromptOpen] = useState(!directSetup)
  const [completed, setCompleted] = useState(false)
  const [stage, setStage] = useState(initialStage)
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [simulateError, setSimulateError] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)

  useEffect(() => {
    if (view !== 'setup' || stage !== 'customize' || requestedScroll !== 'bottom') return undefined
    const frame = requestAnimationFrame(() => {
      const page = document.querySelector('.player-setup-page')
      page?.scrollTo({ top: page.scrollHeight })
    })
    return () => cancelAnimationFrame(frame)
  }, [stage, view])

  const jump = (next) => {
    setView('setup')
    setStage(next)
    setError('')
    setToolsOpen(false)
    setRevision((value) => value + 1)
  }

  const openSetup = () => {
    setPromptOpen(false)
    jump('boxed')
  }

  const finish = async () => {
    setSaving(true)
    setError('')
    await new Promise((resolve) => setTimeout(resolve, 650))
    setSaving(false)
    if (simulateError) {
      setError('Не удалось сохранить. Попробуйте ещё раз.')
      return
    }
    if (directSetup) {
      setCompleted(true)
      return
    }
    setCompleted(true)
    setView('home')
    setToolsOpen(false)
    window.scrollTo({ top: 0 })
  }

  if (view === 'home') {
    return <ExistingApp
      promptOpen={promptOpen}
      completed={completed}
      onOpenSetup={openSetup}
      onClosePrompt={() => setPromptOpen(false)}
    />
  }

  return <>
    <PlayerSetupScreen key={revision} stage={stage} onStageChange={setStage} onFinish={finish} saving={saving} error={error} />
    {stage === 'customize' && <button type="button" className="setup-preview-tools-toggle" aria-label="Открыть управление предпросмотром" aria-expanded={toolsOpen} onClick={() => setToolsOpen((value) => !value)}>⋯</button>}
    <aside className="setup-preview-toolbar" hidden={!toolsOpen} aria-label="Управление предпросмотром">
      <span>Предпросмотр</span>
      {!directSetup && <button disabled={saving} onClick={() => setView('home')}>В приложение</button>}
      <button disabled={saving} onClick={() => jump('boxed')}>Заново</button>
      <button disabled={saving} onClick={() => jump('customize')}>К оформлению</button>
      <label><input type="checkbox" checked={simulateError} onChange={(event) => setSimulateError(event.target.checked)} />Ошибка сохранения</label>
      {completed && <span role="status">Готово. Настройки проверены.</span>}
    </aside>
  </>
}

createRoot(document.getElementById('root')).render(<Preview />)
