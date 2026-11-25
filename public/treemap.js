import { buildTree, storeLabel } from "./tree.js";

const treemapEl = document.getElementById("treemap");
const breadcrumbEl = document.getElementById("breadcrumb");
const emptyStateEl = document.getElementById("empty-state");
const detailEl = document.getElementById("detail");
const refreshBtn = document.getElementById("refresh-btn");

const state = {
  domains: [],
  minMtime: 0,
  maxMtime: 1,
  // The node being viewed: null for the ~ root, else a store's id.
  view: { nodeId: null },
  tree: null,
  activeFile: null,
};

function domainOf(file) {
  return state.domains.find((d) => d.id === file.storeId);
}

// --- squarified treemap layout -------------------------------------------

function worstAspectRatio(row, sideLength) {
  const sum = row.reduce((s, r) => s + r.area, 0);
  const max = Math.max(...row.map((r) => r.area));
  const min = Math.min(...row.map((r) => r.area));
  const s2 = sideLength * sideLength;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

function squarify(values, x, y, w, h) {
  const rects = [];
  if (w <= 0 || h <= 0 || values.length === 0) return rects;

  const total = values.reduce((s, v) => s + v.value, 0);
  if (total <= 0) return rects;
  const scale = (w * h) / total;
  const items = values.map((v) => ({ ...v, area: v.value * scale }));

  function layout(items, x, y, w, h) {
    if (items.length === 0 || w <= 0 || h <= 0) return;
    const sideLength = Math.min(w, h);
    let row = [items[0]];
    let i = 1;
    while (i < items.length) {
      const candidate = row.concat(items[i]);
      if (
        worstAspectRatio(candidate, sideLength) <=
          worstAspectRatio(row, sideLength)
      ) {
        row = candidate;
        i++;
      } else {
        break;
      }
    }
    const remaining = items.slice(row.length);
    const rowArea = row.reduce((s, r) => s + r.area, 0);

    if (w >= h) {
      const colWidth = rowArea / h;
      let cy = y;
      for (const item of row) {
        const itemHeight = item.area / colWidth;
        rects.push({ item, x, y: cy, w: colWidth, h: itemHeight });
        cy += itemHeight;
      }
      layout(remaining, x + colWidth, y, w - colWidth, h);
    } else {
      const rowHeight = rowArea / w;
      let cx = x;
      for (const item of row) {
        const itemWidth = item.area / rowHeight;
        rects.push({ item, x: cx, y, w: itemWidth, h: rowHeight });
        cx += itemWidth;
      }
      layout(remaining, x, y + rowHeight, w, h - rowHeight);
    }
  }

  layout(items, x, y, w, h);
  return rects;
}

// --- recency color scale ----------------------------------------------------
// Red = most recently modified, blue = oldest. Size (the treemap area) is
// still driven by token cost — see renderFileLeaves/renderOverview below —
// color is a separate, independent channel for staleness.

const COLOR_STOPS = [
  { t: 0, h: 210, s: 70, l: 45 },
  { t: 0.33, h: 105, s: 60, l: 45 },
  { t: 0.66, h: 45, s: 85, l: 50 },
  { t: 1, h: 0, s: 80, l: 50 },
];

function normalizeRecency(mtime) {
  const { minMtime, maxMtime } = state;
  if (maxMtime <= minMtime) return 0.5;
  const v = (mtime - minMtime) / (maxMtime - minMtime);
  return Math.min(1, Math.max(0, v));
}

function colorForRecency(mtime) {
  const t = normalizeRecency(mtime);
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const a = COLOR_STOPS[i], b = COLOR_STOPS[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      const h = a.h + (b.h - a.h) * f;
      const s = a.s + (b.s - a.s) * f;
      const l = a.l + (b.l - a.l) * f;
      return `hsl(${h} ${s}% ${l}%)`;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  return `hsl(${last.h} ${last.s}% ${last.l}%)`;
}

function formatRelativeTime(mtime) {
  const seconds = Math.max(0, (Date.now() - mtime) / 1000);
  const units = [
    ["y", 31536000],
    ["mo", 2592000],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  for (const [label, secs] of units) {
    const n = Math.floor(seconds / secs);
    if (n >= 1) return `${n}${label} ago`;
  }
  return "just now";
}

function nodeFor(file) {
  return state.tree?.nodes.get(file.storeId) ?? null;
}

// --- rendering --------------------------------------------------------------

const HEADER_H = 16;
const GAP = 2;

function renderFileLeaves(files, x, y, w, h, container, invalid) {
  const rects = squarify(
    files.map((f) => ({ value: f.tokens, file: f })),
    x + GAP,
    y + GAP,
    Math.max(0, w - GAP * 2),
    Math.max(0, h - GAP * 2),
  );

  for (const r of rects) {
    const file = r.item.file;
    const leaf = document.createElement("div");
    leaf.className = "file-leaf" + (file.isIndex ? " is-index" : "") +
      (invalid ? " invalid" : "");
    leaf.style.left = `${r.x}px`;
    leaf.style.top = `${r.y}px`;
    leaf.style.width = `${Math.max(0, r.w)}px`;
    leaf.style.height = `${Math.max(0, r.h)}px`;
    // backgroundColor, not background, so the stripes' image layer survives.
    leaf.style.backgroundColor = colorForRecency(file.mtime);
    if (r.w > 40 && r.h > 14) {
      leaf.textContent = `${file.name} · ${file.tokens}t`;
    }
    leaf.title = `${file.name} (${file.type})\n${file.tokens} tokens · ` +
      `modified ${formatRelativeTime(file.mtime)}\n${file.description}`;
    leaf.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(file);
    });
    container.appendChild(leaf);
  }
}

const SCOPE_WORD = {
  repo: "repo",
  dir: "folder",
  everywhere: "shared folder",
  named: "named project",
  orphaned: "folder gone",
  overridden: "unused",
};

function formatTokens(n) {
  return n < 1000 ? `${n}t` : `${(n / 1000).toFixed(1)}kt`;
}

function countStores(node) {
  return node.children.reduce((sum, c) => sum + 1 + countStores(c), 0);
}

/** Facts about a box, in its header: kind, size, what's inside, freshness. */
function headerText(node) {
  const memories = node.files.filter((f) => !f.isIndex);
  const noun = node.parent === null ? "instruction" : "memor";
  const count = memories.length === 1
    ? `1 ${noun}${node.parent === null ? "" : "y"}`
    : `${memories.length} ${noun}${node.parent === null ? "s" : "ies"}`;
  const stores = countStores(node);
  const newest = Math.max(0, ...node.files.map((f) => f.mtime));
  return [
    node.label,
    node.domain && node.parent !== null ? SCOPE_WORD[node.domain.scope] : null,
    count,
    formatTokens(node.ownTotal),
    stores ? `${formatTokens(node.total)} total` : null,
    stores ? `${stores} store${stores === 1 ? "" : "s"} inside` : null,
    newest ? `updated ${formatRelativeTime(newest)}` : null,
  ].filter(Boolean).join(" · ");
}

/** The why behind a box, on hover rather than in its header. */
function boxTooltip(node) {
  const where = node.domain?.dir || node.label;
  if (node.parent === null) return "~ applies to everything below it.";
  return node.invalid
    ? `${where}\nIts memories don't reach the stores inside it.`
    : where;
}

/** Draws a node as a box: its own memories as one cluster, its children beside them. */
function renderNode(node, x, y, w, h, container) {
  const box = document.createElement("div");
  box.className = "domain-box" + (node.parent === null ? " root-box" : "") +
    (node.invalid ? " invalid" : "");
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  box.style.width = `${Math.max(0, w)}px`;
  box.style.height = `${Math.max(0, h)}px`;
  box.title = boxTooltip(node);
  box.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomTo(node);
  });

  const label = document.createElement("div");
  label.className = "domain-label";
  label.textContent = headerText(node);
  box.appendChild(label);
  container.appendChild(box);

  const items = [
    ...(node.ownTotal > 0 ? [{ value: node.ownTotal, own: true }] : []),
    ...node.children.map((child) => ({ value: child.total, child })),
  ];
  const rects = squarify(
    items,
    GAP,
    HEADER_H + GAP,
    Math.max(0, w - GAP * 2),
    Math.max(0, h - HEADER_H - GAP * 2),
  );
  for (const r of rects) {
    if (r.item.own) {
      renderFileLeaves(
        node.files,
        r.x - GAP,
        r.y - GAP,
        r.w + GAP * 2,
        r.h + GAP * 2,
        box,
        node.invalid,
      );
    } else {
      renderNode(r.item.child, r.x, r.y, r.w, r.h, box);
    }
  }
}

