import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { GitStatus } from '../types'
import { NO_GIT, deletedEntries, folderMarks, isIgnored, mergeGit, readGit } from './git'
import { ICON_CELLS, iconOf } from './icons'
import { badgeOf } from './marks'
import type { TreeMark } from './marks'
import { join, nameOf, normalize, parentOf, relativeTo } from './paths'
import type { TreeMessage, TreeProps } from './tree-view'

const PANE = 'file-tree'
const TITLE = 'Files'
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const pinned = atom({ plugin: 'file-tree', key: 'pinned' } as const, '')
const newFile = atom({ plugin: 'file-tree', key: 'newFile' } as const, { isOpen: false, dir: '', suggested: '', name: '', error: '' })
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
  const path = join(context.root, dir)
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
// Paths in the rows stay relative to the tree's top folder.
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


const toggle = ($: EngineInterface, path: string) =>
  update($, expanded, list => (list.includes(path) ? list.filter(one => one !== path) : [...list, path]))

const refresh = ($: EngineInterface) => update($, tick, n => n + 1)

/** The session's working directory, spelled as the tree spells paths. */
const cwdOf = async ($: EngineInterface) => normalize(await $.session.cwd())

/** The tree's top folder: where the person pinned it by moving up, else the session's cwd. */
const rootOf = async ($: EngineInterface) => (await read($, pinned)) || cwdOf($)

/** Every row path below `from`'s open folders, respelled from `to` (dropped where outside `to`). */
function rebase(list: readonly string[], from: string, to: string): string[] {
  return list.flatMap(path => {
    const rel = relativeTo(to, join(from, path))
    return rel === undefined || rel === '' ? [] : [rel]
  })
}

// Moves the tree's top up one folder and pins it there: it no longer follows the session's cwd.
// The folder it came from stays open, so the place the person was is still in view.
async function moveUp($: EngineInterface) {
  const root = await rootOf($)
  const parent = parentOf(root)
  if (parent === undefined) return
  const came = relativeTo(parent, root)
  await update($, expanded, list => [...new Set([...(came ? [came] : []), ...rebase(list, root, parent)])])
  await update($, pinned, () => parent)
  await refreshAll($)
}

// Back in sync with the session's cwd: the open folders below it stay open.
async function sync($: EngineInterface) {
  const root = await rootOf($)
  const cwd = await cwdOf($)
  await update($, expanded, list => rebase(list, root, cwd))
  await update($, pinned, () => '')
  await refreshAll($)
}

// Bounds the folders checked for a `.git` of their own on one read.
const MAX_REPO_PROBES = 200

// The tree's repository; where its top is in none (a folder of projects), every folder on screen
// that is a repository's top, each read by its own git. Written only when it changed, so a quiet
// repository redraws nothing.
async function refreshGit($: EngineInterface) {
  const root = await rootOf($)
  let next = await readGit($, root)
  if (!next.isRepo) {
    const rows = await walk($, contextOf(root, new Set(await read($, expanded)), NO_GIT))
    const dirs = rows.filter(row => row.isDir).slice(0, MAX_REPO_PROBES)
    const isTop = await Promise.all(dirs.map(row => $.fs.exists(`${join(root, row.path)}/.git`).catch(() => false)))
    const repos = dirs.filter((_, index) => isTop[index]).map(row => row.path)
    next = mergeGit(await Promise.all(repos.map(async repo => [repo, await readGit($, join(root, repo))] as const)))
  }
  const known = await read($, git)
  if (JSON.stringify(next) !== JSON.stringify(known)) await update($, git, () => next)
}

// `@path` as Claude reads it: relative to the session's cwd where the file is below it, else absolute.
async function insertPath($: EngineInterface, path: string) {
  const file = join(await rootOf($), path)
  const reference = relativeTo(await cwdOf($), file) || file
  return $.prompt.fill({ text: `@${reference} `, mode: 'insert' })
}

// $VISUAL, then $EDITOR, else VS Code; through cmd on Windows so a `.cmd` shim like code.cmd resolves.
async function openInEditor($: EngineInterface, path: string) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const editor = ((await $.env.get('VISUAL')) || (await $.env.get('EDITOR')) || 'code').trim().split(/\s+/)
  const file = join(await rootOf($), path)
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

