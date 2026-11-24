import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { layoutKey, validatePage, type PageSpec } from '../glasses/page'
import type { KV } from '../storage/kv'
import type { Device, GlassesInput, Lifecycle, RenderStats } from './types'

/**
 * Real Even Hub SDK adapter. Every bridge call is serialized through one queue with a
 * per-call timeout (BLE hops can hang). Renders are coalesced: only the latest page wins.
 * Layout-identical pages use textContainerUpgrade / updateImageRawData (no rebuild flicker).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

class BridgeQueue {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(label: string, fn: () => Promise<T>, ms = 6000): Promise<T> {
    const job = () => withTimeout(fn(), ms, label)
    const p = this.chain.then(job, job)
    this.chain = p.catch(() => undefined)
    return p
  }
}

class BridgeKV implements KV {
  readonly kind = 'even-host' as const
  constructor(
    private bridge: EvenAppBridge,
    private q: BridgeQueue,
  ) {}
  async get(key: string) {
    try {
      const v = await this.q.run('getLocalStorage', () => this.bridge.getLocalStorage(key), 8000)
      return v === '' || v === undefined || v === null ? null : v
    } catch {
      return null
    }
  }
  async set(key: string, value: string) {
    try {
      return !!(await this.q.run('setLocalStorage', () => this.bridge.setLocalStorage(key, value), 8000))
    } catch {
      return false
    }
  }
  async remove(key: string) {
    // SDK exposes no delete: an empty string reads back as "missing"
    return this.set(key, '')
  }
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

export class EvenDevice implements Device {
  readonly kind = 'even' as const
  readonly label = 'Even Hub SDK'
  readonly supportsMic = true
  readonly kv: KV
  private q = new BridgeQueue()
  private started = false
  private last: PageSpec | null = null
  private lastKey = ''
  private pending: PageSpec | null = null
  private rendering = false
  private imageCache = new Map<string, Uint8Array>()
  private shownImages = new Map<string, string>()
  private inputCbs = new Set<(i: GlassesInput) => void>()
  private lifeCbs = new Set<(e: Lifecycle) => void>()
  private audioCbs = new Set<(pcm: Uint8Array) => void>()
  private unsub: (() => void) | null = null
  private micOn = false
  private st: RenderStats = { rebuilds: 0, textUpdates: 0, imageUpdates: 0, failures: [], lastScreen: '' }

  constructor(private bridge: EvenAppBridge) {
    this.kv = new BridgeKV(bridge, this.q)
    this.unsub = bridge.onEvenHubEvent((e) => this.dispatch(e))
  }

  private dispatch(event: EvenHubEvent) {
    const pcm = event.audioEvent?.audioPcm
    if (pcm && pcm.length) for (const cb of this.audioCbs) cb(pcm)
    const emit = (i: GlassesInput) => {
      for (const cb of this.inputCbs) cb(i)
    }
    const life = (l: Lifecycle) => {
      for (const cb of this.lifeCbs) cb(l)
    }
    const sys = eventTypeOf(event.sysEvent)
    const text = eventTypeOf(event.textEvent)
    const list = eventTypeOf(event.listEvent)
    // Explicit ids first; CLICK (0) is the fallback of an envelope without a type.
    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return life('foreground')
    if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return life('background')
    if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      void this.stopMic()
      return life('exit')
    }
    if (sys === OsEventTypeList.IMU_DATA_REPORT) return
    if (event.menuItemClickEvent?.itemID) return emit({ kind: 'menu', itemId: event.menuItemClickEvent.itemID })
    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || text === OsEventTypeList.DOUBLE_CLICK_EVENT || list === OsEventTypeList.DOUBLE_CLICK_EVENT) return emit({ kind: 'double' })
    if (sys === OsEventTypeList.LONG_PRESS_EVENT || text === OsEventTypeList.LONG_PRESS_EVENT || list === OsEventTypeList.LONG_PRESS_EVENT) return emit({ kind: 'long_press' })
    if (sys === OsEventTypeList.LONG_PRESS_RELEASE_EVENT || text === OsEventTypeList.LONG_PRESS_RELEASE_EVENT || list === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return emit({ kind: 'long_release' })
    if (text === OsEventTypeList.SCROLL_TOP_EVENT) return emit({ kind: 'up' })
    if (text === OsEventTypeList.SCROLL_BOTTOM_EVENT) return emit({ kind: 'down' })
    if (event.listEvent && list === OsEventTypeList.CLICK_EVENT) return emit({ kind: 'select', index: event.listEvent.currentSelectItemIndex ?? 0 })
    if (sys === OsEventTypeList.CLICK_EVENT || text === OsEventTypeList.CLICK_EVENT) return emit({ kind: 'tap' })
  }

  render(page: PageSpec) {
    this.pending = page
    if (!this.rendering) void this.loop()
  }

  private async loop() {
    this.rendering = true
    try {
      while (this.pending) {
        const page = this.pending
        this.pending = null
        await this.renderNow(page)
      }
    } finally {
      this.rendering = false
    }
  }

  private toSdk(page: PageSpec) {
    const textObject = page.texts.map(
      (t) =>
        new TextContainerProperty({
          xPosition: t.x,
          yPosition: t.y,
          width: t.w,
          height: t.h,
          borderWidth: t.border ?? 0,
          borderColor: t.borderColor ?? 0,
          borderRadius: t.radius ?? 0,
          paddingLength: t.padding ?? 0,
          containerID: t.id,
          containerName: t.name,
          isEventCapture: t.capture ? 1 : 0,
          content: t.content,
          ...(t.brightness !== undefined ? { textColor: t.brightness } : {}),
        }),
    )
    const listObject = page.lists.map(
      (l) =>
        new ListContainerProperty({
          xPosition: l.x,
          yPosition: l.y,
          width: l.w,
          height: l.h,
          borderWidth: l.border ?? 0,
          borderColor: l.borderColor ?? 0,
          paddingLength: l.padding ?? 0,
          containerID: l.id,
          containerName: l.name,
          isEventCapture: l.capture ? 1 : 0,
          itemContainer: new ListItemContainerProperty({ itemCount: l.items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: l.items }),
        }),
    )
    const imageObject = page.images.map((i) => new ImageContainerProperty({ xPosition: i.x, yPosition: i.y, width: i.w, height: i.h, containerID: i.id, containerName: i.name }))
    return { containerTotalNum: textObject.length + listObject.length + imageObject.length, textObject, listObject, imageObject }
  }

  private async renderNow(page: PageSpec) {
    const errs = validatePage(page)
    if (errs.length) {
      this.fail(`invalid page ${page.screen}: ${errs.join('; ')}`)
      return
    }
    const key = layoutKey(page)
    try {
      if (!this.started) {
        const r = await this.q.run('createStartUpPageContainer', () => this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(this.toSdk(page))), 10_000)
        this.started = true // one-shot by contract, even if it failed
        if (r !== StartUpPageCreateResult.success) {
          this.fail(`createStartUpPageContainer=${r}`)
          this.lastKey = ''
          return
        }
        this.st.rebuilds++
        this.shownImages.clear()
      } else if (key !== this.lastKey) {
        const ok = await this.q.run('rebuildPageContainer', () => this.bridge.rebuildPageContainer(new RebuildPageContainer(this.toSdk(page))), 10_000)
        if (!ok) {
          this.fail(`rebuildPageContainer=false (${page.screen})`)
          this.lastKey = ''
          return
        }
        this.st.rebuilds++
        this.shownImages.clear()
      } else if (this.last) {
        for (const t of page.texts) {
          const prev = this.last.texts.find((x) => x.id === t.id)
          if (prev && prev.content === t.content && prev.brightness === t.brightness) continue
          const ok = await this.q.run('textContainerUpgrade', () =>
            this.bridge.textContainerUpgrade(
              new TextContainerUpgrade({ containerID: t.id, containerName: t.name, contentOffset: 0, contentLength: 0, content: t.content, ...(t.brightness !== undefined ? { textColor: t.brightness } : {}) }),
            ),
          )
          if (ok) this.st.textUpdates++
          else this.fail(`textContainerUpgrade=false ${t.name}`)
        }
      }
      this.last = page
      this.lastKey = key
      this.st.lastScreen = page.screen
      for (const img of page.images) {
        if (this.pending && layoutKey(this.pending) !== key) break // a newer layout is waiting
        if (this.shownImages.get(img.name) === img.src) continue
        const bytes = await this.loadImage(img.src)
        if (!bytes) continue
        const r = await this.q.run('updateImageRawData', () => this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: img.id, containerName: img.name, imageData: bytes })), 8000)
        if (r === ImageRawDataUpdateResult.success) {
          this.shownImages.set(img.name, img.src)
          this.st.imageUpdates++
        } else this.fail(`updateImageRawData=${r} ${img.name}`)
      }
    } catch (e) {
      this.fail((e as Error).message)
      this.lastKey = ''
    }
  }

  private async loadImage(src: string): Promise<Uint8Array | null> {
    const c = this.imageCache.get(src)
    if (c) return c
    try {
      const r = await fetch(src)
      if (!r.ok) return null
      const bytes = new Uint8Array(await r.arrayBuffer())
      if (this.imageCache.size > 80) this.imageCache.clear()
      this.imageCache.set(src, bytes)
      return bytes
    } catch {
      return null
    }
  }

  private fail(msg: string) {
    console.warn('[questling/glasses]', msg)
    this.st.failures = [...this.st.failures.slice(-19), msg]
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
    if (!this.started) return false
    try {
      const ok = await this.q.run('audioControl(on)', () => this.bridge.audioControl(true, AudioInputSource.Glasses), 6000)
      this.micOn = !!ok
      return this.micOn
    } catch {
      return false
    }
  }

  async stopMic(): Promise<void> {
    if (!this.micOn) return
    this.micOn = false
    try {
      await this.q.run('audioControl(off)', () => this.bridge.audioControl(false), 6000)
    } catch {
      /* best effort: host also stops capture on exit */
    }
  }

  async requestExit() {
    try {
      await this.q.run('shutDownPageContainer', () => this.bridge.shutDownPageContainer(1), 6000)
    } catch (e) {
      this.fail((e as Error).message)
    }
  }

  stats() {
    return { ...this.st }
  }

  dispose() {
    void this.stopMic()
    this.unsub?.()
    this.inputCbs.clear()
    this.lifeCbs.clear()
    this.audioCbs.clear()
  }
}