/** Each crumb names only what its parent's crumb doesn't: ~ › dev › supabase › cli. */
function crumbLabel(node) {
  if (node.parent === null) return "~";
  // Nested stores' labels are already relative to the store around them.
  if (node.parent.parent !== null) return node.label;
  return node.label.replace(/^~( · |\/)/, "");
}

function setBreadcrumb(node) {
  const trail = [];
  for (let n = node; n; n = n.parent) trail.unshift(n);
  breadcrumbEl.innerHTML = "";
  trail.forEach((n, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = "›";
      breadcrumbEl.appendChild(sep);
    }
    const span = document.createElement("span");
    span.textContent = crumbLabel(n);
    // The active crumb is the current view, not a link to itself.
    const isActive = i === trail.length - 1;
    span.className = isActive ? "breadcrumb-active" : "breadcrumb-link";
    if (!isActive) span.addEventListener("click", () => zoomTo(n));
    breadcrumbEl.appendChild(span);
  });
}

function zoomTo(node) {
  state.view = { nodeId: node.id };
  render();
}

function render() {
  const hasFiles = state.domains.length > 0;
  emptyStateEl.classList.toggle("hidden", hasFiles);
  treemapEl.innerHTML = "";
  state.tree = buildTree(state.domains);
  // The tree is rebuilt on every rescan, so the view is kept by id and falls
  // back to ~ when that store is gone (e.g. its last memory was deleted).
  const node = state.tree.nodes.get(state.view.nodeId) ?? state.tree.root;
  state.view = { nodeId: node.id };
  setBreadcrumb(node);
  if (!hasFiles) return;
  renderNode(
    node,
    0,
    0,
    treemapEl.clientWidth,
    treemapEl.clientHeight,
    treemapEl,
  );
}

