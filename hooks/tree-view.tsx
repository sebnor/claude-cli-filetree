import type { ClientModule, ClientPointerEvent, JsonValue } from 'claude-code'

import { ICON_CELLS, iconOf } from './icons'
import { badgeOf } from './marks'
import type { TreeMark } from './marks'

// Surface module: draws the whole pane body (title, header actions, rows) and reads the raw
// pointer there, so a right click can open the action menu and a click anywhere that is no row
// clears the selection. It posts what was chosen; register.tsx acts on it.

/**
 * One row: its path relative to the cwd, its tree glyphs, `f` file, `d` closed or `o` open
 * folder, and its git mark when it has one.
 */
export type TreeRow = [path: string, prefix: string, kind: 'f' | 'd' | 'o', mark?: TreeMark]
/**
 * `root` the top folder's name, `summary` the git line beside it (`3 changed`), `rows` the body
 * rows, `icons` whether to draw Nerd Font icons. `isPinned` while the person moved up out of sync
 * with the session's cwd, `canGoUp` while there is a folder above, `here` the cwd's row then.
 */
export type TreeProps = {
  root: string
  summary: string
  rows: TreeRow[]
  icons: boolean
  isPinned: boolean
  canGoUp: boolean
  here?: string
  /** The first of the region's rows the pane shows, and how many it shows: the drawn window. */
  offset: number
  bodyRows: number
}
export type TreeAction =
  | 'toggle' | 'insert' | 'edit' | 'open' | 'refresh' | 'collapse' | 'new-md' | 'open-vscode' | 'up' | 'sync'
export type TreeMessage = { action: TreeAction; path: string }

/**
 * `row` is an index into the rows, as is `cursor`; `-1` for the empty room below them, where
 * the menu opens at `y` (region cells) instead of under a row.
 */
type Menu = { row: number; x: number; y: number; selected: number }
/**
 * `cursor` is the selected row (drawn while `hasSelection`); `lastClick` arms a double click.
 * `pressed` is a file row the left button went down on (region cells), `drag` that row once the
 * pointer has moved far enough to be dragging it, and whether it is outside the pane now.
 */
type State = {
  cursor: number
  hasSelection: boolean
  menu?: Menu
  lastClick?: { row: number; at: number }
  pressed?: { row: number; x: number; y: number }
  drag?: { row: number; isOutside: boolean }
}

// Two left clicks on one file this close together open it.
const DOUBLE_CLICK_MS = 400
// A held press becomes a drag once the pointer is this many cells away, so a click never does.
const DRAG_CELLS = 2
// The title and the header actions sit above the first row.
const HEADER_ROWS = 2
// Rows drawn beyond the window on each side, so a scroll shows rows while the next draw comes;
// and the most drawn at once, which keeps a drawing well under its 100,000 characters.
const WINDOW_MARGIN = 20
const MAX_DRAWN_ROWS = 110
const HEADER_GAP = 2

// The header's actions as drawn, each with the column it starts at: ↑ up while there is a folder
// above, ↻ sync while pinned (out of sync with the session's cwd).
function headerActions(canGoUp: boolean, isPinned: boolean) {
  const actions: { label: string; action: TreeAction }[] = [
    ...(canGoUp ? [{ label: '↑ up', action: 'up' as const }] : []),
    { label: 'refresh', action: 'refresh' },
    { label: 'collapse all', action: 'collapse' },
    ...(isPinned ? [{ label: '↻ sync', action: 'sync' as const }] : []),
  ]
  let from = 0
  return actions.map(one => {
    const placed = { ...one, from }
    from += one.label.length + HEADER_GAP
    return placed
  })
}

type MenuItem = { label: string; action: TreeAction }

