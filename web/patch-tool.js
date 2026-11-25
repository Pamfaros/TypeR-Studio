/*
 * TypeR Studio - Patch Tool
 *
 * The controller owns pointer gestures, selection paths, a fast Normal
 * pixel preview, options and cancellation. photoshop.js owns mutations,
 * history, raster snapshots and the Poisson engine dispatch.
 *
 * Source mode samples from the dragged-to location into the original area.
 * Target mode writes the selected source at the dragged-to location.
 */
(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const UI = window.TypeRApp;
  if (!PS || !UI || !PS.ops || !PS.app) {
    throw new Error("Patch Tool requires photoshop.js and app.js to be loaded first.");
  }

  const { app, ops } = PS;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STORAGE_KEY = "typer.web.patch.options.v3";
  const MAX_FEATHER = 32;
  const PREVIEW_INTERVAL = 90;
  const MAX_PREVIEW_PIXELS = 800000;
  const MODES = new Set(["normal", "poisson", "adaptive", "healing"]);
  const DIRECTIONS = new Set(["source", "target"]);
  const SAMPLES = new Set(["current", "below", "all"]);

  const settings = { blend: "healing", direction: "source", sample: "current", feather: 1 };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const previous = stored || JSON.parse(
      localStorage.getItem("typer.web.patch.options.v2") || "null");
    // Keep the previous sampling preference, but introduce Healing as the
    // default mode with a narrow edge for existing Adaptive Heal users.
    if (stored && MODES.has(stored.blend)) settings.blend = stored.blend;
    if (stored && DIRECTIONS.has(stored.direction)) settings.direction = stored.direction;
    if (previous && SAMPLES.has(previous.sample)) settings.sample = previous.sample;
    if (stored && Number.isInteger(stored.feather)) {
      settings.feather = Math.max(0, Math.min(MAX_FEATHER, stored.feather));
    }
  } catch (_) {
    // Storage is optional in private browsing and embedded environments.
  }

  let activeJob = null;
  let previewImage = null;
  let pathFrame = 0;
  let pathWanted = "";
  let previewTimer = 0;
  let previewToken = 0;
  let lastPreview = 0;
  let currentGesture = null;
  let previewDisabled = false;
  let previewController = null;

  const docOf = () => app.doc;
  const stageOf = () => document.getElementById("stage");
  const clamp = (value, a, b) => Math.max(a, Math.min(b, value));
  const T = (value) => typeof UI.T === "function" ? UI.T(value) : value;

  function report(message, error = false) {
    if (typeof UI.toast === "function") UI.toast(T(message), error);
    else if (error) console.error(message);
  }

  function setCursor(value) {
    const stage = stageOf();
    if (stage) stage.style.cursor = value;
  }

  function persistSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) {
      // Tool preferences remain available for this browser session.
    }
  }

  function setPath(path) {
    if (typeof UI.setDrag === "function") {
      UI.setDrag(path);
      return;
    }
    const front = document.getElementById("drag");
    const back = document.getElementById("drag-b");
    if (front) front.setAttribute("d", path);
    if (back) back.setAttribute("d", path);
  }

  function schedulePath(path) {
    pathWanted = path;
    if (pathFrame) return;
    pathFrame = requestAnimationFrame(() => {
      pathFrame = 0;
      setPath(pathWanted);
    });
  }

  function clearPath() {
    if (pathFrame) cancelAnimationFrame(pathFrame);
    pathFrame = 0;
    pathWanted = "";
    setPath("");
  }

  function clearPixelPreview() {
    ++previewToken;
    if (previewController) previewController.abort();
    previewController = null;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = 0;
    if (previewImage) {
      previewImage.remove();
      previewImage = null;
    }
  }

  function clearPreview() {
    clearPath();
    clearPixelPreview();
  }

  function pathOf(points, closed = false) {
    if (!Array.isArray(points) || !points.length) return "";
    let d = `M${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      d += `L${points[i][0]} ${points[i][1]}`;
    }
    return closed && points.length >= 3 ? d + "Z" : d;
  }

  function selectionPath(selection, dx, dy) {
    if (!selection || !Array.isArray(selection.rings)) return "";
    return selection.rings.map((ring) => pathOf(
      ring.map((point) => [point[0] + dx, point[1] + dy]), true
    )).join("");
  }

  function areaOf(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      sum += a[0] * b[1] - a[1] * b[0];
    }
    return Math.abs(sum) / 2;
  }

  function clampPoint(doc, point) {
    return [clamp(point[0], 0, doc.width), clamp(point[1], 0, doc.height)];
  }

  function addPoint(gesture, point, event, force = false) {
    const next = clampPoint(gesture.doc, point);
    const previous = gesture.points[gesture.points.length - 1];
    if (previous && Math.hypot(next[0] - previous[0], next[1] - previous[1]) < 0.01) return;
    const screen = gesture.lastScreen;
    if (!force && screen &&
        Math.hypot(event.clientX - screen[0], event.clientY - screen[1]) < 2) return;
    gesture.points.push(next);
    gesture.lastScreen = [event.clientX, event.clientY];
  }

  function offsetOf(gesture, point, shift) {
    const bounds = gesture.selection.bounds;
    const doc = gesture.doc;
    let dx = Math.round(point[0] - gesture.start[0]);
    let dy = Math.round(point[1] - gesture.start[1]);
    if (shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    dx = clamp(dx, Math.ceil(-bounds.left), Math.floor(doc.width - bounds.right));
    dy = clamp(dy, Math.ceil(-bounds.top), Math.floor(doc.height - bounds.bottom));
    return [dx, dy];
  }

  function rasterLayer() {
    const layer = typeof UI.activeLayer === "function" ? UI.activeLayer() : null;
    return layer && layer.kind === "raster" && !layer.adjustment ? layer : null;
  }

  function ensurePreviewNode() {
    const group = document.getElementById("over-doc");
    if (!group || !group.namespaceURI || group.namespaceURI !== SVG_NS) return null;
    if (!previewImage || previewImage.parentNode !== group) {
      previewImage = document.createElementNS(SVG_NS, "image");
      previewImage.setAttribute("id", "patch-live-preview");
      previewImage.setAttribute("preserveAspectRatio", "none");
      previewImage.setAttribute("pointer-events", "none");
      previewImage.style.pointerEvents = "none";
      previewImage.style.opacity = "0.94";
      group.insertBefore(previewImage, group.firstChild);
    }
    return previewImage;
  }

  async function showPixelPreview(gesture, offset, token) {
    if (token !== previewToken || !currentGesture || currentGesture !== gesture ||
        app.tool !== "patch" || gesture.doc !== docOf()) return;
    const sample = ops.patchSample;
    if (typeof sample !== "function") return;
    try {
      const controller = previewController;
      const result = await sample({
        doc: gesture.doc,
        layerId: gesture.layerId,
        selection: gesture.selection,
        offset: { dx: offset[0], dy: offset[1] },
        sample: gesture.options.sample,
        blend: gesture.options.blend,
        direction: gesture.options.direction,
        feather: gesture.options.feather,
        signal: controller?.signal
      });
      if (!result || token !== previewToken || controller?.signal.aborted ||
          gesture.doc !== docOf() || app.tool !== "patch") return;
      const { region, imageData, hardMask } = result;
      if (!hardMask || imageData.width * imageData.height > MAX_PREVIEW_PIXELS) {
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const copy = new ImageData(new Uint8ClampedArray(imageData.data),
        imageData.width, imageData.height);
      for (let p = 0, i = 0; p < hardMask.length; p++, i += 4) {
        if (!hardMask[p]) copy.data[i + 3] = 0;
      }
      canvas.getContext("2d").putImageData(copy, 0, 0);
      const image = ensurePreviewNode();
      if (!image || token !== previewToken) return;
      image.setAttribute("x", region.left);
      image.setAttribute("y", region.top);
      image.setAttribute("width", region.width);
      image.setAttribute("height", region.height);
      // A translucent overlay would reveal the unwanted target text again.
      image.style.opacity = "1";
      image.setAttribute("href", canvas.toDataURL("image/png"));
    } catch (error) {
      if (!previewDisabled) console.warn("Patch Tool pixel preview unavailable:", error);
      previewDisabled = true;
      clearPixelPreview();
    }
  }

  function schedulePixelPreview(gesture, offset) {
    if (previewDisabled || !ops.patchSample ||
        (offset[0] === 0 && offset[1] === 0)) {
      if (previewImage) {
        previewImage.remove();
        previewImage = null;
      }
      return;
    }
    const token = ++previewToken;
    if (previewController) previewController.abort();
    previewController = new AbortController();
    if (previewTimer) clearTimeout(previewTimer);
    const delay = Math.max(0, PREVIEW_INTERVAL - (performance.now() - lastPreview));
    previewTimer = setTimeout(() => {
      previewTimer = 0;
      lastPreview = performance.now();
      showPixelPreview(gesture, offset, token);
    }, delay);
  }

  function down(event, point, base) {
    const doc = docOf();
    if (!doc || activeJob || event.button !== 0) return null;
    if (!Array.isArray(point) || point.length !== 2) return null;
    const selected = doc.state.selection;
    const inside = Boolean(selected && ops.selectionContains &&
      ops.selectionContains(point[0], point[1]));
    clearPreview();
    previewDisabled = false;
    // Keyboard modifiers override the touch toolbar's selection mode for this stroke.
    const touchMode = window.TypeRShell?.touch ? app.selectionMode : "new";
    const selectionMode = event.shiftKey && event.altKey ? "intersect"
      : event.shiftKey ? "add" : event.altKey ? "subtract" : touchMode;
    if (inside && selectionMode === "new") {
      const layer = rasterLayer();
      if (!layer) {
        report("Select an unlocked raster layer before applying a patch.", true);
        return null;
      }
      const gesture = {
        ...base, kind: "patch", phase: "dragging", doc,
        selection: selected, layerId: layer.id,
        offset: [0, 0], options: { ...settings }
      };
      currentGesture = gesture;
      setCursor("move");
      return gesture;
    }
    const gesture = {
      ...base, kind: "patch", phase: "selecting", doc,
      points: [clampPoint(doc, point)],
      selectionMode,
      lastScreen: [event.clientX, event.clientY]
    };
    currentGesture = gesture;
    setCursor("crosshair");
    return gesture;
  }

  function move(gesture, event, point) {
    if (!gesture || gesture.doc !== docOf()) {
      cancel(gesture, "document-change");
      return;
    }
    // app.js clones the returned gesture; use its pointer identity, not object identity.
    currentGesture = gesture;
    gesture.last = point;
    if (gesture.phase === "selecting") {
      addPoint(gesture, point, event);
      schedulePath(pathOf(gesture.points));
      return;
    }
    if (gesture.phase === "dragging") {
      const offset = offsetOf(gesture, point, event.shiftKey);
      gesture.offset = offset;
      schedulePath(selectionPath(gesture.selection, offset[0], offset[1]));
      schedulePixelPreview(gesture, offset);
    }
  }

  function finishSelection(gesture, event, point) {
    addPoint(gesture, point, event, true);
    clearPreview();
    if (gesture.points.length < 3 || areaOf(gesture.points) < 4) return false;
    if (typeof ops.patchSelect !== "function") {
      throw new Error("Missing ops.patchSelect() in photoshop.js.");
    }
    return Boolean(ops.patchSelect(gesture.points, gesture.selectionMode || "new"));
  }

  async function finishDrag(gesture, event, point) {
    if (gesture.doc !== docOf() ||
        gesture.doc.state.selection !== gesture.selection) return false;
    const offset = offsetOf(gesture, point, event.shiftKey);
    clearPreview();
    if (!offset[0] && !offset[1]) return false;
    if (typeof ops.patchCommit !== "function") {
      throw new Error("Missing ops.patchCommit() in photoshop.js.");
    }
    const controller = new AbortController();
    const job = { controller, doc: gesture.doc, id: gesture.layerId };
    activeJob = job;
    setCursor("progress");
    if (typeof UI.renderOptions === "function") UI.renderOptions();
    try {
      const applied = await ops.patchCommit({
        doc: gesture.doc,
        layerId: gesture.layerId,
        selection: gesture.selection,
        offset: { dx: offset[0], dy: offset[1] },
        ...gesture.options,
        signal: controller.signal
      });
      if (!controller.signal.aborted && applied === false) {
        report("Patch could not be applied. Check the layer, source area and selection.", true);
      }
      return applied;
    } finally {
      if (activeJob === job) {
        activeJob = null;
        setCursor(app.tool === "patch" ? "crosshair" : "");
        if (typeof UI.renderOptions === "function") UI.renderOptions();
      }
    }
  }

  async function up(gesture, event, point, cancelled) {
    if (!gesture || gesture.kind !== "patch") return false;
    currentGesture = null;
    if (cancelled || gesture.doc !== docOf()) {
      cancel(gesture, "pointer-cancel");
      return false;
    }
    if (gesture.phase === "selecting") {
      return finishSelection(gesture, event, point);
    }
    if (gesture.phase === "dragging") {
      return finishDrag(gesture, event, point);
    }
    return false;
  }

  function cancel(_gesture, reason = "cancel") {
    if (activeJob) {
      activeJob.controller.abort(reason);
      activeJob = null;
    }
    currentGesture = null;
    clearPreview();
    setCursor(app.tool === "patch" ? "crosshair" : "");
    if (typeof UI.renderOptions === "function") UI.renderOptions();
    return true;
  }

  function toolChosen(tool) {
    if (tool !== "patch") cancel(null, "tool-change");
    else if (!activeJob) setCursor("crosshair");
  }

  function documentChanged() {
    cancel(null, "document-change");
  }

  function hover(_event, point) {
    if (app.tool !== "patch" || activeJob || currentGesture) return;
    const doc = docOf();
    const inside = Boolean(doc && doc.state.selection && ops.selectionContains &&
      ops.selectionContains(point[0], point[1]));
    setCursor(inside ? "move" : "crosshair");
  }

  function key(event) {
    if (event.key !== "Escape" || app.tool !== "patch") return false;
    if (activeJob) {
      cancel(null, "escape");
      return true;
    }
    if (docOf()?.state.selection && typeof ops.deselect === "function") {
      clearPreview();
      ops.deselect();
      return true;
    }
    return false;
  }

  function options(bar) {
    const group = document.createElement("span");
    group.className = "obar__group";
    const busy = Boolean(activeJob);

    function field(label, value, choices, update) {
      const wrap = document.createElement("label");
      wrap.className = "patch-option";
      const caption = document.createElement("span");
      caption.textContent = T(label) + " ";
      const input = document.createElement("select");
      input.setAttribute("aria-label", T(label));
      input.disabled = busy;
      for (const [key, text] of choices) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = T(text);
        input.appendChild(option);
      }
      input.value = value;
      input.addEventListener("change", () => {
        update(input.value);
        persistSettings();
      });
      wrap.append(caption, input);
      group.appendChild(wrap);
    }

    field("Mode", settings.blend,
      [["healing", "Seamless Healing"],
       ["normal", "Normal"], ["poisson", "Legacy Poisson"],
       ["adaptive", "Adaptive Heal (Experimental)"]],
      (value) => { if (MODES.has(value)) settings.blend = value; });
    field("Direction", settings.direction,
      [["source", "Source"], ["target", "Target"]],
      (value) => { if (DIRECTIONS.has(value)) settings.direction = value; });
    field("Sample", settings.sample,
      [["current", "Current Layer"], ["below", "Current and Below"],
       ["all", "All Layers"]],
      (value) => { if (SAMPLES.has(value)) settings.sample = value; });

    const wrap = document.createElement("label");
    wrap.className = "patch-option";
    wrap.textContent = T("Feather") + " ";
    const feather = document.createElement("input");
    feather.type = "number";
    feather.min = "0";
    feather.max = String(MAX_FEATHER);
    feather.step = "1";
    feather.disabled = busy;
    feather.value = String(settings.feather);
    feather.style.width = "60px";
    feather.setAttribute("aria-label", T("Feather"));
    feather.addEventListener("change", () => {
      const value = Number(feather.value);
      settings.feather = Number.isFinite(value)
        ? clamp(Math.round(value), 0, MAX_FEATHER) : 3;
      feather.value = String(settings.feather);
      persistSettings();
    });
    wrap.appendChild(feather);
    group.appendChild(wrap);
    bar.appendChild(group);
  }

  function drawOverlay() {
    // Raster preview is rendered as an SVG image under the existing overlay paths.
  }

  window.TypeRPatchTool = Object.freeze({
    down, move, up, cancel, toolChosen, documentChanged,
    hover, key, options, drawOverlay
  });
})();
