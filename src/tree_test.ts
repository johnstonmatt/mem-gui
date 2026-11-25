import { buildTree as buildTreeJs } from "../public/tree.js";
import { assert, assertEquals } from "./test_helpers.ts";

const H = "/h/.claude";
const store = (dir: string, scope = "dir", extra = {}) => ({
  id: `${dir}#store`,
  home: H,
  homeLabel: "",
  dir,
  domainLabel: dir.replace(/^\/u/, "~"),
  scope,
  files: [{ tokens: 10 }],
  ...extra,
});

type Node = {
  label: string;
  invalid: boolean;
  total: number;
  children: Node[];
  files: unknown[];
};
// public/tree.js is plain JS, so its inferred types are too loose to use here.
const buildTree = (domains: unknown[]) =>
  buildTreeJs(domains as never) as unknown as {
    root: Node;
    nodes: Map<string, Node>;
  };

const shape = (n: Node): unknown => [
  n.label,
  n.invalid,
  n.children.map(shape),
];

Deno.test("~ is the root; stores nest under the nearest store around them", () => {
  const { root } = buildTree([
    { ...store("", "shared"), id: "shared", domainLabel: "~" },
    store("/u/dev"),
    store("/u/dev/supabase"),
    store("/u/dev/supabase/cli", "repo"),
    store("/u/dev/johnstonmatt/proser", "repo"),
    store("/u/.lockin"),
  ]);
  assertEquals(shape(root), [
    "~",
    false,
    [
      ["~/dev", true, [
        ["supabase", true, [["cli", false, []]]],
        ["johnstonmatt/proser", false, []],
      ]],
      ["~/.lockin", false, []],
    ],
  ]);
  // Root's own tiles are the shared instructions; totals add up the tree.
  assertEquals(root.files.length, 1);
  assertEquals(root.total, 60);
});

Deno.test("the home folder's own store is striped but contains nothing", () => {
  const { root } = buildTree([
    { ...store("/u"), domainLabel: "~ · sessions started here" },
    store("/u/dev/app", "repo"),
  ]);
  assertEquals(shape(root), [
    "~",
    false,
    [["~ · sessions started here", true, []], ["~/dev/app", false, []]],
  ]);
});

Deno.test("stores only nest within the same agent home", () => {
  const { root } = buildTree([
    store("/u/dev"),
    store("/u/dev/app", "repo", { home: "/h/.claude-work", homeLabel: "w" }),
  ]);
  assertEquals(shape(root), [
    "~",
    false,
    [["~/dev", false, []], ["~/dev/app · w", false, []]],
  ]);
});

Deno.test("stores without a real folder sit directly under ~", () => {
  const { root, nodes } = buildTree([
    store("/u/dev"),
    store("/u/dev/gone", "orphaned"),
    store("", "named", { id: "named", domainLabel: "work" }),
  ]);
  assertEquals(root.children.length, 3);
  assert(!nodes.get("/u/dev#store")!.invalid, "an orphan inside isn't a child");
});
