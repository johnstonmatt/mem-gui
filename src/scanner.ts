import type { Domain, MemoryFile, StoreScope } from "./types.ts";
import {
  contractHome,
  domainForProjectDir,
  findRepoRoot,
  isRepoRoot,
  realPathForDomain,
} from "./paths.ts";
import {
  listMemoryStores,
  type MemoryStore,
  sharedMemoryDir,
} from "./homes.ts";
import { parseShared, planWiring, sharedFilePath } from "./hoist.ts";

/**
 * Last-resort label when neither a transcript nor the filesystem can name the
 * directory: lossy, since original dashes and separators look the same.
 */
function prettifyDomain(dir: string): string {
  return dir.startsWith("-") ? dir.replace(/-/g, "/") : dir;
}

/**
 * Reads a .jsonl session transcript line-by-line (without loading the whole
 * file, since transcripts can be large) looking for a message carrying a
 * real "cwd" field, and returns as soon as one is found.
 */
async function readCwdFromTranscript(path: string): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }

  const reader = file.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.includes('"cwd"')) continue;
        try {
          const obj = JSON.parse(line);
          if (typeof obj.cwd === "string" && obj.cwd.startsWith("/")) {
            return obj.cwd;
          }
        } catch {
          // malformed/partial line, skip
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    try {
      file.close();
    } catch {
      // already closed
    }
  }

  return null;
}

/**
 * Resolves a store name to the directory it belongs to. A transcript's cwd can
 * be a subdirectory of the repo the store is keyed by, so it's mapped to its
 * repo root and accepted only if that escapes back to this exact name.
 */
async function resolveDomainPath(
  projectsDir: string,
  domain: string,
): Promise<{ path: string; found: boolean }> {
  const domainDir = `${projectsDir}/${domain}`;
  try {
    for await (const entry of Deno.readDir(domainDir)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const cwd = await readCwdFromTranscript(`${domainDir}/${entry.name}`);
      if (!cwd) continue;
      const root = await findRepoRoot(cwd) ?? cwd;
      if (domainForProjectDir(root) === domain) {
        return { path: root, found: true };
      }
      if (domainForProjectDir(cwd) === domain) {
        return { path: cwd, found: true };
      }
    }
  } catch {
    // fall through to the filesystem search
  }
  const real = await realPathForDomain(domain);
  return real
    ? { path: real, found: true }
    : { path: prettifyDomain(domain), found: false };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Names the directory a store belongs to, and where its memories load. */
async function describeStore(
  store: MemoryStore,
  shared: string | null,
): Promise<{ dir: string; label: string; scope: StoreScope }> {
  if (store.project === null) {
    return { dir: "", label: contractHome(store.dir), scope: "everywhere" };
  }
  // CLAUDE_CODE_PROJECT_DIR_NAME picks names that aren't escaped paths.
  if (!store.project.startsWith("-")) {
    return {
      dir: "",
      label: store.project,
      scope: shared ? "overridden" : "named",
    };
  }

  const resolved = await resolveDomainPath(
    `${store.home}/projects`,
    store.project,
  );
  const scope: StoreScope = shared
    ? "overridden"
    : !resolved.found || !await isDir(resolved.path)
    ? "orphaned"
    : await isRepoRoot(resolved.path)
    ? "repo"
    : "dir";
  return {
    dir: resolved.path,
    label: folderLabel(resolved.path, scope),
    scope,
  };
}

/**
 * Folders read as `~/…`. Plain "~" is the hoisted instructions every agent
 * shares, so a store Claude keeps for the home folder itself says what it is.
 */
function folderLabel(path: string, scope: StoreScope): string {
  const label = contractHome(path);
  if (label !== "~") return label;
  return scope === "repo" ? "~ · repo store" : "~ · sessions started here";
}

interface Frontmatter {
  attrs: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { attrs: {}, body: content };

  const attrs: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const rawLine of match[1].split("\n")) {
    if (!rawLine.trim()) continue;
    const nested = /^\s/.test(rawLine);
    const line = rawLine.trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (nested && currentKey) {
      const parent = attrs[currentKey];
      const bucket = (parent && typeof parent === "object")
        ? parent as Record<string, unknown>
        : (attrs[currentKey] = {});
      (bucket as Record<string, unknown>)[key] = value;
    } else {
      attrs[key] = value;
      currentKey = key;
    }
  }

  return { attrs, body: content.slice(match[0].length) };
}

