// These two are deliberately hand-rolled rather than imported from @std/path.
// Pulling any remote (JSR/HTTPS) module into a `deno desktop` module graph
// silently breaks the webview binding channel: every win.bind() handler ends up
// unregistered, so the page's first call fails with "No callback bound for: X"
// and the window comes up empty. Verified against deno 2.9.0 / laufey 0.4.0 by
// bisecting this exact import — dropping it takes the app's embedded remote
// modules from 295KB to 12B and all bindings come back. Keep this file
// dependency-free; if you need more path handling, extend it here.

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

/**
 * Settings and destination inputs keep `~`-prefixed paths as typed — they stay
 * readable in the settings JSON and in the UI — so every consumer expands them
 * here rather than storing a pre-resolved absolute path.
 */
export function expandHome(path: string): string {
  const home = Deno.env.get("HOME") ?? "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Turns a user-supplied project directory into the exact absolute path we'll
 * derive a memory-store domain from. Existence is part of the contract: a typo
 * would otherwise silently mint a brand-new bogus domain rather than failing.
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

  // normalize() resolves any "." / ".." segments and collapses duplicate
  // slashes, but preserves a trailing slash — which would escape to a trailing
  // dash and name the wrong domain, so strip it too.
  const dir = normalize(expanded).replace(/\/+$/, "") || "/";

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(dir);
  } catch {
    throw new Error(`No such directory: ${dir}`);
  }
  if (!stat.isDirectory) {
    throw new Error(`Not a directory: ${dir}`);
  }
  return dir;
}

/**
 * Claude Code names each project's memory dir after the escaped absolute cwd
 * (e.g. "/Users/m/dev" -> "-Users-m-dev"). Unlike reversing this mapping
 * (lossy — see scanner.ts), going forward from a known real path is exact:
 * every "/" becomes "-", deterministically.
 */
export function domainForProjectDir(dir: string): string {
  return dir.replace(/\//g, "-");
}
