"use strict";

/* =========================================================================
   CONFIGURATION
   Edit these values (or the inputs in the toolbar) to change the hive.
   Nothing below this block needs to change to re-tune the blueprint.
   ========================================================================= */

// Every base is exactly BASE_BLOCK x BASE_BLOCK map tiles.
const BASE_BLOCK = 3;

// Size of the map, in tiles, in each direction.
const MAP_TILES = 80;

// Pixel size of a single map tile in SVG user units.
const TILE_PX = 20;

// Footprint of the schematic City / Theme Park block, in tiles.
const CITY_WIDTH_TILES = 7;
const CITY_HEIGHT_TILES = 6;
const CITY_GAP_TILES = 3; // gap between city footprint and the hive

// Core R4/R5 placements, given as (col, row) offsets from the Marshall
// Guard (MG) position, which is treated as the anchor (0, 0). Moving a
// member is a one-line edit here; the flood-fill packer does the rest.
const CORE_BASES = [
  { name: "Cristy", col: 2, row: -1 },
  { name: "DBK", col: 1, row: -2 },
  { name: "HHK", col: 1, row: -1 },
  { name: "MikeIs", col: -1, row: -1 },
  { name: "Ironman", col: 0, row: -1 },
  { name: "Vrish", col: -1, row: 0 },
  { name: "MG", col: 0, row: 0, tier: "mg" },
  { name: "Ajitanshu", col: 1, row: 0 },
  { name: "Milka", col: 2, row: 0 },
  { name: "DJ", col: -1, row: 1 },
  { name: "Jal", col: 0, row: 1 },
  { name: "Deadman", col: 1, row: 1 },
];

// Fill-tier counts. Changing these and hitting "Regenerate" (or calling
// App.regenerate()) rebuilds the whole hive with no manual placement.
const DEFAULT_TIER_COUNTS = {
  R3: 38,
  R2: 30,
  R1: 21,
};

const COLORS = {
  grass: "#78A950",
  grid: "#5C8744",
  base: "#4B89FF",
  baseStroke: "#2E5FBF",
  mg: "#F39C34",
  mgStroke: "#B96E12",
  label: "#FFFFFF",
  city: "#7A8699",
  cityStroke: "#4E5766",
  cityRoof: "#5C6779",
  highlight: "#FFF176",
};

/* =========================================================================
   LAYOUT
   Pure data-generation logic. No DOM access happens in this section, so it
   can be reused, unit tested, or ported to another renderer untouched.
   ========================================================================= */

const Layout = (() => {
  function key(bx, by) {
    return bx + "," + by;
  }

  function buildCore(coreBases) {
    const occupied = new Map();
    coreBases.forEach((b) => {
      occupied.set(key(b.col, b.row), {
        bx: b.col,
        by: b.row,
        tier: b.tier || "core",
        label: b.name,
      });
    });
    return occupied;
  }

  // All empty cells orthogonally touching the current hive.
  function frontierOf(occupied) {
    const seen = new Set();
    const frontier = [];
    const deltas = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const cell of occupied.values()) {
      for (const [dx, dy] of deltas) {
        const nx = cell.bx + dx;
        const ny = cell.by + dy;
        const k = key(nx, ny);
        if (!occupied.has(k) && !seen.has(k)) {
          seen.add(k);
          frontier.push({ bx: nx, by: ny });
        }
      }
    }
    return frontier;
  }

  // Nearest-to-center first, then angular order, so growth reads as a
  // clean concentric ring rather than a jagged random walk.
  function sortByProximity(frontier) {
    return frontier.slice().sort((a, b) => {
      const da = a.bx * a.bx + a.by * a.by;
      const db = b.bx * b.bx + b.by * b.by;
      if (da !== db) return da - db;
      return Math.atan2(a.by, a.bx) - Math.atan2(b.by, b.bx);
    });
  }

  // Grows the occupied set outward by `count` cells, one nearest-frontier
  // cell at a time, tagging every new cell with `tierName`.
  function growTier(occupied, count, tierName) {
    const added = [];
    for (let i = 1; i <= count; i++) {
      const frontier = sortByProximity(frontierOf(occupied));
      if (frontier.length === 0) break;
      const cell = frontier[0];
      const block = {
        bx: cell.bx,
        by: cell.by,
        tier: tierName,
        label: tierName + "-" + String(i).padStart(2, "0"),
      };
      occupied.set(key(cell.bx, cell.by), block);
      added.push(block);
    }
    return added;
  }

  // Builds the full hive: core first, then each fill tier in order,
  // flood-filling outward so the hive never has an internal hole.
  function generateLayout({ coreBases, tierCounts }) {
    const occupied = buildCore(coreBases);
    growTier(occupied, tierCounts.R3, "R3");
    growTier(occupied, tierCounts.R2, "R2");
    growTier(occupied, tierCounts.R1, "R1");

    const blocks = Array.from(occupied.values());
    const bounds = blocks.reduce(
      (acc, b) => ({
        minBx: Math.min(acc.minBx, b.bx),
        maxBx: Math.max(acc.maxBx, b.bx),
        minBy: Math.min(acc.minBy, b.by),
        maxBy: Math.max(acc.maxBy, b.by),
      }),
      { minBx: Infinity, maxBx: -Infinity, minBy: Infinity, maxBy: -Infinity }
    );
    return { blocks, bounds };
  }

  return { generateLayout, key, frontierOf, sortByProximity };
})();

