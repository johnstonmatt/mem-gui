import {
  hoistMemory,
  parseShared,
  planHoist,
  planWiring,
  removeSharedInstruction,
  repairWiring,
  undoHoist,
} from "./hoist.ts";
import type { MigratableMemory } from "./migrate.ts";
import {
  assert,
  assertEquals,
  assertIncludes,
  exists,
  MEMORY_FIXTURE,
  rejects,
  withTempHome,
} from "./test_helpers.ts";

async function seed(
  home: string,
  filename = "thing.md",
  body = MEMORY_FIXTURE,
) {
  const memoryDir = `${home}/.claude/projects/-proj/memory`;
  await Deno.mkdir(memoryDir, { recursive: true });
  const path = `${memoryDir}/${filename}`;
  await Deno.writeTextFile(path, body);
  const memory: MigratableMemory = {
    path,
    filename,
    name: filename.replace(/\.md$/, ""),
    description: "",
  };
  return memory;
}

const read = (path: string) => Deno.readTextFile(path);
const shared = (home: string) => `${home}/.agents/AGENTS.md`;

Deno.test("hoisting moves the memory into the one shared file", async () => {
  await withTempHome(async (home) => {
    const memory = await seed(home);
    const index = memory.path.replace("thing.md", "MEMORY.md");
    await Deno.writeTextFile(
      index,
      "- [thing](thing.md) — a thing\n- [keep](keep.md) — stays\n",
    );
    await hoistMemory(memory);

    const text = await read(shared(home));
    assertEquals(parseShared(text).sections, [
      { id: "thing.md", name: "thing", text: "## thing\n\nBody text." },
    ]);
    // Frontmatter is memory bookkeeping, not instruction text.
    assert(!text.includes("metadata:"), text);
    assert(!await exists(memory.path), "the memory leaves its store");
    assertEquals(await read(index), "- [keep](keep.md) — stays\n");
  });
});

Deno.test("undo puts the memory back exactly and takes it out of ~", async () => {
  await withTempHome(async (home) => {
    await hoistMemory(await seed(home, "keep.md"));
    const memory = await seed(home);
    const index = memory.path.replace("thing.md", "MEMORY.md");
    await Deno.writeTextFile(index, "- [thing](thing.md) — a thing\n");

    const { undo } = await hoistMemory(memory);
    await undoHoist(undo);

    assertEquals(await read(memory.path), MEMORY_FIXTURE);
    assertEquals(await read(index), "- [thing](thing.md) — a thing\n");
    assertEquals(
      parseShared(await read(shared(home))).sections.map((s) => s.id),
      ["keep.md"],
    );
  });
});

Deno.test("undo never overwrites a memory that came back meanwhile", async () => {
  await withTempHome(async (home) => {
    const memory = await seed(home);
    const { undo } = await hoistMemory(memory);
    await Deno.writeTextFile(memory.path, "new\n");

    assertIncludes(await rejects(() => undoHoist(undo)), "exists again");
    assertEquals(await read(memory.path), "new\n");
  });
});

Deno.test("undo still restores a memory already deleted from ~", async () => {
  await withTempHome(async (home) => {
    const memory = await seed(home);
    const { undo } = await hoistMemory(memory);
    await removeSharedInstruction("thing.md");

    await undoHoist(undo);
    assertEquals(await read(memory.path), MEMORY_FIXTURE);
  });
});

Deno.test("Claude Code imports the shared file, keeping what's there", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.claude`, { recursive: true });
    await Deno.writeTextFile(`${home}/.claude/CLAUDE.md`, "# Mine\n");
    await hoistMemory(await seed(home));
    assertEquals(
      await read(`${home}/.claude/CLAUDE.md`),
      "# Mine\n\n@~/.agents/AGENTS.md\n",
    );

    // A second hoist finds the import already there.
    await hoistMemory(await seed(home, "other.md"));
    assertEquals(
      await read(`${home}/.claude/CLAUDE.md`),
      "# Mine\n\n@~/.agents/AGENTS.md\n",
    );
  });
});

Deno.test("Codex's AGENTS.md becomes a link to the shared file", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.codex`);
    // An empty file holds nothing worth keeping.
    await Deno.writeTextFile(`${home}/.codex/AGENTS.md`, "");
    await hoistMemory(await seed(home));

    assertEquals(await Deno.readLink(`${home}/.codex/AGENTS.md`), shared(home));
    assertIncludes(await read(`${home}/.codex/AGENTS.md`), "Body text.");
  });
});

