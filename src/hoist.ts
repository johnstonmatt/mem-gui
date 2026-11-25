import { discoverHomes } from "./homes.ts";
import { type MigratableMemory, stripFrontmatter } from "./migrate.ts";
import { contractHome } from "./paths.ts";
import { addToIndex, removeFromIndex } from "./memory_index.ts";

/**
 * Hoisted instructions live in exactly one file. Each agent folder points at
 * it once: Codex's AGENTS.md is a symlink to it (Codex reads that file as-is
 * and has no imports), and Claude Code's CLAUDE.md imports it.
 */
export function sharedFilePath(): string {
  return `${Deno.env.get("HOME") ?? ""}/.agents/AGENTS.md`;
}

const IMPORT_LINE = "@~/.agents/AGENTS.md";

/** One change a hoist (or a link repair) makes. */
export interface HoistStep {
  path: string;
  display: string;
  /**
   * create/append: the shared file gets the instruction; link: an agent's
   * AGENTS.md becomes a symlink to it; merge: an AGENTS.md's own text moves
   * into the shared file first; import: a CLAUDE.md gains the import line.
   */
  action: "create" | "append" | "link" | "merge" | "import";
}

export interface Wiring {
  steps: HoistStep[];
  /** Why an agent folder can't be pointed at the shared file. */
  blocked: string[];
  /** Pointed at it, but something stops it loading for now. */
  warnings: string[];
}

export interface SharedInstruction {
  /** The hoisted memory's filename; identifies the section. */
  id: string;
  name: string;
  text: string;
}

const begin = (id: string) => `<!-- mem-gui:begin ${id} -->`;
const end = (id: string) => `<!-- mem-gui:end ${id} -->`;
const SECTION =
  /<!-- mem-gui:begin ([^\n]+?) -->\n([\s\S]*?)\n<!-- mem-gui:end \1 -->\n*/g;

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

function step(path: string, action: HoistStep["action"]): HoistStep {
  return { path, display: contractHome(path), action };
}