// --- detail panel -----------------------------------------------------------

const detailDomainEl = document.getElementById("detail-domain");
const detailNameEl = document.getElementById("detail-name");
const detailMetaEl = document.getElementById("detail-meta");
const detailContentEl = document.getElementById("detail-content");

const SCOPE_TEXT = {
  shared: () =>
    "Every coding agent on this machine follows this in every project.",
  repo: (label) => `Loads in sessions inside ${label} and its worktrees.`,
  dir: (label) => `Loads only in sessions started in exactly ${label}.`,
  everywhere: () => "Loads in every project.",
  named: (label) =>
    `Loads in sessions launched with the project name ${label}.`,
  orphaned: (label) => `${label} no longer exists, so this never loads.`,
  overridden: () =>
    "Never loads: memory for every project now lives in one shared folder.",
};

/** Where this memory actually loads — stores never inherit from parents. */
function scopeLine(file) {
  const domain = domainOf(file);
  const el = document.createElement("div");
  el.className = "detail-scope";
  el.textContent = domain ? SCOPE_TEXT[domain.scope](file.domainLabel) : "";
  if (nodeFor(file)?.invalid) {
    el.textContent += " It doesn't reach the stores inside its folder, " +
      "which keep their own memory: hoist it to ~, or move it to the project " +
      "it's for.";
  }
  return el;
}

const detailWiringEl = document.getElementById("detail-wiring");
const detailWiringTextEl = document.getElementById("detail-wiring-text");
const repairBtn = document.getElementById("repair-btn");

