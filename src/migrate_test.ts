import {
  type MigratableMemory,
  stampMovedFrom,
  writeIntegration,
  writeMovedMemory,
} from "./migrate.ts";
import { domainForProjectDir } from "./paths.ts";
import {
  assert,
  assertEquals,
  assertIncludes,
  exists,
  MEMORY_FIXTURE,
  rejects,
  withTempHome,
} from "./test_helpers.ts";

/** Builds a source project with one memory in its store, mirroring the real layout. */
async function seed(home: string, project = "proj-a") {
  const dir = `${home}/dev/${project}`;
  await Deno.mkdir(dir, { recursive: true });
  const claudeHome = `${home}/.claude`;
  const memoryDir = `${claudeHome}/projects/${domainForProjectDir(dir)}/memory`;
  await Deno.mkdir(memoryDir, { recursive: true });
  const path = `${memoryDir}/thing.md`;
  await Deno.writeTextFile(path, MEMORY_FIXTURE);
  const memory: MigratableMemory = {
    path,
    filename: "thing.md",
    name: "thing",
    description: "a thing",
  };
  return { dir, claudeHome, memoryDir, memory };
}

const storeFor = (home: string, dir: string) =>
  `${home}/.claude/projects/${domainForProjectDir(dir)}/memory`;

Deno.test("moving to a named directory lands in that project's store", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });

    const result = await writeMovedMemory(src.memory, src.memoryDir, {
      kind: "dir",
      dir: "~/dev/proj-b",
      home: src.claudeHome,
    });

    assertEquals(result.destDir, storeFor(home, `${home}/dev/proj-b`));
    assertEquals(result.writtenPath, `${result.destDir}/thing.md`);

    const moved = await Deno.readTextFile(result.writtenPath);
    // Traceability for reversibility, and the body must survive untouched.
    assertIncludes(moved, `  movedFrom: ${src.memoryDir}`);
    assertIncludes(moved, "Body text.");
    // Removing the original is the caller's step, not a hidden side effect.
    assert(await exists(src.memory.path), "source should still be present");
  });
});

Deno.test("moving to an existing store uses it verbatim", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    const dest = storeFor(home, `${home}/dev/proj-b`);
    await Deno.mkdir(dest, { recursive: true });

    const result = await writeMovedMemory(src.memory, src.memoryDir, {
      kind: "store",
      storeId: dest,
    });
    assertEquals(result.destDir, dest);
    assert(await exists(result.writtenPath));
  });
});

Deno.test("moving to a folder inside a repo lands in the repo's store", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    // Claude Code keys stores by repo root, so a subdirectory is the same store.
    await Deno.mkdir(`${home}/dev/repo.b/.git`, { recursive: true });
    await Deno.mkdir(`${home}/dev/repo.b/pkg/lib`, { recursive: true });

    const result = await writeMovedMemory(src.memory, src.memoryDir, {
      kind: "dir",
      dir: "~/dev/repo.b/pkg/lib",
      home: src.claudeHome,
    });
    assertEquals(result.destDir, storeFor(home, `${home}/dev/repo.b`));
    assertEquals(result.destLabel, `${home}/dev/repo.b`);
  });
});

