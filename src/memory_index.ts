/** Keeps each store's MEMORY.md index in step with its memory files. */

function indexPathFor(memoryPath: string): string {
  return `${memoryPath.slice(0, memoryPath.lastIndexOf("/"))}/MEMORY.md`;
}

export function indexLine(
  name: string,
  filename: string,
  description: string,
): string {
  return `- [${name}](${filename}) — ${description}`;
}

/**
 * Strips the index lines linking to a removed memory, matched by the exact
 * markdown link target (e.g. "](thing.md)") so prose that merely mentions the
 * filename survives. Returns the removed lines, so they can be put back.
 */
export async function removeFromIndex(memoryPath: string): Promise<string[]> {
  const filename = memoryPath.slice(memoryPath.lastIndexOf("/") + 1);
  if (filename === "MEMORY.md") return [];

  let content: string;
  try {
    content = await Deno.readTextFile(indexPathFor(memoryPath));
  } catch {
    return [];
  }

  const target = `](${filename})`;
  const lines = content.split("\n");
  const removed = lines.filter((line) => line.includes(target));
  if (removed.length) {
    await Deno.writeTextFile(
      indexPathFor(memoryPath),
      lines.filter((line) => !line.includes(target)).join("\n"),
    );
  }
  return removed;
}

/** Appends lines to the index of the store a memory lives in, creating it if needed. */
export async function addToIndex(
  memoryPath: string,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  let existing = "";
  try {
    existing = await Deno.readTextFile(indexPathFor(memoryPath));
  } catch {
    // no index yet — create one below
  }
  const trimmed = existing.replace(/\s+$/, "");
  const added = lines.join("\n");
  await Deno.writeTextFile(
    indexPathFor(memoryPath),
    trimmed ? `${trimmed}\n${added}\n` : `${added}\n`,
  );
}