/** For hoisted instructions: agent folders not yet reading the shared file. */
function renderWiring(file) {
  const wiring = file.section !== undefined && domainOf(file)?.wiring;
  const lines = wiring
    ? [
      ...wiring.blocked,
      ...wiring.warnings,
      ...(wiring.pending.length
        ? [`Not yet reading these instructions: ${wiring.pending.join(", ")}.`]
        : []),
    ]
    : [];
  detailWiringTextEl.textContent = lines.join("\n");
  repairBtn.classList.toggle(
    "hidden",
    !wiring || wiring.pending.length === 0 || wiring.blocked.length > 0,
  );
  detailWiringEl.classList.toggle("hidden", lines.length === 0);
}

async function openDetail(file) {
  state.activeFile = file;
  const shared = file.section !== undefined;
  // Hoisted instructions are already everywhere; only memories move around.
  for (const btn of [integrateBtn, hoistBtn, moveBtn]) {
    btn.classList.toggle("hidden", shared);
  }
  detailDomainEl.textContent = file.domainLabel;
  detailNameEl.textContent = file.name;
  detailMetaEl.innerHTML =
    `<span class="type-badge">${file.type}</span>${file.tokens} tokens · ${file.chars} chars · modified ${
      formatRelativeTime(file.mtime)
    }<br>${file.description}`;
  detailMetaEl.appendChild(scopeLine(file));
  renderWiring(file);
  detailEl.classList.remove("hidden");
  resetMigratePanel();

  if (shared) {
    detailContentEl.textContent = file.content;
    return;
  }
  detailContentEl.textContent = "Loading…";
  try {
    detailContentEl.textContent = await bindings.getFileContent(file.path);
  } catch (err) {
    detailContentEl.textContent = `Failed to read file: ${err}`;
  }
}

document.getElementById("close-detail").addEventListener("click", () => {
  detailEl.classList.add("hidden");
  state.activeFile = null;
  resetMigratePanel();
});

document.getElementById("reveal-btn").addEventListener("click", () => {
  if (state.activeFile) bindings.revealInFinder(state.activeFile.path);
});

document.getElementById("open-btn").addEventListener("click", () => {
  if (state.activeFile) bindings.openFile(state.activeFile.path);
});

