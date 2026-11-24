import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { EvenDevice } from './even'
import { PreviewDevice } from './preview'
import type { Device } from './types'

/**
 * Pick the runtime adapter. The SDK needs `window.flutter_inappwebview.callHandler`
 * (README "Requirements"): present inside the Even app and the official simulator,
 * absent in an ordinary browser → labelled preview.
 */
export async function detectDevice(): Promise<Device> {
  const force = new URLSearchParams(location.search).get('device')
  if (force === 'preview') return new PreviewDevice()
  const hasHost = () => typeof (window as unknown as { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview?.callHandler === 'function'
  // the host may inject the handler shortly after load
  for (let i = 0; i < 10 && !hasHost(); i++) await new Promise((r) => setTimeout(r, 100))
  if (!hasHost()) return new PreviewDevice()
  try {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('bridge_timeout')), 6000)),
    ])
    return new EvenDevice(bridge)
  } catch {
    return new PreviewDevice()
  }
}
