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

// Rows: y 2 `src/`, y 3 `README.md` (below the two header rows), empty room from y 4. `taken` already exist.
const mount = async ($: Parameters<TestBody>[0], on: On, taken: string[] = []) => {
  const disk: Record<string, FsEntry[]> = { '': [dir('src'), file('README.md')], src: [file('main.ts')] }
  const written: string[] = []
  const ran: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => {
    const path = slash(e.path)
    return { value: disk[path === CWD ? '' : path.slice(CWD.length + 1)] ?? [] }
  })
  on('fs.exists', ($, e) => ({ value: taken.includes(slash(e.path)) }))
  on('fs.write', ($, e) => {
    written.push(slash(e.path))
    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    // Not a repository: no git marks, and the editor starts.
    const isGit = e.argv[0] === 'git'
    return { value: { exitCode: isGit ? 128 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree',
    viewport: { columns: 120, rows: 40 },
  })
  const menu = async (y: number, item: string) => {
    await ui.pointer({ type: 'down', x: 4, y, button: 'right', in: 'tree' })
    await ui.key({ key: item, in: 'tree' })
  }
  const opened = () => ran.filter(argv => argv[0] !== 'git')
  // Types into the name box and presses Enter.
  const name = (text: string) => ui.input({ key: 'new-name', text })
  const pane = async () => JSON.stringify(await ui.drawn())
  return { ui, written, opened, menu, name, pane }
}

test('New .md file opens a name box, nothing written yet; the typed name gets .md', async ($, on) => {
  const { written, opened, menu, name, pane } = await mount($, on)

  await menu(12, '1')
  expect(await pane()).toContain('New file in ')
  expect(written).toEqual([])

  await name('notes')
  expect(written).toEqual([`${CWD}/notes.md`])
  expect(opened()).toEqual([['code', `${CWD}/notes.md`]])
  expect(await pane()).not.toContain('New file in ')
})

test('a name with an extension keeps it', async ($, on) => {
  const { written, menu, name } = await mount($, on)

  await menu(12, '1')
  await name('todo.txt')
  expect(written).toEqual([`${CWD}/todo.txt`])
})

test('an empty name takes the suggested one: file.md, or the next free file-N.md', async ($, on) => {
  const { written, menu, name, pane } = await mount($, on, [`${CWD}/file.md`, `${CWD}/file-1.md`])

  await menu(12, '1')
  expect(await pane()).toContain('file-2.md')
  await name('')
  expect(written).toEqual([`${CWD}/file-2.md`])
})

test('a name already taken is refused in the box, which stays open with the name', async ($, on) => {
  const { written, menu, name, pane } = await mount($, on, [`${CWD}/README.md`])

  await menu(12, '1')
  await name('README')
  expect(written).toEqual([])
  const drawn = await pane()
  expect(drawn).toContain('README.md already exists.')
  expect(drawn).toContain('"value":"README"')
})

test('a name with characters a file cannot hold, or with .., is refused', async ($, on) => {
  const { written, menu, name, pane } = await mount($, on)

  await menu(12, '1')
  await name('a:b')
  expect(await pane()).toContain('cannot hold')
  await name('../escape')
  expect(await pane()).toContain('cannot have empty parts')
  expect(written).toEqual([])
})

test('a name with a slash makes the subfolders, which open to show the file', async ($, on) => {
  const { ui, written, menu, name } = await mount($, on)

  await menu(2, '1')
  await name('docs/today')
  expect(written).toEqual([`${CWD}/src/docs/today.md`])
  expect(JSON.stringify(await ui.drawn({ in: 'tree' }))).toContain('main.ts')
})

test('cancel closes the box and writes nothing', async ($, on) => {
  const { ui, written, menu, pane } = await mount($, on)

  await menu(12, '1')
  await ui.press({ key: 'new-cancel' })
  expect(await pane()).not.toContain('New file in ')
  expect(written).toEqual([])
})

test('right click on a folder: New .md file puts the file inside it, and the folder opens', async ($, on) => {
  const { ui, written, opened, menu, name, pane } = await mount($, on)

  await menu(2, '1')
  expect(await pane()).toContain('src/')
  await name('')
  expect(written).toEqual([`${CWD}/src/file.md`])
  expect(opened()).toEqual([['code', `${CWD}/src/file.md`]])
  expect(JSON.stringify(await ui.drawn({ in: 'tree' }))).toContain('main.ts')
})

test('right click on a folder: Open VS Code opens that folder', async ($, on) => {
  const { opened, menu } = await mount($, on)

  await menu(2, '2')
  expect(opened()).toEqual([['code', `${CWD}/src`]])
})

test('New .md file is offered on a folder and below the rows: not on a file or the title', async ($, on) => {
  const { ui } = await mount($, on)
  const offered = async (y: number) => {
    await ui.pointer({ type: 'down', x: 4, y, button: 'right', in: 'tree' })
    const drawn = JSON.stringify(await ui.drawn({ in: 'tree' }))
    await ui.pointer({ type: 'down', x: 30, y: 25, button: 'left', in: 'tree' })
    return drawn.includes('New .md file')
  }

  expect(await offered(3)).toBe(false)
  expect(await offered(2)).toBe(true)
  expect(await offered(0)).toBe(false)
  expect(await offered(12)).toBe(true)
})

test('right click below the last row: Open VS Code opens the outermost folder in VS Code', async ($, on) => {
  const { written, opened, menu } = await mount($, on)

  await menu(12, '2')
  expect(opened()).toEqual([['code', CWD]])
  expect(written).toEqual([])
})