// A file's menu, and a folder's: new files go into the folder, VS Code opens on it. The empty room below the rows
// stands for the cwd, the outermost folder, and has the folder's menu.
const FILE_MENU: readonly MenuItem[] = [
  { label: 'Insert path', action: 'insert' },
  { label: 'Edit file', action: 'edit' },
]
const FOLDER_MENU: readonly MenuItem[] = [
  { label: 'New .md file', action: 'new-md' },
  { label: 'Open VS Code', action: 'open-vscode' },
]
const MENU_INNER = Math.max(...[...FILE_MENU, ...FOLDER_MENU].map(item => item.label.length)) + 4
const MENU_WIDTH = MENU_INNER + 2
const MENU_HEIGHT_MAX = Math.max(FILE_MENU.length, FOLDER_MENU.length) + 2
const INITIAL: State = { cursor: 0, hasSelection: false }

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const itemsFor = (menu: Menu, rows: readonly TreeRow[]) => (rows[menu.row]?.[2] === 'f' ? FILE_MENU : FOLDER_MENU)

// In region cells: below the row (or the click) when it fits, else above; never past the right edge.
const placeMenu = (menu: Menu, items: readonly MenuItem[], columns: number, height: number) => {
  const y = menu.row < 0 ? menu.y : menu.row + HEADER_ROWS
  const menuHeight = items.length + 2
  return {
    top: y + 1 + menuHeight <= height ? y + 1 : Math.max(0, y - menuHeight),
    left: Math.max(0, Math.min(menu.x, columns - MENU_WIDTH)),
  }
}

