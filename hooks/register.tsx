import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { GitStatus } from '../types'
import { NO_GIT, deletedEntries, folderMarks, isIgnored, mergeGit, readGit } from './git'
import { ICON_CELLS, iconOf } from './icons'
import { badgeOf } from './marks'
import type { TreeMark } from './marks'
import type { TreeMessage, TreeProps } from './tree-view'

const PANE = 'file-tree'
const TITLE = 'Files'
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const tick = atom({ plugin: 'file-tree', key: 'tick' } as const, 0)
const git = atom({ plugin: 'file-tree', key: 'git' } as const, NO_GIT)

// Hidden however the tree is opened: version-control internals, never useful here.
const ALWAYS_HIDDEN = new Set(['.git', '.hg', '.svn'])
// Bounds one drawing, so opening node_modules cannot stall the pane (and keeps the
// tree view's props under a Client's 100,000 characters).
const MAX_ROWS = 1500
const POLL_MS = 4000
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])

export type Row = {
  path: string
  name: string
  prefix: string
  isDir: boolean
  isOpen: boolean
  mark?: TreeMark
}

/** What one walk draws from: the cwd, the open folders, and the git status and what it derives. */
type Context = {
  root: string
  open: ReadonlySet<string>
  status: GitStatus
  folders: ReturnType<typeof folderMarks>
  deleted: ReturnType<typeof deletedEntries>
}

const contextOf = (root: string, open: ReadonlySet<string>, status: GitStatus): Context => ({
  root,
  open,
  status,
  folders: folderMarks(status),
  deleted: deletedEntries(status),
})

type Listed = { entry: FsEntry; isGone: boolean }

const byKindThenName = (a: Listed, b: Listed) => {
  const aDir = a.entry.kind === 'dir' ? 0 : 1
  const bDir = b.entry.kind === 'dir' ? 0 : 1
  return aDir - bDir || a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' })
}

// The folder's entries, plus what git says was deleted from it: gone from disk, still a change.
async function listDir($: EngineInterface, context: Context, dir: string): Promise<Listed[]> {
  const path = dir === '' ? context.root : `${context.root}/${dir}`
  const entries = await $.fs.list(path).catch(() => [] as FsEntry[])
  const listed = entries.filter(entry => !ALWAYS_HIDDEN.has(entry.name)).map(entry => ({ entry, isGone: false }))
  const present = new Set(entries.map(entry => entry.name))
  for (const [name, isDir] of context.deleted.get(dir) ?? []) {
    if (present.has(name)) continue
    listed.push({ entry: { name, kind: isDir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false }, isGone: true })
  }

  return listed.sort(byKindThenName)
}

function markOf(context: Context, path: string, isDir: boolean, isGone: boolean): TreeMark | undefined {
  if (!context.status.isRepo) return undefined
  const change = isDir ? context.folders.get(path) : context.status.files[path]
  const mark: TreeMark = change ? { c: change.code, a: change.added, r: change.removed } : {}
  if (isIgnored(context.status, path)) mark.i = 1
  if (isGone) mark.x = 1

  return Object.keys(mark).length > 0 ? mark : undefined
}

