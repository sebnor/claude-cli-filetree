import { expect, test } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

const CWD = 'C:/huge'
const slash = (path: string) => path.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '')
// 1,400 files with long names: well under the row count limit, well over a Client's 100,000 characters.
const LONG = 'a-file-name-long-enough-that-a-few-hundred-of-them-fill-the-props-of-the-tree-view'
const FILES: FsEntry[] = Array.from({ length: 1400 }, (_, index) => ({
  name: `${LONG}-${String(index).padStart(4, '0')}.md`,
  kind: 'file',
  size: 1,
  mtimeMs: 1,
  isLink: false,
}))

test('a tree too large for one drawing is cut to fit, with a note, not failed', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => ({ value: slash(e.path) === CWD ? FILES : [] }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', requestId: 'file-tree',
    props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 120, rows: 40 },
  })

  const pane = JSON.stringify(await ui.drawn())
  expect(pane).toContain('more entries than fit')
  const client = await ui.find({ type: 'Client' })
  expect(JSON.stringify(client?.props ?? {}).length).toBeLessThan(100_000)
  // The tree view still draws: its header, with the actions to get out.
  expect(JSON.stringify(await ui.drawn({ in: 'tree' }))).toContain('collapse all')
})

test('scrolled far down, the rows in view are drawn and a click there opens the right file', async ($, on) => {
  const ran: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => ({ value: slash(e.path) === CWD ? FILES.slice(0, 900) : [] }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: e.argv[0] === 'git' ? 128 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The pane's window starts at region row 702: file 700, below the two header rows.
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', requestId: 'file-tree',
    props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 702, bodyRows: 30 }, view: {} },
    viewport: { columns: 120, rows: 40 },
  })

  const tree = JSON.stringify(await ui.drawn({ in: 'tree' }))
  expect(tree).toContain(`${LONG}-0700.md`)
  expect(tree).toContain(`${LONG}-0729.md`)
  expect(tree).not.toContain(`${LONG}-0000.md`)
  expect(tree).not.toContain(`${LONG}-0899.md`)

  await ui.pointer({ type: 'down', x: 8, y: 712, button: 'left', in: 'tree' })
  await ui.pointer({ type: 'down', x: 8, y: 712, button: 'left', in: 'tree' })
  expect(ran.filter(argv => argv[0] !== 'git')).toEqual([['code', `${CWD}/${LONG}-0710.md`]])
})
