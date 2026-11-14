// Photoshop's Styles panel (Window > Styles): layer styles kept by name, each given to the
// selected layers with a click, and Photoshop's own .asl files loaded and saved.
//
//   a style    { id, name, effects?, stroke?, blending?, group? }: the layer's effects as photoshop.js
//              draws them (FX_DEFAULTS), its stroke, and its Blending Options ({ blend, opacity,
//              fill }, in %) when it was kept with them. Without blending, a style leaves the
//              layer's own as they are, as Photoshop's do. `group`: the id of its group.
//   a group    { id, name, open, parent? }: a folder of styles, as Photoshop's style groups,
//              folded or not, inside another one when it has a parent. In the panel a group
//              shows its styles, then its groups; the styles in none come first. A style or a
//              group is dragged into a group (onto its name), before a style, or out of them.
//   the store  the user's styles and groups, in localStorage (typer.web.styles); the view (thumbnails or
//              list) in typer.web.styles.view
//   applying   on the selected text and pixel layers, one step of history ("Apply Style"); it
//              replaces their style, as in Photoshop; Shift adds its effects to theirs. No Style
//              clears it ("Clear Layer Style"). Both are recorded by the Actions panel as
//              Photoshop records them (actions.js).
//   files      Export Styles… writes TypeR's own .json (every setting kept) or Photoshop's .asl;
//              Import Styles… reads both, with their groups; a file without any comes in as a
//              group of its name, as in Photoshop. From an .asl, what TypeR doesn't draw (Bevel &
//              Emboss, Satin, Pattern Overlay…) is left out and said (asl.js).
//   thumbnails "Aa" drawn by photoshop.js itself with the style, its sizes brought down when
//              they would not fit

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const A = window.TypeRApp;
  const ASL = window.TypeRASL;
  if (!PS || !A || !A.actions || !ASL) return;
  const { ops, app } = PS;
  const host = A.actions;
  const { T, fill } = A;
  const Shell = window.TypeRShell || {};
  const $ = (id) => document.getElementById(id);
  const STORE = "typer.web.styles";
  const STORE_VIEW = "typer.web.styles.view";
  const MAX_STYLES = 1000;
  const FX_NAMES = PS.FX_ORDER;

  const make = (tag, className, parent, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  };
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /* --------------------------------- a style --------------------------------- */

  // A style as it was kept, read, or loaded from a file: only what TypeR knows, each value
  // checked, so that what comes from an older version or another file can't break a layer
  const finite = (value, low, high, fallback) => (typeof value === "number" && Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback);
  const byte = (value) => Math.round(finite(value, 0, 255, 0));
  const colorOf = (c, fallback) => (c && typeof c === "object" ? { r: byte(c.r), g: byte(c.g), b: byte(c.b) } : clone(fallback));
  const blendOf = (name, fallback = "normal") => (typeof name === "string" && PS.BLENDS[name] && name !== "pass through" ? name : fallback);
  // A gradient's settings: Gradient Overlay's, a stroke's with Fill Type Gradient
  const cleanGradient = (given) => {
    const out = { stops: PS.fxDefault("gradientOverlay").stops };
    const stops = (Array.isArray(given.stops) ? given.stops : []).filter((stop) => stop && typeof stop === "object")
      .map((stop) => ({ at: finite(stop.at, 0, 1, 0), r: byte(stop.r), g: byte(stop.g), b: byte(stop.b), a: finite(stop.a, 0, 1, 1) }))
      .sort((a, b) => a.at - b.at);
    if (stops.length >= 2) out.stops = stops;
    out.style = ["linear", "radial", "angle", "reflected", "diamond"].includes(given.style) ? given.style : "linear";
    out.angle = finite(given.angle, -360, 360, 90);
    out.scale = finite(given.scale, 10, 150, 100);
    out.reverse = Boolean(given.reverse);
    return out;
  };
  const cleanEffect = (name, given) => {
    if (!given || typeof given !== "object") return null;
    const out = PS.fxDefault(name);
    out.enabled = given.enabled !== false;
    out.blend = blendOf(given.blend);
    out.opacity = finite(given.opacity, 0, 100, out.opacity);
    if ("color" in out) out.color = colorOf(given.color, out.color);
    ["angle"].forEach((key) => { if (key in out) out[key] = finite(given[key], -360, 360, out[key]); });
    ["distance", "size"].forEach((key) => { if (key in out) out[key] = finite(given[key], 0, 5000, out[key]); });
    ["spread", "choke"].forEach((key) => { if (key in out) out[key] = finite(given[key], 0, 100, out[key]); });
    if (name === "dropShadow" && given.knockout === false) out.knockout = false;
    if (name === "gradientOverlay") Object.assign(out, cleanGradient(given));
    return out;
  };
  const cleanStroke = (given) => {
    if (!given || typeof given !== "object" || !(finite(given.size, 0, 5000, 0) > 0)) return null;
    const out = {
      enabled: given.enabled !== false,
      size: finite(given.size, 0, 5000, 3),
      opacity: finite(given.opacity, 0, 100, 100),
      position: ["outer", "inner", "center"].includes(given.position) ? given.position : "outer",
      color: colorOf(given.color, { r: 0, g: 0, b: 0 }),
    };
    if (given.fill === "gradient" && given.gradient && typeof given.gradient === "object") Object.assign(out, { fill: "gradient", gradient: cleanGradient(given.gradient) });
    if (given.outer && typeof given.outer === "object" && finite(given.outer.size, 0, 5000, 0) > 0) {
      out.outer = { size: finite(given.outer.size, 0, 5000, 0), color: colorOf(given.outer.color, { r: 0, g: 0, b: 0 }) };
      if (finite(given.outer.opacity, 0, 100, 100) < 100) out.outer.opacity = finite(given.outer.opacity, 0, 100, 100);
    }
    return out;
  };
  const cleanStyle = (given) => {
    if (!given || typeof given !== "object") return null;
    const style = { id: typeof given.id === "string" && given.id ? given.id.slice(0, 64) : newId(), name: String(given.name || T("Style")).slice(0, 120) };
    const effects = {};
    if (given.effects && typeof given.effects === "object") FX_NAMES.forEach((name) => {
      const one = cleanEffect(name, given.effects[name]);
      if (one) effects[name] = one;
    });
    if (Object.keys(effects).length) style.effects = effects;
    const stroke = cleanStroke(given.stroke);
    if (stroke) style.stroke = stroke;
    const b = given.blending;
    if (b && typeof b === "object") style.blending = { blend: blendOf(b.blend), opacity: finite(b.opacity, 0, 100, 100), fill: finite(b.fill, 0, 100, 100) };
    if (typeof given.group === "string" && given.group) style.group = given.group.slice(0, 64);
    return style;
  };
  const cleanGroup = (given) => {
    if (!given || typeof given !== "object") return null;
    const group = { id: typeof given.id === "string" && given.id ? given.id.slice(0, 64) : newId(), name: String(given.name || T("Group")).slice(0, 120), open: given.open !== false };
    if (typeof given.parent === "string" && given.parent) group.parent = given.parent.slice(0, 64);
    return group;
  };
  // What a style draws: its look, without its name (two styles alike, a layer that has it)
  const lookOf = (style) => JSON.stringify([style.effects || null, style.stroke || null, style.blending || null]);
  const isEmpty = (style) => !style.effects && !style.stroke;

  // Photoshop's look of TypeR's built-in gradients (the Layer Style dialog's)
  const stops = (...list) => list.map(([at, r, g, b]) => ({ at, r, g, b, a: 1 }));
  const defaultStyles = () => [
    { name: T("White Stroke"), stroke: { size: 4, color: { r: 255, g: 255, b: 255 } } },
    { name: T("Black Stroke"), stroke: { size: 3, color: { r: 0, g: 0, b: 0 } } },
    { name: T("Double Stroke"), stroke: { size: 4, color: { r: 255, g: 255, b: 255 }, outer: { size: 3, color: { r: 0, g: 0, b: 0 } } } },
    { name: T("Soft Shadow"), effects: { dropShadow: { blend: "multiply", color: { r: 0, g: 0, b: 0 }, opacity: 60, angle: 120, distance: 4, spread: 0, size: 8 } } },
    { name: T("White Glow"), effects: { outerGlow: { blend: "normal", color: { r: 255, g: 255, b: 255 }, opacity: 100, spread: 30, size: 10 } } },
    { name: T("Gold"), stroke: { size: 3, color: { r: 74, g: 42, b: 0 } }, effects: { gradientOverlay: { stops: stops([0, 120, 76, 4], [0.45, 255, 230, 150], [0.55, 196, 140, 30], [1, 110, 66, 0]), style: "linear", angle: 90 }, dropShadow: { blend: "multiply", color: { r: 0, g: 0, b: 0 }, opacity: 50, angle: 120, distance: 3, size: 4 } } },
    { name: T("Fire"), stroke: { size: 3, color: { r: 90, g: 10, b: 0 } }, effects: { gradientOverlay: { stops: stops([0, 122, 8, 0], [0.5, 255, 72, 0], [1, 255, 214, 64]), style: "linear", angle: 90 }, outerGlow: { blend: "screen", color: { r: 255, g: 120, b: 0 }, opacity: 75, spread: 0, size: 12 } } },
    { name: T("Neon"), effects: { colorOverlay: { blend: "normal", color: { r: 240, g: 255, b: 255 }, opacity: 100 }, outerGlow: { blend: "screen", color: { r: 0, g: 216, b: 255 }, opacity: 100, spread: 15, size: 14 }, innerGlow: { blend: "normal", color: { r: 0, g: 216, b: 255 }, opacity: 60, choke: 0, size: 4 } } },
  ].map((style, at) => cleanStyle(Object.assign({ id: `default-${at}` }, style)));

  /* --------------------------------- the store --------------------------------- */

  const load = () => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORE));
      if (saved && Array.isArray(saved.styles)) return { styles: saved.styles.map(cleanStyle).filter(Boolean), groups: (Array.isArray(saved.groups) ? saved.groups : []).map(cleanGroup).filter(Boolean) };
    } catch (error) {
      console.warn("TypeR web: could not read the styles", error);
    }
    return { styles: defaultStyles(), groups: [] };
  };
  let { styles, groups } = load();

  /* --------------------------------- the groups --------------------------------- */

  const groupById = (id) => (id ? groups.find((group) => group.id === id) || null : null);
  // Inside `ancestor`, or it
  const within = (id, ancestor) => {
    const seen = new Set();
    for (let group = groupById(id); group && !seen.has(group.id); group = groupById(group.parent)) {
      if (group.id === ancestor) return true;
      seen.add(group.id);
    }
    return false;
  };
  // Every reference kept true: a parent or a group that isn't there any more, a group inside
  // itself, are let go
  const tidyGroups = () => {
    groups.forEach((group) => {
      if (group.parent && (!groupById(group.parent) || within(group.parent, group.id))) delete group.parent;
    });
    styles.forEach((style) => { if (style.group && !groupById(style.group)) delete style.group; });
  };
  tidyGroups();
  const groupsIn = (parent) => groups.filter((group) => (group.parent || null) === parent);
  const stylesIn = (parent) => styles.filter((style) => (style.group || null) === parent);
  const countIn = (id) => styles.filter((style) => style.group && within(style.group, id)).length;
  // The panel's order, as the files keep it: a container's styles, then its groups, each with
  // what it holds. `keep(style)` picks the styles; a group with none of them is left out
  // unless `empty`. Visits { style }, { group }, { end }.
  const walk = (parent, visit, keep = () => true, empty = true) => {
    stylesIn(parent).forEach((style) => { if (keep(style)) visit({ style }); });
    groupsIn(parent).forEach((group) => {
      if (!empty && !styles.some((style) => keep(style) && style.group && within(style.group, group.id))) return;
      visit({ group });
      walk(group.id, visit, keep, empty);
      visit({ end: group });
    });
  };
  // A name not taken by another group beside it: "Group 2"
  const groupName = (base, parent, except = null) => {
    const taken = new Set(groupsIn(parent || null).filter((group) => group !== except).map((group) => group.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  };
  let view = "small";
  try {
    const kept = window.localStorage.getItem(STORE_VIEW);
    if (["small", "large", "list"].includes(kept)) view = kept;
  } catch (error) {
    // The thumbnails, then
  }
  let saveTimer = 0;
  const keep = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(STORE, JSON.stringify({ version: 1, styles, groups }));
      } catch (error) {
        console.warn("TypeR web: could not keep the styles", error);
        A.toast(T("The styles could not be kept: the browser's storage is full."), true);
      }
    }, 120);
  };
  const changed = () => {
    keep();
    render();
  };
  // "Style 3": the first number not taken
  const numbered = (base) => {
    const taken = new Set(styles.map((style) => style.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  };
  const nextName = () => {
    let n = styles.length + 1;
    while (styles.some((style) => style.name === fill(T("Style {n}"), { n }))) n++;
    return fill(T("Style {n}"), { n });
  };

  /* ------------------------------ layers and styles ------------------------------ */

  const doc = () => app.doc;
  const inSfx = (layer, d = doc()) => {
    const parent = Boolean(layer && layer.group && d) && d.state.layers.find((item) => item.id === layer.group);
    return Boolean(parent && parent.sfx);
  };
  // The layers a style goes on: texts (not an SFX's letters, which its recipe draws again) and
  // pixel layers, unlocked, not the Background
  const canTake = (layer) => (layer.kind === "text" && !inSfx(layer)) || (layer.kind === "raster" && !layer.adjustment && !layer.isBackground);
  const refusal = (layers) => {
    if (!doc()) return T("Open a page first.");
    if (!layers.length) return T("Select a text or pixel layer first.");
    if (layers.some((layer) => layer.kind === "text" && inSfx(layer))) return T("An SFX's letters take their look from the SFX: change it in the SFX panel.");
    if (layers.some((layer) => layer.isBackground)) return T("The Background can't take a style: make it a normal layer first.");
    if (layers.every((layer) => layer.locked)) return T("This layer is locked.");
    return T("A style goes on text and pixel layers.");
  };

  // A layer's style, as a style keeps it. Pattern Overlays are left out: their pattern belongs
  // to the file the layer came from.
  const styleOfLayer = (layer, withEffects = true, withBlending = true) => {
    const style = {};
    if (withEffects) {
      const effects = {};
      FX_NAMES.forEach((name) => { if (layer.effects && layer.effects[name]) effects[name] = clone(layer.effects[name]); });
      if (Object.keys(effects).length) style.effects = effects;
      if (layer.stroke && layer.stroke.size > 0) style.stroke = clone(layer.stroke);
    }
    if (withBlending) style.blending = { blend: blendOf(layer.blend), opacity: Math.round(finite(layer.opacity, 0, 1, 1) * 1000) / 10, fill: Math.round(PS.fillOf(layer) * 1000) / 10 };
    return style;
  };
  // The layer with the style given: its effects and stroke replaced (with `add`, the style's go
  // over the layer's own), its blending too when the style has some. `null`: No Style.
  const styledLayer = (layer, style, add) => {
    const next = Object.assign({}, layer);
    if (!style) Object.assign(next, { stroke: null, effects: undefined, blend: "normal", opacity: 1, knockout: false, fill: undefined });
    else {
      const effects = add ? Object.assign({}, layer.effects, clone(style.effects)) : clone(style.effects);
      next.effects = effects && Object.keys(effects).length ? effects : undefined;
      next.stroke = style.stroke ? clone(style.stroke) : add ? layer.stroke : null;
      if (style.blending) {
        const f = style.blending.fill / 100;
        Object.assign(next, { blend: style.blending.blend, opacity: style.blending.opacity / 100, knockout: f <= 0, fill: f > 0 && f < 1 ? f : undefined });
      }
    }
    if (!next.stroke) next.stroke = layer.kind === "raster" ? undefined : null;
    // The style replaces the whole of the file's, as in Photoshop: its Bevel & Emboss, Satin,
    // Pattern Overlay… (which TypeR keeps in the file but doesn't draw) go too. Added with Shift,
    // they stay.
    if (!add && layer.raw && layer.raw.effects) {
      next.raw = Object.assign({}, layer.raw);
      delete next.raw.effects;
    }
    // A text's own pixels (Photoshop's) hold its stroke: drawn again when the stroke changes
    if (layer.kind === "text" && JSON.stringify(next.stroke || null) !== JSON.stringify(layer.stroke || null)) next.raster = null;
    return next;
  };
  const sameLook = (a, b) => ["effects", "stroke", "blend", "opacity", "knockout", "fill"].every((key) => JSON.stringify(a[key] === undefined ? null : a[key]) === JSON.stringify(b[key] === undefined ? null : b[key]));

  // A click on a style: on the selected layers that can take it, one step of history
  const apply = (style, { add = false, quiet = false } = {}) => {
    const d = doc();
    if (host.modalOpen()) return 0;
    // The words being typed go in first, as before any other change of the layer
    if (A.isEditing()) A.endEdit();
    const chosen = host.activeLayers();
    const targets = chosen.filter((layer) => canTake(layer) && !layer.locked);
    if (!d || !targets.length) {
      if (!quiet && d) A.toast(refusal(chosen));
      return 0;
    }
    if (targets.length < chosen.length && !quiet) A.toast(fill(T("Given to {count} of the {total} selected layers: {why}"), { count: targets.length, total: chosen.length, why: refusal(chosen.filter((layer) => !targets.includes(layer))) }));
    const ids = new Set(targets.map((layer) => layer.id));
    let count = 0;
    const layers = d.state.layers.map((layer) => {
      if (!ids.has(layer.id)) return layer;
      const next = styledLayer(layer, style, add);
      if (sameLook(next, layer) && next.raw === layer.raw) return layer;
      count++;
      return next;
    });
    if (!count) return 0;
    ops.setLayers(layers, style ? "Apply Style" : "Clear Layer Style");
    // Recorded as Photoshop records it: the style by its name, or Clear Layer Style
    if (window.TypeRActions && window.TypeRActions.record) window.TypeRActions.record(style ? "applyStyle" : "clearStyle", style ? { name: style.name } : {});
    return count;
  };
  // An action's Apply Style: the style of that name in the panel
  const applyByName = (name) => {
    const style = styles.find((one) => one.name === name);
    if (!style) throw new Error(fill(T("There is no style named “{name}” in the Styles panel."), { name }));
    if (!host.activeLayers().some((layer) => canTake(layer) && !layer.locked)) throw new Error(refusal(host.activeLayers()));
    apply(style, { quiet: true });
  };

  /* --------------------------------- thumbnails --------------------------------- */

  // "Aa" in the default font, drawn with the style by the page's own renderer. Sizes are
  // brought down when they'd spill out of the thumbnail; the letters in a middle grey show both
  // a black stroke and a white one.
  const SAMPLE = 96;
  const REACH = 15;
  const reachOf = (style) => {
    const fx = style.effects || {};
    const s = style.stroke && style.stroke.enabled !== false ? style.stroke.size + ((style.stroke.outer && style.stroke.outer.size) || 0) : 0;
    const shown = (one) => one && one.enabled !== false;
    return Math.max(s, shown(fx.outerGlow) ? fx.outerGlow.size : 0, shown(fx.dropShadow) ? fx.dropShadow.distance + fx.dropShadow.size : 0);
  };
  const scaledLook = (style, k) => {
    if (k >= 1) return style;
    const out = clone(style);
    const fx = out.effects || {};
    ["dropShadow", "innerShadow", "outerGlow", "innerGlow"].forEach((name) => {
      if (!fx[name]) return;
      ["distance", "size"].forEach((key) => { if (key in fx[name]) fx[name][key] *= k; });
    });
    if (out.stroke) {
      out.stroke.size *= k;
      if (out.stroke.outer) out.stroke.outer.size *= k;
    }
    return out;
  };
  const sampleDoc = { id: "typer-styles-sample", width: SAMPLE, height: SAMPLE, resolution: 72, state: { layers: [], activeIds: [] }, history: [], historyIndex: 0 };
  let sampleBase = null;
  const sampleLayer = () => {
    if (sampleBase) return sampleBase;
    const d = app.textDefaults;
    const text = "Aa";
    const textStyle = { fontPostScriptName: d.font, fontName: d.family, fontStyleName: d.style, size: 62, impliedFontSize: 62, autoLeading: true, tracking: 0, horizontalScale: 100, verticalScale: 100, autoKern: "metricsKern", color: { red: 80, green: 80, blue: 80 } };
    const params = { layerText: { textKey: text, antiAlias: "antiAliasSmooth", textClickPoint: { horizontal: 50, vertical: 71 }, textStyleRange: [{ from: 0, to: text.length, textStyle }], paragraphStyleRange: [{ from: 0, to: text.length, paragraphStyle: { alignment: "center", autoLeadingPercentage: 1.2 } }], textShape: [{ textType: "point", orientation: "horizontal" }] } };
    sampleBase = PS.newTextLayer(sampleDoc, params, null, text);
    return sampleBase;
  };
  const thumbs = new Map();
  const thumbOf = (style) => {
    const key = lookOf(style);
    if (thumbs.has(key)) return thumbs.get(key);
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    try {
      const look = scaledLook(style, REACH / Math.max(REACH, reachOf(style)));
      const layer = styledLayer(sampleLayer(), look, false);
      layer.raster = null;
      const visual = PS.visualOf(layer, sampleDoc);
      if (visual && visual.canvas.width) canvas.getContext("2d").drawImage(visual.canvas, visual.x, visual.y);
    } catch (error) {
      console.warn("TypeR web: a style's thumbnail could not be drawn", error);
    }
    thumbs.set(key, canvas);
    if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value);
    return canvas;
  };

  /* ---------------------------------- files ---------------------------------- */

  const FORMAT = "typer-styles";
  // What a file keeps of `list` (the styles to save, all of them by default): those styles in
  // the panel's order, and their groups as Photoshop's files list them ({ group }, { style:
  // index }, { end }). Saving them all keeps the empty groups too.
  const fileOrder = (list = styles) => {
    const wanted = new Set(list);
    const all = list.length === styles.length;
    const order = [];
    const hierarchy = [];
    walk(null, (item) => {
      if (item.style) {
        hierarchy.push({ style: order.length });
        order.push(item.style);
      } else if (item.group) hierarchy.push({ group: item.group.name, id: item.group.id });
      else hierarchy.push({ end: true });
    }, (style) => wanted.has(style), all);
    return { order, hierarchy };
  };
  const jsonOf = (list) => {
    const { order, hierarchy } = fileOrder(list);
    const kept = new Set(hierarchy.filter((item) => item.id).map((item) => item.id));
    return JSON.stringify({
      format: FORMAT,
      version: 1,
      styles: order.map(({ name, effects, stroke, blending, group }) => ({ name, effects, stroke, blending, group: kept.has(group) ? group : undefined })),
      groups: groups.filter((group) => kept.has(group.id)).map(({ id, name, parent }) => ({ id, name, parent: kept.has(parent) ? parent : undefined })),
    }, null, 1);
  };
  const aslOf = (list) => {
    const { order, hierarchy } = fileOrder(list);
    return ASL.write(order.map((style) => ({ name: style.name, id: ASL.newId(), style: ASL.toStyle(style) })), hierarchy);
  };
  // Photoshop's list of groups as groups of TypeR's, ids of this file only, and which group
  // each style of the file (by its place) is in
  const groupsOfHierarchy = (hierarchy) => {
    const made = [];
    const groupAt = new Map();
    const open = [];
    (hierarchy || []).forEach((item) => {
      if (item.group !== undefined) {
        const group = { id: `file-${made.length}`, name: String(item.group || T("Group")).slice(0, 120), open: true };
        if (open.length) group.parent = open[open.length - 1].id;
        made.push(group);
        open.push(group);
      } else if (item.end) open.pop();
      else if (item.style !== undefined && open.length) groupAt.set(item.style, open[open.length - 1].id);
    });
    return { groups: made, groupAt };
  };

  // An .asl's styles as TypeR's, and what was left out: { label: count }
  const fromAsl = (bytes) => {
    const PSD = window.TypeRPSD;
    const { styles: read, hierarchy } = ASL.parse(bytes);
    const { groups: fileGroups, groupAt } = groupsOfHierarchy(hierarchy);
    const leftOut = {};
    const out = [];
    let empty = 0;
    read.forEach((one, at) => {
      const { effects, blending, leftOut: missing } = ASL.fromStyle(one.style);
      Object.keys(missing).forEach((label) => { leftOut[label] = (leftOut[label] || 0) + missing[label]; });
      const typerEffects = PSD.effectsFromPsd(effects, undefined);
      const stroke = PSD.strokeFromEffects(effects);
      // Two shown strokes TypeR can't make its stroke and the one around it: one is left out
      const shownStrokes = (effects.stroke || []).filter((s) => s.enabled !== false && s.fillType !== "pattern" && s.size.value > 0).length;
      if (shownStrokes > (stroke ? (stroke.outer ? 2 : 1) : 0)) leftOut["More than one effect of a kind"] = (leftOut["More than one effect of a kind"] || 0) + 1;
      const style = cleanStyle({ name: one.name || fill(T("Style {n}"), { n: at + 1 }), effects: typerEffects, stroke, blending, group: groupAt.get(at) });
      // Photoshop's "Default Style (None)" and the styles TypeR draws nothing of are left out
      const plain = !style.blending || (style.blending.blend === "normal" && style.blending.opacity === 100 && style.blending.fill === 100);
      if (isEmpty(style) && plain) {
        empty++;
        return;
      }
      out.push(style);
    });
    return { styles: out, groups: fileGroups, leftOut, empty, total: read.length };
  };
  const fromJson = (text) => {
    const data = JSON.parse(text);
    if (!data || data.format !== FORMAT || !Array.isArray(data.styles)) throw new Error(T("This is not a file of TypeR styles."));
    return { styles: data.styles.map(cleanStyle).filter(Boolean), groups: (Array.isArray(data.groups) ? data.groups : []).map(cleanGroup).filter(Boolean), leftOut: {}, empty: 0, total: data.styles.length };
  };

  // Styles added to the panel, with the file's groups (`fileGroups`, which their `group` names
  // by the file's ids), under new ids. A name already there gets a number, as in Photoshop.
  const addStyles = (list, fileGroups = []) => {
    const room = Math.max(0, MAX_STYLES - styles.length);
    const kept = list.slice(0, room);
    const ids = new Map();
    const known = new Set(fileGroups.map((group) => group.id));
    fileGroups.forEach((group) => {
      const parent = known.has(group.parent) ? ids.get(group.parent) : undefined;
      const made = { id: newId(), name: groupName(group.name, parent || null), open: true };
      if (parent) made.parent = parent;
      ids.set(group.id, made.id);
      groups.push(made);
    });
    const added = kept.map((style) => {
      const group = ids.get(style.group);
      const next = Object.assign(style, { id: newId(), name: numbered(style.name) });
      if (group) next.group = group;
      else delete next.group;
      return next;
    });
    added.forEach((style) => styles.push(style));
    return added;
  };
  const LEFT_OUT_WORDS = {
    "Bevel & Emboss": T("Bevel & Emboss"),
    Satin: T("Satin"),
    "Pattern Overlay": T("Pattern Overlay"),
    "Pattern strokes": T("pattern strokes"),
    "More than one effect of a kind": T("more than one effect of a kind"),
    "Blend modes TypeR doesn't have (drawn in Normal)": T("blend modes TypeR doesn't have (drawn in Normal)"),
    "Noise gradients (drawn black to white)": T("noise gradients (drawn black to white)"),
    "Gradient styles TypeR doesn't have (drawn Linear)": T("gradient styles TypeR doesn't have (drawn Linear)"),
    "Advanced Blending": T("Advanced Blending"),
    "Effects TypeR doesn't know": T("effects TypeR doesn't know"),
  };
  // Reads a file of styles (.json or .asl) into the panel, and says what came in
  const loadFile = async (file) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isAsl = /\.asl$/i.test(file.name) || String.fromCharCode(...bytes.subarray(2, 6)) === "8BSL";
      const read = isAsl ? fromAsl(bytes) : fromJson(new TextDecoder().decode(bytes));
      // A file without groups comes in as one, of its name, as Photoshop loads one
      let fileGroups = read.groups;
      if (!fileGroups.length && read.styles.length) {
        fileGroups = [{ id: "file", name: file.name.replace(/(\.styles)?\.(asl|json)$/i, "") || T("Group"), open: true }];
        read.styles.forEach((style) => { style.group = "file"; });
      }
      const added = addStyles(read.styles, fileGroups);
      if (added.length) chosenId = added[0].id;
      changed();
      const said = [fill(T("Imported from {name}: {count} styles."), { count: added.length, name: file.name })];
      if (added.length < read.styles.length) said.push(fill(T("The panel is full: {count} were left out."), { count: read.styles.length - added.length }));
      const missing = Object.keys(read.leftOut).map((label) => `${LEFT_OUT_WORDS[label] || label} (${read.leftOut[label]})`);
      if (missing.length) said.push(fill(T("Left out, as TypeR doesn't draw them: {list}."), { list: missing.join(", ") }));
      if (read.empty) said.push(fill(T("{count} styles weren't added: TypeR draws nothing in them."), { count: read.empty }));
      A.toast(said.join(" "), missing.length > 0 || read.empty > 0);
      if (window.TypeRWorkspace && !window.TypeRWorkspace.isVisible("styles") && !Shell.touch) window.TypeRWorkspace.setVisible("styles", true);
      if (added.length) requestAnimationFrame(() => focusChosen(false));
      return Object.assign({ added: added.length }, read, { styles: undefined, groups: fileGroups.length });
    } catch (error) {
      console.warn("TypeR web: a Styles file can't be read", error);
      A.toast(fill(T("{name} can't be read: {error}"), { name: file.name, error: error.message || error }), true);
      return { added: 0, error: String(error.message || error) };
    }
  };
  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".asl,.json,application/json";
    input.multiple = true;
    input.addEventListener("change", async () => {
      for (const file of Array.from(input.files)) await loadFile(file);
    });
    input.click();
  };
  // A phone keeps it through its share sheet; elsewhere, where the user picks, or a download
  const saveBlob = async (blob, name, description, accept) => {
    try {
      const file = new File([blob], name, { type: blob.type });
      if (Shell.touch && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept }] });
        await host.writeTo(handle, blob);
        A.toast(fill(T("Saved {name}."), { name: handle.name }));
      } else {
        host.download(blob, name);
        A.toast(fill(T("Downloaded {name}."), { name }));
      }
    } catch (error) {
      if (error.name !== "AbortError") A.toast(fill(T("Could not save: {error}"), { error: error.message || error }), true);
    }
  };
  const exportStyles = async () => {
    if (!styles.length) return;
    const chosen = chosenStyle();
    // A group: the one chosen, else the chosen style's
    const group = groupById(chosenGroupId) || (chosen && groupById(chosen.group));
    const ofGroup = group ? styles.filter((style) => style.group && within(style.group, group.id)) : [];
    const values = await A.dialog({
      title: T("Export Styles"),
      ok: T("Export"),
      fields: [
        { id: "which", label: T("Styles"), value: group && chosenGroupId ? "group" : "all", options: [["all", fill(T("All styles ({count})"), { count: styles.length })], ...(ofGroup.length ? [["group", fill(T("The group “{name}” ({count})"), { name: group.name, count: ofGroup.length })]] : []), ...(chosen ? [["chosen", fill(T("Only “{name}”"), { name: chosen.name })]] : [])] },
        { id: "format", label: T("Format"), value: "json", options: [["json", T("TypeR Styles (.json)")], ["asl", T("Photoshop Styles (.asl)")]] },
      ],
    });
    if (!values) return;
    const list = values.which === "chosen" && chosen ? [chosen] : values.which === "group" && ofGroup.length ? ofGroup : styles.slice();
    const base = (list.length === 1 ? list[0].name : values.which === "group" && group ? group.name : T("TypeR Styles")).replace(/[\\/:*?"<>|]+/g, "-") || "Styles";
    if (values.format === "asl") await saveBlob(new Blob([aslOf(list)], { type: "application/octet-stream" }), `${base}.asl`, T("Photoshop Styles"), { "application/octet-stream": [".asl"] });
    else await saveBlob(new Blob([jsonOf(list)], { type: "application/json" }), `${base}.styles.json`, T("TypeR Styles"), { "application/json": [".json"] });
  };

  /* ------------------------------ what the panel does ------------------------------ */

  let chosenId = null;
  // A group clicked: what New Style goes into, what Delete takes off, until a style is clicked
  let chosenGroupId = null;
  const chosenStyle = () => styles.find((style) => style.id === chosenId) || null;
  // Where a new style goes: the group chosen, or the chosen style's
  const groupForNew = () => (groupById(chosenGroupId) ? chosenGroupId : (chosenStyle() && chosenStyle().group) || null);
  const leadLayer = () => {
    const d = doc();
    if (!d) return null;
    const id = d.state.activeIds[d.state.activeIds.length - 1];
    return d.state.layers.find((layer) => layer.id === id) || null;
  };
  // New Style…: the current layer's style (or the Layer Style dialog's, as it stands), as
  // Photoshop's dialog asks for it
  const newStyle = async (from = leadLayer()) => {
    if (!from) {
      A.toast(T("Select a layer first: its style becomes the new style."));
      return null;
    }
    const values = await A.dialog({
      title: T("New Style"),
      ok: "OK",
      fields: [
        { id: "name", label: T("Name"), value: nextName() },
        { id: "effects", label: T("Include Layer Effects"), type: "checkbox", checked: true },
        { id: "blending", label: T("Include Layer Blending Options"), type: "checkbox", checked: true },
      ],
    });
    if (!values) return null;
    const style = cleanStyle(Object.assign({ name: values.name.trim() || nextName() }, styleOfLayer(from, values.effects, values.blending)));
    if (styles.length >= MAX_STYLES) {
      A.toast(T("The Styles panel is full: delete a style first."), true);
      return null;
    }
    const group = groupForNew();
    if (group) {
      style.group = group;
      openTo(group);
    }
    styles.push(style);
    chosenId = style.id;
    chosenGroupId = null;
    changed();
    requestAnimationFrame(() => focusChosen(false));
    return style;
  };
  const renameStyle = async (style = chosenStyle()) => {
    if (!style) return;
    const values = await A.dialog({ title: T("Style Name"), ok: "OK", fields: [{ id: "name", label: T("Name"), value: style.name }] });
    if (!values || !values.name.trim()) return;
    style.name = values.name.trim().slice(0, 120);
    changed();
    requestAnimationFrame(() => focusChosen(false));
  };
  const deleteStyle = async (style = chosenStyle(), ask = true) => {
    if (!style) return;
    if (ask && !(await A.dialog({ title: T("Delete Style"), body: fill(T("Delete the style “{name}”?"), { name: style.name }), ok: T("Delete") }))) return;
    const at = styles.indexOf(style);
    if (at < 0) return;
    styles.splice(at, 1);
    const next = styles[Math.min(at, styles.length - 1)];
    chosenId = next ? next.id : null;
    changed();
    requestAnimationFrame(() => focusChosen(false));
  };
  const resetStyles = async () => {
    if (!(await A.dialog({ title: T("Reset Styles"), body: T("Replace the styles of the panel with the default styles?"), ok: "OK" }))) return;
    styles = defaultStyles();
    groups = [];
    chosenId = null;
    chosenGroupId = null;
    changed();
  };
  // A group and those around it unfolded, so that what is in it shows
  const openTo = (id) => {
    for (let group = groupById(id); group; group = groupById(group.parent)) group.open = true;
  };
  // New Style Group…: in the group chosen, if any, else at the top, as Photoshop's
  const newGroup = async () => {
    const parent = groupById(chosenGroupId) ? chosenGroupId : null;
    const values = await A.dialog({ title: T("New Style Group"), ok: "OK", fields: [{ id: "name", label: T("Name"), value: groupName(T("Group"), parent) }] });
    if (!values) return null;
    const group = { id: newId(), name: (values.name.trim() || groupName(T("Group"), parent)).slice(0, 120), open: true };
    if (parent) {
      group.parent = parent;
      openTo(parent);
    }
    groups.push(group);
    chosenGroupId = group.id;
    changed();
    requestAnimationFrame(() => focusGroup(group));
    return group;
  };
  const renameGroup = async (group = groupById(chosenGroupId)) => {
    if (!group) return;
    const values = await A.dialog({ title: T("Group Name"), ok: "OK", fields: [{ id: "name", label: T("Name"), value: group.name }] });
    if (!values || !values.name.trim()) return;
    group.name = values.name.trim().slice(0, 120);
    changed();
    requestAnimationFrame(() => focusGroup(group));
  };
  // Ungroup Styles: what it holds goes where it was
  const ungroup = (group = groupById(chosenGroupId)) => {
    if (!group) return;
    styles.forEach((style) => { if (style.group === group.id) style.group = group.parent || undefined; });
    groups.forEach((other) => { if (other.parent === group.id) other.parent = group.parent || undefined; });
    groups = groups.filter((other) => other !== group);
    styles.forEach((style) => { if (!style.group) delete style.group; });
    groups.forEach((other) => { if (!other.parent) delete other.parent; });
    chosenGroupId = null;
    changed();
  };
  // Delete Group: the group, the groups in it and their styles, once asked
  const deleteGroup = async (group = groupById(chosenGroupId), ask = true) => {
    if (!group) return;
    const count = countIn(group.id);
    if (ask && !(await A.dialog({ title: T("Delete Group"), body: count ? fill(T("Delete the group “{name}” and its {count} styles?"), { name: group.name, count }) : fill(T("Delete the group “{name}”?"), { name: group.name }), ok: T("Delete") }))) return;
    styles = styles.filter((style) => !(style.group && within(style.group, group.id)));
    groups = groups.filter((other) => !within(other.id, group.id));
    if (!chosenStyle()) chosenId = null;
    chosenGroupId = null;
    changed();
  };
  // A style or a group dropped: into a group (null: out of them all), or before a style, in
  // that style's group
  const moveStyle = (style, { into, before }) => {
    const target = before ? before.group || null : into;
    styles.splice(styles.indexOf(style), 1);
    if (target) style.group = target;
    else delete style.group;
    const at = before ? styles.indexOf(before) : -1;
    if (at >= 0) styles.splice(at, 0, style);
    else styles.push(style);
    if (target) openTo(target);
    changed();
  };
  const moveGroup = (group, into) => {
    if (into && within(into, group.id)) return;
    groups.splice(groups.indexOf(group), 1);
    if (into) group.parent = into;
    else delete group.parent;
    group.name = groupName(group.name, into, group);
    groups.push(group);
    if (into) openTo(into);
    changed();
  };
  const setView = (next) => {
    view = next;
    try {
      window.localStorage.setItem(STORE_VIEW, view);
    } catch (error) {
      // Kept for this visit only
    }
    render();
  };

  /* ---------------------------------- the panel ---------------------------------- */

  const pane = $("pane-styles");
  const list = $("styles");
  const foot = $("styles-foot");
  if (!pane || !list || !foot) return;
  const SVG = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  const ICONS = {
    none: SVG('<circle cx="12" cy="12" r="7.5"/><path d="m6.7 17.3 10.6-10.6"/>'),
    add: SVG('<path d="M7 4h7l4 4v12H7Z"/><path d="M12.5 10v6M9.5 13h6"/>'),
    group: SVG('<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M12 11v5M9.5 13.5h5"/>'),
    trash: A.ICON.trash,
    menu: A.ICON.more,
  };

  // The swatches: No Style, the styles in no group, then each group with its own, as
  // Photoshop's grid (or its list)
  const itemOf = new WeakMap();
  const groupOf = new WeakMap();
  const styleItem = (style, into) => {
    const item = make("button", "styles__item", into);
    item.type = "button";
    item.setAttribute("role", "option");
    item.tabIndex = -1;
    const on = style.id === chosenId && !chosenGroupId;
    item.classList.toggle("is-on", on);
    item.setAttribute("aria-selected", String(on));
    item.title = `${style.name}\n${T("Click to give it to the selected layers, Shift+click to add it to their style.")}`;
    item.setAttribute("aria-label", style.name);
    const thumb = make("span", "styles__thumb", item);
    // Each its own canvas: two styles alike share a drawing, not an element
    const picture = make("canvas", "", thumb);
    picture.width = SAMPLE;
    picture.height = SAMPLE;
    picture.getContext("2d").drawImage(thumbOf(style), 0, 0);
    if (view === "list") make("span", "styles__name", item, style.name);
    itemOf.set(item, style);
  };
  const fillIn = (parent, into) => {
    stylesIn(parent).forEach((style) => styleItem(style, into));
    groupsIn(parent).forEach((group) => {
      const box = make("div", "styles__group", into);
      const head = make("button", "styles__ghead", box);
      head.type = "button";
      head.tabIndex = -1;
      head.setAttribute("aria-expanded", String(group.open));
      head.classList.toggle("is-on", group.id === chosenGroupId);
      head.title = `${group.name}\n${T("Click to fold or unfold it. Drag styles onto it to put them in it.")}`;
      make("span", "styles__arrow", head).innerHTML = A.ICON.chevronDown;
      make("span", "styles__folder", head).innerHTML = A.ICON.folder;
      make("span", "styles__gname", head, group.name);
      make("span", "styles__gcount", head, String(countIn(group.id)));
      groupOf.set(head, group);
      const body = make("div", "styles__body", box);
      groupOf.set(body, group);
      body.hidden = !group.open;
      if (!group.open) return;
      fillIn(group.id, body);
      if (!body.childNodes.length) make("p", "styles__gempty", body, T("Drag styles here."));
    });
  };
  const render = () => {
    const scroll = list.scrollTop;
    list.textContent = "";
    list.className = `styles styles--${view}`;
    const none = make("button", "styles__item styles__item--none", list);
    none.type = "button";
    none.setAttribute("role", "option");
    none.tabIndex = -1;
    none.title = `${T("No Style")}\n${T("Clears the layer style of the selected layers.")}`;
    none.setAttribute("aria-label", T("No Style"));
    make("span", "styles__thumb styles__thumb--none", none);
    if (view === "list") make("span", "styles__name", none, T("No Style"));
    itemOf.set(none, null);
    fillIn(null, list);
    if (!styles.length && !groups.length) make("p", "styles__empty", list, T("No styles yet. Give a layer a Layer Style, then click New Style to keep it here."));
    // One of them can be reached with Tab: the one chosen, else the first
    const items = itemsOf();
    const focusable = items.find((item) => item.classList.contains("is-on")) || items[0];
    if (focusable) focusable.tabIndex = 0;
    list.scrollTop = scroll;
    renderFoot();
  };
  // The styles and the groups' names, in the panel's order
  const itemsOf = () => Array.from(list.querySelectorAll(".styles__item, .styles__ghead"));
  // `keep`: the focus was in the panel before it was drawn again
  const focusItem = (item, keep = false) => {
    if (!item) return;
    itemsOf().forEach((one) => { one.tabIndex = one === item ? 0 : -1; });
    item.scrollIntoView({ block: "nearest" });
    if (keep || pane.contains(document.activeElement)) item.focus({ preventScroll: true });
  };
  const focusChosen = (andScroll = true) => {
    const items = itemsOf();
    const item = items.find((one) => itemOf.get(one) && itemOf.get(one).id === chosenId) || items[0];
    if (!item) return;
    items.forEach((one) => { one.tabIndex = one === item ? 0 : -1; });
    if (pane.contains(document.activeElement) || andScroll) item.scrollIntoView({ block: "nearest" });
    if (pane.contains(document.activeElement)) item.focus({ preventScroll: true });
  };
  const focusGroup = (group, keep) => focusItem(itemsOf().find((one) => groupOf.get(one) === group), keep);
  const choose = (style) => {
    chosenId = style ? style.id : null;
    chosenGroupId = null;
    itemsOf().forEach((item) => {
      const on = Boolean(style) && itemOf.get(item) === style;
      item.classList.toggle("is-on", on);
      if (item.classList.contains("styles__item")) item.setAttribute("aria-selected", String(on));
    });
    renderFoot();
  };
  const chooseGroup = (group) => {
    chosenGroupId = group ? group.id : null;
    itemsOf().forEach((item) => {
      const on = Boolean(group) && groupOf.get(item) === group;
      item.classList.toggle("is-on", on);
      if (item.classList.contains("styles__item")) item.setAttribute("aria-selected", "false");
    });
    renderFoot();
  };
  const fold = (group, open = !group.open) => {
    const keep = list.contains(document.activeElement);
    group.open = open;
    chosenGroupId = group.id;
    changed();
    requestAnimationFrame(() => focusGroup(group, keep));
  };

  // Dragged (past a few pixels), a style or a group goes where it is let go: onto a group's
  // name, into it; onto a style, before it, in its group; elsewhere in a group, at its end; on
  // the panel's free space, out of the groups
  let dragged = false;
  const dropAt = (x, y, moving) => {
    const under = document.elementFromPoint(x, y);
    if (!under || !list.contains(under)) return null;
    const head = under.closest(".styles__ghead");
    if (head) return { el: head, into: groupOf.get(head).id };
    const item = under.closest(".styles__item");
    if (item && itemOf.get(item) && moving.style && itemOf.get(item) !== moving.style) return { el: item, before: itemOf.get(item), side: true };
    const body = under.closest(".styles__body");
    if (body) return { el: body, into: groupOf.get(body).id };
    return { el: list, into: null };
  };
  list.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const source = event.target.closest(".styles__item, .styles__ghead");
    const moving = source && (itemOf.get(source) ? { style: itemOf.get(source) } : groupOf.get(source) ? { group: groupOf.get(source) } : null);
    if (!moving) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let ghost = null;
    let target = null;
    const mark = (next) => {
      if (target && target.el) target.el.classList.remove("is-drop", "is-drop-before");
      target = next;
      if (target && target.el) target.el.classList.add(target.side ? "is-drop-before" : "is-drop");
    };
    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
        ghost = make("div", "layer-ghost", document.body, moving.style ? moving.style.name : moving.group.name);
        document.body.classList.add("is-dragging-tool");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 112}px)`;
      const next = dropAt(e.clientX, e.clientY, moving);
      // A group can't go into itself
      mark(next && moving.group && next.into && within(next.into, moving.group.id) ? null : next);
    };
    const end = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("is-dragging-tool");
      const at = target;
      mark(null);
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      if (!at || e.type === "pointercancel") return;
      if (moving.style) {
        moveStyle(moving.style, at);
        choose(moving.style);
        requestAnimationFrame(() => focusChosen(true));
      } else if (at.into !== (moving.group.parent || null)) moveGroup(moving.group, at.into);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  // A click gives the style to the selected layers, and chooses it (to rename or delete); on a
  // group's name, folds or unfolds it
  list.addEventListener("click", (event) => {
    if (dragged) return;
    const head = event.target.closest(".styles__ghead");
    if (head && groupOf.has(head)) {
      fold(groupOf.get(head));
      return;
    }
    const item = event.target.closest(".styles__item");
    if (!item || !itemOf.has(item)) return;
    const style = itemOf.get(item);
    itemsOf().forEach((one) => { one.tabIndex = one === item ? 0 : -1; });
    if (style) choose(style);
    apply(style, { add: event.shiftKey, quiet: !doc() });
  });
  // Twice: its name, as Photoshop's Style Name (a group's, Group Name)
  list.addEventListener("dblclick", (event) => {
    const head = event.target.closest(".styles__ghead");
    if (head && groupOf.has(head)) {
      renameGroup(groupOf.get(head));
      return;
    }
    const item = event.target.closest(".styles__item");
    const style = item && itemOf.get(item);
    if (style) renameStyle(style);
  });
  list.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const head = event.target.closest(".styles__ghead");
    const group = head && groupOf.get(head);
    const newItems = [{ label: "New Style…", enabled: () => Boolean(leadLayer()), action: () => newStyle() }, { label: "New Style Group…", action: newGroup }];
    if (group) {
      chooseGroup(group);
      host.openContextMenu(event.clientX, event.clientY, [
        { label: "Rename Group…", action: () => renameGroup(group) },
        { label: "Ungroup Styles", action: () => ungroup(group) },
        { label: "Delete Group", action: () => deleteGroup(group) },
        null,
        ...newItems,
      ]);
      return;
    }
    const item = event.target.closest(".styles__item");
    const style = item && itemOf.get(item);
    if (style) choose(style);
    host.openContextMenu(event.clientX, event.clientY, style ? [
      { label: "Rename Style…", action: () => renameStyle(style) },
      { label: "Delete Style", action: () => deleteStyle(style, false) },
      null,
      ...newItems,
    ] : newItems);
  });
  // The keys of a grid: arrows move (up and down by a row), Enter or Space gives the style (on
  // a group, folds it), Delete removes it, F2 renames it
  list.addEventListener("keydown", (event) => {
    if (host.isText(event.target)) return;
    const items = itemsOf();
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    const style = itemOf.get(items[at]);
    const group = groupOf.get(items[at]);
    const tile = items.find((one) => one.classList.contains("styles__item"));
    const across = view === "list" ? 1 : Math.max(1, Math.round(list.clientWidth / Math.max(1, (tile ? tile.offsetWidth : 36) + 2)));
    const go = (to) => {
      const next = items[Math.max(0, Math.min(items.length - 1, to))];
      items.forEach((one) => { one.tabIndex = one === next ? 0 : -1; });
      next.focus();
      next.scrollIntoView({ block: "nearest" });
      if (itemOf.get(next)) choose(itemOf.get(next));
      else if (groupOf.get(next)) chooseGroup(groupOf.get(next));
    };
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: group ? 1 : across, ArrowUp: group ? -1 : -across }[event.key];
    const rtl = getComputedStyle(list).direction === "rtl" && (event.key === "ArrowRight" || event.key === "ArrowLeft");
    if (group && (event.key === "ArrowRight" || event.key === "ArrowLeft") && group.open !== ((event.key === "ArrowRight") !== rtl)) fold(group, (event.key === "ArrowRight") !== rtl);
    else if (step) go(at + (rtl ? -step : step));
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (group && (event.key === "Enter" || event.key === " ")) fold(group);
    else if (event.key === "Enter" || event.key === " ") apply(style, { add: event.shiftKey });
    else if ((event.key === "Delete" || event.key === "Backspace") && (style || group)) {
      if (group) deleteGroup(group);
      else deleteStyle(style);
    } else if (event.key === "F2" && (style || group)) {
      if (group) renameGroup(group);
      else renameStyle(style);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  list.setAttribute("aria-label", T("Styles"));

  // The panel's menu, then No Style, New Style and Delete, as in Photoshop
  const footButtons = {};
  const footButton = (name, icon, title, run) => {
    const button = make("button", `icon-btn styles__${name}`, foot);
    button.type = "button";
    button.innerHTML = ICONS[icon];
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", run);
    footButtons[name] = button;
    return button;
  };
  const openMenu = (x, y, above) => {
    const chosen = chosenStyle();
    const items = [
      { label: "New Style…", enabled: () => Boolean(leadLayer()), action: () => newStyle() },
      { label: "New Style Group…", action: newGroup },
      { label: "Rename Style…", enabled: () => Boolean(chosen), action: () => renameStyle(chosen) },
      { label: "Delete Style", enabled: () => Boolean(chosen), action: () => deleteStyle(chosen) },
      null,
      { label: "Small Thumbnail", check: () => view === "small", action: () => setView("small") },
      { label: "Large Thumbnail", check: () => view === "large", action: () => setView("large") },
      { label: "Large List", check: () => view === "list", action: () => setView("list") },
      null,
      { label: "Import Styles…", action: pickFiles },
      { label: "Export Styles…", enabled: () => styles.length > 0, action: exportStyles },
      null,
      { label: "Reset Styles", action: resetStyles },
    ];
    host.openContextMenu(x, y, items);
    const opened = document.querySelector(".menu__list--context");
    if (opened && above) opened.style.top = `${Math.max(8, y - opened.offsetHeight)}px`;
  };
  const menuButton = footButton("menu", "menu", T("Styles panel menu"), () => {
    const box = menuButton.getBoundingClientRect();
    openMenu(box.left, box.top - 4, true);
  });
  menuButton.setAttribute("aria-haspopup", "menu");
  make("span", "styles__grow", foot);
  footButton("none", "none", T("Clear Style"), () => apply(null));
  footButton("newgroup", "group", T("Create new group"), () => newGroup());
  footButton("add", "add", T("Create new style"), () => newStyle());
  // The group chosen, else the style
  footButton("delete", "trash", T("Delete Style"), () => (groupById(chosenGroupId) ? deleteGroup() : deleteStyle()));
  const renderFoot = () => {
    const d = doc();
    footButtons.none.disabled = !d;
    footButtons.add.disabled = !leadLayer();
    footButtons.delete.disabled = !chosenStyle() && !groupById(chosenGroupId);
  };

  $("head-styles").textContent = T("Styles");
  PS.on((type) => {
    if (type === "document" || type === "history" || type === "select" || type === "render") renderFoot();
  });
  // The thumbnails' letters come once their font does
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
    thumbs.clear();
    sampleBase = null;
    render();
  });
  render();

  window.TypeRStyles = {
    // app.js: New Style… of the Layer Style dialog, an .asl opened or dropped
    newStyle,
    loadFile,
    // actions.js: an action's Apply Style
    applyByName,
    // For scripts and tests
    get styles() {
      return styles;
    },
    get groups() {
      return groups;
    },
    newGroup,
    moveStyle: (style, where) => moveStyle(style, where),
    moveGroup,
    apply: (nameOrStyle, options) => apply(typeof nameOrStyle === "string" ? styles.find((one) => one.name === nameOrStyle) : nameOrStyle, options),
    styleOfLayer,
    fromAsl,
    jsonOf,
    aslOf,
    choose: (name) => choose(styles.find((one) => one.name === name) || null),
    refresh: changed,
  };
})();
