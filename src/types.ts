/**
 * Where a store's memories load. repo: the repo and its worktrees; dir: only
 * sessions started in exactly that directory; everywhere: every project (a
 * shared autoMemoryDirectory); named: sessions launched with that project
 * name; orphaned: its directory is gone; overridden: a shared store wins.
 * shared: hoisted instructions, which every agent follows everywhere.
 */
export type StoreScope =
  | "shared"
  | "repo"
  | "dir"
  | "everywhere"
  | "named"
  | "orphaned"
  | "overridden";

export interface MemoryFile {
  path: string;
  filename: string;
  /** The id (directory) of the store holding this memory. */
  storeId: string;
  /** The directory its store belongs to, absolute; "" when there isn't one. */
  dir: string;
  domainLabel: string;
  name: string;
  description: string;
  type: string;
  isIndex: boolean;
  chars: number;
  tokens: number;
  mtime: number;
  /** For a hoisted instruction: its section id and text. */
  section?: string;
  content?: string;
}

export interface Domain {
  /** The memory directory; unique across every agent home. */
  id: string;
  /** The Claude Code home the store belongs to. */
  home: string;
  /** Empty for the default home, else where the store's home lives. */
  homeLabel: string;
  /** The directory the store belongs to, absolute; "" when there isn't one. */
  dir: string;
  /** How the store reads in the UI: `~/…` paths, "~" for shared instructions. */
  domainLabel: string;
  scope: StoreScope;
  /** For the shared file: agent folders not yet pointed at it, and why. */
  wiring?: { pending: string[]; blocked: string[]; warnings: string[] };
  files: MemoryFile[];
  totalTokens: number;
}
