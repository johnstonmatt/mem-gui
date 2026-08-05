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

/**
 * Every module here derives its paths from $HOME, so tests run against a
 * throwaway one instead of the real memory store. HOME is process-wide, so this
 * restores it afterwards — `deno test` runs test modules in one process, and a
 * leaked HOME would quietly point later tests at a deleted directory.
 */
export async function withTempHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const original = Deno.env.get("HOME");
  const home = await Deno.makeTempDir({ prefix: "mem-gui-test-" });
  Deno.env.set("HOME", home);
  try {
    await fn(home);
  } finally {
    if (original === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", original);
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
