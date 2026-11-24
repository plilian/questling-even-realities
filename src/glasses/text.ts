import { getAdvW, measureTextWrap, pxTruncate } from '@evenrealities/pretext'

/**
 * Pixel-accurate text fitting for the G2 firmware font (official @evenrealities/pretext).
 * Line height is fixed at 27 px. Characters missing from the firmware font are
 * replaced with safe equivalents so nothing renders as placeholder boxes.
 */
export const LINE_H = 27

const REPLACE: Record<string, string> = {
  '✓': '√',
  '✔': '√',
  '✕': '×',
  '✗': '×',
  '░': '─',
  '◷': '•',
  '⏰': '•',
  '☀': '*',
  '✦': '*',
  '⚔': '†',
  ' ': ' ',
}

const supportCache = new Map<number, boolean>()
function supported(cp: number): boolean {
  let s = supportCache.get(cp)
  if (s === undefined) {
    s = cp === 10 || cp === 32 || getAdvW(cp) > 0
    supportCache.set(cp, s)
  }
  return s
}

/** Replace/strip glyphs the firmware cannot draw (emoji, unsupported symbols). */
export function glassSafe(text: string): string {
  let out = ''
  for (const ch of text) {
    const r = REPLACE[ch]
    if (r !== undefined) {
      out += r
      continue
    }
    const cp = ch.codePointAt(0)!
    // Even FAQ: no emoji on glasses — drop astral-plane pictographs and variation selectors even if a fallback glyph exists
    if (cp >= 0x1f000 || cp === 0xfe0f || cp === 0x200d) continue
    if (supported(cp)) out += ch
  }
  return out.replace(/[ \t]{2,}/g, ' ')
}

export function textWidth(s: string): number {
  return measureTextWrap(glassSafe(s), 10_000).lineWidths[0] ?? 0
}

export function truncate(s: string, maxPx: number): string {
  return pxTruncate(glassSafe(s), maxPx)
}

/** Fit text into a box: wraps by the firmware rules and truncates the last visible line with an ellipsis. */
export function fitText(text: string, innerWidth: number, maxLines: number): string {
  const safe = glassSafe(text)
  const out: string[] = []
  for (const para of safe.split('\n')) {
    if (out.length >= maxLines) break
    if (!para) {
      out.push('')
      continue
    }
    const words = para.split(' ')
    let line = ''
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      const candidate = line ? `${line} ${w}` : w
      if (measureTextWrap(candidate, 10_000).lineWidths[0]! <= innerWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      if (out.length >= maxLines) {
        line = ''
        break
      }
      line = measureTextWrap(w, 10_000).lineWidths[0]! <= innerWidth ? w : pxTruncate(w, innerWidth)
    }
    if (line && out.length < maxLines) out.push(line)
  }
  const fullFits = measureTextWrap(safe, innerWidth).lineCount <= maxLines
  if (!fullFits && out.length) {
    const last = out[out.length - 1]!
    out[out.length - 1] = pxTruncate(`${last}…`, innerWidth).replace(/\.\.\.$/, '…')
  }
  return out.slice(0, maxLines).join('\n')
}

/** Text progress bar using firmware glyphs. */
export function bar(fraction: number, segments: number, full = '━', empty = '─'): string {
  const f = Math.max(0, Math.min(1, fraction))
  const n = Math.round(f * segments)
  return full.repeat(n) + empty.repeat(segments - n)
}

/** Pad-right to a pixel width using spaces (no alignment support in firmware). */
export function padToPx(s: string, px: number): string {
  let out = glassSafe(s)
  const space = textWidth(' ') || 5
  let w = textWidth(out)
  while (w + space <= px) {
    out += ' '
    w += space
  }
  return out
}
