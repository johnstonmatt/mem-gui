# Mem GUI

**A desktop treemap for the memories Claude Code keeps about you.**

Claude Code quietly accumulates memory files across every project you work in —
tucked away under `~/.claude/projects/*/memory/` as little Markdown notes with
frontmatter. Over time you build up dozens of them, and there's no good way to
see what's in there, what's gone stale, or what's silently eating your context
budget. Mem GUI gives that hidden store a window.

![Mem GUI — a treemap of Claude Code memories with an inspect panel open](docs/screenshot.png)

Every memory is a tile. **Area is token cost** — the bigger the box, the more of
your context window it spends. **Color is recency** — warm tiles were touched
recently. Click any tile to read it, then keep,
relocate, or delete it.

---

## Why

Memories are cheap to create and easy to forget. They're scattered one directory
per project, named after escaped filesystem paths, and invisible until they show
up in a prompt. The questions you can't answer at a glance are exactly the ones
that matter:

- **Which memories are costing me the most tokens?** → the largest tiles.
- **What have I not looked at in months?** → the coolest, bluest tiles.
- **Is this note really project-specific, or should it apply everywhere?** →
  open it and *hoist* it up to your `~/dev` root.
- **Should this live in the repo's docs instead of a private memory?** → let
  Claude *integrate* it into the right file.

## Features

- **Squarified treemap** grouped by project domain, sized by estimated token
  cost and colored on a recency gradient (red = fresh, blue = old).
- **Drill down** — click a domain to zoom into just its memories, breadcrumb
  back out.
- **Inspect panel** — full file contents, type badge, token/char counts, and
  last-modified time for any memory.
- **Reveal in Finder / Open** — jump straight to the file on disk.
- **Integrate into repo** — a read-only `claude` sub-process proposes the single
  best doc in the memory's own project to fold the note into (README, a doc
  under `docs/`, etc.). Nothing is written until you review the proposal and
  confirm; the write lands in one Markdown file, reversible via the repo's git
  history.
- **Hoist to `~/dev`** — deterministically relocate a memory as-is into your
  `~/dev` root store, so it applies across every project instead of one. No LLM,
  no arbitrary write target; refuses on a filename collision rather than
  overwriting.
- **Delete** — with confirmation, and the dangling entry is stripped from that
  domain's `MEMORY.md` index automatically.

## How it works

Mem GUI is a [Deno desktop](https://docs.deno.com/) app: a native webview window
whose page talks to a small Deno backend over typed bindings — no browser tab, no
separate server to manage.

- `src/scanner.ts` walks `~/.claude/projects/*/memory/`, parses each memory's
  frontmatter, estimates its token cost, and resolves each project's cryptic
  escaped-path domain name back to a real path by reading the `cwd` out of one
  of its session transcripts.
- `src/migrate.ts` implements the two relocation flows — the LLM-assisted
  *integrate* (structurally read-only: tools locked to `Read`/`Glob`/`Grep`, MCP
  disabled, so the proposal step *cannot* write) and the deterministic *hoist*.
- `public/treemap.js` renders the squarified layout and the inspect panel.
- `main.ts` wires the bindings up and guards every filesystem action behind a
  check that the path lives inside the managed memory store.

Every write is scoped, reviewable, and reversible — nothing is mutated as a
silent side effect of something else.

## Getting started

**Prerequisites:** [Deno](https://deno.com/) 2.8+ (this uses the experimental
`deno desktop` runtime) and, optionally, the `claude` CLI on your `PATH` for the
*Integrate into repo* feature.

```bash
git clone https://github.com/johnstonmatt/mem-gui.git
cd mem-gui
deno task dev
```

The window opens on your memory store automatically. Hit **⟳** any time to
rescan.

### Build a standalone macOS app

```bash
deno task build:mac
# → dist/MemGui.app
```

## Permissions

The app runs with a deliberately narrow permission set (see `deno.json`):

| Scope | Grant | Why |
| --- | --- | --- |
| Read / write | `~/.claude/projects`, `~/dev` | scan and manage the memory store |
| Run | `open`, `claude` | reveal/open files, and the read-only integrate proposal |
| Net | `127.0.0.1` | serve the local page to the webview |

Nothing outside `~/.claude/projects/*/memory/` is ever touched — path guards in
`main.ts` and `src/migrate.ts` enforce it at the boundary.

## Project layout

```
main.ts              # bindings + local asset server + path guards
src/
  scanner.ts         # walk the memory store, parse frontmatter, resolve domains
  migrate.ts         # integrate (LLM-assisted) and hoist (deterministic) flows
  types.ts           # Domain / MemoryFile shapes
public/
  index.html         # window shell
  styles.css         # dark treemap theme
  treemap.js         # squarified layout + inspect panel
deno.json            # tasks, desktop config, permission scopes
```

## License

MIT
