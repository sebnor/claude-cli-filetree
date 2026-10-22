// Absolute paths as the tree spells them: forward slashes, no trailing slash, except a root's
// own (`C:/`, `/`). Windows and POSIX both.

const DRIVE = /^[A-Za-z]:$/

/** `C:\Users\me\` → `C:/Users/me`; `C:` or `C:\` → `C:/`. */
export function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const trimmed = slashed.replace(/\/+$/, '')
  if (DRIVE.test(trimmed)) return `${trimmed}/`
  return trimmed === '' && slashed.startsWith('/') ? '/' : trimmed
}

/** `root` joined with `rel` (a tree path, `/`-separated; `''` the root itself). */
export const join = (root: string, rel: string) =>
  rel === '' ? root : root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`

/** The folder above `path`, or undefined at a root (`C:/`, `/`). */
export function parentOf(path: string): string | undefined {
  if (path === '/' || /^[A-Za-z]:\/$/.test(path)) return undefined
  const cut = path.lastIndexOf('/')
  if (cut < 0) return undefined
  const parent = path.slice(0, cut)
  return parent === '' ? '/' : DRIVE.test(parent) ? `${parent}/` : parent
}

/** The last name in `path`; a root is its own name (`C:`, `/`). */
export const nameOf = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

// Windows paths compare without case, as its file systems do.
const same = (a: string, b: string) => (/^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b)

/** `path` below `root` as a tree path (`''` for the root itself), or undefined when outside it. */
export function relativeTo(root: string, path: string): string | undefined {
  if (same(root, path)) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return same(path.slice(0, prefix.length), prefix) ? path.slice(prefix.length) : undefined
}