/* =========================================================================
   RENDER
   All DOM / SVG construction. Consumes plain data from Layout and never
   computes placement itself.
   ========================================================================= */

const Render = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Translates block-grid bounds (in BASE_BLOCK units, MG-relative) into
  // absolute tile offsets, centering the hive on the map and reserving
  // room above it for the City.
  function computeOffsets(bounds) {
    const widthTiles = (bounds.maxBx - bounds.minBx + 1) * BASE_BLOCK;
    const heightTiles = (bounds.maxBy - bounds.minBy + 1) * BASE_BLOCK;

    const topReserve = CITY_HEIGHT_TILES + CITY_GAP_TILES;
    const bandHeight = MAP_TILES - topReserve;

    const hiveOriginTileX = Math.floor((MAP_TILES - widthTiles) / 2);
    const hiveOriginTileY =
      topReserve + Math.max(0, Math.floor((bandHeight - heightTiles) / 2));

    const cityOriginTileX = Math.floor(
      hiveOriginTileX + widthTiles / 2 - CITY_WIDTH_TILES / 2
    );
    const cityOriginTileY = hiveOriginTileY - CITY_GAP_TILES - CITY_HEIGHT_TILES;

    return {
      hiveOriginTileX,
      hiveOriginTileY,
      cityOriginTileX,
      cityOriginTileY: Math.max(1, cityOriginTileY),
      widthTiles,
      heightTiles,
    };
  }

  function drawGrid(gridLayer) {
    clear(gridLayer);
    const size = MAP_TILES * TILE_PX;
    for (let i = 0; i <= MAP_TILES; i++) {
      const p = i * TILE_PX;
      gridLayer.appendChild(
        el("line", {
          x1: p,
          y1: 0,
          x2: p,
          y2: size,
          stroke: COLORS.grid,
          "stroke-width": i % 10 === 0 ? 1.1 : 0.5,
          "stroke-opacity": i % 10 === 0 ? 0.55 : 0.3,
        })
      );
      gridLayer.appendChild(
        el("line", {
          x1: 0,
          y1: p,
          x2: size,
          y2: p,
          stroke: COLORS.grid,
          "stroke-width": i % 10 === 0 ? 1.1 : 0.5,
          "stroke-opacity": i % 10 === 0 ? 0.55 : 0.3,
        })
      );
    }
  }

  // Approximate bold-sans character width as a fraction of font size to
  // decide how much a label must shrink to stay inside its footprint.
  function fitFontSize(label, boxPx) {
    const CHAR_W = 0.62;
    const MAX_SIZE = 11;
    const MIN_SIZE = 5;
    const PADDING = 6;
    const available = boxPx - PADDING * 2;
    let size = MAX_SIZE;
    const widthAt = (s) => label.length * s * CHAR_W;
    if (widthAt(size) > available) {
      size = available / (label.length * CHAR_W);
    }
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size * 10) / 10));
  }

  function truncateForBox(label, boxPx, fontSize) {
    const CHAR_W = 0.62;
    const PADDING = 6;
    const available = boxPx - PADDING * 2;
    if (label.length * fontSize * CHAR_W <= available) return label;
    const maxChars = Math.max(1, Math.floor(available / (fontSize * CHAR_W)) - 1);
    return label.slice(0, maxChars) + "…";
  }

  function houseIcon(cx, cy, scale, fill) {
    const g = el("g", { transform: `translate(${cx}, ${cy})`, "pointer-events": "none" });
    const roofHalf = 7 * scale;
    const roofTop = -8 * scale;
    const bodyTop = 0;
    const bodyHalf = 5 * scale;
    const bodyH = 7 * scale;

    g.appendChild(
      el("path", {
        d: `M ${-roofHalf} ${bodyTop} L 0 ${roofTop} L ${roofHalf} ${bodyTop} Z`,
        fill,
      })
    );
    g.appendChild(
      el("rect", {
        x: -bodyHalf,
        y: bodyTop,
        width: bodyHalf * 2,
        height: bodyH,
        fill,
      })
    );
    return g;
  }

  // Absolute tile/pixel rectangle a block occupies, given the current
  // hive offset. Shared by block drawing and the selection overlay so
  // both always agree on where a block actually sits.
  function tileRectForBlock(block, offset) {
    const blockPx = BASE_BLOCK * TILE_PX;
    const tileX = offset.hiveOriginTileX + (block.bx - offset.minBx) * BASE_BLOCK;
    const tileY = offset.hiveOriginTileY + (block.by - offset.minBy) * BASE_BLOCK;
    return { tileX, tileY, x: tileX * TILE_PX, y: tileY * TILE_PX, size: blockPx };
  }

  function drawBlock(hiveLayer, block, offset, handlers) {
    const { tileX, tileY, x, y, size: blockPx } = tileRectForBlock(block, offset);
    const cx = x + blockPx / 2;
    const cy = y + blockPx / 2;

    const isMg = block.tier === "mg";
    const fill = isMg ? COLORS.mg : COLORS.base;
    const stroke = isMg ? COLORS.mgStroke : COLORS.baseStroke;

    const g = el("g", {
      class: "base-group",
      "data-label": block.label,
      "data-tile-x": tileX,
      "data-tile-y": tileY,
    });

    const inset = 1.5;
    const body = el("rect", {
      x: x + inset,
      y: y + inset,
      width: blockPx - inset * 2,
      height: blockPx - inset * 2,
      rx: 4,
      ry: 4,
      fill,
      stroke,
      "stroke-width": 1.2,
    });
    g.appendChild(body);

    g.appendChild(houseIcon(cx, cy - blockPx * 0.16, TILE_PX / 20, COLORS.label));

    const fontSize = fitFontSize(block.label, blockPx);
    const text = el("text", {
      x: cx,
      y: cy + blockPx * 0.28,
      fill: COLORS.label,
      "font-size": fontSize,
      "font-weight": 700,
      "font-family": "Arial, Helvetica, sans-serif",
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "pointer-events": "none",
    });
    text.textContent = truncateForBox(block.label, blockPx, fontSize);
    g.appendChild(text);

    // Exact 3x3 footprint outline used for the hover highlight.
    const highlight = el("rect", {
      x,
      y,
      width: blockPx,
      height: blockPx,
      fill: "none",
      stroke: COLORS.highlight,
      "stroke-width": 3,
      "pointer-events": "none",
      opacity: 0,
    });
    g.appendChild(highlight);

    g.addEventListener("mouseenter", () => {
      highlight.setAttribute("opacity", "1");
      if (handlers && handlers.onHover) handlers.onHover(block, tileX, tileY, true);
    });
    g.addEventListener("mouseleave", () => {
      highlight.setAttribute("opacity", "0");
      if (handlers && handlers.onHover) handlers.onHover(block, tileX, tileY, false);
    });
    g.addEventListener("click", () => {
      if (handlers && handlers.onClick) handlers.onClick(block);
    });
    g.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      if (handlers && handlers.onDblClick) handlers.onDblClick(block);
    });

    hiveLayer.appendChild(g);
  }

  // Highlights the currently-selected block with a distinct dashed
  // outline so it reads differently from the transient hover outline.
  function drawSelectionHighlight(selectionLayer, block, offset) {
    clear(selectionLayer);
    if (!block) return;
    const { x, y, size } = tileRectForBlock(block, offset);
    selectionLayer.appendChild(
      el("rect", {
        x,
        y,
        width: size,
        height: size,
        rx: 4,
        ry: 4,
        fill: "none",
        stroke: "#FFFFFF",
        "stroke-width": 3.5,
        "stroke-dasharray": "7 5",
        "pointer-events": "none",
      })
    );
  }

  function drawCity(cityLayer, offset) {
    clear(cityLayer);
    const x = offset.cityOriginTileX * TILE_PX;
    const y = offset.cityOriginTileY * TILE_PX;
    const w = CITY_WIDTH_TILES * TILE_PX;
    const h = CITY_HEIGHT_TILES * TILE_PX;

    const g = el("g", { class: "city-group" });

    g.appendChild(
      el("rect", {
        x,
        y,
        width: w,
        height: h,
        rx: 6,
        ry: 6,
        fill: COLORS.city,
        stroke: COLORS.cityStroke,
        "stroke-width": 1.5,
      })
    );

    // Simplified corner towers / theme-park spires.
    const towerW = w * 0.16;
    const towerH = h * 0.28;
    const towerPositions = [
      x + w * 0.08,
      x + w * 0.5 - towerW / 2,
      x + w * 0.92 - towerW,
    ];
    towerPositions.forEach((tx) => {
      g.appendChild(
        el("rect", {
          x: tx,
          y: y - towerH * 0.5,
          width: towerW,
          height: towerH,
          fill: COLORS.cityRoof,
          stroke: COLORS.cityStroke,
          "stroke-width": 1,
        })
      );
    });

    const fontSize = Math.min(16, w * 0.12);
    const label = el("text", {
      x: x + w / 2,
      y: y + h / 2 + h * 0.12,
      fill: COLORS.label,
      "font-size": fontSize,
      "font-weight": 700,
      "font-family": "Arial, Helvetica, sans-serif",
      "text-anchor": "middle",
      "dominant-baseline": "middle",
    });
    label.textContent = "CITY";
    g.appendChild(label);

    cityLayer.appendChild(g);
  }

  // Redraws just the hive blocks against an already-computed offset.
  // Used both by the initial render and by in-place edits (swap/rename)
  // that never change the hive's bounds.
  function redrawHive(hiveLayer, blocks, offset, handlers) {
    clear(hiveLayer);
    blocks.forEach((block) => drawBlock(hiveLayer, block, offset, handlers));
  }

  function renderAll(layers, layoutResult, handlers) {
    const offset = computeOffsets(layoutResult.bounds);
    offset.minBx = layoutResult.bounds.minBx;
    offset.minBy = layoutResult.bounds.minBy;

    drawGrid(layers.grid);
    drawCity(layers.city, offset);
    redrawHive(layers.hive, layoutResult.blocks, offset, handlers);
    clear(layers.selection);

    return offset;
  }

  return {
    renderAll,
    redrawHive,
    drawSelectionHighlight,
    tileRectForBlock,
    computeOffsets,
    el,
    clear,
  };
})();

