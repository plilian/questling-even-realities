import { createRoot } from 'react-dom/client'
import '@fontsource-variable/fraunces/opsz.css'
import '@fontsource-variable/fraunces/opsz-italic.css'
import '@fontsource/atkinson-hyperlegible/latin-400.css'
import '@fontsource/atkinson-hyperlegible/latin-700.css'
import './ui/styles.css'
import { App } from './ui/App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { app } from './app/controller'
import { detectDevice } from './device/detect'
import { PreviewDevice } from './device/preview'

async function start() {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <ErrorBoundary>
      <App preview={null} />
    </ErrorBoundary>,
  )
  const device = await detectDevice()
  const params = new URLSearchParams(location.search)
  const demoParam = params.get('demo')
  await app.boot(device, { forceDemo: demoParam === '1', resetDemo: demoParam === 'reset', demoNotes: !!demoParam && params.get('notes') === 'demo' })
  console.log(`[questling] ready · device=${device.kind} · mode=${app.getSnapshot().mode}`)
  root.render(
    <ErrorBoundary>
      <App preview={device instanceof PreviewDevice ? device : null} />
    </ErrorBoundary>,
  )
  window.addEventListener('beforeunload', () => app.dispose())
}

void start()