document.getElementById("delete-btn").addEventListener("click", async () => {
  const file = state.activeFile;
  if (!file) return;
  if (file.section !== undefined) {
    if (file.section === "") {
      setActionStatus("Edit this text directly: use Open.");
      return;
    }
    const prompt =
      `Delete "${file.name}" for every agent? This removes it from ${file.description}.`;
    if (!confirm(prompt)) return;
    try {
      state.domains = await bindings.deleteSharedInstruction(file.section);
    } catch (err) {
      setActionStatus(`Failed to delete: ${err}`);
      return;
    }
    computeMinMax();
    detailEl.classList.add("hidden");
    state.activeFile = null;
    render();
    return;
  }
  if (!confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
  await deleteMemory(file);
});

repairBtn.addEventListener("click", async () => {
  try {
    state.domains = await bindings.repairWiring();
    computeMinMax();
    render();
    const file = state.activeFile && domainOf(state.activeFile)?.files.find(
      (f) => f.section === state.activeFile.section,
    );
    if (file) openDetail(file);
  } catch (err) {
    setActionStatus(`Failed to fix links: ${err}`);
  }
});

// --- integrate / hoist / move -----------------------------------------------
//  - Integrate: a read-only `claude` run proposes one doc in the memory's own
//    repo to fold it into; nothing writes until you confirm.
//  - Hoist: moves it up to ~, the one instructions file every agent on this
//    machine reads in every project. One click, with Undo; it only asks first
//    when agent folders also need pointing at that file.
//  - Move to…: relocates it as-is into another project's store.

const actionSpinnerEl = document.getElementById("action-spinner");
const actionStatusTextEl = document.getElementById("action-status-text");
const integrateBtn = document.getElementById("integrate-btn");
const hoistBtn = document.getElementById("hoist-btn");
const hoistPanel = document.getElementById("hoist-panel");
const hoistFilesEl = document.getElementById("hoist-files");
const hoistFilesSummaryEl = document.getElementById("hoist-files-summary");
const hoistConfirmBtn = document.getElementById("hoist-confirm-btn");
const hoistProblemsEl = document.getElementById("hoist-problems");
const undoBtn = document.getElementById("undo-btn");
let pendingUndo = null;
const moveBtn = document.getElementById("move-btn");
const movePanel = document.getElementById("move-panel");
const moveDestEl = document.getElementById("move-dest");
const moveDestDirEl = document.getElementById("move-dest-dir");
const integratePanel = document.getElementById("integrate-panel");
const integrateProposalTargetEl = document.getElementById(
  "integrate-proposal-target",
);
const integrateProposalSummaryEl = document.getElementById(
  "integrate-proposal-summary",
);
const integrateProposalAlsoEl = document.getElementById(
  "integrate-proposal-also",
);
const integrateProposalContentEl = document.getElementById(
  "integrate-proposal-content",
);
const integrateApplyBtn = document.getElementById("integrate-apply-btn");
const integrateDiscardBtn = document.getElementById("integrate-discard-btn");

let integrateProposal = null;

function setActionStatus(text, { spinning = false, undo = null } = {}) {
  actionStatusTextEl.textContent = text;
  actionSpinnerEl.classList.toggle("hidden", !spinning);
  pendingUndo = undo;
  undoBtn.classList.toggle("hidden", !undo);
}

function resetMigratePanel() {
  setActionStatus("");
  integratePanel.classList.add("hidden");
  movePanel.classList.add("hidden");
  hoistPanel.classList.add("hidden");
  integrateProposal = null;
}

async function deleteMemory(file) {
  state.domains = await bindings.deleteFile(file.path);
  computeMinMax();
  detailEl.classList.add("hidden");
  state.activeFile = null;
  render();
}

integrateBtn.addEventListener("click", async () => {
  const file = state.activeFile;
  if (!file) return;

  resetMigratePanel();
  setActionStatus(
    `Asking claude how best to integrate this into ${file.domainLabel}…`,
    {
      spinning: true,
    },
  );

  try {
    const proposal = await bindings.proposeIntegration(
      memoryPayload(file),
      file.dir,
    );
    integrateProposal = proposal;
    setActionStatus("");
    integrateProposalTargetEl.textContent = proposal.targetFile;
    integrateProposalSummaryEl.textContent = proposal.summary;
    integrateProposalAlsoEl.textContent = proposal.alsoImportsIn
      ? `Also adds an @AGENTS.md line to ${proposal.alsoImportsIn}, so every agent reads it.`
      : "";
    integrateProposalAlsoEl.classList.toggle("hidden", !proposal.alsoImportsIn);
    integrateProposalContentEl.textContent = proposal.content;
    integratePanel.classList.remove("hidden");
  } catch (err) {
    setActionStatus(`Failed to propose integration: ${err}`);
  }
});

integrateApplyBtn.addEventListener("click", async () => {
  const file = state.activeFile;
  if (!file || !integrateProposal) return;
  setActionStatus("Writing…", { spinning: true });
  try {
    const result = await bindings.applyIntegration(
      file.dir,
      integrateProposal.targetFile,
      integrateProposal.content,
    );
    integratePanel.classList.add("hidden");
    integrateProposal = null;
    const written = result.writtenPaths.join(", ");
    setActionStatus(`Written to ${written}`);

    if (
      confirm(
        `Integrated into ${written}.\n\nDelete the original memory "${file.name}" now that it's captured there?`,
      )
    ) {
      setActionStatus("Deleting original memory…", { spinning: true });
      try {
        await deleteMemory(file);
      } catch (err) {
        setActionStatus(`Failed to delete original: ${err}`);
      }
    }
  } catch (err) {
    setActionStatus(`Failed to write: ${err}`);
  }
});

integrateDiscardBtn.addEventListener("click", () => {
  integrateProposal = null;
  integratePanel.classList.add("hidden");
  setActionStatus("");
});

/** Shared write path for every Move to… destination (see src/migrate.ts). */
async function moveMemory(file, dest, destLabel) {
  if (
    !confirm(
      `Move "${file.name}" to ${destLabel}'s memory store? It'll be removed from ${file.domainLabel}.`,
    )
  ) {
    return;
  }

  setActionStatus(`Moving to ${destLabel}…`, { spinning: true });
  try {
    const result = await bindings.moveMemory(
      memoryPayload(file),
      file.storeId,
      dest,
    );
    state.domains = result.domains;
    computeMinMax();
    detailEl.classList.add("hidden");
    state.activeFile = null;
    resetMigratePanel();
    render();
  } catch (err) {
    setActionStatus(`Failed to move: ${err}`);
  }
}

function memoryPayload(file) {
  return {
    path: file.path,
    filename: file.filename,
    name: file.name,
    description: file.description,
  };
}

const HOIST_ACTION_TEXT = {
  create: "Creates the shared file",
  append: "Adds it to",
  link: "Points at the shared file:",
  merge: "Moves its text into the shared file, then points at it:",
  import: "Adds an import of the shared file to",
};

function renderHoistPlan(plan) {
  hoistFilesEl.innerHTML = "";
  for (const step of plan.steps) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = step.display;
    item.append(`${HOIST_ACTION_TEXT[step.action]} `, code);
    hoistFilesEl.appendChild(item);
  }
  const n = plan.steps.length;
  hoistFilesSummaryEl.textContent = `Changes ${n} file${n === 1 ? "" : "s"}`;
  const problems = [...plan.blocked, ...plan.warnings];
  hoistProblemsEl.textContent = problems.join("\n");
  hoistProblemsEl.classList.toggle("hidden", problems.length === 0);
  hoistConfirmBtn.disabled = plan.blocked.length > 0;
}

