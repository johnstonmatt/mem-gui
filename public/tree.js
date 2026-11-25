// The ~ tree the treemap draws; a module of its own so the tests can check it.

/** A store's directory, plus which agent config folder it's in when not the default. */
export function storeLabel(domain) {
  return domain.homeLabel
    ? `${domain.domainLabel} · ${domain.homeLabel}`
    : domain.domainLabel;
}

// --- hierarchy ----------------------------------------------------------------
// ~ (the shared instructions) really does apply to every store, so it's the
// root. Stores nest under the nearest store whose folder contains theirs, only
// to show where they sit: one with stores inside it is striped, because its
// memories never reach them.

/** A store placed by folder: it has a real directory and still loads somewhere. */
function nestsByFolder(domain) {
  return Boolean(domain.dir) && domain.scope !== "orphaned";
}

/** Claude's store for the home folder itself; it would otherwise contain everything. */
function isHomeStore(domain) {
  return domain.domainLabel.startsWith("~ · ");
}

function isInside(inner, outer) {
  return inner.home === outer.home && inner.dir.startsWith(`${outer.dir}/`);
}

export function buildTree(domains) {
  const shared = domains.find((d) => d.scope === "shared");
  const root = {
    id: null,
    domain: shared ?? null,
    label: "~",
    files: shared?.files ?? [],
    children: [],
    parent: null,
    invalid: false,
  };
  const stores = domains.filter((d) => d.scope !== "shared");
  const nodes = new Map(stores.map((d) => [d.id, {
    id: d.id,
    domain: d,
    label: storeLabel(d),
    files: d.files,
    children: [],
    parent: root,
    invalid: false,
  }]));

  for (const d of stores) {
    const node = nodes.get(d.id);
    if (!nestsByFolder(d)) {
      root.children.push(node);
      continue;
    }
    node.invalid = stores.some((o) =>
      o !== d && nestsByFolder(o) && isInside(o, d)
    );
    const parent = stores
      .filter((o) =>
        o !== d && nestsByFolder(o) && !isHomeStore(o) && isInside(d, o)
      )
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (parent) {
      node.parent = nodes.get(parent.id);
      // Inside a store, a child's path reads relative to it.
      node.label = d.domainLabel.slice(parent.domainLabel.length + 1) +
        (d.homeLabel ? ` · ${d.homeLabel}` : "");
    }
    node.parent.children.push(node);
  }

  const total = (node) => {
    node.ownTotal = node.files.reduce((sum, f) => sum + f.tokens, 0);
    node.total = node.ownTotal +
      node.children.reduce((sum, c) => sum + total(c), 0);
    node.children.sort((a, b) => b.total - a.total);
    return node.total;
  };
  total(root);
  return { root, nodes };
}