// VS Code itself (not $EDITOR) on `dir` (a tree path; `''` the tree's top folder, from the room below
// the rows); through cmd on Windows for code.cmd.
async function openFolderInVsCode($: EngineInterface, dir: string) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const folder = join(await rootOf($), dir)
  const argv = isWindows ? ['cmd', '/c', 'code', folder.replace(/\//g, '\\')] : ['code', folder]
  $.ui.toast(`Opening ${nameOf(folder)} in VS Code`)
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
  const file = join(await rootOf($), path)
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

const inDir = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`)

// Characters no file name may hold on Windows (and so nowhere, for a name meant to travel).
const BAD_NAME = /[<>:"|?*\u0000-\u001f]/

/**
 * The name typed into the box as a path below its folder, or why it cannot be one: `.md` added
 * where the last part has no extension; `/` (or `\`) makes subfolders; no `..`, no absolute path.
 */
export function nameToPath(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/\\/g, '/')
  if (name.startsWith('/')) return { error: 'Give a name inside the folder, not an absolute path.' }
  const parts = name.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return { error: 'A name cannot have empty parts, "." or "..".' }
  }
  if (BAD_NAME.test(name)) return { error: 'A name cannot hold < > : " | ? * or control characters.' }
  const last = parts[parts.length - 1] ?? ''
  return { name: last.includes('.') && !last.endsWith('.') ? name : `${name.replace(/\.$/, '')}.md` }
}

/** The first of `file.md`, `file-1.md`, ... that is free in `dir`. */
async function freeName($: EngineInterface, root: string, dir: string) {
  let name = 'file.md'
  for (let n = 1; await $.fs.exists(join(root, inDir(dir, name))); n++) name = `file-${n}.md`
  return name
}

const NAME_KEY = 'new-name'

// **New .md file**: opens the name box at the top of the pane, for a file in `dir` (a tree path;
// `''` the tree's top folder), and puts the keyboard in its field where the pane holds the keys.
async function openNewFile($: EngineInterface, dir: string) {
  const suggested = await freeName($, await rootOf($), dir)
  await update($, newFile, () => ({ isOpen: true, dir, suggested, name: '', error: '' }))
  await $.ui.focus({ requestId: PANE, key: NAME_KEY }).catch(() => undefined)
}

const closeNewFile = ($: EngineInterface) => update($, newFile, box => ({ ...box, isOpen: false, error: '' }))

/**
 * Creates the file the box names (empty: the suggested `file.md`), opens the folders down to it
 * so it shows, then opens it in the editor; a name refused or taken stays in the box with why.
 */
async function submitNewFile($: EngineInterface, raw: string) {
  const box = await read($, newFile)
  if (!box.isOpen) return
  const parsed = nameToPath(raw.trim() === '' ? box.suggested : raw)
  const refuse = (error: string) => update($, newFile, one => ({ ...one, name: raw, error }))
  if ('error' in parsed) return refuse(parsed.error)
  const root = await rootOf($)
  const path = inDir(box.dir, parsed.name)
  if (await $.fs.exists(join(root, path))) return refuse(`${parsed.name} already exists.`)
  await $.fs.write(join(root, path), '')

  const parts = path.split('/').slice(0, -1)
  const folders = parts.map((_, index) => parts.slice(0, index + 1).join('/'))
  await update($, expanded, list => [...new Set([...list, ...folders])])
  await closeNewFile($)
  await refreshAll($)
  void openInEditor($, path)
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

/** How the header reads the tree's top: pinned (moved up, out of sync) or in sync with the cwd. */
type Where = { isPinned: boolean; canGoUp: boolean; here?: string }

/** Where the tree stands: pinned or not, whether there is a folder above, the cwd's row when pinned. */
async function whereOf($: EngineInterface, root: string): Promise<Where> {
  const isPinned = (await read($, pinned)) !== ''
  const here = isPinned ? relativeTo(root, await cwdOf($)) : undefined
  return { isPinned, canGoUp: parentOf(root) !== undefined, ...(here ? { here } : {}) }
}

// A Client's props may serialize to 100,000 characters at most, or the surface unmounts it, header
// and all. The rows get this much of it; the rest of the props are a few hundred at most.
const ROWS_BUDGET = 90_000

/** The rows as the tree view takes them, as many as fit the budget, and whether some were cut. */
function fitRows(rows: readonly Row[]): { rows: TreeProps['rows']; isCut: boolean } {
  const fitted: TreeProps['rows'] = []
  let used = 2
  for (const row of rows) {
    const kind = row.isDir ? (row.isOpen ? 'o' : 'd') : 'f'
    const tuple: TreeProps['rows'][number] = row.mark ? [row.path, row.prefix, kind, row.mark] : [row.path, row.prefix, kind]
    used += JSON.stringify(tuple).length + 1
    if (used > ROWS_BUDGET) return { rows: fitted, isCut: true }
    fitted.push(tuple)
  }

  return { rows: fitted, isCut: false }
}

/** The window the pane shows of the tree view's region: its first row and how many. */
type Window = { offset: number; bodyRows: number }

const treeProps = (root: string, where: Where, status: GitStatus, rows: TreeProps['rows'], icons: boolean, window: Window): TreeProps => ({
  root: nameOf(root),
  ...where,
  summary: summaryOf(status),
  icons,
  rows,
  ...window,
})

// A held key repeats far faster than this; a person pressing again waits longer.
const KEY_REPEAT_MS = 400

export const register: Register = (on, options) => {
  // Nerd Font icons, unless the person's terminal font has none (the `icons` option).
  const icons = options.icons !== false
  let lastSignature: string | undefined
  let isPolling = false
  // When the last `u` arrived: a key held down sends one up, its repeats are dropped.
  let lastUpKeyAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'files',
      description: 'Show or hide the file tree of the working directory; `sync` puts its top back on the cwd',
      argumentHint: '[sync]',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refreshGit($)

    // Catch changes made outside the tools (an editor, a build, a commit) without redrawing when nothing moved.
    $.clock.every(POLL_MS, () => {
      if (isPolling) return
      isPolling = true
      void (async () => {
        await refreshGit($)
        const root = await rootOf($)
        const context = contextOf(root, new Set(await read($, expanded)), await read($, git))
        // The top folder is in the signature: a `cd` while in sync redraws the new tree.
        const current = `${root}\n${signature(await walk($, context))}`
        if (lastSignature !== undefined && current !== lastSignature) await refresh($)
        lastSignature = current
      })().finally(() => (isPolling = false))
    })

    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    // The way back from anywhere, the pane drawn or not: in sync with the cwd, pane open.
    if (e.args.trim() === 'sync') {
      await sync($)
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'File tree back in sync with the working directory.' }
    }
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
    else if (action === 'new-md') await openNewFile($, path)
    else if (action === 'open-vscode') void openFolderInVsCode($, path)
    else if (action === 'up') {
      // From the keyboard, one step per press: a held key's repeats arrive closer than a person presses.
      const now = Date.now()
      const isRepeat = path === 'key' && now - lastUpKeyAt < KEY_REPEAT_MS
      if (path === 'key') lastUpKeyAt = now
      if (!isRepeat) await moveUp($)
    } else if (action === 'sync') await sync($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick)
    const top = await rootOf($)
    const where = await whereOf($, top)
    const context = contextOf(top, new Set(await read($, expanded)), await read($, git))
    const rows = await walk($, context)
    const root = nameOf(top)
    const width = Math.max(12, e.props.bodyColumns)
    // The tree view needs the raw pointer for its right-click menu: a desktop, or the fullscreen
    // terminal that reports clicks. Elsewhere the rows are plain Buttons (left click only).
    const Client = e.surface === 'desktop' || e.surface === 'terminal' ? $.ui.resolve(e).Client : undefined
    const hasPointer = Client !== undefined && (e.surface === 'desktop' || e.viewport?.isFullscreen === true)
    const summary = summaryOf(context.status)
    // Too many rows for one drawing (by count, or by size for the tree view): the first ones show.
    const fitted = fitRows(rows)
    const more = (rows.length >= MAX_ROWS || (hasPointer && fitted.isCut)) && (
      <Text dimColor>… more entries than fit, collapse some folders</Text>
    )

    // The name box of **New .md file**, above the tree while open. A surface with no text field
    // (mobile) has no box: there the menu that opens it is not drawn either.
    const box = await read($, newFile)
    const table = $.ui.resolve(e)
    const Input = 'Input' in table ? table.Input : undefined
    const boxRows = box.isOpen && Input ? 5 + (box.error ? 1 : 0) : 0
    const nameBox = boxRows > 0 && Input && (
      <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Text wrap="truncate">
          New file in <Text bold>{box.dir === '' ? `${root}/` : `${box.dir}/`}</Text>
        </Text>
        <Input
          key={NAME_KEY}
          label="Name "
          placeholder={box.suggested}
          value={box.name}
          submitLabel="create"
          autoFocus
          onSubmit={name => void submitNewFile($, name)}
        />
        {box.error && <Text color="error">{box.error}</Text>}
        <Box flexDirection="row">
          <Button key="new-cancel" plain dimColor onPress={() => void closeNewFile($)}>
            cancel
          </Button>
          <Text dimColor wrap="truncate">  Enter creates · empty: {box.suggested}</Text>
        </Box>
      </Box>
    )

    // With a pointer the tree view draws the whole body, header included, and fills the pane,
    // so every click in the sidebar reaches it (a click on no row clears the selection).
    if (hasPointer) {
      const height = Math.max(fitted.rows.length + 2, e.props.scroll.bodyRows - (more ? 1 : 0) - boxRows)
      return (
        <Box flexDirection="column">
          {nameBox}
          <Client key="tree" module="./tree-view.tsx" props={treeProps(top, where, context.status, fitted.rows, icons, { offset: Math.max(0, e.props.scroll.offset - boxRows), bodyRows: e.props.scroll.bodyRows })} width={width} height={height} />
          {more}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {nameBox}
        <Text bold>
          {fit(`${root}/`, width - (summary ? summary.length + 1 : 0) - (where.isPinned ? 9 : 0))}
          {summary && <Text dimColor> {summary}</Text>}
          {where.isPinned && <Text color="warning"> · pinned</Text>}
        </Text>
        <Box flexDirection="row">
          {where.canGoUp && (
            <Button key="up" plain dimColor onPress={() => void moveUp($)}>
              ↑ up
            </Button>
          )}
          {where.canGoUp && <Text> </Text>}
          <Button key="refresh" plain dimColor onPress={() => void refreshAll($)}>
            refresh
          </Button>
          <Text> </Text>
          <Button key="collapse" plain dimColor onPress={() => void collapseAll($)}>
            collapse all
          </Button>
          {where.isPinned && <Text> </Text>}
          {where.isPinned && (
            <Button key="sync" plain onPress={() => void sync($)}>
              ↻ sync
            </Button>
          )}
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
