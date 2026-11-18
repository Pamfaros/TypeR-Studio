// What changes when this page runs in TypeR Studio on a phone or a tablet, the iOS and Android
// app. Only that app loads this file (index.html). It lives with the page so that both change
// together when an update arrives.
//
// The main gain over a browser tab is the files: a phone's browser only hands out copies, so
// Save could only share a new file each time. The app opens the files where they are (Files,
// iCloud Drive, Google Drive, a USB key…) and keeps the right to write over them. It is given
// to the page as the pickers and handles a computer's browser has (showOpenFilePicker and the
// others), so everything that works with them on a computer works here: Save over the file,
// Open Recent, Open a Chapter from a folder, Batch Save.

(function () {
  "use strict";

  const Capacitor = window.Capacitor;
  if (!Capacitor || !Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) return;

  const platform = Capacitor.getPlatform();
  const root = document.documentElement;
  const Native = Capacitor.Plugins.TypeRFiles || null;
  const can = (method) => Boolean(Native) && Capacitor.isPluginAvailable("TypeRFiles") && typeof Native[method] === "function";

  root.classList.add("mobile-app", `mobile-app--${platform}`);
  try {
    // The beta notice talks about the web version
    window.localStorage.setItem("typer.web.betaNotice", "1");
  } catch (error) {
    console.warn("TypeR Studio: no storage", error);
  }

  /* ------------------------------ asking the app ----------------------------- */

  const ERRORS = { ABORT: "AbortError", NOT_FOUND: "NotFoundError", DENIED: "NotAllowedError", MISMATCH: "TypeMismatchError", UNREADABLE: "NotReadableError" };
  const ask = async (method, options) => {
    try {
      return await Native[method](options || {});
    } catch (error) {
      throw new DOMException((error && error.message) || String(error), ERRORS[error && error.code] || "UnknownError");
    }
  };

  /* --------------------------------- handles --------------------------------- */

  // A file or a folder the user picked, as the app knows it: `token` is all it takes to find
  // it again, at the next launch too. Kept in IndexedDB like a browser's own handles, which
  // only keeps these three fields: they get their methods back as they come out (see below).
  const MARK = "typerNative";
  const TYPES = {
    psd: "image/vnd.adobe.photoshop", psb: "image/vnd.adobe.photoshop", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    idml: "application/vnd.adobe.indesign-idml-package", indd: "application/x-indesign", indt: "application/x-indesign",
    ttf: "font/ttf", otf: "font/otf", ttc: "font/collection", otc: "font/collection", woff: "font/woff", woff2: "font/woff2",
    json: "application/json", zip: "application/zip", txt: "text/plain", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const typeOf = (name) => {
    const found = /\.([^.]+)$/.exec(name);
    return (found && TYPES[found[1].toLowerCase()]) || "";
  };

  // The file last read or written through a handle: asking for it again while it hasn't
  // changed on the disk doesn't read it again (a save asks twice, for a PSD of 100 MB)
  const given = new WeakMap();
  const CHUNK = 2 * 1024 * 1024;
  const base64Of = (blob) => new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });

  class NativeHandle {
    constructor(kind, name, token) {
      this.kind = kind;
      this.name = name;
      this.token = token;
      this[MARK] = 1;
    }
    async isSameEntry(other) {
      if (!other || other[MARK] !== 1 || other.kind !== this.kind) return false;
      if (other.token === this.token) return true;
      return Boolean((await ask("same", { a: this.token, b: other.token })).same);
    }
    // There's nothing to ask the user again here: the app either still has the file or not
    async queryPermission(options) {
      try {
        const { granted } = await ask("access", { token: this.token, write: Boolean(options && options.mode === "readwrite") });
        return granted ? "granted" : "denied";
      } catch (error) {
        return "denied";
      }
    }
    requestPermission(options) {
      return this.queryPermission(options);
    }
  }

  class NativeFileHandle extends NativeHandle {
    async getFile() {
      const info = await ask("stat", { token: this.token });
      const known = given.get(this);
      if (known && known.size === info.size && known.modified === info.modified) {
        const file = known.file instanceof File ? known.file : known.file.deref();
        if (file) return file;
      }
      const { path } = await ask("read", { token: this.token });
      try {
        const response = await fetch(Capacitor.convertFileSrc(path));
        if (!response.ok) throw new DOMException(`${info.name}: ${response.status}`, "NotReadableError");
        const blob = await response.blob();
        const file = new File([blob], info.name, { type: typeOf(info.name) || blob.type, lastModified: info.modified });
        given.set(this, { file: new WeakRef(file), size: info.size, modified: info.modified });
        this.name = info.name;
        return file;
      } finally {
        if (can("release")) Native.release({ path }).catch(() => {});
      }
    }
    // The whole file at once, as the page writes it: it replaces the old one only when all of
    // it is there, so a save cut short leaves the file as it was
    async createWritable() {
      const handle = this;
      const parts = [];
      return {
        async write(data) {
          if (data && typeof data === "object" && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
            if (data.type !== "write" || data.position) throw new DOMException("Only whole files are written here.", "NotSupportedError");
            data = data.data;
          }
          parts.push(data);
        },
        async close() {
          const blob = new Blob(parts);
          const { id } = await ask("writeBegin", { token: handle.token });
          let info;
          try {
            for (let at = 0; at < blob.size; at += CHUNK) await ask("writeChunk", { id, data: await base64Of(blob.slice(at, at + CHUNK)) });
            info = await ask("writeEnd", { id });
          } catch (error) {
            Native.writeAbort({ id }).catch(() => {});
            throw error;
          }
          handle.name = info.name || handle.name;
          const entry = { file: new File([blob], handle.name, { type: typeOf(handle.name), lastModified: info.modified }), size: info.size, modified: info.modified };
          given.set(handle, entry);
          // Asked for right after a save, then only for as long as someone holds it
          setTimeout(() => { entry.file = new WeakRef(entry.file); }, 10000);
        },
        async abort() {
          parts.length = 0;
        },
      };
    }
  }

  class NativeDirectoryHandle extends NativeHandle {
    async* values() {
      const { entries } = await ask("list", { token: this.token });
      for (const entry of entries) yield make(entry);
    }
    async* keys() {
      for await (const handle of this.values()) yield handle.name;
    }
    async* entries() {
      for await (const handle of this.values()) yield [handle.name, handle];
    }
    [Symbol.asyncIterator]() {
      return this.entries();
    }
    async getFileHandle(name, options) {
      return make(await ask("child", { token: this.token, name, kind: "file", create: Boolean(options && options.create) }));
    }
    async getDirectoryHandle(name, options) {
      return make(await ask("child", { token: this.token, name, kind: "directory", create: Boolean(options && options.create) }));
    }
    // The names from this folder down to a file in it, or null
    async resolve(other) {
      if (!other || other[MARK] !== 1) return null;
      const { path } = await ask("resolve", { token: this.token, child: other.token });
      return Array.isArray(path) ? path : null;
    }
  }

  const make = ({ kind, name, token }) => (kind === "directory" ? new NativeDirectoryHandle("directory", name, token) : new NativeFileHandle("file", name, token));

  // Out of IndexedDB a handle is a bare object again. Whatever the page reads there is looked
  // through for them, near the top where the page keeps them (the recent files, the pages of
  // a session, the default folder).
  const looked = new WeakSet();
  const revive = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) {
      if (value.length && (typeof value[0] !== "object" || value[0] === null)) return;
      for (const item of value) revive(item, depth + 1);
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    if (value[MARK] === 1 && typeof value.token === "string") {
      Object.setPrototypeOf(value, value.kind === "directory" ? NativeDirectoryHandle.prototype : NativeFileHandle.prototype);
      return;
    }
    for (const key of Object.keys(value)) revive(value[key], depth + 1);
  };
  const reviveOut = (proto, name) => {
    const described = Object.getOwnPropertyDescriptor(proto, name);
    if (!described || !described.get) return;
    Object.defineProperty(proto, name, Object.assign({}, described, {
      get() {
        const value = described.get.call(this);
        if (value && typeof value === "object" && !looked.has(value)) {
          looked.add(value);
          revive(value, 0);
        }
        return value;
      },
    }));
  };

  if (can("pickFiles")) {
    reviveOut(IDBRequest.prototype, "result");
    reviveOut(IDBCursorWithValue.prototype, "value");

    const near = (options) => {
      const start = options && options.startIn;
      return start && start[MARK] === 1 ? start.token : null;
    };
    // No filter by type: a phone's picker greys out the PSDs as soon as there is one, and what
    // can't be opened is refused once picked
    window.showOpenFilePicker = async (options) => (await ask("pickFiles", { multiple: Boolean(options && options.multiple), near: near(options) })).files.map(make);
    window.showSaveFilePicker = async (options) => make(await ask("createFile", { name: (options && options.suggestedName) || "Untitled", near: near(options) }));
    window.showDirectoryPicker = async (options) => make(await ask("pickFolder", { near: near(options) }));
  }

  /* --------------------------------- downloads -------------------------------- */

  // A web view has no downloads: what the page would download is saved where the user says.
  // One at a time, when several come at once.
  let saving = Promise.resolve();
  const saveBlob = (blob, name) => {
    saving = saving.then(async () => {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        if (error.name !== "AbortError") console.error("TypeR Studio: could not save", name, error);
      }
    });
    return saving;
  };
  if (can("createFile")) {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.hasAttribute("download") || !/^(blob|data):/.test(this.href)) return click.call(this);
      const name = this.download || "TypeR";
      fetch(this.href).then((response) => response.blob()).then((blob) => saveBlob(blob, name)).catch((error) => console.error(error));
      return undefined;
    };
  }

  /* --------------------------- opened from another app -------------------------- */

  // « Open in TypeR Studio » in Files, or a file shared to the app. Opened where it is when the
  // system allows it, so Save writes over it; a copy handed over opens as a page to save.
  const openGiven = async (files) => {
    const entries = [];
    for (const given of files || []) {
      try {
        // Text shared as it is, without a file: a script
        if (typeof given.text === "string") await window.TypeRApp.importScript({ name: given.name || "", text: given.text }).then(() => window.TypeRTouch && window.TypeRTouch.openSheet("script"));
        if (given.token) {
          const handle = make({ kind: "file", name: given.name, token: given.token });
          entries.push({ file: await handle.getFile(), handle: given.lasting === false ? null : handle });
        }
      } catch (error) {
        console.error("TypeR Studio: could not open", given && given.name, error);
      }
    }
    if (entries.length) window.TypeRApp.openFiles(entries);
  };

  /* -------------------------------- system bars ------------------------------- */

  // The clock and the battery take the theme's colours (Settings > Appearance)
  const SystemBars = Capacitor.Plugins.SystemBars;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const followTheme = () => {
    const light = root.dataset.theme === "light";
    if (SystemBars && SystemBars.setStyle) SystemBars.setStyle({ style: light ? "LIGHT" : "DARK" }).catch(() => {});
    if (can("setBackground") && themeColor) Native.setBackground({ color: themeColor.content, light }).catch(() => {});
  };
  followTheme();
  if (themeColor) new MutationObserver(followTheme).observe(themeColor, { attributes: true, attributeFilter: ["content"] });
  new MutationObserver(followTheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  /* ----------------------------- the system's own bars ---------------------------- */

  // On an iPhone held upright, the top bar and the tabs are the system's own
  // (TypeRChromePlugin.swift): Liquid Glass on iOS 26 and later. The page tells them what to
  // show, makes room for them, and draws everything else. A dialog, a menu or the busy veil
  // covers the whole screen: the bars step back while it's there.
  const Bars = platform === "ios" && Capacitor.isPluginAvailable("TypeRChrome") ? Capacitor.Plugins.TypeRChrome : null;
  if (Bars) {
    const Shell = window.TypeRShell;
    const COVERS = "dialog[open], .font-menu, .menu__list--context, .brush-picker, .grad-editor, #busy:not([hidden])";
    const wanted = () => Shell.kind === "phone" && Shell.side === "bottom";
    let sent = "";
    let waiting = false;
    const push = () => {
      waiting = false;
      const Touch = window.TypeRTouch;
      const on = wanted() && Boolean(Touch && Touch.barsState);
      root.classList.toggle("native-bars", wanted());
      const state = on
        ? Object.assign(Touch.barsState(), { shown: true, covered: Boolean(document.querySelector(COVERS)), light: root.dataset.theme === "light", tint: getComputedStyle(root).getPropertyValue("--blue").trim() })
        : { shown: false };
      const key = JSON.stringify(state);
      if (key === sent) return;
      sent = key;
      Bars.update(state).then((room) => {
        if (!state.shown) return;
        root.style.setProperty("--bars-t", `${room.top}px`);
        root.style.setProperty("--bars-b", `${room.bottom}px`);
      }).catch((error) => console.error("TypeR Studio: the bars", error));
    };
    const soon = () => {
      if (waiting) return;
      waiting = true;
      requestAnimationFrame(push);
    };
    root.classList.toggle("native-bars", wanted());
    window.addEventListener("typer-bars", soon);
    Shell.onChange(soon);
    // The bars' own height changes when the phone is turned
    window.addEventListener("resize", () => {
      sent = "";
      soon();
    });
    window.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(soon).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden"] });
      new MutationObserver(soon).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    });
    Bars.addListener("act", ({ what, id }) => {
      if (window.TypeRTouch && window.TypeRTouch.barsDo) window.TypeRTouch.barsDo(what, id);
    });
  }

  /* ----------------------------------- start ---------------------------------- */

  const whenBooted = (run) => {
    if (window.TypeRApp && window.TypeRApp.booted) run();
    else window.addEventListener("typer-booted", run, { once: true });
  };

  // Android's back button closes what is open over the page, as Escape does on a keyboard: a
  // dialog, a menu, then the panel. With nothing left to close, the app goes to the background
  // rather than closing with its pages.
  window.addEventListener("typerBack", () => {
    const dialogs = Array.from(document.querySelectorAll("dialog[open]")).filter((dialog) => dialog.matches(":modal"));
    const dialog = dialogs[dialogs.length - 1];
    if (dialog) {
      // What Escape tells a dialog: it closes itself, or says no and stays (a save under way)
      if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
      return;
    }
    const changes = new MutationObserver(() => {});
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "open"] });
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true });
    const taken = !target.dispatchEvent(escape) || changes.takeRecords().length > 0;
    changes.disconnect();
    if (taken) return;
    if (root.classList.contains("sheet-open") && window.TypeRTouch) window.TypeRTouch.closeSheet();
    else if (can("background")) Native.background().catch(() => {});
  });

  window.addEventListener("DOMContentLoaded", () => {
    const logo = document.querySelector(".mbar__logo");
    if (logo) logo.removeAttribute("href");
    document.title = "TypeR Studio";
    document.querySelectorAll(".mbar__title, .start h1").forEach((title) => { title.textContent = "TypeR Studio"; });
  });

  whenBooted(() => {
    if (!can("opened")) return;
    Native.addListener("open", ({ files }) => openGiven(files));
    Native.opened().then(({ files }) => openGiven(files)).catch((error) => console.error(error));
  });

  window.TypeRMobile = { platform, saveBlob };
})();
