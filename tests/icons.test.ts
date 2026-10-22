import { expect, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

import { iconOf } from '../hooks/icons'

const CWD = 'C:/work/demo'
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const fakeDisk = (on: On) => {
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => ({ value: e.path.split(String.fromCharCode(92)).join('/') === CWD ? [dir('src'), file('app.ts'), file('logo.png')] : [] }))
}

const PROPS = {
  title: 'Files',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const VIEWPORT = { columns: 120, rows: 40 }

test('icons: by name before extension, by extension, then a plain file', async () => {
  expect(iconOf('package.json', 'f')).not.toEqual(iconOf('data.json', 'f'))
  expect(iconOf('Dockerfile', 'f')).toEqual(iconOf('dockerfile', 'f'))
  expect(iconOf('.env.local', 'f')).toEqual(iconOf('.env', 'f'))
  expect(iconOf('main.ts', 'f')).toEqual(iconOf('types.mts', 'f'))
  expect(iconOf('photo.JPG', 'f')).toEqual(iconOf('logo.png', 'f'))
  expect(iconOf('notes.unknownext', 'f')).toEqual(iconOf('noextension', 'f'))
})

test('icons: a folder has a closed and an open look; some folders their own', async () => {
  expect(iconOf('src', 'd').glyph).not.toBe(iconOf('src', 'o').glyph)
  expect(iconOf('node_modules', 'd')).not.toEqual(iconOf('src', 'd'))
})

test('desktop: each row draws its icon in its colour', async ($, on) => {
  fakeDisk(on)
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree', viewport: VIEWPORT,
  })
  const drawn = JSON.stringify(await ui.drawn({ in: 'tree' }))
  for (const [name, kind] of [['src', 'd'], ['app.ts', 'f'], ['logo.png', 'f']] as const) {
    const { glyph, color } = iconOf(name, kind)
    expect(drawn).toContain(JSON.stringify(glyph))
    expect(drawn).toContain(JSON.stringify(color))
  }
})

test('desktop: with the icons option off no icon is drawn', { options: { icons: false } }, async ($, on) => {
  fakeDisk(on)
  const ui = await $.ui.mount({
    plugin: 'file-tree', surface: 'desktop', component: 'Pane', props: PROPS, requestId: 'file-tree', viewport: VIEWPORT,
  })
  const drawn = JSON.stringify(await ui.drawn({ in: 'tree' }))
  expect(drawn).not.toContain(JSON.stringify(iconOf('app.ts', 'f').glyph))
  expect(drawn).toContain('"app.ts"')
})

test('terminal: the plain-button rows draw icons too', async ($, on) => {
  fakeDisk(on)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', component: 'Pane', props: PROPS, requestId: 'file-tree' })
  expect(JSON.stringify(await ui.drawn())).toContain(JSON.stringify(iconOf('app.ts', 'f').glyph))
})
