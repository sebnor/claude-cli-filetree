import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const CWD = 'C:/work/demo'
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const slash = (path: string) => path.split(String.fromCharCode(92)).join('/')

const PROPS = {
  title: 'Files',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

// Rows: y 2 `src/`, y 3 `README.md` (below the two header rows).
const mount = async ($: Parameters<TestBody>[0], on: On) => {
  const filled: string[] = []
  const ran: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => ({ value: slash(e.path) === CWD ? [dir('src'), file('README.md')] : [] }))
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
  const pointer = (type: 'down' | 'move' | 'up', x: number, y: number) =>
    ui.pointer({ type, x, y, button: 'left', in: 'tree' })
  const header = async () => JSON.stringify(await ui.drawn({ in: 'tree' }))
  return { filled, ran, pointer, header }
}

test('dragging a file out of the pane and releasing references it in the prompt', async ($, on) => {
  const { filled, pointer, header } = await mount($, on)

  await pointer('down', 6, 3)
  await pointer('move', 3, 3)
  expect(await header()).toContain('drag left of the pane to reference')
  await pointer('move', -8, 4)
  expect(await header()).toContain('release to reference')
  await pointer('up', -8, 4)

  expect(filled).toEqual(['@README.md '])
  expect(await header()).toContain('collapse all')
})

test('a drag released back inside the pane is cancelled', async ($, on) => {
  const { filled, pointer, header } = await mount($, on)

  await pointer('down', 6, 3)
  await pointer('move', -8, 3)
  await pointer('move', 10, 3)
  await pointer('up', 10, 3)

  expect(filled).toEqual([])
  expect(await header()).not.toContain('reference')
})

test('a press that barely moves is a click, not a drag, even released outside', async ($, on) => {
  const { filled, ran, pointer, header } = await mount($, on)

  await pointer('down', 6, 3)
  await pointer('move', 7, 3)
  expect(await header()).not.toContain('reference')
  await pointer('up', 7, 3)
  expect(filled).toEqual([])

  // Still a click: a second one right after opens the file.
  await pointer('down', 6, 3)
  expect(ran.filter(argv => argv[0] !== 'git')).toEqual([['code', `${CWD}/README.md`]])
})

test('a folder is not dragged: its press opens it as before', async ($, on) => {
  const { filled, pointer, header } = await mount($, on)

  await pointer('down', 6, 2)
  await pointer('move', -8, 2)
  await pointer('up', -8, 2)

  expect(filled).toEqual([])
  expect(await header()).not.toContain('reference')
})
