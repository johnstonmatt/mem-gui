import { scanDomains } from "./scanner.ts";
import { hoistMemory } from "./hoist.ts";
import { domainForProjectDir } from "./paths.ts";
import {
  assert,
  assertEquals,
  MEMORY_FIXTURE,
  withTempHome,
} from "./test_helpers.ts";

async function store(home: string, dir: string): Promise<string> {
  const path = `${home}/.claude/projects/${domainForProjectDir(dir)}`;
  await Deno.mkdir(`${path}/memory`, { recursive: true });
  await Deno.writeTextFile(`${path}/memory/thing.md`, MEMORY_FIXTURE);
  return path;
}

Deno.test("a machine that has never run Claude Code scans to nothing", async () => {
  await withTempHome(async () => {
    // No ~/.claude at all. This is the one case that legitimately yields an
    // empty treemap, and it must stay quiet rather than throwing at people.
    assertEquals(await scanDomains(), [], "a missing store is not an error");
  });
});

Deno.test("a store it cannot read is an error, not an empty store", async () => {
  // The distinction this pins: the v0.1.1 release build was denied read access
  // to the real $HOME (its grants were baked against the CI runner's home), and
  // the old `catch { return [] }` reported that as zero domains. The window
  // opened, looked fine, and showed nothing — with no way to tell a permission
  // fault from an empty store.
  //
  // A test can't produce Deno's own NotCapable here, since `deno test` runs
  // with read access already granted. An OS-level EACCES takes the identical
  // path through scanDomains: only NotFound returns empty, everything else
  // propagates.
  await withTempHome(async (home) => {
    const claude = `${home}/.claude`;
    await Deno.mkdir(`${claude}/projects`, { recursive: true });

    // Drop exec on the parent so stat() of projects/ fails with EACCES.
    const original = (await Deno.stat(claude)).mode ?? 0o700;
    await Deno.chmod(claude, 0o000);

    // Root ignores mode bits, and this test would silently invert there.
    let denied = false;
    try {
      await Deno.stat(`${claude}/projects`);
    } catch {
      denied = true;
    }

    let thrown: Error | undefined;
    if (denied) {
      try {
        await scanDomains();
      } catch (error) {
        thrown = error as Error;
      }
    }

    // Restore before asserting, or withTempHome can't clean up after a failure.
    await Deno.chmod(claude, original & 0o777);

    if (denied) {
      assert(
        thrown !== undefined,
        "an unreadable store must throw rather than scan to zero domains",
      );
      assert(
        !(thrown instanceof Deno.errors.NotFound),
        `expected a permission fault, got NotFound: ${thrown?.message}`,
      );
    }
  });
});

Deno.test("a transcript from a subdirectory labels the repo root", async () => {
  await withTempHome(async (home) => {
    const repo = `${home}/dev/my-repo`;
    await Deno.mkdir(`${repo}/.git`, { recursive: true });
    await Deno.mkdir(`${repo}/pkg`, { recursive: true });
    const path = await store(home, repo);
    await Deno.writeTextFile(
      `${path}/s.jsonl`,
      `${JSON.stringify({ cwd: `${repo}/pkg` })}\n`,
    );

    const [domain] = await scanDomains();
    assertEquals(domain.dir, repo);
    assertEquals(domain.domainLabel, "~/dev/my-repo");
    assertEquals(domain.scope, "repo");
    assertEquals(domain.homeLabel, "");
  });
});

Deno.test("with no transcript left, the label comes from the filesystem", async () => {
  await withTempHome(async (home) => {
    // The lossy reverse mapping would read this as ".../edge/functions".
    const dir = `${home}/dev/edge-functions`;
    await Deno.mkdir(dir, { recursive: true });
    await store(home, dir);

    const [domain] = await scanDomains();
    assertEquals(domain.dir, dir);
    assertEquals(domain.domainLabel, "~/dev/edge-functions");
    assertEquals(domain.scope, "dir");
  });
});

Deno.test("older memories with a top-level type keep their type", async () => {
  await withTempHome(async (home) => {
    const dir = `${home}/dev/p`;
    await Deno.mkdir(dir, { recursive: true });
    const path = await store(home, dir);
    await Deno.writeTextFile(
      `${path}/memory/thing.md`,
      "---\nname: old\ntype: feedback\n---\n\nBody.\n",
    );

    const [domain] = await scanDomains();
    assertEquals(domain.files[0].type, "feedback");
  });
});

Deno.test("a store whose folder is gone is flagged as missing", async () => {
  await withTempHome(async (home) => {
    await store(home, `${home}/dev/deleted-project`);
    const [domain] = await scanDomains();
    assertEquals(domain.scope, "orphaned");
  });
});

Deno.test("a shared memory directory loads everywhere and idles the rest", async () => {
  await withTempHome(async (home) => {
    const dir = `${home}/dev/p`;
    await Deno.mkdir(dir, { recursive: true });
    await store(home, dir);
    await Deno.mkdir(`${home}/shared`, { recursive: true });
    await Deno.writeTextFile(`${home}/shared/note.md`, MEMORY_FIXTURE);
    await Deno.writeTextFile(
      `${home}/.claude/settings.json`,
      '{"autoMemoryDirectory": "~/shared"}',
    );

    const scopes = Object.fromEntries(
      (await scanDomains()).map((d) => [d.domainLabel, d.scope]),
    );
    assertEquals(scopes, { "~/shared": "everywhere", "~/dev/p": "overridden" });
  });
});

Deno.test("stores in another agent home are labelled with it", async () => {
  await withTempHome(async (home) => {
    const dir = `${home}/dev/p`;
    await Deno.mkdir(dir, { recursive: true });
    const other = `${home}/.claude-work/projects/${domainForProjectDir(dir)}`;
    await Deno.mkdir(`${other}/memory`, { recursive: true });
    await Deno.writeTextFile(`${other}/memory/thing.md`, MEMORY_FIXTURE);
    Deno.env.set("CLAUDE_CONFIG_DIR", `${home}/.claude-work`);

    const [domain] = await scanDomains();
    assertEquals(domain.id, `${other}/memory`);
    assertEquals(domain.homeLabel, "~/.claude-work");
    assertEquals(domain.files[0].storeId, domain.id);
  });
});

Deno.test("hoisted instructions appear as one shared group", async () => {
  await withTempHome(async (home) => {
    const dir = `${home}/dev/p`;
    await Deno.mkdir(dir, { recursive: true });
    const path = await store(home, dir);
    await hoistMemory({
      path: `${path}/memory/thing.md`,
      filename: "thing.md",
      name: "thing",
      description: "",
    });
    await Deno.mkdir(`${home}/.codex`);

    const [shared] = await scanDomains();
    assertEquals(shared.scope, "shared");
    assertEquals(shared.domainLabel, "~");
    assertEquals(shared.files.map((f) => [f.section, f.name]), [
      ["thing.md", "thing"],
    ]);
    assertEquals(shared.files[0].content, "## thing\n\nBody text.");
    // ~/.codex appeared after the hoist, so it isn't reading it yet.
    assertEquals(shared.wiring?.pending, ["~/.codex/AGENTS.md"]);
  });
});

Deno.test("a store for the home folder itself isn't labelled plain ~", async () => {
  await withTempHome(async (home) => {
    await store(home, home);
    const [domain] = await scanDomains();
    assertEquals(domain.domainLabel, "~ · sessions started here");
    assertEquals(domain.dir, home);
  });
});