/** Splits the shared file into hoisted sections and any other text. */
export function parseShared(
  text: string,
): { sections: SharedInstruction[]; rest: string } {
  const sections = [...text.matchAll(SECTION)].map(([, id, inner]) => ({
    id,
    name: inner.match(/^## (.+)$/m)?.[1].trim() ?? id,
    text: inner.trim(),
  }));
  return { sections, rest: text.replace(SECTION, "").trim() };
}

/** Whether an existing symlink already points at the shared file. */
async function linksToShared(path: string, shared: string): Promise<boolean> {
  if (await Deno.readLink(path) === shared) return true;
  const [a, b] = [await realOrNull(path), await realOrNull(shared)];
  return a !== null && a === b;
}

/** What's needed for every agent folder on this machine to read the shared file. */
export async function planWiring(): Promise<Wiring> {
  const shared = sharedFilePath();
  const wiring: Wiring = { steps: [], blocked: [], warnings: [] };

  for (const { tool, dir } of await discoverHomes()) {
    if (tool === "claude") {
      const path = `${dir}/CLAUDE.md`;
      const text = await readOrNull(path) ?? "";
      const imported = text.split("\n").some((line) =>
        [IMPORT_LINE, `@${shared}`].includes(line.trim())
      );
      if (!imported) wiring.steps.push(step(path, "import"));
      continue;
    }

    const path = `${dir}/AGENTS.md`;
    const info = await lstatOrNull(path);
    if (!info) {
      wiring.steps.push(step(path, "link"));
    } else if (info.isSymlink) {
      if (!await linksToShared(path, shared)) {
        wiring.blocked.push(
          `${contractHome(path)} links to ${await Deno.readLink(path)}. ` +
            `Move what it holds into ${contractHome(shared)}, then delete it.`,
        );
      }
    } else if (!info.isFile) {
      wiring.blocked.push(`${contractHome(path)} isn't a file.`);
    } else {
      const own = (await Deno.readTextFile(path)).trim();
      if (own.includes("<!-- mem-gui:begin ")) {
        // An editor that saves by replacing the file turned the link into a
        // copy of the shared file; merging it would duplicate everything.
        wiring.blocked.push(
          `${contractHome(path)} is a separate copy of ${
            contractHome(shared)
          } (an editor replaced the link). Keep the version you want in ` +
            `${contractHome(shared)}, then delete ${contractHome(path)}.`,
        );
      } else {
        wiring.steps.push(step(path, own ? "merge" : "link"));
      }
    }

    // Codex reads a non-empty override instead of AGENTS.md.
    const override = `${dir}/AGENTS.override.md`;
    if ((await readOrNull(override))?.trim()) {
      wiring.warnings.push(
        `Codex reads ${contractHome(override)} instead of AGENTS.md while it ` +
          `has text, so shared instructions won't load there until it's removed.`,
      );
    }
  }
  return wiring;
}

async function appendShared(text: string): Promise<void> {
  const shared = sharedFilePath();
  await Deno.mkdir(shared.slice(0, shared.lastIndexOf("/")), {
    recursive: true,
  });
  const existing = (await readOrNull(shared) ?? "").replace(/\s+$/, "");
  await Deno.writeTextFile(
    shared,
    existing ? `${existing}\n\n${text}` : text,
  );
}

/** Carries out a plan's link, merge and import steps. */
async function applyWiring(steps: HoistStep[]): Promise<void> {
  const shared = sharedFilePath();
  if (await readOrNull(shared) === null) await appendShared("");

  for (const { path, action } of steps) {
    if (action === "merge") {
      await appendShared(`${(await Deno.readTextFile(path)).trim()}\n`);
    }
    if (action === "merge" || action === "link") {
      if (await lstatOrNull(path)) await Deno.remove(path);
      await Deno.symlink(shared, path);
    }
    if (action === "import") {
      const existing = (await readOrNull(path) ?? "").replace(/\s+$/, "");
      await Deno.writeTextFile(
        path,
        existing ? `${existing}\n\n${IMPORT_LINE}\n` : `${IMPORT_LINE}\n`,
      );
    }
  }
}

/** Points any agent folder that isn't yet at the shared file. */
export async function repairWiring(): Promise<Wiring> {
  const wiring = await planWiring();
  if (wiring.blocked.length) throw new Error(wiring.blocked.join(" "));
  await applyWiring(wiring.steps);
  return wiring;
}

/** What hoisting would change, for review before confirming. */
export async function planHoist(memory: MigratableMemory): Promise<Wiring> {
  if (memory.filename === "MEMORY.md") {
    throw new Error("Refusing to hoist the index file itself (MEMORY.md).");
  }
  if (!stripFrontmatter(await Deno.readTextFile(memory.path))) {
    throw new Error(`"${memory.name}" has no body to hoist.`);
  }
  const shared = sharedFilePath();
  const text = await readOrNull(shared);
  if (text?.includes(begin(memory.filename))) {
    throw new Error(
      `A hoisted "${memory.filename}" is already in ${
        contractHome(shared)
      } — edit or delete that one first.`,
    );
  }

  const wiring = await planWiring();
  return {
    ...wiring,
    steps: [step(shared, text === null ? "create" : "append"), ...wiring.steps],
  };
}

/**
 * Moves the memory into the shared file, points every agent folder at it,
 * and removes the memory and its index line. Nothing is written if any folder
 * can't be pointed at the file. Returns what undoHoist needs to reverse it.
 */
export async function hoistMemory(
  memory: MigratableMemory,
): Promise<{ wiring: Wiring; undo: HoistUndo }> {
  const plan = await planHoist(memory);
  if (plan.blocked.length) throw new Error(plan.blocked.join(" "));

  const content = await Deno.readTextFile(memory.path);
  const body = stripFrontmatter(content);
  await applyWiring(plan.steps.slice(1));
  await appendShared(
    `${begin(memory.filename)}\n## ${memory.name}\n\n${body}\n${
      end(memory.filename)
    }\n`,
  );
  await Deno.remove(memory.path);
  const indexLines = await removeFromIndex(memory.path);
  return {
    wiring: plan,
    undo: {
      path: memory.path,
      content,
      indexLines,
      sectionId: memory.filename,
    },
  };
}

export interface HoistUndo {
  path: string;
  content: string;
  indexLines: string[];
  sectionId: string;
}

/**
 * Puts a hoisted memory back exactly as it was and takes its section out of
 * the shared file. Agent folders stay pointed at the shared file.
 */
export async function undoHoist(undo: HoistUndo): Promise<void> {
  try {
    await Deno.writeTextFile(undo.path, undo.content, { createNew: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `${contractHome(undo.path)} exists again; not overwriting it.`,
      );
    }
    throw error;
  }
  await addToIndex(undo.path, undo.indexLines);
  const text = await readOrNull(sharedFilePath()) ?? "";
  if (text.includes(begin(undo.sectionId))) {
    await removeSharedInstruction(undo.sectionId);
  }
}

/** Removes one hoisted instruction from the shared file. */
export async function removeSharedInstruction(id: string): Promise<void> {
  const shared = sharedFilePath();
  const text = await readOrNull(shared) ?? "";
  const next = text.replace(
    SECTION,
    (block, found) => found === id ? "" : block,
  );
  if (next === text) throw new Error(`No hoisted instruction "${id}".`);
  await Deno.writeTextFile(
    shared,
    `${next.replace(/\n{3,}/g, "\n\n").trim()}\n`,
  );
}