/** Hoists, then shows the instruction where it landed in ~, with Undo. */
async function doHoist(file) {
  hoistConfirmBtn.disabled = true;
  setActionStatus("Hoisting…", { spinning: true });
  let result;
  try {
    result = await bindings.hoistMemory(memoryPayload(file));
  } catch (err) {
    hoistConfirmBtn.disabled = false;
    setActionStatus(`Failed to hoist: ${err}`);
    return;
  }
  state.domains = result.domains;
  computeMinMax();
  render();
  const hoisted = state.domains.find((d) => d.scope === "shared")?.files
    .find((f) => f.section === file.filename);
  if (hoisted) openDetail(hoisted);
  else detailEl.classList.add("hidden");
  const note = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
  setActionStatus(`Hoisted "${file.name}" to ~.${note}`, {
    undo: { id: result.undoId, path: file.path },
  });
}

hoistBtn.addEventListener("click", async () => {
  const file = state.activeFile;
  if (!file) return;
  resetMigratePanel();
  let plan;
  try {
    plan = await bindings.getHoistPlan(memoryPayload(file));
  } catch (err) {
    setActionStatus(`Can't hoist this: ${err}`);
    return;
  }
  if (plan.blocked.length) {
    setActionStatus(`Can't hoist this: ${plan.blocked.join(" ")}`);
    return;
  }
  // Only a change to agent folders needs a look first; adding to ~ doesn't.
  if (plan.steps.every((step) => step.action === "append")) {
    await doHoist(file);
    return;
  }
  renderHoistPlan(plan);
  hoistPanel.classList.remove("hidden");
});

document.getElementById("hoist-cancel-btn").addEventListener("click", () => {
  hoistPanel.classList.add("hidden");
  setActionStatus("");
});

hoistConfirmBtn.addEventListener("click", () => {
  if (state.activeFile) doHoist(state.activeFile);
});

undoBtn.addEventListener("click", async () => {
  const undo = pendingUndo;
  if (!undo) return;
  setActionStatus("Undoing…", { spinning: true });
  try {
    state.domains = await bindings.undoHoist(undo.id);
  } catch (err) {
    setActionStatus(`Failed to undo: ${err}`);
    return;
  }
  computeMinMax();
  render();
  const restored = state.domains.flatMap((d) => d.files)
    .find((f) => f.path === undo.path);
  if (restored) openDetail(restored);
  setActionStatus("Hoist undone.");
});

const MOVE_DEST_CUSTOM = "custom";

