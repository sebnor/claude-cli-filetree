import type { GitCode } from '../types'

/** A row's git mark, short keys as it rides a Client's props: code, added, removed, ignored, deleted. */
export type TreeMark = { c?: GitCode; a?: number; r?: number; i?: 1; x?: 1 }

/** Theme colours, as the engine draws its own diffs: green new, yellow changed, red gone. */
export const CODE_COLOR: Record<GitCode, string> = {
  M: 'warning',
  A: 'success',
  U: 'success',
  D: 'error',
  R: 'suggestion',
  C: 'error',
}

export type Badge = { added?: string; removed?: string; code?: string; color?: string; width: number }

// Below this many columns a row keeps only its status letter (or a folder's dot).
const ROOM_FOR_COUNTS = 28

/** What a row draws at its right edge: `+12 -3 M` for a file, `+40 -7 ●` for a folder. */
export function badgeOf(mark: TreeMark | undefined, isDir: boolean, columns: number): Badge | undefined {
  if (!mark?.c) return undefined
  const hasRoom = columns >= ROOM_FOR_COUNTS
  const added = hasRoom && mark.a ? `+${mark.a}` : undefined
  const removed = hasRoom && mark.r ? `-${mark.r}` : undefined
  const code = isDir ? '●' : mark.c
  const width = [added, removed, code].reduce((sum, part) => sum + (part ? part.length + 1 : 0), 0)

  return { added, removed, code, color: CODE_COLOR[mark.c], width }
}
