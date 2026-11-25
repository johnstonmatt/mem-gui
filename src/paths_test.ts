import {
  domainForProjectDir,
  expandHome,
  findRepoRoot,
  isRepoRoot,
  realPathForDomain,
  resolveProjectDir,
  storeForDir,
} from "./paths.ts";
import {
  assert,
  assertEquals,
  assertIncludes,
  rejects,
  withTempHome,
} from "./test_helpers.ts";

Deno.test("expandHome expands only a leading ~", async () => {
  await withTempHome(async (home) => {
    assertEquals(expandHome("~"), home);
    assertEquals(expandHome("~/dev"), `${home}/dev`);
    assertEquals(expandHome("/a/b"), "/a/b");
    // "~foo" is a real (if odd) relative name, not a home reference.
    assertEquals(expandHome("~foo"), "~foo");
    assertEquals(expandHome("/a/~/b"), "/a/~/b");
    await Promise.resolve();
  });
});

Deno.test("domainForProjectDir matches Claude Code's escaping", () => {
  assertEquals(domainForProjectDir("/Users/m/dev"), "-Users-m-dev");
  assertEquals(domainForProjectDir("/Users/m"), "-Users-m");
});

Deno.test("resolveProjectDir normalizes to an exact directory", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/dev/a/b`, { recursive: true });

    for (
      const input of [
        `${home}/dev/a/b`,
        `${home}/dev/a/b/`,
        `${home}/dev/a/b///`,
        `${home}//dev//a//b`,
        `${home}/dev/./a/./b`,
        `${home}/dev/a/b/../b`,
        `${home}/dev/a/b/../../a/b`,
        "~/dev/a/b",
        "~/dev/a/b/",
        "  ~/dev/a/b  ",
      ]
    ) {
      assertEquals(await resolveProjectDir(input), `${home}/dev/a/b`, input);
    }

    // Above an absolute root there is nowhere to go.
    assertEquals(await resolveProjectDir("/"), "/");
    assertEquals(await resolveProjectDir("/../.."), "/");
    assertEquals(await resolveProjectDir("/tmp/.."), "/");
  });
});

Deno.test("resolveProjectDir rejects anything that isn't a real directory", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/dev`, { recursive: true });
    await Deno.writeTextFile(`${home}/dev/a-file`, "x");

    assertIncludes(
      await rejects(() => resolveProjectDir("dev/foo")),
      "Not an absolute path",
    );
    assertIncludes(
      await rejects(() => resolveProjectDir("")),
      "No directory given",
    );
    assertIncludes(
      await rejects(() => resolveProjectDir("~/dev/nope")),
      "No such directory",
    );
    assertIncludes(
      await rejects(() => resolveProjectDir("~/dev/a-file")),
      "Not a directory",
    );
  });
});

Deno.test("a trailing slash cannot corrupt the domain id", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/dev/a`, { recursive: true });
    const id = domainForProjectDir(await resolveProjectDir(`${home}/dev/a/`));
    assertEquals(id, domainForProjectDir(`${home}/dev/a`));
    assert(!id.endsWith("-"), id);
  });
});

Deno.test("domainForProjectDir escapes every non-alphanumeric character", () => {
  // Observed in real stores: "/Users/m/.lockin" lives at "-Users-m--lockin".
  assertEquals(domainForProjectDir("/Users/m/.lockin"), "-Users-m--lockin");
  assertEquals(domainForProjectDir("/a/b_c/d.e f"), "-a-b-c-d-e-f");
});

Deno.test("findRepoRoot walks up to the enclosing working tree", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/repo/.git`, { recursive: true });
    await Deno.mkdir(`${home}/repo/src/deep`, { recursive: true });
    await Deno.mkdir(`${home}/plain`, { recursive: true });

    assertEquals(await findRepoRoot(`${home}/repo`), `${home}/repo`);
    assertEquals(await findRepoRoot(`${home}/repo/src/deep`), `${home}/repo`);
    assertEquals(await findRepoRoot(`${home}/plain`), null);
  });
});

Deno.test("a linked worktree resolves to its main working tree", async () => {
  await withTempHome(async (home) => {
    // The layout `git worktree add` produces.
    const gitdir = `${home}/repo/.git/worktrees/feature`;
    await Deno.mkdir(gitdir, { recursive: true });
    await Deno.writeTextFile(`${gitdir}/commondir`, "../..\n");
    await Deno.mkdir(`${home}/wt/feature/src`, { recursive: true });
    await Deno.writeTextFile(`${home}/wt/feature/.git`, `gitdir: ${gitdir}\n`);

    assertEquals(await findRepoRoot(`${home}/wt/feature/src`), `${home}/repo`);
    const store = await storeForDir(`${home}/wt/feature`);
    assertEquals(store.root, `${home}/repo`);
    assertEquals(store.domain, domainForProjectDir(`${home}/repo`));
    assert(store.isRepo);
  });
});

Deno.test("a .git file without a commondir is its own root", async () => {
  await withTempHome(async (home) => {
    // A submodule checkout points at .git/modules/<name>, which has no commondir.
    await Deno.mkdir(`${home}/super/.git/modules/sub`, { recursive: true });
    await Deno.mkdir(`${home}/super/sub`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/super/sub/.git`,
      "gitdir: ../.git/modules/sub\n",
    );
    assertEquals(await findRepoRoot(`${home}/super/sub`), `${home}/super/sub`);
  });
});

Deno.test("realPathForDomain recovers dashes the reverse mapping loses", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/dev/edge-functions/libs`, { recursive: true });
    await Deno.mkdir(`${home}/.lockin`, { recursive: true });

    for (const dir of [`${home}/dev/edge-functions/libs`, `${home}/.lockin`]) {
      assertEquals(await realPathForDomain(domainForProjectDir(dir)), dir);
    }
    assertEquals(
      await realPathForDomain(domainForProjectDir(`${home}/gone`)),
      null,
    );
  });
});

Deno.test("the repo search never reads above $HOME", async () => {
  await withTempHome(async (outer) => {
    // A repo around the home folder must not be found from inside it.
    await Deno.mkdir(`${outer}/.git`);
    const home = `${outer}/home`;
    await Deno.mkdir(`${home}/dev/x`, { recursive: true });
    Deno.env.set("HOME", home);

    assertEquals(await findRepoRoot(`${home}/dev/x`), null);
    // A repo at $HOME itself (e.g. dotfiles) still counts.
    await Deno.mkdir(`${home}/.git`);
    assertEquals(await findRepoRoot(`${home}/dev/x`), home);
  });
});

Deno.test("isRepoRoot looks only at the folder itself", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/repo/.git`, { recursive: true });
    await Deno.mkdir(`${home}/repo/sub`, { recursive: true });
    const gitdir = `${home}/repo/.git/worktrees/wt`;
    await Deno.mkdir(gitdir, { recursive: true });
    await Deno.writeTextFile(`${gitdir}/commondir`, "../..\n");
    await Deno.mkdir(`${home}/wt`);
    await Deno.writeTextFile(`${home}/wt/.git`, `gitdir: ${gitdir}\n`);

    assert(await isRepoRoot(`${home}/repo`));
    assert(!await isRepoRoot(`${home}/repo/sub`));
    // A linked worktree's store is its main tree's, so it isn't a root itself.
    assert(!await isRepoRoot(`${home}/wt`));
  });
});