/**
 * Existing stores are offered by their id, not their displayed path: for a
 * store whose directory is gone the label is only a guess (see scanner.ts),
 * so round-tripping through it could name a different store.
 */
function populateMoveDest(file) {
  moveDestEl.innerHTML = "";

  for (const domain of state.domains) {
    if (domain.id === file.storeId) continue;
    const option = document.createElement("option");
    option.value = `store:${domain.id}`;
    option.textContent = storeLabel(domain);
    moveDestEl.appendChild(option);
  }

  const custom = document.createElement("option");
  custom.value = MOVE_DEST_CUSTOM;
  custom.textContent = "Other directory…";
  moveDestEl.appendChild(custom);

  moveDestEl.selectedIndex = 0;
  moveDestDirEl.value = "";
  moveDestDirEl.classList.toggle(
    "hidden",
    moveDestEl.value !== MOVE_DEST_CUSTOM,
  );
}

moveDestEl.addEventListener("change", () => {
  const isCustom = moveDestEl.value === MOVE_DEST_CUSTOM;
  moveDestDirEl.classList.toggle("hidden", !isCustom);
  if (isCustom) moveDestDirEl.focus();
});

moveBtn.addEventListener("click", () => {
  const file = state.activeFile;
  if (!file) return;
  resetMigratePanel();
  populateMoveDest(file);
  movePanel.classList.remove("hidden");
});

document.getElementById("move-cancel-btn").addEventListener("click", () => {
  movePanel.classList.add("hidden");
  setActionStatus("");
});

document.getElementById("move-confirm-btn").addEventListener("click", () => {
  const file = state.activeFile;
  if (!file) return;

  const value = moveDestEl.value;
  if (value === MOVE_DEST_CUSTOM) {
    const dir = moveDestDirEl.value.trim();
    if (!dir) {
      setActionStatus("Enter a directory to move this memory to.");
      return;
    }
    // A named directory means its store in the same agent home as the source.
    const home = domainOf(file)?.home;
    moveMemory(file, { kind: "dir", dir, home }, dir);
    return;
  }

  const storeId = value.slice("store:".length);
  const label = moveDestEl.selectedOptions[0].textContent;
  moveMemory(file, { kind: "store", storeId }, label);
});

// --- bootstrap ---------------------------------------------------------------

function computeMinMax() {
  const allMtimes = state.domains.flatMap((d) => d.files.map((f) => f.mtime));
  state.minMtime = allMtimes.length ? Math.min(...allMtimes) : 0;
  state.maxMtime = allMtimes.length ? Math.max(...allMtimes) : 1;
}

/**
 * The window navigates to the local server the moment its listener comes up,
 * and under --hmr the page can reload before the re-evaluated module has
 * re-registered its handlers — either way a call on load can land before the
 * Deno side is listening for it, which surfaces as "No callback bound for: X".
 * That window is milliseconds wide and closes on its own, so retry briefly
 * rather than leaving the window stuck on an error the user can only fix by
 * hitting refresh. Any *other* error is a real failure and propagates at once.
 */
async function callBinding(name, ...args) {
  const DEADLINE_MS = 3000;
  const RETRY_MS = 100;
  let lastErr;

  for (let waited = 0; waited <= DEADLINE_MS; waited += RETRY_MS) {
    try {
      return await bindings[name](...args);
    } catch (err) {
      if (!`${err}`.includes("No callback bound")) throw err;
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw lastErr;
}

async function load() {
  if (typeof bindings === "undefined") {
    emptyStateEl.textContent =
      "bindings unavailable — open this in the Mem GUI desktop window, not a plain browser tab.";
    emptyStateEl.classList.remove("hidden");
    return;
  }

  try {
    state.domains = await callBinding("getTree");
    computeMinMax();
    render();
  } catch (err) {
    emptyStateEl.textContent = `Failed to load memory tree: ${err}`;
    emptyStateEl.classList.remove("hidden");
  }
}

refreshBtn.addEventListener("click", load);
// globalThis rather than window: identical in the webview, and it keeps this
// file clean under `deno lint`, which lints it with Deno's rules (no-window).
globalThis.addEventListener("resize", () => render());

load();
