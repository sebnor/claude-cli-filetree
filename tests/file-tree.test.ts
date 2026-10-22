import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

// A working directory that is not a git repo, with a .git folder that must stay hidden anyway.
const DISK: Record<string, FsEntry[]> = {
  '': [file('README.md'), dir('src'), dir('.git'), file('.env'), file('logo.png')],
  src: [file('main.ts'), dir('lib')],
  'src/lib': [file('util.ts')],
}

const CWD = 'C:/work/demo'
// The header reads `↑ up  refresh  collapse all`: refresh starts at column 6.
const REFRESH_X = 7

const fakeDisk = (on: On) => {
  on('session.cwd', () => ({ value: CWD }))
  // The host hands the path on in the platform's spelling (backslashes on Windows).
  on('fs.list', ($, e) => {
    const path = e.path.replace(/\\/g, '/')
    return { value: DISK[path === CWD ? '' : path.slice(CWD.length + 1)] ?? [] }
  })
}

const PROPS = {
  title: 'Files',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

// Without a pointer (the terminal's main screen, VS Code) every row is a Button.
for (const surface of ['terminal', 'vscode'] as const) {
  test(`${surface}: lists every file, folders first, hiding only .git`, async ($, on) => {
    fakeDisk(on)
    const ui = await $.ui.mount({ plugin: 'file-tree', surface, component: 'Pane', props: PROPS, requestId: 'file-tree' })

    const rows = (await ui.findAll({ type: 'Button' })).map(one => one.key)
    expect(rows).toEqual(['up', 'refresh', 'collapse', 'd:src', 'f:.env', 'f:logo.png', 'f:README.md'])
  })

  test(`${surface}: pressing a folder opens it, pressing again closes it`, async ($, on) => {
    fakeDisk(on)
    const ui = await $.ui.mount({ plugin: 'file-tree', surface, component: 'Pane', props: PROPS, requestId: 'file-tree' })

    await ui.press({ key: 'd:src' })
    await ui.press({ key: 'd:src/lib' })
    const opened = (await ui.findAll({ type: 'Button' })).map(one => one.key)
    expect(opened).toContain('f:src/lib/util.ts')
    expect(opened).toContain('f:src/main.ts')

    await ui.press({ key: 'collapse' })
    const collapsed = (await ui.findAll({ type: 'Button' })).map(one => one.key)
    expect(collapsed).not.toContain('f:src/main.ts')
  })
}

// With a pointer (a desktop, the fullscreen terminal) one Client draws the rows: in the fake disk
// they are y 0 `src/`, y 1 `.env`, y 2 `logo.png`, y 3 `README.md`.
const POINTER = [
  { surface: 'desktop', viewport: { columns: 120, rows: 40 } },
  { surface: 'terminal', viewport: { columns: 160, rows: 40, isFullscreen: true } },
] as const

const textOf = (tree: unknown) => JSON.stringify(tree)

type Drawn = { props?: Record<string, unknown>; children?: unknown[] }

// The open menu's Box (the one drawn `position: absolute`), and its offsets in region cells.
const menuBox = (tree: unknown): { top: number; left: number } => {
  const find = (node: unknown): Drawn | undefined => {
    if (!node || typeof node !== 'object') return undefined
    const drawn = node as Drawn
    if (drawn.props?.position === 'absolute') return drawn
    for (const child of drawn.children ?? []) {
      const found = find(child)
      if (found) return found
    }
    return undefined
  }
  const props = find(tree)?.props ?? {}
  return { top: Number(props.top), left: Number(props.left) }
}

for (const { surface, viewport } of POINTER) {
  const mount = async ($: Parameters<TestBody>[0], on: On, env: Record<string, string> = {}) => {
    fakeDisk(on)
    const filled: string[] = []
    const ran: string[][] = []
    on('prompt.fill', ($, e) => {
      filled.push(e.text)
      return { isFilled: true, text: e.text, cursor: e.text.length }
    })
    on('env.get', ($, e) => ({ value: env[e.name] }))
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await $.ui.mount({ plugin: 'file-tree', surface, component: 'Pane', props: PROPS, requestId: 'file-tree', viewport })
    const click = (y: number) => ui.pointer({ type: 'down', x: 4, y: y + 2, button: 'left', in: 'tree' })
    return { ui, filled, ran, click }
  }

  test(`${surface}: one left click selects a file and does nothing else`, async ($, on) => {
    const { ui, filled, ran, click } = await mount($, on)

    await click(3)
    expect(filled).toEqual([])
    expect(ran).toEqual([])
    expect(textOf(await ui.drawn({ in: 'tree' }))).toContain('"inverse":true')
  })

  test(`${surface}: a double click opens a file in the editor, an image in the system viewer`, async ($, on) => {
    const { ran, click } = await mount($, on)

    await click(3)
    await click(3)
    expect(ran).toEqual([['code', `${CWD}/README.md`]])

    await click(2)
    await click(2)
    expect(ran.slice(1)).toEqual([['uname'], ['xdg-open', `${CWD}/logo.png`]])
  })

  test(`${surface}: on Windows an image opens through start, the default app`, async ($, on) => {
    const { ran, click } = await mount($, on, { OS: 'Windows_NT' })

    await click(2)
    await click(2)
    expect(ran).toEqual([['cmd', '/c', 'start', '', 'C:\\work\\demo\\logo.png']])
  })

  test(`${surface}: clicks on two different files are no double click`, async ($, on) => {
    const { ran, click } = await mount($, on)

    await click(2)
    await click(3)
    expect(ran).toEqual([])
  })

  test(`${surface}: one left click opens a folder`, async ($, on) => {
    const { ui, click } = await mount($, on)

    await click(0)
    expect(textOf(await ui.drawn({ in: 'tree' }))).toContain('main.ts')
  })

  test(`${surface}: right click on a file opens the action menu; Edit file opens the editor`, async ($, on) => {
    const { ui, filled, ran } = await mount($, on)

    await ui.pointer({ type: 'down', x: 4, y: 5, button: 'right', in: 'tree' })
    const menu = textOf(await ui.drawn({ in: 'tree' }))
    expect(menu).toContain('Insert path')
    expect(menu).toContain('Edit file')
    expect(filled).toEqual([])

    // Where the menu lands depends on the room below the row: read it off the drawing.
    const { top, left } = menuBox(await ui.drawn({ in: 'tree' }))
    await ui.pointer({ type: 'down', x: left + 2, y: top + 2, button: 'left', in: 'tree' })
    expect(ran).toEqual([['code', `${CWD}/README.md`]])
    expect(textOf(await ui.drawn({ in: 'tree' }))).not.toContain('Edit file')
  })

  test(`${surface}: a click on no row, below the rows or on the title, clears the selection`, async ($, on) => {
    const { ui, ran, click } = await mount($, on)

    await click(3)
    expect(textOf(await ui.drawn({ in: 'tree' }))).toContain('"inverse":true')
    await ui.pointer({ type: 'down', x: 4, y: 20, button: 'left', in: 'tree' })
    expect(textOf(await ui.drawn({ in: 'tree' }))).not.toContain('"inverse":true')

    await click(1)
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tree' })
    expect(textOf(await ui.drawn({ in: 'tree' }))).not.toContain('"inverse":true')
    expect(ran).toEqual([])
  })

  test(`${surface}: a click below the rows closes the menu and clears the selection`, async ($, on) => {
    const { ui } = await mount($, on)

    await ui.pointer({ type: 'down', x: 4, y: 5, button: 'right', in: 'tree' })
    await ui.pointer({ type: 'down', x: 30, y: 25, button: 'left', in: 'tree' })
    const drawn = textOf(await ui.drawn({ in: 'tree' }))
    expect(drawn).not.toContain('Edit file')
    expect(drawn).not.toContain('"inverse":true')
  })

  test(`${surface}: the menu works from the keyboard and Insert path fills the prompt`, async ($, on) => {
    const { ui, filled } = await mount($, on)

    await ui.pointer({ type: 'down', x: 4, y: 3, button: 'right', in: 'tree' })
    await ui.key({ key: 'down', in: 'tree' })
    await ui.key({ key: 'up', in: 'tree' })
    await ui.key({ key: 'return', in: 'tree' })
    expect(filled).toEqual(['@.env '])
  })

  test(`${surface}: right click on a folder opens the folder menu: new file, VS Code`, async ($, on) => {
    const { ui } = await mount($, on)

    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'tree' })
    const drawn = textOf(await ui.drawn({ in: 'tree' }))
    expect(drawn).toContain('New .md file')
    expect(drawn).toContain('Open VS Code')
    expect(drawn).not.toContain('Insert path')
  })
}

