import { resolveProjectDir } from "./paths.ts";

export interface Settings {
  /**
   * Project directory the one-click "Hoist" action moves a memory into. Stored
   * as typed (so `~` stays `~` in the file rather than being baked into an
   * absolute path) and expanded on use.
   */
  defaultHoistDir: string;
}

// Defaults to the home root: hoisting is for memories that shouldn't be pinned
// to one project, and `~` is the broadest store that still corresponds to a
// real directory Claude Code can be run from.
const DEFAULTS: Settings = { defaultHoistDir: "~" };

/**
 * Lives beside Claude Code's own state rather than in `~/.config`, so the
 * app's write scope stays limited to the one directory tree it already needs
 * (see the permission grants in deno.jsonc).
 */
export function settingsPath(): string {
  const home = Deno.env.get("HOME") ?? "";
  return `${home}/.claude/mem-gui.json`;
}

/**
 * A missing, unreadable, or malformed settings file is not an error worth
 * surfacing — the app is fully usable on defaults, and the file is written
 * only when the user actually saves a setting.
 */
export async function readSettings(): Promise<Settings> {
  let parsed: Partial<Settings>;
  try {
    parsed = JSON.parse(await Deno.readTextFile(settingsPath()));
  } catch {
    return { ...DEFAULTS };
  }

  const dir = typeof parsed.defaultHoistDir === "string"
    ? parsed.defaultHoistDir.trim()
    : "";
  return { defaultHoistDir: dir || DEFAULTS.defaultHoistDir };
}

/**
 * Validates before persisting: a default hoist target that doesn't resolve to
 * a real directory would fail on every later hoist instead of here, once, with
 * the input still in front of the user.
 */
export async function writeSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  const next = await readSettings();

  if (patch.defaultHoistDir !== undefined) {
    const input = patch.defaultHoistDir.trim();
    await resolveProjectDir(input);
    next.defaultHoistDir = input;
  }

  await Deno.writeTextFile(
    settingsPath(),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}
