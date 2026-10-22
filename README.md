# file-tree – a file explorer sidebar for Claude Code

A [Claude Code](https://claude.com/claude-code) mod that shows **every file in your working directory** as a collapsible tree in a pane beside the conversation – not just the files git says changed, and whether or not the folder is a git repository.

```
my-project/ 4 changed
refresh  collapse all
▾ src/ ··················· +4 -1 ●
│ ├ index.ts ············· +3 -1 M
│ ├ App.tsx
│ └ ▸ utils/ ··············· +1 ●
├ ▸ node_modules/
├ NOTES.md ················· +3 U
├ package.json
└ README.md
```

## Features

- **The whole tree.** Every file and folder in the session's working directory, folders first, A–Z. Only version-control internals (`.git`, `.hg`, `.svn`) are hidden. The tree follows the session if it changes directory.
- **Git status per row.** A status letter – `M` modified, `A` added, `U` untracked, `R` renamed, `D` deleted, `C` conflict – and `+added -removed` line counts against `HEAD`. Folders sum up everything beneath them and show a `●` in the colour of the most serious change, so a closed folder still tells you something changed inside. A dotted leader ties each name to its badge. Deleted files stay in the tree, struck through. Ignored paths are dimmed.
- **Nested repositories.** When the working directory is a folder of projects rather than a repository itself, every repository among the visible folders reports its own changes.
- **File icons.** Coloured [Nerd Font](https://www.nerdfonts.com/) icons by file type and name (can be turned off).
- **Mouse.** Click to select, double-click to open, right-click for actions, and drag a file out of the pane to reference it in your prompt.
- **Stays current.** Refreshes after Claude edits files or runs commands, and checks every 4 seconds for changes made elsewhere (your editor, a build, a commit) – redrawing only when something actually changed.

## Requirements

- **Claude Code 2.1.296 or newer.** This is a *mod*: it uses Claude Code's function-hook plugin API, which is early access and may change between releases.
- **Mouse support:** the fullscreen terminal layout or the Claude Code desktop app. The terminal's normal screen and VS Code get the same tree with plain buttons (left click only, no menus).
- **Optional:** `git` on your `PATH` for the status marks; a [Nerd Font](https://www.nerdfonts.com/) as your terminal font for the icons; [VS Code](https://code.visualstudio.com/) (`code` on your `PATH`) for the open actions.

Developed and tested on Windows. macOS and Linux should work (opening images uses `open` / `xdg-open`) but are untested.

## Install

In Claude Code:

```
/plugin marketplace add sebnor/claude-cli-filetree
/plugin install file-tree@claude-cli-filetree
```

Or from a shell:

```sh
claude plugin install file-tree --marketplace sebnor/claude-cli-filetree
```

The pane opens by itself at the start of a session once the terminal is wide enough to dock it (about 144 columns); otherwise run `/files`.

## Usage

| Action | Result |
| --- | --- |
| `/files` | Show or hide the pane |
| Left click on a folder | Open or close it |
| Left click on a file | Select it |
| Double click on a file | Open it: images in the system's default viewer, everything else in your editor |
| Drag a file left out of the pane and release | Reference it in your prompt (`@path`, at the prompt's cursor); release inside the pane to cancel |
| Right click on a file | **Insert path** (adds `@path` to your prompt), **Edit file** |
| Right click on a folder | **New .md file** (creates `file.md` inside it, then opens it), **Open VS Code** (on that folder) |
| Right click below the last row | The same, for the working directory itself |
| Click anywhere else in the pane | Clear the selection, close the menu |
| **refresh**, **collapse all** | Re-read the tree and git status; close every folder |

With the tree focused (click it): ↑/↓ move, Enter opens, →/← open and close folders, `m` opens the menu. In a menu: ↑/↓ or Tab, Enter, or the item's number; `q` or ← closes it.

**Editor:** files open in `$VISUAL`, else `$EDITOR`, else VS Code. Use a graphical editor – a terminal editor such as `vim` cannot share Claude Code's terminal. **Open VS Code** always uses VS Code.

### Settings

`/config` lists the plugin's one option:

- **File icons** (on by default) – turn off if your terminal font is not a Nerd Font, where the icons show as boxes.

## Limits

- One drawing shows at most 1,500 rows; collapse folders past that.
- Line counts for untracked files are read for at most 200 files per refresh; binary files count as 0.
- In a folder of projects, up to 200 visible folders are checked for a repository of their own.
- Dragging a file needs the terminal to pass a held-button drag on to Claude Code. Some terminal multiplexers keep it for their own text selection, and then nothing is dropped; the drop needs only the release, so a terminal that reports presses and releases is enough. Inside such a multiplexer, use **Insert path** from the right-click menu instead.

## Privacy

Everything runs locally. The plugin reads your files and runs `git status` / `git diff` in your working directory; nothing is sent anywhere.

## Development

```sh
git clone https://github.com/sebnor/claude-cli-filetree
cd claude-cli-filetree
claude --plugin-dir .            # a session with the plugin loaded from disk; saves reload it
claude plugin validate .         # what the engine would refuse, before loading
claude plugin test .             # the tests in tests/
npx -p typescript@5 tsc -p .     # type-check (after one load has written .claude-plugin/types/)
```

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The hooks module: the pane, the `/files` command, refreshes, opening files |
| `hooks/tree-view.tsx` | The surface module drawing the tree and reading the mouse and keys |
| `hooks/git.ts` | Reads `git status` and `git diff --numstat` |
| `hooks/marks.ts`, `hooks/icons.ts` | Git badges and file icons |
| `types/index.d.ts` | The plugin's state contract |

## License

[MIT](LICENSE)
