import {
  discoverHomes,
  listMemoryStores,
  sharedMemoryDir,
  storeContaining,
} from "./homes.ts";
import { assertEquals, withTempHome } from "./test_helpers.ts";

const mkdir = (path: string) => Deno.mkdir(path, { recursive: true });

Deno.test("only agent folders that exist are found", async () => {
  await withTempHome(async (home) => {
    assertEquals(await discoverHomes(), []);
    await mkdir(`${home}/.claude`);
    assertEquals(await discoverHomes(), [
      { tool: "claude", dir: `${home}/.claude` },
    ]);
  });
});

Deno.test("CLAUDE_CONFIG_DIR and CODEX_HOME add their folders once", async () => {
  await withTempHome(async (home) => {
    await mkdir(`${home}/.claude`);
    await mkdir(`${home}/alt-claude`);
    await mkdir(`${home}/.codex`);
    Deno.env.set("CLAUDE_CONFIG_DIR", "~/alt-claude");
    // Pointing at the default folder must not list it twice.
    Deno.env.set("CODEX_HOME", `${home}/.codex/`);

    assertEquals(await discoverHomes(), [
      { tool: "claude", dir: `${home}/.claude` },
      { tool: "claude", dir: `${home}/alt-claude` },
      { tool: "codex", dir: `${home}/.codex` },
    ]);
  });
});

Deno.test("Ori profile folders are expanded the way Ori does", async () => {
  await withTempHome(async (home) => {
    for (const dir of [".claude", ".codex", ".claude-work", "shared-box"]) {
      await mkdir(`${home}/${dir}`);
    }
    await mkdir(`${home}/.ori`);
    await Deno.writeTextFile(
      `${home}/.ori/profiles.json`,
      JSON.stringify({
        active: "work",
        profiles: {
          default: { sessions: { kind: "path", path: "~/ignored" } },
          work: {
            sessions: { kind: "template", template: "~/.{harness}-{profile}" },
          },
          box: { sessions: { kind: "path", path: "~/shared-box" } },
          plain: { sessions: { kind: "shared" } },
        },
      }),
    );

    // ~/.codex-work was never created, so Codex hasn't run under "work".
    assertEquals(await discoverHomes(), [
      { tool: "claude", dir: `${home}/.claude` },
      { tool: "claude", dir: `${home}/.claude-work` },
      { tool: "claude", dir: `${home}/shared-box` },
      { tool: "codex", dir: `${home}/.codex` },
      { tool: "codex", dir: `${home}/shared-box` },
    ]);
  });
});

Deno.test("a malformed Ori profiles file is ignored", async () => {
  await withTempHome(async (home) => {
    await mkdir(`${home}/.claude`);
    await mkdir(`${home}/.ori`);
    for (const text of ["{ nope", "[]", '{"profiles": 3}']) {
      await Deno.writeTextFile(`${home}/.ori/profiles.json`, text);
      assertEquals((await discoverHomes()).length, 1, text);
    }
  });
});

Deno.test("stores cover every Claude home, shared directory included", async () => {
  await withTempHome(async (home) => {
    await mkdir(`${home}/.claude/projects/-a/memory`);
    await mkdir(`${home}/.claude/projects/-no-memory`);
    await mkdir(`${home}/alt/projects/-b/memory`);
    await mkdir(`${home}/shared-mem`);
    await Deno.writeTextFile(
      `${home}/alt/settings.json`,
      '{"autoMemoryDirectory": "~/shared-mem/"}',
    );
    Deno.env.set("CLAUDE_CONFIG_DIR", `${home}/alt`);

    assertEquals(await sharedMemoryDir(`${home}/alt`), `${home}/shared-mem`);
    assertEquals(await sharedMemoryDir(`${home}/.claude`), null);
    assertEquals(await listMemoryStores(), [
      {
        dir: `${home}/.claude/projects/-a/memory`,
        home: `${home}/.claude`,
        project: "-a",
      },
      { dir: `${home}/shared-mem`, home: `${home}/alt`, project: null },
      {
        dir: `${home}/alt/projects/-b/memory`,
        home: `${home}/alt`,
        project: "-b",
      },
    ]);
  });
});

Deno.test("storeContaining accepts only files directly inside a store", async () => {
  await withTempHome(async (home) => {
    const store = `${home}/.claude/projects/-a/memory`;
    await mkdir(store);

    assertEquals((await storeContaining(`${store}/x.md`))?.dir, store);
    for (
      const path of [
        `${store}/sub/x.md`,
        `${store}/x.txt`,
        `${store}/../../-b/memory/x.md`,
        `${home}/.claude/settings.md`,
        `${store}`,
      ]
    ) {
      assertEquals(await storeContaining(path), null, path);
    }
  });
});
