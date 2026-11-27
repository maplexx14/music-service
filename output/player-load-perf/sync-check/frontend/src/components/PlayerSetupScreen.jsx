import { useEffect, useRef } from 'react'
import { ArrowRight } from '@/components/icons'
import CdPlayerAppearance from './CdPlayerAppearance'
import UnboxPlayer from './UnboxPlayer'
import '../styles/controls.css'
import '../pages/PlayerSetup.css'

export default function PlayerSetupScreen({ stage, onStageChange, onFinish, saving = false, error = '', diagnostic = false }) {
  const headingRef = useRef(null)
  const customize = stage === 'customize'
  useEffect(() => { if (customize) headingRef.current?.focus({ preventScroll: true }) }, [customize])
  return <main className="player-setup-page" data-stage={stage}>
    <div className="player-setup-content" data-stage={stage}>
      <div className="player-setup-display">
        <UnboxPlayer stage={stage} onUnboxed={() => onStageChange('unboxed')} onReady={() => onStageChange('customize')} />
      </div>
      {customize && <section className="player-setup-appearance" aria-labelledby="player-setup-title">
        <header className="player-setup-header">
          <h1 id="player-setup-title" ref={headingRef} tabIndex={-1}>Персонализируйте свой плеер</h1>
        </header>
        <CdPlayerAppearance showAccentColors={false} />
        <footer className="player-setup-footer">
          {error && <p className="player-setup-error" role="alert">{error}</p>}
          <button type="button" className="btn btn--primary btn--lg player-setup-button player-setup-finish" disabled={saving} onClick={onFinish} aria-busy={saving || undefined}>{saving ? 'Сохраняем…' : diagnostic ? 'Вернуться в диагностику' : 'Начать слушать'}<ArrowRight size={18} aria-hidden="true" /></button>
          <p>{diagnostic ? 'Диагностический повтор не сбрасывает прохождение этапа.' : 'Оформление можно изменить позже.'}</p>
        </footer>
      </section>}
    </div>
  </main>
}
