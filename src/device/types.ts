import type { PageSpec } from '../glasses/page'
import type { KV } from '../storage/kv'

export type GlassesInput =
  | { kind: 'tap' }
  | { kind: 'double' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'select'; index: number }
  | { kind: 'long_press' }
  | { kind: 'long_release' }
  | { kind: 'menu'; itemId: number }

export type Lifecycle = 'foreground' | 'background' | 'exit'

export interface RenderStats {
  rebuilds: number
  textUpdates: number
  imageUpdates: number
  failures: string[]
  lastScreen: string
}

/** One adapter interface for the real Even host bridge and the labelled browser preview. */
export interface Device {
  readonly kind: 'even' | 'preview'
  readonly label: string
  readonly kv: KV
  readonly supportsMic: boolean
  render(page: PageSpec): void
  onInput(cb: (input: GlassesInput) => void): () => void
  onLifecycle(cb: (e: Lifecycle) => void): () => void
  onAudio(cb: (pcm: Uint8Array) => void): () => void
  startMic(): Promise<boolean>
  stopMic(): Promise<void>
  /** root double-tap: system exit confirmation (QA rule) */
  requestExit(): Promise<void>
  stats(): RenderStats
  dispose(): void
}
