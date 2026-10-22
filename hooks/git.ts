import type { EngineInterface } from 'claude-code'

import type { GitCode, GitFile, GitStatus } from '../types'

export const NO_GIT: GitStatus = { isRepo: false, files: {}, ignored: [] }

// Bounds the untracked files whose lines are counted on one read.
const MAX_COUNTED_UNTRACKED = 200

const RANK: Record<GitCode, number> = { C: 5, D: 4, M: 3, R: 2, A: 2, U: 1 }

/** The code a folder shows: the most serious change beneath it. */
export const strongest = (a: GitCode | undefined, b: GitCode) => (a === undefined || RANK[b] > RANK[a] ? b : a)

function codeOf(xy: string): GitCode {
  const [x, y] = [xy[0], xy[1]]
  if (xy === '??') return 'U'
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'C'
  if (x === 'D' || y === 'D') return 'D'
  if (x === 'R' || x === 'C') return 'R'
  if (x === 'A') return 'A'

  return 'M'
}

const countLines = (text: string) =>
  text.includes('\0') || text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

/**
 * Reads `git status` and `git diff HEAD --numstat` for the cwd. Git spells paths from the
 * repository root; they are cut to the cwd (`rev-parse --show-prefix`) and anything outside dropped.
 */
export async function readGit($: EngineInterface, cwd: string): Promise<GitStatus> {
  const git = (args: string[]) =>
    $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd, timeoutMs: 10000 }).catch(() => undefined)

  const prefix = await git(['rev-parse', '--show-prefix'])
  if (!prefix || prefix.exitCode !== 0) return NO_GIT
  const base = prefix.stdout.trim()
  const local = (path: string) => (path.startsWith(base) ? path.slice(base.length) : undefined)

  const [status, numstat] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']),
    git(['diff', 'HEAD', '--numstat', '-z', '-M']),
  ])
  if (!status || status.exitCode !== 0) return NO_GIT

  const files: Record<string, GitFile> = {}
  const ignored: string[] = []
  // `XY path\0`, a rename or copy followed by its source path as one more field.
  const fields = status.stdout.split('\0')
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? ''
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    if (xy[0] === 'R' || xy[0] === 'C') index++
    const path = local(field.slice(3))
    if (path === undefined || path === '') continue
    if (xy === '!!') ignored.push(path)
    else files[path] = { code: codeOf(xy), added: 0, removed: 0 }
  }

  // `added\tremoved\tpath\0`; a rename leaves the path empty, then `old\0new\0`. Binary is `-`.
  const parts = numstat?.exitCode === 0 ? numstat.stdout.split('\0') : []
  for (let index = 0; index < parts.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[index] ?? '')
    if (!match) continue
    let path = match[3] ?? ''
    if (path === '') {
      path = parts[index + 2] ?? ''
      index += 2
    }
    const file = files[local(path) ?? '']
    if (!file) continue
    file.added = match[1] === '-' ? 0 : Number(match[1])
    file.removed = match[2] === '-' ? 0 : Number(match[2])
  }

  // Untracked files have no diff: their lines count as added.
  const untracked = Object.entries(files).filter(([, file]) => file.code === 'U').slice(0, MAX_COUNTED_UNTRACKED)
  await Promise.all(
    untracked.map(async ([path, file]) => {
      const text = await $.fs.read(`${cwd}/${path}`).catch(() => '')
      file.added = countLines(text)
    }),
  )

  return { isRepo: true, files, ignored }
}

/**
 * Several repositories' statuses as one, each read at its own top and spelled from the tree's
 * root: a folder of projects whose root is no repository itself.
 */
export function mergeGit(repos: readonly (readonly [dir: string, status: GitStatus])[]): GitStatus {
  const merged: GitStatus = { isRepo: false, files: {}, ignored: [] }
  for (const [dir, status] of repos) {
    if (!status.isRepo) continue
    merged.isRepo = true
    for (const [path, file] of Object.entries(status.files)) merged.files[`${dir}/${path}`] = file
    merged.ignored.push(...status.ignored.map(rule => `${dir}/${rule}`))
  }

  return merged
}

export const isIgnored =(status: GitStatus, path: string) =>
  status.ignored.some(rule => (rule.endsWith('/') ? `${path}/`.startsWith(rule) : path === rule))

export type FolderMark = { code: GitCode; added: number; removed: number }

/** Every folder with a change beneath it: the most serious code and the summed line counts. */
export function folderMarks(status: GitStatus): Map<string, FolderMark> {
  const marks = new Map<string, FolderMark>()
  for (const [path, file] of Object.entries(status.files)) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/')
      const mark = marks.get(dir)
      marks.set(dir, {
        code: strongest(mark?.code, file.code),
        added: (mark?.added ?? 0) + file.added,
        removed: (mark?.removed ?? 0) + file.removed,
      })
    }
  }

  return marks
}

/** Deleted files are gone from disk: per folder, the names to show anyway (and whether each is a folder). */
export function deletedEntries(status: GitStatus): Map<string, Map<string, boolean>> {
  const ghosts = new Map<string, Map<string, boolean>>()
  for (const [path, file] of Object.entries(status.files)) {
    if (file.code !== 'D') continue
    const parts = path.split('/')
    for (let depth = 0; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/')
      const names = ghosts.get(dir) ?? new Map<string, boolean>()
      names.set(parts[depth] ?? '', depth < parts.length - 1)
      ghosts.set(dir, names)
    }
  }

  return ghosts
}
