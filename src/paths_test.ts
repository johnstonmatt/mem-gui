import { domainForProjectDir, expandHome, resolveProjectDir } from "./paths.ts";
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
