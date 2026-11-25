// Assertions are hand-rolled rather than imported from @std/assert to keep the
// project free of remote modules end to end (see the note in paths.ts for why
// that matters here). Test modules aren't part of the `deno desktop` graph, so
// a dep here wouldn't break the app — but it would reintroduce a lockfile and
// make CI need the network, for three functions this short.

export function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
  }
}

/** Asserts `haystack` contains `needle`, reporting the full value when it doesn't. */
export function assertIncludes(haystack: string, needle: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`expected to find "${needle}" in: ${haystack}`);
  }
}

/** Variables that point agents at other config folders; cleared per test. */
const AGENT_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

/**
 * Every module here derives its paths from $HOME (and the agent config-folder
 * variables), so tests run against a throwaway home with those cleared. The
 * environment is process-wide, so it's restored afterwards.
 */
export async function withTempHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const names = ["HOME", ...AGENT_ENV];
  const original = new Map(names.map((n) => [n, Deno.env.get(n)]));
  // realPath: macOS temp dirs sit behind the /var -> /private/var symlink.
  const home = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "mem-gui-test-" }),
  );
  Deno.env.set("HOME", home);
  for (const name of AGENT_ENV) Deno.env.delete(name);
  try {
    await fn(home);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Asserts `fn` rejects, and returns the message so callers can assert on it. */
export async function rejects(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a rejection, but the call succeeded");
}

export const MEMORY_FIXTURE = `---
name: thing
description: a thing
metadata:
  type: project
---

Body text.
`;
