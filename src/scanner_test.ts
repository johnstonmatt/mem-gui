import { scanDomains } from "./scanner.ts";
import { assert, assertEquals, withTempHome } from "./test_helpers.ts";

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
