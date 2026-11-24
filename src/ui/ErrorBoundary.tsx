import { Component, type ReactNode } from 'react'

/** Last-resort guard: a render fault shows a recoverable message instead of a blank WebView. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('[questling] UI error:', error.message)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="onboard" style={{ justifyContent: 'center' }}>
        <div className="eyebrow">Something tripped</div>
        <h1 style={{ margin: '6px 0 10px' }}>The page tore a little.</h1>
        <p className="muted">Your quests and progress are saved on this device. Reload to continue.</p>
        <button type="button" className="btn primary block" onClick={() => location.reload()}>
          Reload Questling
        </button>
      </div>
    )
  }
}
