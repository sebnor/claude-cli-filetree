/** Directory paths relative to the cwd, `/`-separated. */
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

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      /** Directories shown open. */
      expanded: DirPath[]
      /** Bumped whenever the tree on disk may have changed; drawings read it. */
      tick: number
      /** Last `git status` read; written only when it changed. */
      git: GitStatus
    }
  }
}
