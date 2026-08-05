const treemapEl = document.getElementById("treemap");
const breadcrumbEl = document.getElementById("breadcrumb");
const emptyStateEl = document.getElementById("empty-state");
const detailEl = document.getElementById("detail");
const refreshBtn = document.getElementById("refresh-btn");

const state = {
  domains: [],
  minMtime: 0,
  maxMtime: 1,
  view: { mode: "overview", domain: null },
  activeFile: null,
  // Mirrors the backend defaults in src/settings.ts so the UI still renders
  // sensibly if the settings read fails.
  settings: { defaultHoistDir: "~/dev" },
};

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

// --- rendering --------------------------------------------------------------

const HEADER_H = 16;
const GAP = 2;

function renderFileLeaves(files, x, y, w, h, container) {
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
    leaf.className = "file-leaf" + (file.isIndex ? " is-index" : "");
    leaf.style.left = `${r.x}px`;
    leaf.style.top = `${r.y}px`;
    leaf.style.width = `${Math.max(0, r.w)}px`;
    leaf.style.height = `${Math.max(0, r.h)}px`;
    leaf.style.background = colorForRecency(file.mtime);
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

function renderOverview() {
  treemapEl.innerHTML = "";
  const w = treemapEl.clientWidth;
  const h = treemapEl.clientHeight;

  const rects = squarify(
    state.domains.map((d) => ({ value: d.totalTokens, domain: d })),
    0,
    0,
    w,
    h,
  );

  for (const r of rects) {
    const domain = r.item.domain;
    const box = document.createElement("div");
    box.className = "domain-box";
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${Math.max(0, r.w)}px`;
    box.style.height = `${Math.max(0, r.h)}px`;
    box.title = domain.domainLabel;
    box.addEventListener("click", () => zoomToDomain(domain));

    const label = document.createElement("div");
    label.className = "domain-label";
    label.textContent = `${domain.domainLabel} · ${domain.totalTokens}t`;
    box.appendChild(label);

    treemapEl.appendChild(box);

    renderFileLeaves(
      domain.files,
      0,
      HEADER_H,
      r.w,
      Math.max(0, r.h - HEADER_H),
      box,
    );
  }

  setBreadcrumb([{ label: "All domains", domain: null }]);
}

function renderDomainZoom(domain) {
  treemapEl.innerHTML = "";
  const w = treemapEl.clientWidth;
  const h = treemapEl.clientHeight;
  renderFileLeaves(domain.files, 0, 0, w, h, treemapEl);
  setBreadcrumb([
    { label: "All domains", domain: null },
    { label: domain.domainLabel, domain },
  ]);
}

function setBreadcrumb(crumbs) {
  breadcrumbEl.innerHTML = "";
  crumbs.forEach((c, i) => {
    const isActive = i === crumbs.length - 1;

    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = "›";
      breadcrumbEl.appendChild(sep);
    }

    const span = document.createElement("span");
    span.textContent = c.label;
    span.className = isActive ? "breadcrumb-active" : "breadcrumb-link";
    // The active crumb reflects the current view — it isn't a link to
    // itself, so it gets no click handler at all, not just different
    // styling (a no-op click was confusing before this cleanup).
    if (!isActive) {
      span.addEventListener("click", () => {
        if (c.domain) zoomToDomain(c.domain);
        else showOverview();
      });
    }
    breadcrumbEl.appendChild(span);
  });
}

function showOverview() {
  state.view = { mode: "overview", domain: null };
  render();
}

function zoomToDomain(domain) {
  state.view = { mode: "domain", domain };
  render();
}

function render() {
  const hasFiles = state.domains.length > 0;
  emptyStateEl.classList.toggle("hidden", hasFiles);
  if (!hasFiles) {
    treemapEl.innerHTML = "";
    setBreadcrumb([{ label: "All domains", domain: null }]);
    return;
  }
  // state.domains is replaced wholesale on every mutation/rescan (delete,
  // hoist, refresh), so a zoomed view's cached domain object goes stale — it
  // still lists the file we just deleted. Re-point it to the fresh object
  // (matched by domain id), or fall back to the overview if that domain is
  // gone entirely (e.g. its last memory was deleted).
  if (state.view.mode === "domain") {
    const fresh = state.domains.find(
      (d) => d.domain === (state.view.domain && state.view.domain.domain),
    );
    if (fresh) {
      state.view.domain = fresh;
      renderDomainZoom(fresh);
      return;
    }
    state.view = { mode: "overview", domain: null };
  }
  renderOverview();
}

// --- detail panel -----------------------------------------------------------

const detailDomainEl = document.getElementById("detail-domain");
const detailNameEl = document.getElementById("detail-name");
const detailMetaEl = document.getElementById("detail-meta");
const detailContentEl = document.getElementById("detail-content");

async function openDetail(file) {
  state.activeFile = file;
  detailDomainEl.textContent = file.domainLabel;
  detailNameEl.textContent = file.name;
  detailMetaEl.innerHTML =
    `<span class="type-badge">${file.type}</span>${file.tokens} tokens · ${file.chars} chars · modified ${
      formatRelativeTime(file.mtime)
    }<br>${file.description}`;
  detailContentEl.textContent = "Loading…";
  detailEl.classList.remove("hidden");
  resetMigratePanel();

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
  if (!confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
  await deleteMemory(file);
});

// --- integrate into repo / move between stores --------------------------------
// Purpose-built actions rather than one generic "pick any target" flow:
//  - Integrate: assumes the memory's own project repo, no picking needed. A
//    read-only `claude` sub-process (see src/migrate.ts) proposes the single
//    best doc to fold it into; nothing writes until you review and confirm.
//    Reversible via the repo's own git history.
//  - Move to…: fully deterministic, no LLM — relocates the memory as-is into
//    another project's memory store, picked from the domains already scanned or
//    named as a directory. Refuses outright on a filename collision rather
//    than overwriting.
//  - Hoist: the same move with the destination pre-set to the configured
//    default hoist directory (a broad root, so the memory applies across
//    projects instead of one) — one click, no picking.
// Neither one auto-deletes as a side effect of writing; a move's deletion of
// the original is part of the move the user confirmed, not a hidden extra.

const actionStatusEl = document.getElementById("action-status");
const actionSpinnerEl = document.getElementById("action-spinner");
const actionStatusTextEl = document.getElementById("action-status-text");
const integrateBtn = document.getElementById("integrate-btn");
const hoistBtn = document.getElementById("hoist-btn");
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
const integrateProposalContentEl = document.getElementById(
  "integrate-proposal-content",
);
const integrateApplyBtn = document.getElementById("integrate-apply-btn");
const integrateDiscardBtn = document.getElementById("integrate-discard-btn");

let integrateProposal = null;

function setActionStatus(text, { spinning = false } = {}) {
  actionStatusTextEl.textContent = text;
  actionSpinnerEl.classList.toggle("hidden", !spinning);
}

function resetMigratePanel() {
  setActionStatus("");
  integratePanel.classList.add("hidden");
  movePanel.classList.add("hidden");
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
  setActionStatus(`Asking claude how best to integrate this into ${file.domainLabel}…`, {
    spinning: true,
  });

  try {
    const proposal = await bindings.proposeIntegration(
      {
        path: file.path,
        filename: file.filename,
        name: file.name,
        description: file.description,
      },
      file.domainLabel,
    );
    integrateProposal = proposal;
    setActionStatus("");
    integrateProposalTargetEl.textContent = proposal.targetFile;
    integrateProposalSummaryEl.textContent = proposal.summary;
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
      file.domainLabel,
      integrateProposal.targetFile,
      integrateProposal.content,
    );
    integratePanel.classList.add("hidden");
    integrateProposal = null;
    setActionStatus(`Written to ${result.writtenPath}`);

    if (
      confirm(
        `Integrated into ${result.writtenPath}.\n\nDelete the original memory "${file.name}" now that it's captured there?`,
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

/**
 * The one write path for both Hoist and Move to… — `dest` is the only thing
 * that differs between them (see MoveDestination in src/migrate.ts).
 */
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
      {
        path: file.path,
        filename: file.filename,
        name: file.name,
        description: file.description,
      },
      file.domain,
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

hoistBtn.addEventListener("click", () => {
  const file = state.activeFile;
  if (!file) return;
  const dir = state.settings.defaultHoistDir;
  moveMemory(file, { kind: "dir", dir }, dir);
});

const MOVE_DEST_CUSTOM = "custom";

/**
 * Existing domains are offered by their domain id, not their displayed path:
 * the id is what the store is keyed by, and for a domain with no session
 * transcript the label is only a lossy guess at the real path (see
 * scanner.ts) — round-tripping through it could name a different store.
 */
function populateMoveDest(file) {
  moveDestEl.innerHTML = "";

  const hoistDir = state.settings.defaultHoistDir;
  const defaultOption = document.createElement("option");
  defaultOption.value = `dir:${hoistDir}`;
  defaultOption.textContent = `${hoistDir} (default hoist)`;
  moveDestEl.appendChild(defaultOption);

  for (const domain of state.domains) {
    if (domain.domain === file.domain) continue;
    const option = document.createElement("option");
    option.value = `domain:${domain.domain}`;
    option.textContent = domain.domainLabel;
    moveDestEl.appendChild(option);
  }

  const custom = document.createElement("option");
  custom.value = MOVE_DEST_CUSTOM;
  custom.textContent = "Other directory…";
  moveDestEl.appendChild(custom);

  moveDestEl.selectedIndex = 0;
  moveDestDirEl.value = "";
  moveDestDirEl.classList.add("hidden");
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
    moveMemory(file, { kind: "dir", dir }, dir);
    return;
  }

  const [kind, ...rest] = value.split(":");
  const target = rest.join(":");
  if (kind === "dir") {
    moveMemory(file, { kind: "dir", dir: target }, target);
  } else {
    const label = moveDestEl.selectedOptions[0].textContent;
    moveMemory(file, { kind: "domain", domain: target }, label);
  }
});

// --- settings ----------------------------------------------------------------

const settingsOverlay = document.getElementById("settings-overlay");
const settingsHoistDirEl = document.getElementById("settings-hoist-dir");
const settingsStatusEl = document.getElementById("settings-status");

function setSettingsStatus(text, { error = false } = {}) {
  settingsStatusEl.textContent = text;
  settingsStatusEl.classList.toggle("error", error);
}

/** The hoist button names its target, so the setting is visible where it acts. */
function applySettings() {
  const dir = state.settings.defaultHoistDir;
  hoistBtn.textContent = `Hoist to ${dir}`;
  hoistBtn.title = `Move this memory into ${dir}'s memory store`;
}

function openSettings() {
  settingsHoistDirEl.value = state.settings.defaultHoistDir;
  setSettingsStatus("");
  settingsOverlay.classList.remove("hidden");
  settingsHoistDirEl.focus();
}

function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

document.getElementById("settings-btn").addEventListener("click", openSettings);
document.getElementById("settings-cancel-btn").addEventListener(
  "click",
  closeSettings,
);

// Clicking the backdrop dismisses, but clicks inside the dialog must not — they
// bubble up to the overlay too.
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

document.getElementById("settings-save-btn").addEventListener(
  "click",
  async () => {
    const dir = settingsHoistDirEl.value.trim();
    if (!dir) {
      setSettingsStatus("Enter a directory.", { error: true });
      return;
    }
    setSettingsStatus("Saving…");
    try {
      // The backend validates the directory exists before persisting, so a
      // typo is caught here rather than on every later hoist.
      state.settings = await bindings.saveSettings({ defaultHoistDir: dir });
      applySettings();
      closeSettings();
    } catch (err) {
      setSettingsStatus(`${err}`, { error: true });
    }
  },
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsOverlay.classList.contains("hidden")) {
    closeSettings();
  }
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

  // Settings only decide button labels and the default move target, and
  // state.settings already holds usable defaults — so a failure here must not
  // take the treemap down with it.
  try {
    state.settings = await callBinding("getSettings");
  } catch (err) {
    console.error("Failed to read settings, falling back to defaults:", err);
  }
  applySettings();

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
window.addEventListener("resize", () => render());

load();
