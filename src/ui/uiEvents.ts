/** Tiny cross-screen UI requests (header buttons that act on a screen's own state). */
type Listener = () => void
const newQuest = new Set<Listener>()

export function requestNewQuest() {
  newQuest.forEach((l) => l())
}
export function onNewQuestRequest(l: Listener): () => void {
  newQuest.add(l)
  return () => newQuest.delete(l)
}