/* =========================================================================
   APP
   Wires the toolbar, viewport interaction (zoom/pan/hover/coordinates),
   and export utilities. Delegates all data work to Layout/Render above.
   ========================================================================= */

const App = (() => {
  const svg = document.getElementById("blueprint");
  const viewportContainer = document.getElementById("viewport-container");
  const viewportGroup = document.getElementById("viewport");
  const layers = {
    grid: document.getElementById("grid-layer"),
    city: document.getElementById("city-layer"),
    hive: document.getElementById("hive-layer"),
    selection: document.getElementById("selection-layer"),
  };
  const tileReadout = document.getElementById("tile-readout");
  const statReadout = document.getElementById("stat-readout");
  const backgroundRect = document.getElementById("background");

  const inputR3 = document.getElementById("input-r3");
  const inputR2 = document.getElementById("input-r2");
  const inputR1 = document.getElementById("input-r1");
  const btnEditMode = document.getElementById("btn-edit-mode");

  const renameBackdrop = document.getElementById("rename-backdrop");
  const renameInput = document.getElementById("rename-input");
  const renameConfirmBtn = document.getElementById("rename-confirm");
  const renameCancelBtn = document.getElementById("rename-cancel");

  let view = { scale: 1, x: 0, y: 0 };
  let currentLayout = null;
  let currentOffset = null;
  let editMode = false;
  let selectedBlock = null;
  let renamingBlock = null;

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 6;
  const CLICK_MOVE_THRESHOLD = 6; // outer units; beyond this, a mouseup is a drag, not a click

  function applyTransform() {
    viewportGroup.setAttribute(
      "transform",
      `translate(${view.x}, ${view.y}) scale(${view.scale})`
    );
  }

  // Converts a mouse/client point into the SVG's fixed outer coordinate
  // system (i.e. the 0..1600 viewBox space, before pan/zoom is applied).
  function outerPointFromEvent(evt) {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    return {
      x: ((evt.clientX - rect.left) / rect.width) * viewBox.width,
      y: ((evt.clientY - rect.top) / rect.height) * viewBox.height,
    };
  }

  function outerToInner(pt) {
    return {
      x: (pt.x - view.x) / view.scale,
      y: (pt.y - view.y) / view.scale,
    };
  }

  function onWheel(evt) {
    evt.preventDefault();
    const outer = outerPointFromEvent(evt);
    const inner = outerToInner(outer);

    const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));

    view.x = outer.x - inner.x * newScale;
    view.y = outer.y - inner.y * newScale;
    view.scale = newScale;
    applyTransform();
  }

  let dragging = false;
  let dragStart = null;
  // Total mouse movement since the last mousedown, in outer units. A
  // "click" on a base/background is only honored when this stays small,
  // so panning a little before releasing over a base doesn't select it.
  let dragDistance = 0;

  function onMouseDown(evt) {
    if (evt.button !== 0) return;
    dragging = true;
    dragStart = { outer: outerPointFromEvent(evt), x: view.x, y: view.y };
    dragDistance = 0;
    viewportContainer.classList.add("dragging");
  }

  function onMouseMove(evt) {
    const outer = outerPointFromEvent(evt);

    if (dragging && dragStart) {
      view.x = dragStart.x + (outer.x - dragStart.outer.x);
      view.y = dragStart.y + (outer.y - dragStart.outer.y);
      applyTransform();
      dragDistance = Math.max(
        dragDistance,
        Math.hypot(outer.x - dragStart.outer.x, outer.y - dragStart.outer.y)
      );
    }

    const inner = outerToInner(outer);
    const tileX = Math.floor(inner.x / TILE_PX);
    const tileY = Math.floor(inner.y / TILE_PX);
    if (tileX >= 0 && tileX < MAP_TILES && tileY >= 0 && tileY < MAP_TILES) {
      tileReadout.textContent = `Tile: (${tileX}, ${tileY})`;
    } else {
      tileReadout.textContent = "Tile: —";
    }
  }

  function endDrag() {
    dragging = false;
    dragStart = null;
    viewportContainer.classList.remove("dragging");
  }

  function wasClick() {
    return dragDistance < CLICK_MOVE_THRESHOLD;
  }

  function onHoverBase(block, tileX, tileY, entering) {
    if (!entering) {
      updateStats();
      return;
    }
    statReadout.textContent = `${block.label} — tiles (${tileX}–${tileX + BASE_BLOCK - 1}, ${tileY}–${tileY + BASE_BLOCK - 1})`;
  }

  function updateStats() {
    if (!currentLayout) return;
    const total = currentLayout.blocks.length;
    const tilesUsed = total * BASE_BLOCK * BASE_BLOCK;
    statReadout.textContent = `Bases: ${total} · Tiles used: ${tilesUsed} / ${MAP_TILES * MAP_TILES}`;
  }

  /* ----- edit mode: click-to-select / click-to-place swap, and rename ----- */

  function setEditMode(on) {
    editMode = on;
    btnEditMode.classList.toggle("btn-active", editMode);
    btnEditMode.textContent = editMode ? "Editing… (click two bases)" : "Edit Layout";
    if (!editMode) clearSelection();
  }

  function clearSelection() {
    selectedBlock = null;
    Render.drawSelectionHighlight(layers.selection, null, currentOffset);
  }

  // Swaps the identity (name + tier) of two blocks in place. Their grid
  // positions never move, so the hive stays exactly as packed as before —
  // there is no way for a swap to open a gap or create an overlap.
  function swapBlockIdentity(a, b) {
    const label = a.label;
    const tier = a.tier;
    a.label = b.label;
    a.tier = b.tier;
    b.label = label;
    b.tier = tier;
  }

  function redrawHive() {
    if (!currentLayout || !currentOffset) return;
    Render.redrawHive(layers.hive, currentLayout.blocks, currentOffset, {
      onHover: onHoverBase,
      onClick: onBaseClick,
      onDblClick: onBaseRename,
    });
    Render.drawSelectionHighlight(layers.selection, selectedBlock, currentOffset);
  }

  function onBaseClick(block) {
    if (!editMode || !wasClick()) return;

    if (!selectedBlock) {
      selectedBlock = block;
      Render.drawSelectionHighlight(layers.selection, selectedBlock, currentOffset);
      return;
    }

    if (selectedBlock === block) {
      clearSelection();
      return;
    }

    swapBlockIdentity(selectedBlock, block);
    selectedBlock = null;
    redrawHive();
  }

  // A custom overlay stands in for window.prompt(): sandboxed hosts (an
  // Artifact preview iframe, for instance) silently swallow native
  // dialogs, so this is the only version guaranteed to actually appear.
  function onBaseRename(block) {
    renamingBlock = block;
    renameInput.value = block.label;
    renameBackdrop.classList.remove("hidden");
    renameInput.focus();
    renameInput.select();
  }

  function closeRenameModal() {
    renamingBlock = null;
    renameBackdrop.classList.add("hidden");
  }

  function confirmRename() {
    if (!renamingBlock) return;
    const trimmed = renameInput.value.trim();
    if (trimmed && trimmed !== renamingBlock.label) {
      renamingBlock.label = trimmed;
      redrawHive();
    }
    closeRenameModal();
  }

  function onBackgroundClick() {
    if (editMode && wasClick() && selectedBlock) clearSelection();
  }

  function resetView() {
    view = { scale: 1, x: 0, y: 0 };
    applyTransform();
  }

  function readTierCounts() {
    const clampCount = (v, fallback) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
      R3: clampCount(inputR3.value, DEFAULT_TIER_COUNTS.R3),
      R2: clampCount(inputR2.value, DEFAULT_TIER_COUNTS.R2),
      R1: clampCount(inputR1.value, DEFAULT_TIER_COUNTS.R1),
    };
  }

  function regenerate() {
    const tierCounts = readTierCounts();
    currentLayout = Layout.generateLayout({ coreBases: CORE_BASES, tierCounts });
    clearSelection();
    currentOffset = Render.renderAll(layers, currentLayout, {
      onHover: onHoverBase,
      onClick: onBaseClick,
      onDblClick: onBaseRename,
    });
    updateStats();
  }

  function toggleGrid() {
    const visible = layers.grid.style.display !== "none";
    layers.grid.style.display = visible ? "none" : "";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Clones the live SVG with the pan/zoom transform reset to identity, so
  // exports always capture the full blueprint regardless of current view.
  function buildExportSvgString(widthPx, heightPx) {
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", SVG_NS_FALLBACK());
    clone.querySelector("#viewport").setAttribute("transform", "translate(0,0) scale(1)");
    if (widthPx && heightPx) {
      clone.setAttribute("width", widthPx);
      clone.setAttribute("height", heightPx);
    }
    return new XMLSerializer().serializeToString(clone);
  }

  function SVG_NS_FALLBACK() {
    return "http://www.w3.org/2000/svg";
  }

  function exportSvg() {
    const source = buildExportSvgString();
    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, "ekey-hive-blueprint.svg");
  }

  function exportPng4k() {
    const SIZE = 3840;
    const source = buildExportSvgString(SIZE, SIZE);
    const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        downloadBlob(blob, "ekey-hive-blueprint-4k.png");
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // eslint-disable-next-line no-alert
      alert("PNG export failed to rasterize the SVG in this browser.");
    };
    img.src = url;
  }

  function init() {
    svg.addEventListener("wheel", onWheel, { passive: false });
    viewportContainer.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endDrag);
    viewportContainer.addEventListener("mouseleave", () => {
      tileReadout.textContent = "Tile: —";
    });
    backgroundRect.addEventListener("click", onBackgroundClick);
    window.addEventListener("keydown", (evt) => {
      if (evt.key !== "Escape") return;
      if (renamingBlock) {
        closeRenameModal();
      } else {
        clearSelection();
      }
    });

    document.getElementById("btn-regenerate").addEventListener("click", regenerate);
    btnEditMode.addEventListener("click", () => setEditMode(!editMode));
    document.getElementById("btn-grid").addEventListener("click", toggleGrid);
    document.getElementById("btn-reset-view").addEventListener("click", resetView);
    document.getElementById("btn-export-svg").addEventListener("click", exportSvg);
    document.getElementById("btn-export-png").addEventListener("click", exportPng4k);

    renameConfirmBtn.addEventListener("click", confirmRename);
    renameCancelBtn.addEventListener("click", closeRenameModal);
    renameBackdrop.addEventListener("click", (evt) => {
      if (evt.target === renameBackdrop) closeRenameModal();
    });
    renameInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") confirmRename();
    });

    regenerate();
    applyTransform();
  }

  return { init, regenerate };
})();

document.addEventListener("DOMContentLoaded", App.init);