// A repository whose cwd is its root: src/main.ts modified (+3 -1), .env untracked (2 lines),
// src/old.ts and the whole of gone/ deleted, node_modules/ ignored.
const fakeGit = (on: On) => {
  const run = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(3).join(' ')
    if (args.startsWith('rev-parse')) return run('\n')
    if (args.startsWith('status')) {
      return run([' M src/main.ts', '?? .env', ' D src/old.ts', 'D  gone/a.txt', '!! node_modules/', ''].join('\0'))
    }
    if (args.startsWith('diff')) return run(['3\t1\tsrc/main.ts', '0\t5\tsrc/old.ts', '0\t2\tgone/a.txt', ''].join('\0'))
    return run('')
  })
  on('fs.read', () => ({ value: 'A=1\nB=2\n' }))
}

const GIT_DISK = (on: On) => {
  on('session.cwd', () => ({ value: CWD }))
  const disk: Record<string, FsEntry[]> = { ...DISK, '': [...(DISK[''] ?? []), dir('node_modules')] }
  on('fs.list', ($, e) => {
    const path = e.path.replace(/\\/g, '/')
    const listed = disk[path === CWD ? '' : path.slice(CWD.length + 1)]
    if (!listed) throw new Error('ENOENT')
    return { value: listed }
  })
}

