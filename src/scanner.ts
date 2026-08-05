import type { Domain, MemoryFile } from "./types.ts";

/**
 * Claude Code names each project's memory dir after the escaped cwd
 * (e.g. "-Users-m-dev-johnstonmatt-mem-gui"), and that mapping back to a
 * real path is lossy (original dashes vs. path-separator dashes are
 * indistinguishable) — used only as a last-resort fallback below.
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
 * Resolves a project domain dir (e.g. "-Users-m-dev-johnstonmatt-mem-gui")
 * to its real absolute path by reading the "cwd" field out of one of its
 * session transcripts — far more reliable than reversing the dash-escaping.
 * Falls back to the lossy heuristic if no transcript yields a cwd.
 */
async function resolveDomainPath(
  projectsDir: string,
  domain: string,
): Promise<string> {
  const domainDir = `${projectsDir}/${domain}`;
  try {
    for await (const entry of Deno.readDir(domainDir)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const cwd = await readCwdFromTranscript(`${domainDir}/${entry.name}`);
      if (cwd) return cwd;
    }
  } catch {
    // fall through to heuristic
  }
  return prettifyDomain(domain);
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
  domain: string,
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
      domain,
      domainLabel,
      name: (attrs.name as string) ?? entry.name.replace(/\.md$/, ""),
      description: (attrs.description as string) ??
        (isIndex ? "Memory index" : ""),
      type: (metadata.type as string) ?? (isIndex ? "index" : "unknown"),
      isIndex,
      chars: content.length,
      tokens: estimateTokens(content),
      mtime: stat.mtime?.getTime() ?? 0,
    });
  }

  return files;
}

export async function scanDomains(): Promise<Domain[]> {
  const home = Deno.env.get("HOME");
  if (!home) return [];

  const projectsDir = `${home}/.claude/projects`;
  const domains: Domain[] = [];

  // Only a missing directory is the normal "nothing here yet" case — a fresh
  // machine that has never run Claude Code. Anything else is a real fault and
  // has to surface: a bare `catch { return [] }` here turned a mis-scoped
  // permission grant in the v0.1.1 release build into a window that opened
  // cleanly and showed nothing, with no hint anywhere as to why.
  try {
    await Deno.stat(projectsDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  for await (const entry of Deno.readDir(projectsDir)) {
    if (!entry.isDirectory) continue;
    const memoryDir = `${projectsDir}/${entry.name}/memory`;

    // Same rule per project: a project with no memory/ dir is ordinary and gets
    // skipped, but a permission fault must not be mistaken for one — that would
    // silently drop domains from the treemap.
    try {
      const stat = await Deno.stat(memoryDir);
      if (!stat.isDirectory) continue;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }

    const domainLabel = await resolveDomainPath(projectsDir, entry.name);
    const files = await scanMemoryDir(memoryDir, entry.name, domainLabel);
    if (files.length === 0) continue;

    domains.push({
      domain: entry.name,
      domainLabel,
      files,
      totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
    });
  }

  domains.sort((a, b) => b.totalTokens - a.totalTokens);
  return domains;
}
