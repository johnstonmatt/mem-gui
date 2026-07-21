export interface MigratableMemory {
  path: string;
  filename: string;
  name: string;
  description: string;
}

export interface IntegrationProposal {
  targetFile: string;
  summary: string;
  content: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function stripFrontmatter(content: string): string {
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

Decide the single best file in this repo to write this into (relative to the repo root; create it if it doesn't exist — e.g. README.md, DEVELOPMENT.md, or something under docs/), and produce that file's FULL new content after integration. Prefer merging into existing relevant sections over blindly appending. Respond only via the required schema.`;

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

  return { targetFile, summary: proposal.summary, content: proposal.content };
}

/** The only function that writes for "Integrate" — one file, always markdown, always inside the repo it was proposed for. */
export async function writeIntegration(
  repoRoot: string,
  targetFile: string,
  content: string,
): Promise<{ writtenPath: string }> {
  assertWithinRepo(repoRoot, targetFile);
  if (!targetFile.endsWith(".md")) {
    throw new Error(`Refusing non-markdown target: ${targetFile}`);
  }

  const dir = targetFile.slice(0, targetFile.lastIndexOf("/"));
  try {
    await Deno.stat(dir);
  } catch {
    await Deno.mkdir(dir, { recursive: true });
  }
  await Deno.writeTextFile(targetFile, content);
  return { writtenPath: targetFile };
}

/**
 * "Hoist" is fully deterministic — no LLM involved, no arbitrary write
 * target. It relocates a memory file as-is into ~/dev's own memory store (a
 * real, pre-existing Claude Code project domain — the same
 * ~/.claude/projects/<domain>/memory/ convention every project already
 * uses), so it applies at the broader root rather than one narrow project.
 * Refuses outright if a same-named file already exists at the destination,
 * rather than silently overwriting it — collision is the only failure mode,
 * and it's caught before anything is touched.
 */
export async function writeHoistedMemory(
  memory: MigratableMemory,
  sourceDomain: string,
): Promise<{ writtenPath: string; destDomain: string }> {
  if (memory.filename === "MEMORY.md") {
    throw new Error(
      `Refusing to hoist the index file itself (${memory.filename}).`,
    );
  }

  const home = Deno.env.get("HOME") ?? "";
  const rootPath = `${home}/dev`;
  // Claude Code names project memory dirs after the escaped absolute cwd
  // (e.g. "/Users/m/dev" -> "-Users-m-dev"). Unlike reversing this mapping
  // (lossy — see scanner.ts), going forward from a known real path is exact:
  // every "/" becomes "-", deterministically.
  const destDomain = rootPath.replace(/\//g, "-");

  if (sourceDomain === destDomain) {
    throw new Error(`This memory is already in the ~/dev root store.`);
  }

  const destDir = `${home}/.claude/projects/${destDomain}/memory`;
  const destPath = `${destDir}/${memory.filename}`;

  if (await pathExists(destPath)) {
    throw new Error(
      `A memory named "${memory.filename}" already exists in the ~/dev store — rename one of them first.`,
    );
  }

  const rawContent = await Deno.readTextFile(memory.path);
  // Traceability aid for reversibility: records where this came from, right
  // in the file, so "undo" is just "read hoistedFrom and move it back."
  const content = rawContent.replace(
    /^(metadata:[ \t]*\r?\n)/m,
    `$1  hoistedFrom: ${sourceDomain}\n`,
  );

  await Deno.mkdir(destDir, { recursive: true });
  await Deno.writeTextFile(destPath, content);

  return { writtenPath: destPath, destDomain };
}
