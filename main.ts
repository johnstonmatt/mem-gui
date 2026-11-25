import { scanDomains } from "./src/scanner.ts";
import {
  type MigratableMemory,
  type MoveDestination,
  proposeIntegration,
  writeIntegration,
  writeMovedMemory,
} from "./src/migrate.ts";
import {
  hoistMemory,
  type HoistUndo,
  planHoist,
  removeSharedInstruction,
  repairWiring,
  sharedFilePath,
  undoHoist,
} from "./src/hoist.ts";
import { addToIndex, indexLine, removeFromIndex } from "./src/memory_index.ts";
import { storeContaining } from "./src/homes.ts";
// Static assets are pulled in as text modules (stable since Deno 2.8) so
// `deno desktop` embeds them in the module graph like any other import —
// reading them via Deno.readFile at runtime doesn't work, since the
// compiled/HMR runtime's `import.meta.url` root only contains files that
// were actually imported, not arbitrary files under the source tree.
import indexHtml from "./public/index.html" with { type: "text" };
import stylesCss from "./public/styles.css" with { type: "text" };
import treemapJs from "./public/treemap.js" with { type: "text" };
import treeJs from "./public/tree.js" with { type: "text" };

const ASSETS: Record<string, { body: string; contentType: string }> = {
  "/": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/styles.css": { body: stylesCss, contentType: "text/css; charset=utf-8" },
  "/treemap.js": {
    body: treemapJs,
    contentType: "text/javascript; charset=utf-8",
  },
  "/tree.js": { body: treeJs, contentType: "text/javascript; charset=utf-8" },
};

/** Guard against acting on anything but a file directly inside a known store. */
async function assertManagedPath(path: string) {
  if (!await storeContaining(path)) {
    throw new Error(`Refusing to act on path outside memory store: ${path}`);
  }
}

/** Opening is also allowed for the shared instructions file. */
async function assertOpenablePath(path: string) {
  if (path !== sharedFilePath()) await assertManagedPath(path);
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
  (async (path: string) => {
    await assertManagedPath(path);
    return Deno.readTextFile(path);
  }) as never,
);

win.bind(
  "deleteFile",
  (async (path: string) => {
    await assertManagedPath(path);
    await Deno.remove(path);
    await removeFromIndex(path);
    return scanDomains();
  }) as never,
);

win.bind(
  "revealInFinder",
  (async (path: string) => {
    await assertOpenablePath(path);
    new Deno.Command("open", { args: ["-R", path] }).spawn();
  }) as never,
);

win.bind(
  "openFile",
  (async (path: string) => {
    await assertOpenablePath(path);
    new Deno.Command("open", { args: [path] }).spawn();
  }) as never,
);

// "Integrate": assumes the memory's own project repo. Proposing is
// read-only (see migrate.ts); writing stays inside that repo, so it's
// reversible via the repo's own git history.
win.bind(
  "proposeIntegration",
  (async (memory: MigratableMemory, repoRoot: string) => {
    await assertManagedPath(memory.path);
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

// "Move": deterministic relocation into another store. Touches the new
// memory, both indexes, and the old memory, all inside known stores; the new
// file is refused on collision and index edits are append/remove.
win.bind(
  "moveMemory",
  ((
    memory: MigratableMemory,
    sourceStoreId: string,
    dest: MoveDestination,
  ) => {
    return (async () => {
      await assertManagedPath(memory.path);
      const result = await writeMovedMemory(memory, sourceStoreId, dest);
      await addToIndex(result.writtenPath, [
        indexLine(memory.name, memory.filename, memory.description),
      ]);
      await Deno.remove(memory.path);
      await removeFromIndex(memory.path);
      return { ...result, domains: await scanDomains() };
    })();
  }) as never,
);

// "Hoist": moves the memory into the one shared instructions file every
// agent folder points at (see hoist.ts), then removes it from its store.
// Nothing is written if any agent folder can't be pointed at that file.
win.bind(
  "getHoistPlan",
  (async (memory: MigratableMemory) => {
    await assertManagedPath(memory.path);
    return planHoist(memory);
  }) as never,
);

// Undo state stays on this side, so the page can only ask to reverse a hoist
// this process made, never hand over a path and content to write.
const undos = new Map<number, HoistUndo>();
let nextUndo = 1;

win.bind(
  "hoistMemory",
  (async (memory: MigratableMemory) => {
    await assertManagedPath(memory.path);
    const { wiring, undo } = await hoistMemory(memory);
    const undoId = nextUndo++;
    undos.set(undoId, undo);
    return {
      domains: await scanDomains(),
      undoId,
      warnings: wiring.warnings,
    };
  }) as never,
);

win.bind(
  "undoHoist",
  (async (undoId: number) => {
    const undo = undos.get(undoId);
    if (!undo) throw new Error("Nothing to undo.");
    await undoHoist(undo);
    undos.delete(undoId);
    return scanDomains();
  }) as never,
);

win.bind(
  "deleteSharedInstruction",
  (async (id: string) => {
    await removeSharedInstruction(id);
    return scanDomains();
  }) as never,
);

win.bind(
  "repairWiring",
  (async () => {
    await repairWiring();
    return scanDomains();
  }) as never,
);

Deno.serve((req) => {
  const path = new URL(req.url).pathname;
  const asset = ASSETS[path];
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(asset.body, {
    headers: { "content-type": asset.contentType },
  });
});
