import { type MigratableMemory, writeMovedMemory } from "./migrate.ts";
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
  const domain = domainForProjectDir(dir);
  const memoryDir = `${home}/.claude/projects/${domain}/memory`;
  await Deno.mkdir(memoryDir, { recursive: true });
  const path = `${memoryDir}/thing.md`;
  await Deno.writeTextFile(path, MEMORY_FIXTURE);
  const memory: MigratableMemory = {
    path,
    filename: "thing.md",
    name: "thing",
    description: "a thing",
  };
  return { dir, domain, memoryDir, memory };
}

Deno.test("moving to a named directory lands in that project's store", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });

    const result = await writeMovedMemory(src.memory, src.domain, {
      kind: "dir",
      dir: "~/dev/proj-b",
    });

    const destDomain = domainForProjectDir(`${home}/dev/proj-b`);
    assertEquals(result.destDomain, destDomain);
    assertEquals(
      result.writtenPath,
      `${home}/.claude/projects/${destDomain}/memory/thing.md`,
    );

    const moved = await Deno.readTextFile(result.writtenPath);
    // Traceability for reversibility, and the body must survive untouched.
    assertIncludes(moved, `  movedFrom: ${src.domain}`);
    assertIncludes(moved, "Body text.");
    // Removing the original is the caller's step, not a hidden side effect.
    assert(await exists(src.memory.path), "source should still be present");
  });
});

Deno.test("moving to an already-scanned domain id uses it verbatim", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    const destDir = `${home}/dev/proj-b`;
    await Deno.mkdir(destDir, { recursive: true });
    const destDomain = domainForProjectDir(destDir);
    await Deno.mkdir(`${home}/.claude/projects/${destDomain}`, {
      recursive: true,
    });

    const result = await writeMovedMemory(src.memory, src.domain, {
      kind: "domain",
      domain: destDomain,
    });
    assertEquals(result.destDomain, destDomain);
    assert(await exists(result.writtenPath));
  });
});

Deno.test("a filename collision is refused rather than overwritten", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    await Deno.mkdir(`${home}/dev/proj-b`, { recursive: true });
    const dest = { kind: "dir", dir: "~/dev/proj-b" } as const;

    const first = await writeMovedMemory(src.memory, src.domain, dest);
    await Deno.writeTextFile(first.writtenPath, "PRE-EXISTING");

    assertIncludes(
      await rejects(() => writeMovedMemory(src.memory, src.domain, dest)),
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
        writeMovedMemory(src.memory, src.domain, {
          kind: "dir",
          dir: "~/dev/proj-a",
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
        writeMovedMemory({ ...src.memory, filename: "MEMORY.md" }, src.domain, {
          kind: "dir",
          dir: "~/dev/proj-b",
        })
      ),
      "Refusing to move the index file",
    );
  });
});

Deno.test("a bogus destination domain is refused", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);
    assertIncludes(
      await rejects(() =>
        writeMovedMemory(src.memory, src.domain, {
          kind: "domain",
          domain: "-no-such-project",
        })
      ),
      "No such project domain",
    );
    for (const domain of ["../../../etc", "a/b", ""]) {
      assertIncludes(
        await rejects(() =>
          writeMovedMemory(src.memory, src.domain, { kind: "domain", domain })
        ),
        "Invalid destination domain",
      );
    }
  });
});

Deno.test("a nonexistent destination changes nothing at all", async () => {
  await withTempHome(async (home) => {
    const src = await seed(home);

    assertIncludes(
      await rejects(() =>
        writeMovedMemory(src.memory, src.domain, {
          kind: "dir",
          dir: "~/dev/does-not-exist",
        })
      ),
      "No such directory",
    );

    // Validation runs before the first mkdir/write, so nothing is half-done:
    // in particular a typo must not mint a domain nobody will look at again.
    assertEquals(await Deno.readTextFile(src.memory.path), MEMORY_FIXTURE);
    assert(
      !await exists(`${home}/dev/does-not-exist`),
      "must not create the target directory",
    );
    assert(
      !await exists(`${src.memoryDir}/MEMORY.md`),
      "must not touch the source index",
    );
    const domains: string[] = [];
    for await (const e of Deno.readDir(`${home}/.claude/projects`)) {
      domains.push(e.name);
    }
    assertEquals(domains, [src.domain]);
  });
});