Deno.test("Codex's own instructions move into the shared file once", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.codex`);
    await Deno.writeTextFile(`${home}/.codex/AGENTS.md`, "Use pnpm.\n");
    const plan = await planHoist(await seed(home));
    assertEquals(plan.steps.map((s) => s.action), [
      "create",
      "import",
      "merge",
    ]);

    await hoistMemory(await seed(home));
    const text = await read(shared(home));
    assert(
      text.startsWith("Use pnpm.\n\n<!-- mem-gui:begin thing.md -->"),
      text,
    );
    assertEquals(parseShared(text).rest, "Use pnpm.");
  });
});

Deno.test("a folder that can't be pointed at the shared file stops everything", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.codex`);
    await Deno.writeTextFile(`${home}/elsewhere.md`, "theirs\n");
    await Deno.symlink(`${home}/elsewhere.md`, `${home}/.codex/AGENTS.md`);
    const memory = await seed(home);

    assertIncludes(await rejects(() => hoistMemory(memory)), "links to");
    assert(!await exists(shared(home)));
    assert(!await exists(`${home}/.claude/CLAUDE.md`));
  });
});

Deno.test("a link an editor replaced with a copy is reported, not merged", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.codex`);
    await hoistMemory(await seed(home));
    // Simulate a save-by-rename editor breaking the link into a copy.
    const copy = await read(shared(home));
    await Deno.remove(`${home}/.codex/AGENTS.md`);
    await Deno.writeTextFile(`${home}/.codex/AGENTS.md`, copy);

    const wiring = await planWiring();
    assertEquals(wiring.steps, []);
    assertIncludes(wiring.blocked.join(), "separate copy");
  });
});

Deno.test("an active AGENTS.override.md is warned about", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.codex`);
    await Deno.writeTextFile(`${home}/.codex/AGENTS.override.md`, "temp\n");
    const plan = await planHoist(await seed(home));
    assertIncludes(plan.warnings.join(), "AGENTS.override.md");
    assertEquals(plan.blocked, []);
  });
});

Deno.test("every Ori profile folder is pointed at the shared file", async () => {
  await withTempHome(async (home) => {
    for (const dir of [".codex", ".claude-work", ".codex-work", ".ori"]) {
      await Deno.mkdir(`${home}/${dir}`, { recursive: true });
    }
    await Deno.writeTextFile(
      `${home}/.ori/profiles.json`,
      '{"profiles": {"work": {"sessions": {"kind": "template", "template": "~/.{harness}-{profile}"}}}}',
    );

    const plan = await planHoist(await seed(home));
    assertEquals(plan.steps.map((s) => [s.action, s.display]), [
      ["create", "~/.agents/AGENTS.md"],
      ["import", "~/.claude/CLAUDE.md"],
      ["import", "~/.claude-work/CLAUDE.md"],
      ["link", "~/.codex/AGENTS.md"],
      ["link", "~/.codex-work/AGENTS.md"],
    ]);
  });
});

Deno.test("a folder added later is linked by a repair", async () => {
  await withTempHome(async (home) => {
    await hoistMemory(await seed(home));
    await Deno.mkdir(`${home}/.codex`);
    assertEquals((await planWiring()).steps.map((s) => s.action), ["link"]);

    await repairWiring();
    assertEquals((await planWiring()).steps, []);
    assertIncludes(await read(`${home}/.codex/AGENTS.md`), "Body text.");
  });
});

Deno.test("deleting an instruction removes only that section", async () => {
  await withTempHome(async (home) => {
    await hoistMemory(await seed(home, "one.md"));
    await hoistMemory(await seed(home, "two.md"));

    await removeSharedInstruction("one.md");
    assertEquals(
      parseShared(await read(shared(home))).sections.map((s) => s.id),
      ["two.md"],
    );
    assertIncludes(
      await rejects(() => removeSharedInstruction("one.md")),
      "No hoisted instruction",
    );
  });
});

Deno.test("hoisting the same filename twice is refused", async () => {
  await withTempHome(async (home) => {
    await hoistMemory(await seed(home));
    assertIncludes(
      await rejects(async () => hoistMemory(await seed(home))),
      "already in",
    );
  });
});

Deno.test("planning writes nothing", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.codex`);
    await planHoist(await seed(home));
    assert(!await exists(shared(home)));
    assert(!await exists(`${home}/.codex/AGENTS.md`));
    assert(!await exists(`${home}/.claude/CLAUDE.md`));
  });
});

Deno.test("bad requests are refused", async () => {
  await withTempHome(async (home) => {
    const memory = await seed(home);
    assertIncludes(
      await rejects(() => hoistMemory({ ...memory, filename: "MEMORY.md" })),
      "index file",
    );
    await Deno.writeTextFile(memory.path, "---\nname: thing\n---\n\n");
    assertIncludes(await rejects(() => hoistMemory(memory)), "no body");
  });
});

Deno.test("a shared file linked into a dotfiles repo stays linked", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/dotfiles/.agents`, { recursive: true });
    await Deno.writeTextFile(`${home}/dotfiles/.agents/AGENTS.md`, "");
    await Deno.mkdir(`${home}/.agents`);
    await Deno.symlink(`${home}/dotfiles/.agents/AGENTS.md`, shared(home));

    await hoistMemory(await seed(home));
    assertIncludes(
      await read(`${home}/dotfiles/.agents/AGENTS.md`),
      "Body text.",
    );
    assert((await Deno.lstat(shared(home))).isSymlink);
  });
});
