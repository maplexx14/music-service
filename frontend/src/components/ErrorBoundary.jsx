import { Component } from 'react'
import { isChunkLoadError, reloadForStaleBuild } from '../services/staleBuild'

// Корневой предохранитель: без него любое исключение при рендере размонтирует
// всё дерево, и на iOS-PWA остаётся чёрный экран без выхода (нет адресной
// строки, нет кнопки «обновить»). Стили инлайном — CSS-чанк мог не загрузиться.
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('[ErrorBoundary]', error)
    if (isChunkLoadError(error)) reloadForStaleBuild()
  }

  handleReload = () => {
    try {
      sessionStorage.removeItem('bolt-stale-reload-at')
    } catch {
      // ignore
    }
    reloadForStaleBuild()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          color: '#fff',
          background: '#000',
          fontFamily: '-apple-system, system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 17 }}>Не удалось загрузить приложение</div>
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            padding: '12px 24px',
            borderRadius: 12,
            border: 'none',
            background: '#fff',
            color: '#000',
            fontSize: 16,
          }}
        >
          Обновить
        </button>
      </div>
    )
  }
}
