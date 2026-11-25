import { addToIndex, indexLine, removeFromIndex } from "./memory_index.ts";
import { assertEquals, withTempHome } from "./test_helpers.ts";

Deno.test("removing matches the exact link target and returns the lines", async () => {
  await withTempHome(async (home) => {
    const index = `${home}/MEMORY.md`;
    await Deno.writeTextFile(
      index,
      [
        "- [a](a.md) — first",
        "- [old a](old-a.md) — not the same file",
        "Prose mentioning a.md stays.",
        "",
      ].join("\n"),
    );

    assertEquals(await removeFromIndex(`${home}/a.md`), [
      "- [a](a.md) — first",
    ]);
    assertEquals(
      await Deno.readTextFile(index),
      "- [old a](old-a.md) — not the same file\nProse mentioning a.md stays.\n",
    );
    // Nothing to remove, or no index at all, is not an error.
    assertEquals(await removeFromIndex(`${home}/a.md`), []);
    assertEquals(await removeFromIndex(`${home}/none/x.md`), []);
  });
});

Deno.test("adding appends, creating the index when missing", async () => {
  await withTempHome(async (home) => {
    await addToIndex(`${home}/a.md`, [indexLine("a", "a.md", "first")]);
    await addToIndex(`${home}/b.md`, ["- [b](b.md) — second"]);
    assertEquals(
      await Deno.readTextFile(`${home}/MEMORY.md`),
      "- [a](a.md) — first\n- [b](b.md) — second\n",
    );
  });
});
