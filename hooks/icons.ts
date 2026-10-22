// Nerd Font glyphs (v3 code points) and colours per file type, after nvim-web-devicons and
// VS Code's Seti theme. Drawn only where the font has them: the `icons` option turns them off.

export type Icon = { glyph: string; color: string }

const icon = (glyph: string, color: string): Icon => ({ glyph, color })

const FILE = icon('', '#8b949e')
const FOLDER = icon('', '#7aa2f7')
const FOLDER_OPEN = icon('', '#7aa2f7')

const IMAGE = icon('', '#a074c4')
const ARCHIVE = icon('', '#eca517')
const CONFIG = icon('', '#6d8086')
const SHELL = icon('', '#89e051')
const TEXT = icon('', '#89e051')

/** By extension, lower case, without the dot. */
const BY_EXTENSION: Record<string, Icon> = {
  ts: icon('', '#519aba'),
  mts: icon('', '#519aba'),
  cts: icon('', '#519aba'),
  tsx: icon('', '#20c2e3'),
  jsx: icon('', '#20c2e3'),
  js: icon('', '#cbcb41'),
  mjs: icon('', '#cbcb41'),
  cjs: icon('', '#cbcb41'),
  json: icon('', '#cbcb41'),
  jsonc: icon('', '#cbcb41'),
  md: icon('', '#519aba'),
  mdx: icon('', '#519aba'),
  html: icon('', '#e44d26'),
  htm: icon('', '#e44d26'),
  css: icon('', '#42a5f5'),
  scss: icon('', '#f55385'),
  less: icon('', '#563d7c'),
  vue: icon('', '#8dc149'),
  svelte: icon('', '#ff3e00'),
  py: icon('', '#ffbc03'),
  cs: icon('', '#9b4f96'),
  csproj: icon('', '#854cc7'),
  sln: icon('', '#854cc7'),
  go: icon('', '#519aba'),
  rs: icon('', '#dea584'),
  java: icon('', '#cc3e44'),
  sql: icon('', '#dad8d8'),
  xml: icon('', '#e37933'),
  yml: icon('', '#a074c4'),
  yaml: icon('', '#a074c4'),
  toml: icon('', '#9c4221'),
  ini: CONFIG,
  cfg: CONFIG,
  conf: CONFIG,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  ps1: icon('', '#4273ca'),
  bat: icon('', '#c1f12e'),
  cmd: icon('', '#c1f12e'),
  txt: TEXT,
  log: TEXT,
  pdf: icon('', '#b30b00'),
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  bmp: IMAGE,
  webp: IMAGE,
  ico: IMAGE,
  svg: icon('', '#ffb13b'),
  zip: ARCHIVE,
  gz: ARCHIVE,
  tar: ARCHIVE,
  '7z': ARCHIVE,
  rar: ARCHIVE,
  lock: icon('', '#bbbbbb'),
}

/** By whole name, lower case: wins over the extension. */
const BY_NAME: Record<string, Icon> = {
  '.gitignore': icon('', '#f54d27'),
  '.gitattributes': icon('', '#f54d27'),
  '.gitmodules': icon('', '#f54d27'),
  '.env': icon('', '#faf743'),
  'package.json': icon('', '#e8274b'),
  'package-lock.json': icon('', '#7a0d21'),
  'tsconfig.json': icon('', '#519aba'),
  dockerfile: icon('', '#458ee6'),
  containerfile: icon('', '#458ee6'),
  'compose.yaml': icon('', '#458ee6'),
  'docker-compose.yml': icon('', '#458ee6'),
  makefile: icon('', '#6d8086'),
  license: icon('', '#d0bf41'),
  'license.md': icon('', '#d0bf41'),
  'readme.md': icon('', '#ededed'),
  'claude.md': icon('', '#d97757'),
}

/** Folders with a look of their own, closed and open. */
const BY_FOLDER: Record<string, [Icon, Icon]> = {
  node_modules: [icon('', '#cc3e44'), icon('', '#cc3e44')],
  '.github': [icon('', '#7aa2f7'), icon('', '#7aa2f7')],
  '.config': [icon('', '#6d8086'), icon('', '#6d8086')],
  '.claude': [icon('', '#d97757'), icon('', '#d97757')],
}

/** The icon for an entry by its name: `f` a file, `d` a closed folder, `o` an open one. */
export function iconOf(name: string, kind: 'f' | 'd' | 'o'): Icon {
  const lower = name.toLowerCase()
  if (kind !== 'f') {
    const special = BY_FOLDER[lower]
    return special ? special[kind === 'o' ? 1 : 0] : kind === 'o' ? FOLDER_OPEN : FOLDER
  }
  const dot = lower.lastIndexOf('.')
  // `.env.local` and the like read as `.env`.
  const named = BY_NAME[lower] ?? (lower.startsWith('.env') ? BY_NAME['.env'] : undefined)

  return named ?? (dot > 0 ? BY_EXTENSION[lower.slice(dot + 1)] : undefined) ?? FILE
}

/** The cells an icon takes before the name: the glyph and one space. */
export const ICON_CELLS = 2
