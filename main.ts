import { scanDomains } from "./src/scanner.ts";
import {
  type MigratableMemory,
  type MoveDestination,
  proposeIntegration,
  writeIntegration,
  writeMovedMemory,
} from "./src/migrate.ts";
import { readSettings, type Settings, writeSettings } from "./src/settings.ts";
// Static assets are pulled in as text modules (stable since Deno 2.8) so
// `deno desktop` embeds them in the module graph like any other import —
// reading them via Deno.readFile at runtime doesn't work, since the
// compiled/HMR runtime's `import.meta.url` root only contains files that
// were actually imported, not arbitrary files under the source tree.
import indexHtml from "./public/index.html" with { type: "text" };
import stylesCss from "./public/styles.css" with { type: "text" };
import treemapJs from "./public/treemap.js" with { type: "text" };

const ASSETS: Record<string, { body: string; contentType: string }> = {
  "/": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/styles.css": { body: stylesCss, contentType: "text/css; charset=utf-8" },
  "/treemap.js": {
    body: treemapJs,
    contentType: "text/javascript; charset=utf-8",
  },
};

/** Guard against acting on anything outside the memory store we scanned. */
function assertManagedPath(path: string) {
  const home = Deno.env.get("HOME") ?? "";
  const root = `${home}/.claude/projects/`;
  if (!path.startsWith(root) || !path.endsWith(".md")) {
    throw new Error(`Refusing to act on path outside memory store: ${path}`);
  }
}

/**
 * Deleting a memory file leaves a dangling link in that domain's MEMORY.md
 * index otherwise — strip the line pointing at it (matched by the markdown
 * link target, e.g. "(architecture_mem_gui.md)") so the index doesn't rot.
 */
async function removeFromIndex(deletedPath: string) {
  const filename = deletedPath.slice(deletedPath.lastIndexOf("/") + 1);
  if (filename === "MEMORY.md") return;

  const dir = deletedPath.slice(0, deletedPath.lastIndexOf("/"));
  const indexPath = `${dir}/MEMORY.md`;
  const marker = `(${filename})`;

  let content: string;
  try {
    content = await Deno.readTextFile(indexPath);
  } catch {
    return;
  }

  const lines = content.split("\n");
  const filtered = lines.filter((line) => !line.includes(marker));
  if (filtered.length !== lines.length) {
    await Deno.writeTextFile(indexPath, filtered.join("\n"));
  }
}

/** The symmetric counterpart to removeFromIndex, for adding a hoisted memory's entry at its new home. */
async function addToIndex(
  memoryDir: string,
  filename: string,
  name: string,
  description: string,
) {
  const indexPath = `${memoryDir}/MEMORY.md`;
  const line = `- [${name}](${filename}) — ${description}`;

  let existing = "";
  try {
    existing = await Deno.readTextFile(indexPath);
  } catch {
    // no index yet at the destination — fine, create one below
  }

  const trimmed = existing.replace(/\s+$/, "");
  const updated = trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`;
  await Deno.writeTextFile(indexPath, updated);
}

// The auto-opened window navigates to the local server as soon as its
// listener comes up, so the window + all bindings must be fully registered
// *before* Deno.serve() starts listening below — otherwise the page can call
// bindings.getTree() before the Deno side has bound it ("No callback bound
// for: getTree").
const win = new Deno.BrowserWindow({
  title: "Mem GUI",
  width: 1280,
  height: 860,
  x: 0,
  y: 0,
});

// The red close button only dispatches "close" — `deno desktop` has no default
// close behaviour, so without a listener the button is inert. Closing the
// window alone isn't enough either: Deno.serve() below holds the event loop
// open, so the process would outlive its only window with no way to quit it
// short of Activity Monitor. One window means closing it is quitting.
win.addEventListener("close", () => {
  win.close();
  Deno.exit(0);
});

// win.bind()'s generic signature expects loosely-typed JSON args/return
// values; our handlers work with concrete shapes (string paths, Domain[]),
// so each handler is cast at the bind() boundary where they're plain JSON
// over the wire anyway.
win.bind("getTree", (() => scanDomains()) as never);

win.bind(
  "getFileContent",
  ((path: string) => {
    assertManagedPath(path);
    return Deno.readTextFile(path);
  }) as never,
);

win.bind(
  "deleteFile",
  (async (path: string) => {
    assertManagedPath(path);
    await Deno.remove(path);
    await removeFromIndex(path);
    return scanDomains();
  }) as never,
);

win.bind(
  "revealInFinder",
  ((path: string) => {
    assertManagedPath(path);
    new Deno.Command("open", { args: ["-R", path] }).spawn();
  }) as never,
);

win.bind(
  "openFile",
  ((path: string) => {
    assertManagedPath(path);
    new Deno.Command("open", { args: [path] }).spawn();
  }) as never,
);

// "Integrate": assumes the memory's own project repo. Proposing is
// read-only (see migrate.ts); writing is a single file, always markdown,
// always inside that repo — reversible via the repo's own git history.
win.bind(
  "proposeIntegration",
  ((memory: MigratableMemory, repoRoot: string) => {
    assertManagedPath(memory.path);
    return proposeIntegration(memory, repoRoot);
  }) as never,
);

win.bind(
  "applyIntegration",
  ((
    repoRoot: string,
    targetFile: string,
    content: string,
  ) => writeIntegration(repoRoot, targetFile, content)) as never,
);

// "Move": fully deterministic relocation into another project's memory store
// — no LLM, no arbitrary write target. The destination only ever selects
// *which* store (see resolveDestination in migrate.ts); the write path is
// always ~/.claude/projects/<domain>/memory/. Touches 4 files (new memory +
// its index, old memory + its index), but all 4 are within the same
// already-safe ~/.claude/projects scope, none of them overwrite unrelated
// content (collision on the new file is refused outright, index edits are
// simple append/line-removal), so this is one coherent, reversible operation
// rather than the kind of unpredictable multi-file fan-out we ruled out
// for LLM-directed writes (see feedback_scope_destructive_actions memory).
win.bind(
  "moveMemory",
  ((
    memory: MigratableMemory,
    sourceDomain: string,
    dest: MoveDestination,
  ) => {
    assertManagedPath(memory.path);
    return (async () => {
      const result = await writeMovedMemory(memory, sourceDomain, dest);
      const destDir = result.writtenPath.slice(
        0,
        result.writtenPath.lastIndexOf("/"),
      );
      await addToIndex(
        destDir,
        memory.filename,
        memory.name,
        memory.description,
      );
      await Deno.remove(memory.path);
      await removeFromIndex(memory.path);
      return { ...result, domains: await scanDomains() };
    })();
  }) as never,
);

// Settings are read on load (to label the one-click hoist button with its
// current target) and written only when the user saves. writeSettings
// validates the directory before persisting, so a bad value surfaces here
// rather than on every later hoist.
win.bind("getSettings", (() => readSettings()) as never);

win.bind(
  "saveSettings",
  ((patch: Partial<Settings>) => writeSettings(patch)) as never,
);

Deno.serve((req) => {
  const path = new URL(req.url).pathname;
  const asset = ASSETS[path];
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(asset.body, {
    headers: { "content-type": asset.contentType },
  });
});