/** Rough chars-per-token heuristic (~4 chars/token), not a real tokenizer. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function scanMemoryDir(
  memoryDir: string,
  dir: string,
  domainLabel: string,
): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  for await (const entry of Deno.readDir(memoryDir)) {
    if (!entry.isFile || !entry.name.endsWith(".md")) continue;

    const fullPath = `${memoryDir}/${entry.name}`;
    const [content, stat] = await Promise.all([
      Deno.readTextFile(fullPath),
      Deno.stat(fullPath),
    ]);
    const isIndex = entry.name === "MEMORY.md";
    const attrs: Record<string, unknown> = isIndex
      ? {}
      : parseFrontmatter(content).attrs;
    const metadata = (attrs.metadata ?? {}) as Record<string, unknown>;

    files.push({
      path: fullPath,
      filename: entry.name,
      storeId: memoryDir,
      dir,
      domainLabel,
      name: (attrs.name as string) ?? entry.name.replace(/\.md$/, ""),
      description: (attrs.description as string) ??
        (isIndex ? "Memory index" : ""),
      type: (metadata.type as string) ?? (attrs.type as string) ??
        (isIndex ? "index" : "unknown"),
      isIndex,
      chars: content.length,
      tokens: estimateTokens(content),
      mtime: stat.mtime?.getTime() ?? 0,
    });
  }

  return files;
}

/** The hoisted instructions every agent shares, as one group of tiles. */
async function scanShared(): Promise<Domain | null> {
  const path = sharedFilePath();
  let text: string;
  let mtime: number;
  try {
    text = await Deno.readTextFile(path);
    mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }

  const { sections, rest } = parseShared(text);
  const items = rest
    ? [...sections, { id: "", name: "Other shared instructions", text: rest }]
    : sections;
  if (items.length === 0) return null;

  const label = "~";
  const files: MemoryFile[] = items.map((item) => ({
    path,
    filename: item.id || "AGENTS.md",
    storeId: path,
    dir: "",
    domainLabel: label,
    name: item.name,
    description: contractHome(path),
    type: "shared",
    isIndex: false,
    chars: item.text.length,
    tokens: estimateTokens(item.text),
    mtime,
    section: item.id,
    content: item.text,
  }));

  const wiring = await planWiring();
  return {
    id: path,
    home: "",
    homeLabel: "",
    dir: "",
    domainLabel: label,
    scope: "shared",
    wiring: {
      pending: wiring.steps.map((s) => s.display),
      blocked: wiring.blocked,
      warnings: wiring.warnings,
    },
    files,
    totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
  };
}

export async function scanDomains(): Promise<Domain[]> {
  const home = Deno.env.get("HOME");
  if (!home) return [];

  const domains: Domain[] = [];
  const sharedByHome = new Map<string, string | null>();

  for (const store of await listMemoryStores()) {
    if (!sharedByHome.has(store.home)) {
      sharedByHome.set(store.home, await sharedMemoryDir(store.home));
    }
    const { dir, label, scope } = await describeStore(
      store,
      sharedByHome.get(store.home) ?? null,
    );
    const files = await scanMemoryDir(store.dir, dir, label);
    if (files.length === 0) continue;

    domains.push({
      id: store.dir,
      home: store.home,
      homeLabel: store.home === `${home}/.claude`
        ? ""
        : contractHome(store.home),
      dir,
      domainLabel: label,
      scope,
      files,
      totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
    });
  }

  domains.sort((a, b) => b.totalTokens - a.totalTokens);
  const shared = await scanShared();
  return shared ? [shared, ...domains] : domains;
}
