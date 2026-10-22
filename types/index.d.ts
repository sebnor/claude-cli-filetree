/** Directory paths relative to the tree's top folder, `/`-separated. */
export type DirPath = string

/** A file's change against HEAD: Modified, Added, Deleted, Renamed, Untracked, Conflicted. */
export type GitCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

/** One changed file: its code and its line counts against HEAD (untracked: its lines as added). */
export type GitFile = { code: GitCode; added: number; removed: number }

/** `git status` of the cwd, paths relative to the cwd. */
export type GitStatus = {
  /** False outside a work tree (or where git is missing): no marks are drawn. */
  isRepo: boolean
  files: Record<string, GitFile>
  /** Ignored paths that match an ignore rule; a directory ends with `/`. */
  ignored: string[]
}

/**
 * The name box of **New .md file**: open or not, the folder the file goes into (a tree path),
 * the default name an empty field takes, the name last tried and why it was refused.
 */
export type NewFile = { isOpen: boolean; dir: string; suggested: string; name: string; error: string }

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      /** Directories shown open, relative to the tree's top folder. */
      expanded: DirPath[]
      /**
       * The tree's top folder while pinned (absolute, `/`-separated), after the person moved up;
       * `''` while the tree is in sync with the session's working directory.
       */
      pinned: string
      /** Bumped whenever the tree on disk may have changed; drawings read it. */
      tick: number
      /** Last `git status` read; written only when it changed. */
      git: GitStatus
      /** The name box a **New .md file** opens at the top of the pane. */
      newFile: NewFile
    }
  }
}
