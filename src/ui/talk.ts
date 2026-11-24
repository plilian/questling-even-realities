import { useSyncExternalStore } from 'react'

/**
 * Open/close state of the companion conversation sheet. The companion is reached from the
 * Today scene, from the floating portrait on the other tabs and from notice actions — so the
 * state lives outside any single screen.
 */
let open = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function openTalk() {
  if (open) return
  open = true
  emit()
}
export function closeTalk() {
  if (!open) return
  open = false
  emit()
}
export function useTalkOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => open,
  )
}
