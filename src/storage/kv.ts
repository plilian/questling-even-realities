/** Minimal async key-value abstraction over the Even host storage, browser storage or memory. */
export interface KV {
  readonly kind: 'even-host' | 'browser' | 'memory'
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<boolean>
  remove(key: string): Promise<boolean>
}

export class MemoryKV implements KV {
  readonly kind = 'memory' as const
  readonly data = new Map<string, string>()
  failWrites = false
  async get(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  async set(key: string, value: string) {
    if (this.failWrites) return false
    this.data.set(key, value)
    return true
  }
  async remove(key: string) {
    this.data.delete(key)
    return true
  }
}

export class BrowserKV implements KV {
  readonly kind = 'browser' as const
  async get(key: string) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null
    } catch {
      return null
    }
  }
  async set(key: string, value: string) {
    try {
      globalThis.localStorage.setItem(key, value)
      return true
    } catch {
      return false
    }
  }
  async remove(key: string) {
    try {
      globalThis.localStorage.removeItem(key)
      return true
    } catch {
      return false
    }
  }
}

const CHUNK = 40_000

/**
 * Crash-safe chunked document storage on top of any KV:
 * writes the new copy into the inactive slot, then flips a pointer key.
 * A torn write leaves the previous complete copy readable.
 */
export class ChunkedDoc {
  constructor(
    private kv: KV,
    private key: string,
  ) {}

  async read(): Promise<string | null> {
    const ptr = await this.kv.get(`${this.key}.ptr`)
    if (!ptr) return null
    const m = /^([AB]):(\d{1,4})$/.exec(ptr)
    if (!m) return null
    const slot = m[1]
    const n = Number(m[2])
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const p = await this.kv.get(`${this.key}.${slot}.${i}`)
      if (p === null) return null
      parts.push(p)
    }
    return parts.join('')
  }

  async write(doc: string): Promise<boolean> {
    const ptr = await this.kv.get(`${this.key}.ptr`)
    const current = ptr?.startsWith('A') ? 'A' : ptr?.startsWith('B') ? 'B' : null
    const slot = current === 'A' ? 'B' : 'A'
    const n = Math.max(1, Math.ceil(doc.length / CHUNK))
    for (let i = 0; i < n; i++) {
      const ok = await this.kv.set(`${this.key}.${slot}.${i}`, doc.slice(i * CHUNK, (i + 1) * CHUNK))
      if (!ok) return false
    }
    return this.kv.set(`${this.key}.ptr`, `${slot}:${n}`)
  }

  async clear(): Promise<void> {
    await this.kv.remove(`${this.key}.ptr`)
    for (const slot of ['A', 'B']) {
      for (let i = 0; i < 100; i++) {
        const k = `${this.key}.${slot}.${i}`
        if ((await this.kv.get(k)) === null) break
        await this.kv.remove(k)
      }
    }
  }
}
