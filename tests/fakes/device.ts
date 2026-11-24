import type { Device, GlassesInput, Lifecycle, RenderStats } from '../../src/device/types'
import type { PageSpec } from '../../src/glasses/page'
import { MemoryKV } from '../../src/storage/kv'

/** In-memory Device double for controller tests (records every rendered page and mic state). */
export class FakeDevice implements Device {
  readonly kind = 'even' as const
  readonly label = 'fake'
  readonly supportsMic = true
  pages: PageSpec[] = []
  micOn = false
  micStarts = 0
  private inputs = new Set<(i: GlassesInput) => void>()
  private lifes = new Set<(l: Lifecycle) => void>()
  private audios = new Set<(p: Uint8Array) => void>()
  constructor(public kv = new MemoryKV()) {}
  render(p: PageSpec) {
    this.pages.push(p)
  }
  get last(): PageSpec {
    return this.pages[this.pages.length - 1]!
  }
  allText(): string {
    const p = this.last
    return [...p.texts.map((t) => t.content), ...p.lists.flatMap((l) => l.items)].join('\n')
  }
  input(i: GlassesInput) {
    for (const cb of this.inputs) cb(i)
  }
  life(l: Lifecycle) {
    for (const cb of this.lifes) cb(l)
  }
  audio(p: Uint8Array) {
    for (const cb of this.audios) cb(p)
  }
  onInput(cb: (i: GlassesInput) => void) {
    this.inputs.add(cb)
    return () => this.inputs.delete(cb)
  }
  onLifecycle(cb: (l: Lifecycle) => void) {
    this.lifes.add(cb)
    return () => this.lifes.delete(cb)
  }
  onAudio(cb: (p: Uint8Array) => void) {
    this.audios.add(cb)
    return () => this.audios.delete(cb)
  }
  async startMic() {
    this.micOn = true
    this.micStarts++
    return true
  }
  async stopMic() {
    this.micOn = false
  }
  async requestExit() {}
  stats(): RenderStats {
    return { rebuilds: 0, textUpdates: 0, imageUpdates: 0, failures: [], lastScreen: this.last?.screen ?? '' }
  }
  dispose() {}
}
