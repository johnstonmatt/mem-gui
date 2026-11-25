// These helpers are deliberately hand-rolled rather than imported from
// @std/path. Pulling any remote (JSR/HTTPS) module into a `deno desktop` module
// graph silently breaks the webview binding channel: every win.bind() handler
// ends up unregistered and the window comes up empty (verified against deno
// 2.9.0 / laufey 0.4.0). Keep this file dependency-free.

function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

/** Resolves "." / ".." segments and collapses duplicate slashes. */
function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Above an absolute root there is nowhere to go, so "/.." is just "/";
      // a relative path has to keep the ".." it can't resolve away.
      if (segments.length && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }

  return (absolute ? "/" : "") + segments.join("/");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch {
    return null;
  }
}

/** Expands a leading `~` (alone or as `~/`) to $HOME; anything else is kept. */
export function expandHome(path: string): string {
  const home = Deno.env.get("HOME") ?? "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Turns a user-supplied directory into an exact, existing absolute path.
 * Existence is part of the contract: a typo would otherwise silently name a
 * store or file nothing will ever load.
 */
export async function resolveProjectDir(input: string): Promise<string> {
  const expanded = expandHome(input.trim());
  if (!expanded) {
    throw new Error("No directory given.");
  }
  if (!isAbsolute(expanded)) {
    throw new Error(
      `Not an absolute path: "${input}" — give a full path like /Users/you/dev (or ~/dev).`,
    );
  }

  // A trailing slash would escape to a trailing dash and name the wrong store.
  const dir = normalize(expanded).replace(/\/+$/, "") || "/";

  const stat = await statOrNull(dir);
  if (!stat) throw new Error(`No such directory: ${dir}`);
  if (!stat.isDirectory) throw new Error(`Not a directory: ${dir}`);
  return dir;
}

/**
 * Claude Code names a project's store after its root path with every
 * character that isn't an ASCII letter or digit replaced by "-"
 * (e.g. "/Users/m/.lockin" -> "-Users-m--lockin"). Exact going forward;
 * lossy in reverse, which is why realPathForDomain searches instead.
 */
export function domainForProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The main working tree a `.git` *file* points back to. A linked worktree's
 * gitdir holds a `commondir` naming the shared `.git`, whose parent is the
 * main tree; anything else (e.g. a submodule) is its own root.
 */
async function rootFromGitFile(dir: string, gitFile: string): Promise<string> {
  const match = (await Deno.readTextFile(gitFile)).match(/^gitdir:\s*(.+)$/m);
  if (!match) return dir;
  const gitdir = normalize(
    isAbsolute(match[1].trim()) ? match[1].trim() : join(dir, match[1].trim()),
  );

  let common: string;
  try {
    common = (await Deno.readTextFile(join(gitdir, "commondir"))).trim();
  } catch {
    return dir;
  }
  const commonDir = normalize(
    isAbsolute(common) ? common : join(gitdir, common),
  );
  return commonDir.endsWith("/.git") ? dirname(commonDir) : dir;
}

/** The repo root `dir`'s own `.git` makes it, or null if it has none. */
async function rootAt(dir: string): Promise<string | null> {
  const dotGit = join(dir, ".git");
  const stat = await statOrNull(dotGit);
  if (stat?.isDirectory) return dir;
  if (stat?.isFile) return await rootFromGitFile(dir, dotGit);
  return null;
}

/** Whether `dir` is itself a repo's main working tree; looks nowhere else. */
export async function isRepoRoot(dir: string): Promise<boolean> {
  return await rootAt(dir) === dir;
}

/**
 * The git working-tree root containing `dir`, or null outside any repo.
 * Linked worktrees resolve to their main tree, because Claude Code gives all
 * worktrees of a repo one shared memory store. Inside $HOME the search stops
 * at $HOME, so it never reads above it.
 */
export async function findRepoRoot(dir: string): Promise<string | null> {
  const home = Deno.env.get("HOME") ?? "";
  const ceiling = home && (dir === home || dir.startsWith(`${home}/`))
    ? home
    : "/";
  let current = dir;
  while (true) {
    const root = await rootAt(current);
    if (root) return root;
    if (current === ceiling || current === "/") return null;
    current = dirname(current);
  }
}

export interface ProjectStore {
  /** The directory Claude Code keys the store by: repo root, else the dir. */
  root: string;
  domain: string;
  isRepo: boolean;
}

/** Which memory store a session started in `dir` reads and writes. */
export async function storeForDir(dir: string): Promise<ProjectStore> {
  const repoRoot = await findRepoRoot(dir);
  const root = repoRoot ?? dir;
  return { root, domain: domainForProjectDir(root), isRepo: repoRoot !== null };
}

/**
 * Recovers the real directory behind a store name by walking the filesystem
 * and following only entries whose escaped path is a prefix of the name.
 * Starts at $HOME when the name lives under it, so it needs no wider read
 * access than the app already has.
 */
export async function realPathForDomain(
  domain: string,
): Promise<string | null> {
  const home = Deno.env.get("HOME") ?? "";
  const homeDomain = home ? domainForProjectDir(home) : "";
  const start = home &&
      (domain === homeDomain || domain.startsWith(`${homeDomain}-`))
    ? home
    : "/";

  async function search(dir: string): Promise<string | null> {
    if (domainForProjectDir(dir) === domain) return dir;
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return null;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const escaped = domainForProjectDir(child);
      if (escaped !== domain && !domain.startsWith(`${escaped}-`)) continue;
      if (!(await statOrNull(child))?.isDirectory) continue;
      const found = await search(child);
      if (found) return found;
    }
    return null;
  }

  return await search(start);
}

/** Shows a path under $HOME as `~/…`, for display only. */
export function contractHome(path: string): string {
  const home = Deno.env.get("HOME") ?? "";
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