test('desktop: git marks files and folders with their status and line counts', async ($, on) => {
  GIT_DISK(on)
  fakeGit(on)
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree',
    viewport: { columns: 120, rows: 40 },
  })
  await ui.pointer({ type: 'down', x: REFRESH_X, y: 1, button: 'left', in: 'tree' })
  await ui.pointer({ type: 'down', x: 4, y: 4, button: 'left', in: 'tree' })

  const drawn = await ui.drawn({ in: 'tree' })
  const rows = ((drawn as { children?: unknown[] }).children ?? []).filter(Boolean)
  const text = (row: unknown) => JSON.stringify(row).match(/"[^"{}[\]]*"/g)?.join('') ?? ''
  const rowOf = (name: string) => rows.map(text).find(row => row.includes(`"${name}"`)) ?? `(no row ${name})`

  // Folders: the most serious change beneath them and their summed counts; a deleted folder stays.
  expect(rowOf('src/')).toContain('"+3"')
  expect(rowOf('src/')).toContain('"-6"')
  expect(rowOf('src/')).toContain('"●"')
  expect(rowOf('gone/')).toContain('"●"')
  expect(JSON.stringify(rows.find(row => text(row).includes('"gone/"')))).toContain('"strikethrough":true')
  // Files: their letter and counts; an untracked file's lines count as added.
  expect(rowOf('main.ts')).toContain('"+3"')
  expect(rowOf('main.ts')).toContain('"M"')
  expect(rowOf('old.ts')).toContain('"D"')
  expect(rowOf('.env')).toContain('"+2"')
  expect(rowOf('.env')).toContain('"U"')
  expect(JSON.stringify(rows.find(row => text(row).includes('"node_modules/"')))).toContain('"dimColor":true')
  expect(rowOf('README.md')).not.toContain('"M"')
})

test('terminal: outside a repository no marks are drawn', async ($, on) => {
  fakeDisk(on)
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', component: 'Pane', props: PROPS, requestId: 'file-tree' })
  await ui.press({ key: 'refresh' })

  expect(JSON.stringify(await ui.drawn())).not.toContain('changed')
  expect(JSON.stringify(await ui.drawn())).not.toContain('"●"')
})

// The cwd is no repository, but proj/ is one: a folder of projects.
test('desktop: a repository nested in a plain folder shows its changes', async ($, on) => {
  const disk: Record<string, FsEntry[]> = { '': [dir('proj'), file('notes.txt')], proj: [file('app.ts')] }
  const slash = (path: string) => path.split(String.fromCharCode(92)).join('/')
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => {
    const path = slash(e.path)
    return { value: disk[path === CWD ? '' : path.slice(CWD.length + 1)] ?? [] }
  })
  on('fs.exists', ($, e) => ({ value: slash(e.path) === `${CWD}/proj/.git` }))
  on('process.run', ($, e) => {
    const isProj = slash(e.init?.cwd ?? '') === `${CWD}/proj`
    const args = e.argv.slice(3).join(' ')
    const stdout = !isProj ? '' : args.startsWith('rev-parse') ? '\n' : args.startsWith('status') ? ' M app.ts\0' : '2\t0\tapp.ts\0'
    return { value: { exitCode: isProj ? 0 : 128, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree',
    viewport: { columns: 120, rows: 40 },
  })
  await ui.pointer({ type: 'down', x: REFRESH_X, y: 1, button: 'left', in: 'tree' })

  const drawn = JSON.stringify(await ui.drawn({ in: 'tree' }))
  expect(drawn).toContain('"+2"')
  expect(drawn).toContain('"●"')
  expect(JSON.stringify(await ui.drawn())).toContain('1 changed')

  await ui.pointer({ type: 'down', x: 4, y: 2, button: 'left', in: 'tree' })
  expect(JSON.stringify(await ui.drawn({ in: 'tree' }))).toContain('"M"')
})

test('desktop: a dotted leader ties a changed row to its badge; an unchanged row has none', async ($, on) => {
  GIT_DISK(on)
  fakeGit(on)
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree',
    viewport: { columns: 120, rows: 40 },
  })
  await ui.pointer({ type: 'down', x: REFRESH_X, y: 1, button: 'left', in: 'tree' })

  const rows = ((await ui.drawn({ in: 'tree' })) as { children?: unknown[] }).children ?? []
  const rowOf = (name: string) => JSON.stringify(rows.find(row => JSON.stringify(row).includes(`"${name}"`)))
  expect(rowOf('.env')).toMatch(/ ·{3,}/)
  expect(rowOf('README.md')).not.toContain('·')
})
