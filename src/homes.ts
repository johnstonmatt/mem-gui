import { expandHome } from "./paths.ts";

/** The coding agents whose config folders mem-gui reads and writes. */
export type AgentTool = "claude" | "codex";

export interface AgentHome {
  tool: AgentTool;
  /** The agent's config folder: ~/.claude, ~/.codex, or a profile's. */
  dir: string;
}

export interface MemoryStore {
  /** The memory directory itself; unique across homes, so also its id. */
  dir: string;
  /** The Claude Code home it belongs to. */
  home: string;
  /** Its name under <home>/projects/, or null for a shared store. */
  project: string | null;
}

const ENV_VAR: Record<AgentTool, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

function env(name: string): string {
  try {
    return Deno.env.get(name)?.trim() ?? "";
  } catch {
    return "";
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function realPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await Deno.readTextFile(path));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Folders Ori profiles launch agents with (`~/.ori/profiles.json`), expanded
 * as Ori does: "{harness}"/"{profile}" placeholders and a leading `~/`. The
 * default profile and "shared" profiles use the agent's normal folder.
 */
async function oriProfileDirs(tool: AgentTool): Promise<string[]> {
  const doc = await readJsonObject(`${env("HOME")}/.ori/profiles.json`);
  const profiles = doc?.profiles;
  if (!profiles || typeof profiles !== "object") return [];

  const dirs: string[] = [];
  for (const [name, value] of Object.entries(profiles)) {
    if (name === "default") continue;
    const sessions = (value as { sessions?: Record<string, unknown> })
      ?.sessions;
    const raw = sessions?.kind === "path"
      ? sessions.path
      : sessions?.kind === "template" && typeof sessions.template === "string"
      ? sessions.template.replaceAll("{harness}", tool)
        .replaceAll("{profile}", name)
      : undefined;
    if (typeof raw === "string" && raw.trim()) {
      dirs.push(expandHome(raw.trim()));
    }
  }
  return dirs;
}

/**
 * Every agent config folder on this machine that exists: the defaults, the
 * folders CLAUDE_CONFIG_DIR / CODEX_HOME name, and Ori profile folders.
 */
export async function discoverHomes(): Promise<AgentHome[]> {
  const home = env("HOME");
  const homes: AgentHome[] = [];
  const seen = new Set<string>();

  for (const tool of ["claude", "codex"] as const) {
    const candidates = [
      `${home}/.${tool}`,
      expandHome(env(ENV_VAR[tool])),
      ...await oriProfileDirs(tool),
    ];
    for (const dir of candidates) {
      if (!dir.startsWith("/") || !await isDir(dir)) continue;
      const key = `${tool}:${await realPath(dir)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      homes.push({ tool, dir: dir.replace(/\/+$/, "") });
    }
  }
  return homes;
}

/**
 * A Claude Code home's user-level `autoMemoryDirectory`: when set, every
 * project shares that one store instead of its own under projects/.
 */
export async function sharedMemoryDir(home: string): Promise<string | null> {
  const value = (await readJsonObject(`${home}/settings.json`))
    ?.autoMemoryDirectory;
  if (typeof value !== "string" || !value.trim()) return null;
  const dir = expandHome(value.trim()).replace(/\/+$/, "");
  return dir.startsWith("/") ? dir : null;
}

/** Every memory store in every Claude Code home. */
export async function listMemoryStores(): Promise<MemoryStore[]> {
  const stores: MemoryStore[] = [];

  for (const { tool, dir: home } of await discoverHomes()) {
    if (tool !== "claude") continue;

    const shared = await sharedMemoryDir(home);
    if (shared && await isDir(shared)) {
      stores.push({ dir: shared, home, project: null });
    }

    // A missing directory is the ordinary "nothing here yet" case; any other
    // failure is a real fault and must not read as an empty store.
    const projects = `${home}/projects`;
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(projects));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const dir = `${projects}/${entry.name}/memory`;
      try {
        if (!(await Deno.stat(dir)).isDirectory) continue;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      stores.push({ dir, home, project: entry.name });
    }
  }
  return stores;
}

/** The store a memory file lives directly inside, or null if it isn't one. */
export async function storeContaining(
  path: string,
): Promise<MemoryStore | null> {
  if (!path.endsWith(".md") || path.split("/").includes("..")) return null;
  for (const store of await listMemoryStores()) {
    const rest = path.startsWith(`${store.dir}/`)
      ? path.slice(store.dir.length + 1)
      : "";
    if (rest && !rest.includes("/")) return store;
  }
  return null;
}
