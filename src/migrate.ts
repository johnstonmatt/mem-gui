import { resolveProjectDir, storeForDir } from "./paths.ts";
import { discoverHomes, listMemoryStores, sharedMemoryDir } from "./homes.ts";

export interface MigratableMemory {
  path: string;
  filename: string;
  name: string;
  description: string;
}

/**
 * Where a move sends a memory: an existing store by its id (its directory),
 * or a directory, meaning the store a session started there would use in the
 * given Claude Code home (the repo root's, inside a repo).
 */
export type MoveDestination =
  | { kind: "store"; storeId: string }
  | { kind: "dir"; dir: string; home: string };

export interface IntegrationProposal {
  targetFile: string;
  summary: string;
  content: string;
  /** A CLAUDE.md that will also gain an `@AGENTS.md` import, if any. */
  alsoImportsIn: string | null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** "Integrate" always assumes the memory's own project repo — never anywhere else. */
function assertWithinRepo(repoRoot: string, target: string) {
  if (target.includes("..")) {
    throw new Error(`Unsafe path: ${target}`);
  }
  const normalized = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  if (target !== repoRoot && !target.startsWith(normalized)) {
    throw new Error(
      `Refusing to write "${target}" — outside the project repo "${repoRoot}".`,
    );
  }
}

const INTEGRATION_SCHEMA = {
  type: "object",
  properties: {
    targetFile: {
      type: "string",
      description:
        "Path, relative to the repo root, of the single file to write (create it if it doesn't exist).",
    },
    summary: {
      type: "string",
      description:
        "One or two sentences on where/how you integrated this and why.",
    },
    content: {
      type: "string",
      description:
        "The FULL new contents of targetFile after integration — the whole file, not a diff.",
    },
  },
  required: ["targetFile", "summary", "content"],
  additionalProperties: false,
};

/**
 * Shells out to a read-only, non-interactive `claude` sub-invocation, scoped
 * entirely to the memory's own project repo, to decide the single best
 * existing/new doc to integrate it into. Tool access is locked to
 * Read/Glob/Grep (no Edit/Write/Bash) and MCP servers are disabled via
 * --strict-mcp-config, so this call is structurally incapable of writing
 * anything — it can only propose. Nothing is written until the caller
 * invokes writeIntegration() below, after the user reviews the proposal.
 */
export async function proposeIntegration(
  memory: MigratableMemory,
  repoRoot: string,
): Promise<IntegrationProposal> {
  if (!await pathExists(`${repoRoot}/.git`)) {
    throw new Error(
      `Not a git repository: ${repoRoot} — integrate assumes a real, git-tracked project (so the write is trivially reversible via git).`,
    );
  }

  const body = stripFrontmatter(await Deno.readTextFile(memory.path));

  const prompt =
    `You are integrating a piece of persisted knowledge from an AI coding assistant's memory store into this repository's documentation, so future human and AI collaborators can see it too.

Memory name: ${memory.name}
Memory description: ${memory.description || "(none)"}
Memory content:
---
${body}
---

Decide the single best file in this repo to write this into (relative to the repo root; create it if it doesn't exist — e.g. README.md, DEVELOPMENT.md, or something under docs/), and produce that file's FULL new content after integration. If it is guidance for coding agents rather than documentation for people, use the root AGENTS.md (create it if needed): it is the file every coding agent reads. Prefer merging into existing relevant sections over blindly appending. Respond only via the required schema.`;

  const command = new Deno.Command("claude", {
    args: [
      "--print",
      "--output-format",
      "json",
      "--tools",
      "Read,Glob,Grep",
      "--permission-mode",
      "plan",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-budget-usd",
      "1",
      "--json-schema",
      JSON.stringify(INTEGRATION_SCHEMA),
      prompt,
    ],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();

  if (code !== 0) {
    throw new Error(
      `claude exited with code ${code}: ${decoder.decode(stderr)}`,
    );
  }

  const envelope = JSON.parse(decoder.decode(stdout));
  if (envelope.is_error) {
    throw new Error(`claude reported an error: ${envelope.result}`);
  }

  const proposal = JSON.parse(envelope.result);
  const targetFile: string = proposal.targetFile.startsWith("/")
    ? proposal.targetFile
    : `${repoRoot}/${proposal.targetFile}`;

  assertWithinRepo(repoRoot, targetFile);
  if (!targetFile.endsWith(".md")) {
    throw new Error(`Refusing non-markdown target: ${targetFile}`);
  }

  return {
    targetFile,
    summary: proposal.summary,
    content: proposal.content,
    alsoImportsIn: await claudeMdMissingImport(repoRoot, targetFile),
  };
}

const CLAUDE_MD_CANDIDATES = [
  { file: "CLAUDE.md", line: "@AGENTS.md" },
  { file: ".claude/CLAUDE.md", line: "@../AGENTS.md" },
];

/**
 * When a write targets the root AGENTS.md but the repo's CLAUDE.md doesn't
 * import it, Claude Code would skip it (a CLAUDE.md takes precedence), so that
 * CLAUDE.md needs an `@AGENTS.md` line. Returns which CLAUDE.md, or null.
 */
async function claudeMdMissingImport(
  repoRoot: string,
  targetFile: string,
): Promise<string | null> {
  if (targetFile !== `${repoRoot}/AGENTS.md`) return null;
  let first: string | null = null;
  for (const { file } of CLAUDE_MD_CANDIDATES) {
    let text: string;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${file}`);
    } catch {
      continue;
    }
    if (/^\s*@(\.\.?\/)?AGENTS\.md\s*$/m.test(text)) return null;
    first ??= `${repoRoot}/${file}`;
  }
  return first;
}

/**
 * The only function that writes for "Integrate": one markdown file inside the
 * repo it was proposed for, plus the `@AGENTS.md` import line when that file
 * is the root AGENTS.md and the repo's CLAUDE.md lacks it.
 */
export async function writeIntegration(
  repoRoot: string,
  targetFile: string,
  content: string,
): Promise<{ writtenPaths: string[] }> {
  assertWithinRepo(repoRoot, targetFile);
  if (!targetFile.endsWith(".md")) {
    throw new Error(`Refusing non-markdown target: ${targetFile}`);
  }

  const importIn = await claudeMdMissingImport(repoRoot, targetFile);
  await Deno.mkdir(targetFile.slice(0, targetFile.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(targetFile, content);
  if (!importIn) return { writtenPaths: [targetFile] };

  const line =
    CLAUDE_MD_CANDIDATES.find((c) => `${repoRoot}/${c.file}` === importIn)!
      .line;
  const existing = (await Deno.readTextFile(importIn)).replace(/\s+$/, "");
  await Deno.writeTextFile(importIn, `${existing}\n\n${line}\n`);
  return { writtenPaths: [targetFile, importIn] };
}

/**
 * Resolves a destination to the memory directory it names. Both kinds are
 * validated against what exists: a store id must be a store that's there, a
 * directory a real directory in a known Claude Code home — so a typo fails
 * here rather than creating a store nothing will ever load.
 */
async function resolveDestination(
  dest: MoveDestination,
): Promise<{ destDir: string; destLabel: string }> {
  if (dest.kind === "store") {
    const store = (await listMemoryStores()).find((s) =>
      s.dir === dest.storeId
    );
    if (!store) throw new Error(`No such memory store: ${dest.storeId}`);
    return { destDir: store.dir, destLabel: store.dir };
  }

  const homes = await discoverHomes();
  if (!homes.some((h) => h.tool === "claude" && h.dir === dest.home)) {
    throw new Error(`Not a Claude Code config folder: ${dest.home}`);
  }
  const store = await storeForDir(await resolveProjectDir(dest.dir));
  const shared = await sharedMemoryDir(dest.home);
  return {
    destDir: shared ?? `${dest.home}/projects/${store.domain}/memory`,
    destLabel: store.root,
  };
}

/**
 * Records the store a memory came from as `metadata.movedFrom`, so undoing a
 * move is moving it back. Works whatever shape the frontmatter has, adding a
 * metadata block (or the frontmatter itself) when missing.
 */
export function stampMovedFrom(content: string, source: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) {
    return `---\nmetadata:\n  movedFrom: ${source}\n---\n\n${content}`;
  }

  const lines = match[1].split(/\r?\n/).filter((l) =>
    !/^\s+movedFrom:/.test(l)
  );
  const meta = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (meta === -1) lines.push("metadata:", `  movedFrom: ${source}`);
  else lines.splice(meta + 1, 0, `  movedFrom: ${source}`);

  const frontmatter = `---\n${lines.join("\n")}\n---${match[2]}`;
  return frontmatter + content.slice(match[0].length);
}

/**
 * Relocates a memory file as-is into another project's store. Deterministic,
 * no LLM; the destination only selects *which* store. A same-named file at
 * the destination is refused before anything is touched.
 */
export async function writeMovedMemory(
  memory: MigratableMemory,
  sourceStoreId: string,
  dest: MoveDestination,
): Promise<{ writtenPath: string; destDir: string; destLabel: string }> {
  if (memory.filename === "MEMORY.md") {
    throw new Error(
      `Refusing to move the index file itself (${memory.filename}).`,
    );
  }

  const { destDir, destLabel } = await resolveDestination(dest);
  if (sourceStoreId === destDir) {
    throw new Error(`This memory already lives in ${destLabel}.`);
  }

  const destPath = `${destDir}/${memory.filename}`;

  if (await pathExists(destPath)) {
    throw new Error(
      `A memory named "${memory.filename}" already exists in ${destLabel} — rename one of them first.`,
    );
  }

  const content = stampMovedFrom(
    await Deno.readTextFile(memory.path),
    sourceStoreId,
  );

  await Deno.mkdir(destDir, { recursive: true });
  await Deno.writeTextFile(destPath, content);

  return { writtenPath: destPath, destDir, destLabel };
}
