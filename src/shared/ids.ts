/** Collision-resistant local IDs (no server). Format: `<prefix>_<random>` matching schema regex. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function randomToken(len = 16): string {
  const bytes = new Uint8Array(len)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}

export function newId(prefix: 'q' | 'p' | 'mem' | 'bos' | 'ms' | 'prop' | 'ntc' | 'evt' | 'req'): string {
  return `${prefix}_${randomToken(14)}`
}
