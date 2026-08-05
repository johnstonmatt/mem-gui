import { readSettings, settingsPath, writeSettings } from "./settings.ts";
import { domainForProjectDir, resolveProjectDir } from "./paths.ts";
import {
  assert,
  assertEquals,
  assertIncludes,
  exists,
  rejects,
  withTempHome,
} from "./test_helpers.ts";

Deno.test("defaults apply until something is saved", async () => {
  await withTempHome(async () => {
    assertEquals((await readSettings()).defaultHoistDir, "~");
    assert(!await exists(settingsPath()), "no file should exist yet");
  });
});

Deno.test("the shipped default resolves on a fresh machine", async () => {
  await withTempHome(async (home) => {
    // A default that doesn't resolve would break hoist for every new install.
    const resolved = await resolveProjectDir(
      (await readSettings()).defaultHoistDir,
    );
    assertEquals(resolved, home);
    assertEquals(domainForProjectDir(resolved), home.replace(/\//g, "-"));
  });
});

Deno.test("saving round-trips and keeps ~ as typed", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.claude`, { recursive: true });
    await Deno.mkdir(`${home}/dev/proj`, { recursive: true });

    const saved = await writeSettings({ defaultHoistDir: "~/dev/proj" });
    assertEquals(saved.defaultHoistDir, "~/dev/proj");
    assertEquals((await readSettings()).defaultHoistDir, "~/dev/proj");
    // Stored as typed, not pre-expanded, so the file stays readable.
    assertIncludes(await Deno.readTextFile(settingsPath()), '"~/dev/proj"');
  });
});

Deno.test("a nonexistent directory is refused at save time", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.claude`, { recursive: true });
    await Deno.mkdir(`${home}/dev/proj`, { recursive: true });
    await writeSettings({ defaultHoistDir: "~/dev/proj" });

    assertIncludes(
      await rejects(() => writeSettings({ defaultHoistDir: "~/dev/ghost" })),
      "No such directory",
    );
    // The previous value has to survive a refused save.
    assertEquals((await readSettings()).defaultHoistDir, "~/dev/proj");
  });
});

Deno.test("a refused first save leaves no file behind", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.claude`, { recursive: true });
    await rejects(() => writeSettings({ defaultHoistDir: "~/nope" }));
    assert(!await exists(settingsPath()), "should not have written a file");
  });
});

Deno.test("a missing or malformed file falls back to defaults", async () => {
  await withTempHome(async (home) => {
    await Deno.mkdir(`${home}/.claude`, { recursive: true });

    for (
      const contents of ["{ not json", "", "[]", '{"defaultHoistDir": ""}']
    ) {
      await Deno.writeTextFile(settingsPath(), contents);
      assertEquals(
        (await readSettings()).defaultHoistDir,
        "~",
        `contents: ${JSON.stringify(contents)}`,
      );
    }
  });
});
