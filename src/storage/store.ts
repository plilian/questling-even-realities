import type { SaveV1 } from '../shared/schema'
import { applyGameCommand, type DomainEvent, type GameCommand, type GameResult } from '../game/reducer'
import type { SaveRepository } from './save'

export type PersistStatus = 'saved' | 'saving' | 'unsaved'

export interface StoreResult extends GameResult {
  persisted: boolean
}

type Listener = (save: SaveV1, status: PersistStatus) => void
type EventListener = (events: DomainEvent[], persisted: boolean) => void

/**
 * Single authoritative writer for the local save. All mutations are serialized
 * through one promise chain; reducer output and reward ledger are committed
 * together (one domain transaction) and persisted before events are emitted.
 * If persistence fails, state stays in memory, is labelled "unsaved" and retried.
 */
export class SaveStore {
  private chain: Promise<unknown> = Promise.resolve()
  private listeners = new Set<Listener>()
  private eventListeners = new Set<EventListener>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  status: PersistStatus = 'saved'

  constructor(
    private repo: SaveRepository,
    public state: SaveV1,
  ) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  onEvents(fn: EventListener): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  private notify() {
    for (const l of this.listeners) l(this.state, this.status)
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async persist(next: SaveV1): Promise<boolean> {
    this.state = next
    this.status = 'saving'
    this.notify()
    let ok = false
    try {
      ok = await this.repo.write(next)
    } catch {
      ok = false
    }
    this.status = ok ? 'saved' : 'unsaved'
    this.notify()
    if (!ok) this.scheduleRetry()
    return ok
  }

  private scheduleRetry() {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.enqueue(async () => {
        if (this.status !== 'unsaved') return
        await this.persist(this.state)
      })
    }, 3000)
  }

  dispatch(cmd: GameCommand, now: number, tz: string): Promise<StoreResult> {
    return this.enqueue(async () => {
      const result = applyGameCommand(this.state, cmd, now, tz)
      if (result.error || result.duplicate || result.save === this.state) {
        return { ...result, persisted: this.status === 'saved' }
      }
      const next = { ...result.save, revision: this.state.revision + 1 }
      const persisted = await this.persist(next)
      if (result.events.length) for (const l of this.eventListeners) l(result.events, persisted)
      return { ...result, save: next, persisted }
    })
  }

  /** Non-game local settings mutation (preferences, companion, memory, reminders). */
  mutate(fn: (s: SaveV1) => SaveV1): Promise<boolean> {
    return this.enqueue(async () => {
      const next = fn(this.state)
      if (next === this.state) return true
      return this.persist({ ...next, revision: this.state.revision + 1 })
    })
  }

  /** Replace whole state (reset / import). */
  replace(next: SaveV1): Promise<boolean> {
    return this.enqueue(async () => this.persist({ ...next, revision: this.state.revision + 1 }))
  }

  /** Wait for all queued writes (tests, lifecycle flush). */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.status === 'unsaved') await this.persist(this.state)
    })
  }

  dispose() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.listeners.clear()
    this.eventListeners.clear()
  }
}