// Typed as plain JSON at the seam: a mark's optional fields are not `JsonValue` to the compiler,
// though they never cross as `undefined` (register.tsx leaves an absent field out).
const TreeView: ClientModule<JsonValue, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { root, summary, rows, icons, isPinned, canGoUp, here, offset, bodyRows } = props as unknown as TreeProps
  // Only the rows around the pane's window are drawn: a drawing over 100,000 characters unmounts
  // the region, and a row is some 500 of them. Empty Boxes keep the rest's height, so the rows
  // drawn sit where they belong and a click's row is still `y` less the header.
  const first = Math.max(0, offset - HEADER_ROWS - WINDOW_MARGIN)
  const last = Math.min(rows.length, first + Math.min(MAX_DRAWN_ROWS, bodyRows + 2 * WINDOW_MARGIN))
  const header = headerActions(canGoUp, isPinned)
  // The region fills the pane body (register.tsx sizes it), so a click on the empty room below
  // the rows reaches it too; at least as tall as the rows and a menu under the last one.
  const height = Math.max(surface.rows, rows.length + HEADER_ROWS, MENU_HEIGHT_MAX + HEADER_ROWS + 1)
  const columns = surface.columns || 40
  const state = surface.state ?? INITIAL
  const cursor = Math.min(state.cursor, Math.max(0, rows.length - 1))

  const set = (next: State) => surface.setState(next)
  const act = (path: string, action: TreeAction) => surface.post({ action, path })
  const clear = () => (state.hasSelection || state.menu ? set({ cursor, hasSelection: false }) : undefined)
  const openMenu = (row: number, x: number) => set({ cursor: row, hasSelection: true, menu: { row, x, y: 0, selected: 0 } })
  // The empty room's menu: the selection goes, the menu opens where the click was.
  const openEmptyMenu = (x: number, y: number) => set({ cursor, hasSelection: false, menu: { row: -1, x, y, selected: 0 } })
  const choose = (menu: Menu, index: number) => {
    const item = itemsFor(menu, rows)[index]
    set({ ...state, menu: undefined })
    if (!item) return
    if (menu.row < 0) return act('', item.action)
    const row = rows[menu.row]
    if (row) act(row[0], item.action)
  }
  // Enter, or a double click: a file opens, a folder opens or closes.
  const press = (index: number) => {
    const row = rows[index]
    if (row) act(row[0], row[2] === 'f' ? 'open' : 'toggle')
  }

  const menuItemAt = (menu: Menu, event: ClientPointerEvent) => {
    const items = itemsFor(menu, rows)
    const { top, left } = placeMenu(menu, items, columns, height)
    const index = event.y - top - 1
    const isInside = event.x > left && event.x < left + MENU_WIDTH - 1
    return isInside && index >= 0 && index < items.length ? index : undefined
  }

  surface.onPointer(event => {
    const menu = state.menu
    // Hover over the open menu moves its highlight, where the terminal reports motion.
    if (event.type === 'move' && event.button === undefined) {
      const index = menu && menuItemAt(menu, event)
      if (menu && index !== undefined && index !== menu.selected) set({ ...state, menu: { ...menu, selected: index } })
      return
    }
    // Dragging a file: the region holds the pointer from the press to the release, so moves
    // arrive past its edges too (x below 0 is left of the pane: the conversation, the prompt).
    if (event.type === 'move') {
      const pressed = state.pressed
      if (!pressed) return
      const isOutside = event.x < 0
      if (!state.drag) {
        const distance = Math.max(Math.abs(event.x - pressed.x), Math.abs(event.y - pressed.y))
        if (distance >= DRAG_CELLS) set({ ...state, drag: { row: pressed.row, isOutside } })
      } else if (state.drag.isOutside !== isOutside) {
        set({ ...state, drag: { ...state.drag, isOutside } })
      }
      return
    }
    // Dropped left of the pane: the file is referenced in the prompt. Anywhere else: cancelled.
    // The release alone decides, so a drop works where no moves arrive while the button is
    // held (a terminal or multiplexer that reports presses and releases only).
    if (event.type === 'up') {
      const { pressed, drag } = state
      if (!pressed && !drag) return
      const from = drag?.row ?? pressed?.row
      const isDrop = event.x < 0 && (drag !== undefined || (pressed !== undefined && pressed.x - event.x >= DRAG_CELLS))
      set({ ...state, pressed: undefined, drag: undefined, lastClick: isDrop ? undefined : state.lastClick })
      const row = isDrop && from !== undefined ? rows[from] : undefined
      if (row) act(row[0], 'insert')
      return
    }
    if (event.type !== 'down') return
    if (menu) {
      const index = menuItemAt(menu, event)
      if (index !== undefined) return event.button === 'left' ? choose(menu, index) : undefined
    }
    const clicked = event.y === 1 && event.button === 'left'
      ? header.find(one => event.x >= one.from && event.x < one.from + one.label.length)
      : undefined
    if (clicked) {
      clear()
      return act('', clicked.action)
    }
    const index = event.y - HEADER_ROWS
    const row = rows[index]
    // The empty room below the last row: a right click there is for new files.
    if (!row && index >= rows.length && event.button === 'right') return openEmptyMenu(event.x, event.y)
    // Anywhere else that is no row (the title, a left click below the rows): nothing is selected.
    if (!row) return clear()
    if (event.button === 'right') return openMenu(index, event.x)
    if (event.button !== 'left') return
    // A folder opens or closes on one click; a file is selected, and opened on a second click.
    if (row[2] !== 'f') {
      set({ cursor: index, hasSelection: true })
      return press(index)
    }
    const now = Date.now()
    const last = state.lastClick
    const isDouble = last !== undefined && last.row === index && now - last.at <= DOUBLE_CLICK_MS
    set({
      cursor: index,
      hasSelection: true,
      lastClick: isDouble ? undefined : { row: index, at: now },
      pressed: { row: index, x: event.x, y: event.y },
    })
    if (isDouble) press(index)
  })

  surface.onKey(event => {
    const menu = state.menu
    if (menu) {
      const count = itemsFor(menu, rows).length
      if (event.key === 'up') set({ ...state, menu: { ...menu, selected: (menu.selected + count - 1) % count } })
      else if (event.key === 'down' || event.key === 'tab') set({ ...state, menu: { ...menu, selected: (menu.selected + 1) % count } })
      else if (event.key === 'return') choose(menu, menu.selected)
      else if (/^[1-9]$/.test(event.key) && Number(event.key) <= count) choose(menu, Number(event.key) - 1)
      else if (event.key === 'q' || event.key === 'left' || event.key === 'backspace') set({ ...state, menu: undefined })
      return
    }
    // `u` moves the tree's top up a folder (pinning it), once per press: the hooks module drops a
    // held key's repeats (`path: 'key'`). `s` brings it back in sync.
    if (event.key === 'u' && canGoUp) return act('key', 'up')
    if (event.key === 's' && isPinned) return act('', 'sync')
    const row = rows[cursor]
    if (event.key === 'up') set({ cursor: Math.max(0, cursor - 1), hasSelection: true })
    else if (event.key === 'down') set({ cursor: Math.min(rows.length - 1, cursor + 1), hasSelection: true })
    else if (event.key === 'return') press(cursor)
    else if (!row) return
    else if (event.key === 'm') openMenu(cursor, row[1].length + 2)
    else if (event.key === 'right' && row[2] === 'd') act(row[0], 'toggle')
    else if (event.key === 'left' && row[2] === 'o') act(row[0], 'toggle')
  })

  const menu = state.menu
  const menuItems = menu ? itemsFor(menu, rows) : []
  const place = menu && placeMenu(menu, menuItems, columns, height)
  // While a file is dragged, the header's action row says what a release does.
  const dragged = state.drag ? rows[state.drag.row] : undefined

  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate" bold>
        {`${root}/`}
        {summary && <Text dimColor bold={false}> {summary}</Text>}
        {isPinned && <Text color="warning" bold={false}> · pinned</Text>}
      </Text>
      {dragged ? (
        <Text wrap="truncate" color="suggestion">
          {state.drag?.isOutside ? '↳ release to reference ' : '↳ drag left of the pane to reference '}
          <Text bold>@{dragged[0]}</Text>
        </Text>
      ) : (
        <Text>
          {header.map((one, index) => (
            <Text dimColor={one.action !== 'sync'} color={one.action === 'sync' ? 'warning' : undefined}>
              {index > 0 ? ' '.repeat(HEADER_GAP) : ''}
              {one.label}
            </Text>
          ))}
        </Text>
      )}
      {rows.length === 0 && <Text dimColor>(empty)</Text>}
      {first > 0 && <Box height={first} />}
      {rows.slice(first, last).map(([path, prefix, kind, mark], at) => {
        const index = first + at
        const name = baseName(path) + (kind === 'f' ? '' : '/')
        const marker = kind === 'o' ? '▾ ' : kind === 'd' ? '▸ ' : '  '
        const isMarked = menu ? menu.row === index : state.hasSelection && cursor === index
        const badge = badgeOf(mark, kind !== 'f', columns)
        const icon = icons ? iconOf(baseName(path), kind) : undefined
        // While pinned, the session's cwd is marked, so the place the person came from stays found.
        const hereMark = here === path ? ' ← cwd' : ''
        // A dim dotted leader across the gap ties a name to its badge at the right edge.
        const used = prefix.length + marker.length + (icon ? ICON_CELLS : 0) + name.length + hereMark.length
        const gap = badge ? columns - badge.width - used - 1 : 0
        const leader = gap >= 2 ? ` ${'·'.repeat(gap - 1)}` : ''
        return (
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" inverse={isMarked}>
                <Text dimColor>{prefix}</Text>
                {marker}
                {icon && (
                  <Text color={icon.color} dimColor={mark?.i === 1}>
                    {icon.glyph}{' '}
                  </Text>
                )}
                <Text bold={kind !== 'f'} color={badge?.color} dimColor={mark?.i === 1} strikethrough={mark?.x === 1}>
                  {name}
                </Text>
                {hereMark && <Text color="warning">{hereMark}</Text>}
                {leader && <Text dimColor>{leader}</Text>}
              </Text>
            </Box>
            {badge && (
              <Box flexShrink={0}>
                <Text>
                  {badge.added && <Text color="diffAdded"> {badge.added}</Text>}
                  {badge.removed && <Text color="diffRemoved"> {badge.removed}</Text>}
                  <Text color={badge.color}> {badge.code}</Text>
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
      {last < rows.length && <Box height={rows.length - last} />}
      {menu && place && (
        <Box
          position="absolute"
          top={place.top}
          left={place.left}
          width={MENU_WIDTH}
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
        >
          {menuItems.map((item, index) => (
            <Text inverse={index === menu.selected}>{` ${index + 1}  ${item.label}`.padEnd(MENU_INNER)}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default TreeView
