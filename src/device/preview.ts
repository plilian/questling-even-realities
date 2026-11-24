import { layoutKey, validatePage, CANVAS_H, CANVAS_W, type PageSpec } from '../glasses/page'
import { BrowserKV, type KV } from '../storage/kv'
import type { Device, GlassesInput, Lifecycle, RenderStats } from './types'

/**
 * Browser preview adapter — clearly labelled, NOT the Even SDK and NOT simulator evidence.
 * Draws the same PageSpec onto a 576×288 canvas (green-on-black approximation) and maps
 * keyboard/buttons to the verified G2 gesture set (up, down, tap, double-tap).
 * Microphone uses the browser's getUserMedia, resampled to the same 16 kHz s16le PCM.
 */
export class PreviewDevice implements Device {
  readonly kind = 'preview' as const
  readonly label = 'Browser preview (not SDK)'
  readonly kv: KV = new BrowserKV()
  readonly supportsMic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  private canvas: HTMLCanvasElement | null = null
  private page: PageSpec | null = null
  private listSel = new Map<string, number>()
  private lastKey = ''
  private images = new Map<string, HTMLImageElement>()
  private inputCbs = new Set<(i: GlassesInput) => void>()
  private lifeCbs = new Set<(e: Lifecycle) => void>()
  private audioCbs = new Set<(pcm: Uint8Array) => void>()
  private st: RenderStats = { rebuilds: 0, textUpdates: 0, imageUpdates: 0, failures: [], lastScreen: '' }
  private mic: { ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode } | null = null
  private visHandler = () => this.emitLife(document.visibilityState === 'visible' ? 'foreground' : 'background')

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visHandler)
  }

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas
    if (canvas) {
      canvas.width = CANVAS_W
      canvas.height = CANVAS_H
      this.draw()
    }
  }

  render(page: PageSpec) {
    const errs = validatePage(page)
    if (errs.length) {
      this.st.failures = [...this.st.failures.slice(-19), `invalid page ${page.screen}: ${errs.join('; ')}`]
      console.warn('[questling/preview] invalid page', page.screen, errs)
      return
    }
    const key = layoutKey(page)
    if (key !== this.lastKey) {
      this.st.rebuilds++
      this.listSel.clear()
    } else this.st.textUpdates++
    this.lastKey = key
    this.page = page
    this.st.lastScreen = page.screen
    this.draw()
  }

  /** Simulated input from the preview controls (same grammar as the touchpad). */
  inject(kind: 'up' | 'down' | 'tap' | 'double') {
    const p = this.page
    if (!p) return
    const list = p.lists.find((l) => l.capture)
    if (list) {
      const sel = this.listSel.get(list.name) ?? 0
      if (kind === 'up') this.listSel.set(list.name, Math.max(0, sel - 1))
      else if (kind === 'down') this.listSel.set(list.name, Math.min(list.items.length - 1, sel + 1))
      else if (kind === 'tap') this.emit({ kind: 'select', index: sel })
      else this.emit({ kind: 'double' })
      this.draw()
      return
    }
    this.emit(kind === 'tap' ? { kind: 'tap' } : kind === 'double' ? { kind: 'double' } : { kind })
  }

  private emit(i: GlassesInput) {
    for (const cb of this.inputCbs) cb(i)
  }
  private emitLife(l: Lifecycle) {
    for (const cb of this.lifeCbs) cb(l)
  }

  private img(src: string): HTMLImageElement {
    let im = this.images.get(src)
    if (!im) {
      im = new Image()
      im.onload = () => this.draw()
      im.src = src
      this.images.set(src, im)
      this.st.imageUpdates++
    }
    return im
  }

  private draw() {
    const c = this.canvas
    const p = this.page
    if (!c || !p) return
    const g = c.getContext('2d')
    if (!g) return
    g.fillStyle = '#000'
    g.fillRect(0, 0, CANVAS_W, CANVAS_H)
    g.imageSmoothingEnabled = false
    const green = (level = 15) => `rgba(60, 250, 68, ${0.25 + (level / 15) * 0.75})`
    for (const im of p.images) {
      const el = this.img(im.src)
      if (el.complete && el.naturalWidth) {
        // tint greyscale → green using an offscreen pass
        const off = document.createElement('canvas')
        off.width = im.w
        off.height = im.h
        const og = off.getContext('2d')!
        og.imageSmoothingEnabled = false
        og.drawImage(el, 0, 0, im.w, im.h)
        og.globalCompositeOperation = 'multiply'
        og.fillStyle = '#3CFA44'
        og.fillRect(0, 0, im.w, im.h)
        g.drawImage(off, im.x, im.y)
      }
    }
    g.font = '18px "Inter", system-ui, sans-serif'
    g.textBaseline = 'top'
    for (const t of p.texts) {
      const pad = (t.padding ?? 0) + (t.border ?? 0)
      if (t.border) {
        g.strokeStyle = green(t.borderColor ?? 8)
        g.lineWidth = t.border
        g.strokeRect(t.x + t.border / 2, t.y + t.border / 2, t.w - t.border, t.h - t.border)
      }
      g.fillStyle = green(t.brightness === undefined ? 15 : (t.brightness / 4) * 15)
      const lines = t.content.split('\n')
      let y = t.y + pad + 3
      for (const line of lines) {
        if (y + 22 > t.y + t.h) break
        g.fillText(line, t.x + pad, y, t.w - pad * 2)
        y += 27
      }
    }
    for (const l of p.lists) {
      const sel = this.listSel.get(l.name) ?? 0
      const visible = Math.max(1, Math.floor((l.h - 2 * (l.padding ?? 0)) / 40))
      const start = Math.max(0, Math.min(sel - visible + 1, l.items.length - visible))
      for (let i = 0; i < visible && start + i < l.items.length; i++) {
        const idx = start + i
        const y = l.y + (l.padding ?? 0) + i * 40
        if (idx === sel && l.capture) {
          g.strokeStyle = green(15)
          g.lineWidth = 2
          g.strokeRect(l.x + 4, y + 2, l.w - 8, 36)
        }
        g.fillStyle = green(idx === sel ? 15 : 10)
        g.fillText(l.items[idx]!, l.x + 14, y + 10, l.w - 28)
      }
    }
  }

  onInput(cb: (i: GlassesInput) => void) {
    this.inputCbs.add(cb)
    return () => this.inputCbs.delete(cb)
  }
  onLifecycle(cb: (e: Lifecycle) => void) {
    this.lifeCbs.add(cb)
    return () => this.lifeCbs.delete(cb)
  }
  onAudio(cb: (pcm: Uint8Array) => void) {
    this.audioCbs.add(cb)
    return () => this.audioCbs.delete(cb)
  }

  async startMic(): Promise<boolean> {
    if (!this.supportsMic || this.mic) return !!this.mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const ctx = new AudioContext({ sampleRate: 16000 })
      const src = ctx.createMediaStreamSource(stream)
      const node = ctx.createScriptProcessor(2048, 1, 1)
      node.onaudioprocess = (e) => {
        const f = e.inputBuffer.getChannelData(0)
        const ratio = e.inputBuffer.sampleRate / 16000
        const n = Math.floor(f.length / ratio)
        const out = new Uint8Array(n * 2)
        const view = new DataView(out.buffer)
        for (let i = 0; i < n; i++) {
          const s = Math.max(-1, Math.min(1, f[Math.floor(i * ratio)]!))
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        }
        for (const cb of this.audioCbs) cb(out)
      }
      src.connect(node)
      node.connect(ctx.destination)
      this.mic = { ctx, stream, node }
      return true
    } catch {
      return false
    }
  }

  async stopMic(): Promise<void> {
    const m = this.mic
    this.mic = null
    if (!m) return
    m.node.disconnect()
    m.stream.getTracks().forEach((t) => t.stop())
    await m.ctx.close().catch(() => undefined)
  }

  async requestExit() {
    this.emitLife('exit')
  }

  stats() {
    return { ...this.st }
  }

  dispose() {
    void this.stopMic()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visHandler)
    this.inputCbs.clear()
    this.lifeCbs.clear()
    this.audioCbs.clear()
  }
}
