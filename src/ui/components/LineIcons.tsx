/**
 * Gold line-art icons for the header and bottom navigation (UI concept).
 * Drawn on a 24×24 grid, 1.6 px strokes, `currentColor` so active/inactive states are pure CSS.
 */
export type LineIconName = 'today' | 'journal' | 'companion' | 'character' | 'camp' | 'gear' | 'book' | 'quill'

const PATHS: Record<LineIconName, React.ReactNode> = {
  // mountains with a small sun
  today: (
    <>
      <path d="M2.5 19.5 9 9.5l3.6 5.4L15 11.5l6.5 8z" />
      <path d="M7.3 12.2 9 13.4l1.6-1.3" />
      <circle cx="17.5" cy="5.6" r="1.9" />
    </>
  ),
  // open book
  journal: (
    <>
      <path d="M12 6.4C9.8 4.9 6.6 4.6 3 5.2v13c3.6-.6 6.8-.3 9 1.2 2.2-1.5 5.4-1.8 9-1.2v-13c-3.6-.6-6.8-.3-9 1.2z" />
      <path d="M12 6.4v13" />
      <path d="M5.6 8.6c1.6-.2 3.2 0 4.4.6M5.6 11.4c1.6-.2 3.2 0 4.4.6M14 9.2c1.2-.6 2.8-.8 4.4-.6M14 12c1.2-.6 2.8-.8 4.4-.6" />
    </>
  ),
  // speech bubble with a spark — the companion
  companion: (
    <>
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 20 17h-8.5L7 20.5V17H4a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 4 5.5z" />
      <path d="M12 8.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </>
  ),
  // knight's helmet
  character: (
    <>
      <path d="M12 3c-4.4 0-7.5 3.4-7.5 8.2V19c0 .8.6 1.5 1.4 1.5H18c.8 0 1.5-.7 1.5-1.5v-7.8C19.5 6.4 16.4 3 12 3z" />
      <path d="M4.6 11.6h14.8M12 11.6v8.9M8.4 14.6h1.8M13.8 14.6h1.8" />
      <path d="M12 3v3.2" />
    </>
  ),
  // tent
  camp: (
    <>
      <path d="M12 4 2.5 19.5h19z" />
      <path d="M12 4v15.5M12 11.4l-3.2 8.1M12 11.4l3.2 8.1" />
      <path d="M10.6 1.8 12 4l1.4-2.2" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
      <circle cx="12" cy="12" r="6.6" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5h11.5a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2z" />
      <path d="M5 17.5a2 2 0 0 1 2-2h11.5M9 8.2h6M9 11h4" />
    </>
  ),
  quill: (
    <>
      <path d="M20.5 3.5c-6.8.6-11.5 4.6-13.6 12.3l1.5 1.5C16 15.2 19.9 10.4 20.5 3.5z" />
      <path d="M6.9 15.8 3.5 20.5M10.2 12.4l3.2.4M12.6 9.4l2.9.2" />
    </>
  ),
}

export function LineIcon({ name, size = 24, title }: { name: LineIconName; size?: number; title?: string }) {
  return (
    <svg className="lineicon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      {PATHS[name]}
    </svg>
  )
}