Deno.test("with a shared memory directory, a folder means the shared store", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/shared`, { recursive: true });
    await Deno.writeTextFile(
      `${src.claudeHome}/settings.json`,
      '{"autoMemoryDirectory": "~/shared"}',
    );
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });

    const result = await writeMovedMemory(src.memory, src.memoryDir, {
      kind: "dir",
      dir: "~/dev/proj-b",
      home: src.claudeHome,
    });
    assertEquals(result.destDir, `${home}/shared`);
  });
});

Deno.test("a filename collision is refused rather than overwritten", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });
    const dest = {
      kind: "dir",
      dir: "~/dev/proj-b",
      home: src.claudeHome,
    } as const;

    const first = await writeMovedMemory(src.memory, src.memoryDir, dest);
    await Deno.writeTextFile(first.writtenPath, "PRE-EXISTING");

    assertIncludes(
      await rejects(() => writeMovedMemory(src.memory, src.memoryDir, dest)),
      "already exists",
    );
    // The refusal must not have clobbered what was there.
    assertEquals(await Deno.readTextFile(first.writtenPath), "PRE-EXISTING");
  });
});

Deno.test("moving into the memory's own store is refused", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    assertIncludes(
      await rejects(() =>
        writeMovedMemory(src.memory, src.memoryDir, {
          kind: "dir",
          dir: "~/dev/proj-a",
          home: src.claudeHome,
        })
      ),
      "already lives in",
    );
  });
});

Deno.test("the index file itself cannot be moved", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });
    assertIncludes(
      await rejects(() =>
        writeMovedMemory(
          { ...src.memory, filename: "MEMORY.md" },
          src.memoryDir,
          { kind: "dir", dir: "~/dev/proj-b", home: src.claudeHome },
        )
      ),
      "Refusing to move the index file",
    );
  });
});

Deno.test("unknown destinations are refused", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });
    for (
      const storeId of [
        `${home}/.claude/projects/-no-such/memory`,
        `${home}/elsewhere`,
        "",
      ]
    ) {
      assertIncludes(
        await rejects(() =>
          writeMovedMemory(src.memory, src.memoryDir, {
            kind: "store",
            storeId,
          })
        ),
        "No such memory store",
      );
    }
    assertIncludes(
      await rejects(() =>
        writeMovedMemory(src.memory, src.memoryDir, {
          kind: "dir",
          dir: "~/dev/proj-b",
          home: `${home}/not-a-home`,
        })
      ),
      "Not a Claude Code config folder",
    );
  });
});

Deno.test("a nonexistent destination changes nothing at all", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);

    assertIncludes(
      await rejects(() =>
        writeMovedMemory(src.memory, src.memoryDir, {
          kind: "dir",
          dir: "~/dev/does-not-exist",
          home: src.claudeHome,
        })
      ),
      "No such directory",
    );

    // Validation runs before the first mkdir/write, so nothing is half-done:
    // in particular a typo must not create a store nothing will ever load.
    assertEquals(await Deno.readTextFile(src.memory.path), MEMORY_FIXTURE);
    assert(!await exists(`${home}/dev/does-not-exist`));
    assert(!await exists(`${src.memoryDir}/MEMORY.md`));
    const projects = await Array.fromAsync(
      Deno.readDir(`${home}/.claude/projects`),
    );
    assertEquals(projects.length, 1);
  });
});

Deno.test("stampMovedFrom handles every frontmatter shape", () => {
  // Nested metadata block: inserted under it.
  assertIncludes(
    stampMovedFrom(MEMORY_FIXTURE, "-src"),
    "metadata:\n  movedFrom: -src\n  type: project",
  );

  // Older top-level fields, no metadata block: one is added.
  const flat = "---\nname: x\ntype: feedback\n---\n\nBody.\n";
  const stamped = stampMovedFrom(flat, "-src");
  assertIncludes(stamped, "type: feedback\nmetadata:\n  movedFrom: -src\n---");
  assertIncludes(stamped, "\nBody.\n");

  // No frontmatter at all: one is created and the body kept.
  const bare = stampMovedFrom("Just text.\n", "-src");
  assert(bare.startsWith("---\nmetadata:\n  movedFrom: -src\n---\n"), bare);
  assertIncludes(bare, "Just text.");

  // A second move records the latest source only.
  const twice = stampMovedFrom(stampMovedFrom(MEMORY_FIXTURE, "-a"), "-b");
  assertIncludes(twice, "movedFrom: -b");
  assert(!twice.includes("movedFrom: -a"), twice);
});

Deno.test("integrating into AGENTS.md makes an existing CLAUDE.md import it", async () => {
  await withTempHome(async (home) => {
    const repo = `${home}/dev/repo`;
    await Deno.mkdir(`${repo}/.git`, { recursive: true });
    await Deno.writeTextFile(`${repo}/CLAUDE.md`, "# Claude notes\n");

    const result = await writeIntegration(repo, `${repo}/AGENTS.md`, "rules\n");
    assertEquals(result.writtenPaths, [
      `${repo}/AGENTS.md`,
      `${repo}/CLAUDE.md`,
    ]);
    assertEquals(
      await Deno.readTextFile(`${repo}/CLAUDE.md`),
      "# Claude notes\n\n@AGENTS.md\n",
    );

    // Already imported: nothing more to add.
    const again = await writeIntegration(repo, `${repo}/AGENTS.md`, "more\n");
    assertEquals(again.writtenPaths, [`${repo}/AGENTS.md`]);
  });
});

Deno.test("no CLAUDE.md, or another target, means no import is added", async () => {
  await withTempHome(async (home) => {
    const repo = `${home}/dev/repo`;
    await Deno.mkdir(`${repo}/.git`, { recursive: true });

    // Without a CLAUDE.md, Claude Code reads AGENTS.md directly.
    assertEquals(
      (await writeIntegration(repo, `${repo}/AGENTS.md`, "x\n")).writtenPaths,
      [`${repo}/AGENTS.md`],
    );

    await Deno.mkdir(`${repo}/.claude`);
    await Deno.writeTextFile(`${repo}/.claude/CLAUDE.md`, "notes\n");
    assertEquals(
      (await writeIntegration(repo, `${repo}/docs/x.md`, "x\n")).writtenPaths,
      [`${repo}/docs/x.md`],
    );
    // A CLAUDE.md under .claude/ imports with a path relative to itself.
    await writeIntegration(repo, `${repo}/AGENTS.md`, "y\n");
    assertIncludes(
      await Deno.readTextFile(`${repo}/.claude/CLAUDE.md`),
      "@../AGENTS.md",
    );
  });
});
