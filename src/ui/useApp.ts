import { useSyncExternalStore } from 'react'
import { app, type Snapshot } from '../app/controller'

export function useApp(): Snapshot {
  return useSyncExternalStore(app.subscribe, app.getSnapshot)
}
export { app }
