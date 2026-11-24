/** Renderer-agnostic page description for the 576×288 G2 canvas (mirrors SDK container shapes). */
export const CANVAS_W = 576
export const CANVAS_H = 288

export interface TextBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
  capture?: boolean
  border?: number
  borderColor?: number
  radius?: number
  padding?: number
  /** firmware brightness 0–4 (SDK 0.0.14+) */
  brightness?: number
}
export interface ListBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
  capture?: boolean
  border?: number
  borderColor?: number
  padding?: number
}
export interface ImageBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  /** URL of an encoded PNG (greyscale) exactly w×h */
  src: string
}

export interface PageSpec {
  /** screen id — used for logs/tests */
  screen: string
  texts: TextBox[]
  lists: ListBox[]
  images: ImageBox[]
}

/** Layout signature: identical signature ⇒ in-place text/image updates are possible (no rebuild flicker). */
export function layoutKey(p: PageSpec): string {
  const t = p.texts.map((b) => `t${b.id}:${b.name}:${b.x},${b.y},${b.w},${b.h},${b.capture ? 1 : 0},${b.border ?? 0},${b.padding ?? 0}`).join('|')
  const l = p.lists.map((b) => `l${b.id}:${b.name}:${b.x},${b.y},${b.w},${b.h}:${b.items.join('\u0001')}`).join('|')
  const i = p.images.map((b) => `i${b.id}:${b.name}:${b.x},${b.y},${b.w},${b.h}`).join('|')
  return `${t}#${l}#${i}`
}

/** Validate against verified SDK limits before anything reaches the bridge. */
export function validatePage(p: PageSpec): string[] {
  const errs: string[] = []
  const total = p.texts.length + p.lists.length + p.images.length
  if (total < 1 || total > 12) errs.push(`container count ${total} outside 1–12`)
  if (p.texts.length + p.lists.length > 8) errs.push('more than 8 text/list containers')
  if (p.images.length > 4) errs.push('more than 4 image containers')
  const captures = [...p.texts, ...p.lists].filter((b) => b.capture).length
  if (captures !== 1) errs.push(`exactly one event-capture container required (got ${captures})`)
  const ids = new Set<number>()
  const names = new Set<string>()
  for (const b of [...p.texts, ...p.lists, ...p.images]) {
    if (ids.has(b.id)) errs.push(`duplicate id ${b.id}`)
    if (names.has(b.name)) errs.push(`duplicate name ${b.name}`)
    ids.add(b.id)
    names.add(b.name)
    if (b.name.length > 16) errs.push(`name too long: ${b.name}`)
    if (b.x < 0 || b.y < 0 || b.x + b.w > CANVAS_W || b.y + b.h > CANVAS_H) errs.push(`${b.name} out of bounds`)
  }
  for (const t of p.texts) if (t.content.length > 1000) errs.push(`${t.name} content > 1000 chars`)
  for (const t of p.texts) if (!t.content.length) errs.push(`${t.name} empty content`)
  for (const l of p.lists) {
    if (l.items.length < 1 || l.items.length > 20) errs.push(`${l.name} item count ${l.items.length}`)
    for (const it of l.items) if (new TextEncoder().encode(it).length > 63) errs.push(`${l.name} item too long: ${it}`)
  }
  for (const i of p.images) if (i.w < 20 || i.w > 288 || i.h < 20 || i.h > 144) errs.push(`${i.name} image size ${i.w}x${i.h} invalid`)
  return errs
}
