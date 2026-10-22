import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const CWD = 'C:/work/demo'
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const slash = (path: string) => path.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '')

// The session's cwd is C:/work/demo; above it C:/work and the drive's root.
const DISK: Record<string, FsEntry[]> = {
  'C:': [dir('work')],
  'C:/work': [dir('demo'), dir('other'), file('top.txt')],
  'C:/work/demo': [dir('src'), file('README.md')],
  'C:/work/demo/src': [file('main.ts')],
  'C:/work/other': [file('b.md')],
}

const PROPS = {
  title: 'Files',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const mount = async ($: Parameters<TestBody>[0], on: On) => {
  const filled: string[] = []
  const ran: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => ({ value: DISK[slash(e.path)] ?? [] }))
  on('fs.exists', () => ({ value: false }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('env.get', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree',
    viewport: { columns: 120, rows: 40 },
  })
  const drawn = async () => JSON.stringify(await ui.drawn({ in: 'tree' }))
  const key = (name: string) => ui.key({ key: name, in: 'tree' })
  // Row `index` (0 the first row, below the two header rows).
  const click = (index: number, button: 'left' | 'right' = 'left') =>
    ui.pointer({ type: 'down', x: 8, y: index + 2, button, in: 'tree' })
  const opened = () => ran.filter(argv => argv[0] !== 'git')
  // ↑ up in the header: the first action, from column 0.
  const up = () => ui.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'tree' })
  return { ui, filled, opened, drawn, key, click, up }
}

test('in sync, the tree shows the cwd: no pinned mark and no sync action', async ($, on) => {
  const { drawn } = await mount($, on)

  const tree = await drawn()
  expect(tree).toContain('"demo/"')
  expect(tree).toContain('↑ up')
  expect(tree).not.toContain('pinned')
  expect(tree).not.toContain('↻ sync')
})

test('↑ up shows the parent, pinned, with the cwd folder open and marked', async ($, on) => {
  const { ui, drawn, click } = await mount($, on)

  await click(0)
  expect(await drawn()).toContain('main.ts')
  await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'tree' })

  const tree = await drawn()
  expect(tree).toContain('"work/"')
  expect(tree).toContain(' · pinned')
  expect(tree).toContain('↻ sync')
  expect(tree).toContain('← cwd')
  expect(tree).toContain('top.txt')
  // The folders open before stay open, from the new top.
  expect(tree).toContain('main.ts')
})

test('↑ up climbs to the drive root, where there is no folder above', async ($, on) => {
  const { drawn, key, up } = await mount($, on)

  await up()
  await up()
  const tree = await drawn()
  expect(tree).toContain('"work/"')
  expect(tree).not.toContain('↑ up')
  await up()
  expect(await drawn()).toContain('"work/"')
})

test('↻ sync brings the tree back to the cwd, the open folders below it kept', async ($, on) => {
  const { ui, drawn, key, click, up } = await mount($, on)

  await up()
  // Rows from C:/work: demo/ (open, as the cwd), src/, README.md, other/, top.txt.
  await click(1)
  expect(await drawn()).toContain('main.ts')
  // `↑ up  refresh  collapse all  ↻ sync`: sync starts at column 29.
  await ui.pointer({ type: 'down', x: 30, y: 1, button: 'left', in: 'tree' })

  const tree = await drawn()
  expect(tree).toContain('"demo/"')
  expect(tree).not.toContain('pinned')
  expect(tree).not.toContain('top.txt')
  expect(tree).toContain('main.ts')
})

test('`s` syncs too', async ($, on) => {
  const { drawn, key, up } = await mount($, on)

  await up()
  await key('s')
  expect(await drawn()).not.toContain('pinned')
})

test('while pinned, Insert path is relative below the cwd and absolute outside it', async ($, on) => {
  const { filled, key, click, up } = await mount($, on)

  await up()
  // Rows: demo/, src/, README.md, other/, top.txt.
  await click(2, 'right')
  await key('1')
  await click(4, 'right')
  await key('1')
  expect(filled).toEqual(['@README.md ', '@C:/work/top.txt '])
})

test('while pinned, a double click opens the file from the shown folder', async ($, on) => {
  const { opened, key, click, up } = await mount($, on)

  await up()
  await click(4)
  await click(4)
  expect(opened()).toEqual([['code', 'C:/work/top.txt']])
})

test('Backspace does not move the tree up', async ($, on) => {
  const { drawn, key } = await mount($, on)

  await key('backspace')
  expect(await drawn()).not.toContain('pinned')
})

test('`u` moves up once per press: a held key repeating does not climb on', async ($, on) => {
  const { drawn, key } = await mount($, on)

  // A held key: repeats much closer together than a person presses.
  await key('u')
  await key('u')
  await key('u')
  await key('u')
  const tree = await drawn()
  expect(tree).toContain('"work/"')
  expect(tree).toContain('↑ up')
  expect(tree).toContain('← cwd')
})

test('/files sync puts the tree back on the cwd, from wherever it was', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const { drawn, up } = await mount($, on)

  await up()
  await up()
  expect(await drawn()).toContain('pinned')
  const { text } = await $.command.run({
    command: 'files',
    args: 'sync',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(text).toContain('in sync')
  expect(await drawn()).not.toContain('pinned')
})