// Depth-first over the open directories only; a symbolic link is listed but never followed.
// Paths in the rows stay relative to the cwd.
export async function walk($: EngineInterface, context: Context, dir = '', prefix = '', rows: Row[] = []) {
  const listed = await listDir($, context, dir)
  for (const [index, { entry, isGone }] of listed.entries()) {
    if (rows.length >= MAX_ROWS) break
    const isLast = index === listed.length - 1
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`
    const isDir = entry.kind === 'dir'
    const isOpen = isDir && context.open.has(path)
    const mark = markOf(context, path, isDir, isGone)
    rows.push({ path, name: entry.name, prefix: prefix + (isLast ? '└ ' : '├ '), isDir, isOpen, mark })
    if (isOpen) await walk($, context, path, prefix + (isLast ? '  ' : '│ '), rows)
  }

  return rows
}

const signature = (rows: Row[]) => rows.map(row => (row.isDir ? 'd:' : 'f:') + row.path).join('\n')

const fit = (text: string, room: number) =>
  room <= 1 ? '…' : text.length > room ? text.slice(0, room - 1) + '…' : text

const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const toggle = ($: EngineInterface, path: string) =>
  update($, expanded, list => (list.includes(path) ? list.filter(one => one !== path) : [...list, path]))

const refresh = ($: EngineInterface) => update($, tick, n => n + 1)

// Bounds the folders checked for a `.git` of their own on one read.
const MAX_REPO_PROBES = 200

// The cwd's repository; where the cwd is in none (a folder of projects), every folder on screen
// that is a repository's top, each read by its own git. Written only when it changed, so a quiet
// repository redraws nothing.
async function refreshGit($: EngineInterface) {
  const cwd = await $.session.cwd()
  let next = await readGit($, cwd)
  if (!next.isRepo) {
    const rows = await walk($, contextOf(cwd, new Set(await read($, expanded)), NO_GIT))
    const dirs = rows.filter(row => row.isDir).slice(0, MAX_REPO_PROBES)
    const isTop = await Promise.all(dirs.map(row => $.fs.exists(`${cwd}/${row.path}/.git`).catch(() => false)))
    const repos = dirs.filter((_, index) => isTop[index]).map(row => row.path)
    next = mergeGit(await Promise.all(repos.map(async repo => [repo, await readGit($, `${cwd}/${repo}`)] as const)))
  }
  const known = await read($, git)
  if (JSON.stringify(next) !== JSON.stringify(known)) await update($, git, () => next)
}

const insertPath = ($: EngineInterface, path: string) => $.prompt.fill({ text: `@${path} `, mode: 'insert' })

// $VISUAL, then $EDITOR, else VS Code; through cmd on Windows so a `.cmd` shim like code.cmd resolves.
async function openInEditor($: EngineInterface, path: string) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const editor = ((await $.env.get('VISUAL')) || (await $.env.get('EDITOR')) || 'code').trim().split(/\s+/)
  const file = `${await $.session.cwd()}/${path}`
  const argv = isWindows ? ['cmd', '/c', ...editor, file.replace(/\//g, '\\')] : [...editor, file]
  $.ui.toast(`Opening ${path} in ${editor[0]}`)
  const ran = await $.process.run(argv, { timeoutMs: 15000 }).catch((error: unknown) => ({
    exitCode: -1,
    stderr: String(error),
  }))
  if (ran.exitCode !== 0) {
    const reason = ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`
    $.ui.toast(`Could not open ${path}: ${reason}`)
  }
}

