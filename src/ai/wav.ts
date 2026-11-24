/** PCM s16le 16 kHz mono → WAV container (Gemini accepts audio/wav). Raw audio is never stored. */
export const SAMPLE_RATE = 16_000

export function pcmToWav(chunks: Uint8Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  const dataLen = chunks.reduce((s, c) => s + c.length, 0) & ~1
  const buf = new Uint8Array(44 + dataLen)
  const v = new DataView(buf.buffer)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i)
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, dataLen, true)
  let o = 44
  for (const c of chunks) {
    const n = Math.min(c.length, 44 + dataLen - o)
    buf.set(c.subarray(0, n), o)
    o += n
  }
  return buf
}

export function durationMs(chunks: Uint8Array[], sampleRate = SAMPLE_RATE): number {
  return Math.round((chunks.reduce((s, c) => s + c.length, 0) / 2 / sampleRate) * 1000)
}

/** RMS level 0..1 of a PCM chunk (for the recording indicator / silence detection). */
export function level(chunk: Uint8Array): number {
  const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  let sum = 0
  const n = Math.floor(chunk.byteLength / 2)
  for (let i = 0; i < n; i++) {
    const s = v.getInt16(i * 2, true) / 32768
    sum += s * s
  }
  return n ? Math.sqrt(sum / n) : 0
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(s)
}