// VS Code itself (not $EDITOR) on `dir` (relative to the cwd; `''` the cwd itself, from the room below
// the rows); through cmd on Windows for code.cmd.
async function openFolderInVsCode($: EngineInterface, dir: string) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const cwd = await $.session.cwd()
  const folder = dir === '' ? cwd : `${cwd}/${dir}`
  const argv = isWindows ? ['cmd', '/c', 'code', folder.replace(/\//g, '\\')] : ['code', folder]
  $.ui.toast(`Opening ${baseName(folder)} in VS Code`)
  const ran = await $.process.run(argv, { timeoutMs: 15000 }).catch((error: unknown) => ({
    exitCode: -1,
    stderr: String(error),
  }))
  if (ran.exitCode !== 0) {
    const reason = ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`
    $.ui.toast(`Could not open VS Code: ${reason}`)
  }
}

const IMAGE = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?|heic|avif)$/i

// The system's own handler for the file: on Windows `start`, which hands an image to Photos
// (or whatever app the person made the default); `open` on macOS, `xdg-open` elsewhere.
async function openWithSystem($: EngineInterface, path: string) {
  const file = `${await $.session.cwd()}/${path}`
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const isMac = !isWindows && (await $.process.run(['uname']).catch(() => undefined))?.stdout.trim() === 'Darwin'
  const argv = isWindows
    ? ['cmd', '/c', 'start', '', file.replace(/\//g, '\\')]
    : [isMac ? 'open' : 'xdg-open', file]
  $.ui.toast(`Opening ${path}`)
  const ran = await $.process.run(argv, { timeoutMs: 15000 }).catch((error: unknown) => ({
    exitCode: -1,
    stderr: String(error),
  }))
  if (ran.exitCode !== 0) {
    const reason = ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`
    $.ui.toast(`Could not open ${path}: ${reason}`)
  }
}

/**
 * Creates an empty `file.md` in `dir` (relative to the cwd; `''` the cwd itself), or `file-1.md`,
 * `file-2.md`, ... where that is taken; opens the folders down to it so it shows, then opens it
 * in the editor. Resolves with the new file's path.
 */
async function newMarkdown($: EngineInterface, dir: string) {
  const cwd = await $.session.cwd()
  const inDir = (name: string) => (dir === '' ? name : `${dir}/${name}`)
  let name = 'file.md'
  for (let n = 1; await $.fs.exists(`${cwd}/${inDir(name)}`); n++) name = `file-${n}.md`
  const path = inDir(name)
  await $.fs.write(`${cwd}/${path}`, '')

  const parts = dir === '' ? [] : dir.split('/')
  const folders = parts.map((_, index) => parts.slice(0, index + 1).join('/'))
  await update($, expanded, list => [...new Set([...list, ...folders])])
  await refreshAll($)
  void openInEditor($, path)

  return path
}

/** What a double click (or Enter) does to a file: an image to the system viewer, the rest to the editor. */
const openFile = ($: EngineInterface, path: string) =>
  IMAGE.test(path) ? openWithSystem($, path) : openInEditor($, path)

const refreshAll = ($: EngineInterface) => Promise.all([refresh($), refreshGit($)])

const collapseAll = ($: EngineInterface) => update($, expanded, () => [])

const summaryOf = (status: GitStatus) => {
  const changes = Object.keys(status.files).length
  return !status.isRepo ? '' : changes === 0 ? 'clean' : `${changes} changed`
}

const treeProps = (root: string, status: GitStatus, rows: Row[], icons: boolean): TreeProps => ({
  root,
  summary: summaryOf(status),
  icons,
  rows: rows.map(row => {
    const kind = row.isDir ? (row.isOpen ? 'o' : 'd') : 'f'
    return row.mark ? [row.path, row.prefix, kind, row.mark] : [row.path, row.prefix, kind]
  }),
})

export const register: Register = (on, options) => {
  // Nerd Font icons, unless the person's terminal font has none (the `icons` option).
  const icons = options.icons !== false
  let lastSignature: string | undefined
  let isPolling = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Show or hide the file tree of the working directory',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refreshGit($)

    // Catch changes made outside the tools (an editor, a build, a commit) without redrawing when nothing moved.
    $.clock.every(POLL_MS, () => {
      if (isPolling) return
      isPolling = true
      void (async () => {
        await refreshGit($)
        const context = contextOf(await $.session.cwd(), new Set(await read($, expanded)), await read($, git))
        const current = signature(await walk($, context))
        if (lastSignature !== undefined && current !== lastSignature) await refresh($)
        lastSignature = current
      })().finally(() => (isPolling = false))
    })

    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      return { text: 'File tree closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'File tree opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (MUTATING_TOOLS.has(e.tool)) {
      await refresh($).catch(() => undefined)
      void refreshGit($).catch(() => undefined)
    }

    return ran
  })

  // What the tree view posts: a left click, a key, or a pick from the right-click menu.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const { action, path } = e.data as TreeMessage
    // An opened folder may hold a repository of its own: look now, not at the next poll.
    if (action === 'toggle') await toggle($, path).then(() => void refreshGit($).catch(() => undefined))
    else if (action === 'insert') await insertPath($, path)
    else if (action === 'edit') void openInEditor($, path)
    else if (action === 'open') void openFile($, path)
    else if (action === 'refresh') await refreshAll($)
    else if (action === 'collapse') await collapseAll($)
    else if (action === 'new-md') await newMarkdown($, path)
    else if (action === 'open-vscode') void openFolderInVsCode($, path)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick)
    const cwd = await $.session.cwd()
    const context = contextOf(cwd, new Set(await read($, expanded)), await read($, git))
    const rows = await walk($, context)
    const root = baseName(cwd)
    const width = Math.max(12, e.props.bodyColumns)
    // The tree view needs the raw pointer for its right-click menu: a desktop, or the fullscreen
    // terminal that reports clicks. Elsewhere the rows are plain Buttons (left click only).
    const Client = e.surface === 'desktop' || e.surface === 'terminal' ? $.ui.resolve(e).Client : undefined
    const hasPointer = Client !== undefined && (e.surface === 'desktop' || e.viewport?.isFullscreen === true)
    const summary = summaryOf(context.status)
    const more = rows.length >= MAX_ROWS && (
      <Text dimColor>… more than {MAX_ROWS} entries, collapse some folders</Text>
    )

    // With a pointer the tree view draws the whole body, header included, and fills the pane,
    // so every click in the sidebar reaches it (a click on no row clears the selection).
    if (hasPointer) {
      const height = Math.max(rows.length + 2, e.props.scroll.bodyRows - (more ? 1 : 0))
      return (
        <Box flexDirection="column">
          <Client key="tree" module="./tree-view.tsx" props={treeProps(root, context.status, rows, icons)} width={width} height={height} />
          {more}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {fit(`${root}/`, width - (summary ? summary.length + 1 : 0))}
          {summary && <Text dimColor> {summary}</Text>}
        </Text>
        <Box flexDirection="row">
          <Button key="refresh" plain dimColor onPress={() => void refreshAll($)}>
            refresh
          </Button>
          <Text> </Text>
          <Button key="collapse" plain dimColor onPress={() => void collapseAll($)}>
            collapse all
          </Button>
        </Box>
        {rows.length === 0 && <Text dimColor>(empty)</Text>}
        {rows.map(row => {
          const marker = row.isDir ? (row.isOpen ? '▾ ' : '▸ ') : '  '
          const badge = badgeOf(row.mark, row.isDir, width)
          const icon = icons ? iconOf(row.name, row.isDir ? (row.isOpen ? 'o' : 'd') : 'f') : undefined
          const room = width - row.prefix.length - marker.length - (icon ? ICON_CELLS : 0) - (badge?.width ?? 0)
          const label = fit(row.name + (row.isDir ? '/' : ''), room)
          // A Button has one press, no double: a file opens on it.
          const onPress = row.isDir ? () => void toggle($, row.path) : () => void openFile($, row.path)

          return (
            <Button key={(row.isDir ? 'd:' : 'f:') + row.path} plain onPress={onPress}>
              <Text dimColor>{row.prefix}</Text>
              {marker}
              {icon && (
                <Text color={icon.color} dimColor={row.mark?.i === 1}>
                  {icon.glyph}{' '}
                </Text>
              )}
              <Text
                bold={row.isDir}
                color={badge?.color}
                dimColor={row.mark?.i === 1}
                strikethrough={row.mark?.x === 1}
              >
                {label}
              </Text>
              {badge?.added && <Text color="diffAdded"> {badge.added}</Text>}
              {badge?.removed && <Text color="diffRemoved"> {badge.removed}</Text>}
              {badge?.code && <Text color={badge.color}> {badge.code}</Text>}
            </Button>
          )
        })}
        {more}
      </Box>
    )
  })
}
