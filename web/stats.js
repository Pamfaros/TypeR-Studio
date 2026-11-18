// How many people use TypeR Studio, and what to improve: once a day, the open app says so to
// stats-worker/, with a random number drawn here the first time (so that one person opening it ten
// times counts once), web or desktop, the system, the desktop app's version and the interface
// language. With it go the days before, each as totals: how many times each of TypeR Studio's
// own tools and commands was used, and from where (keys, menu, toolbar…, app.js counts them), and
// the errors the app ran into, without what they were about. Nothing about the person, their
// documents or what's in them. Settings → Anonymous usage statistics turns it off and forgets
// all of it. Never sent from a copy on this computer (localhost), by a browser driven by a script
// (the demos, the tests), or one that asks sites not to share (Global Privacy Control, Do Not
// Track).

(function () {
  "use strict";

  const ENDPOINT = "https://stats.teamscanr.fr/";
  const STORE = "typer.web.stats";
  // The counts of the days not sent yet: { "2026-11-12": { u: { name: { via: n } }, e: { error: n } } }
  const STORE_DAYS = "typer.web.stats.days";
  // Once the page has settled: a page closed at once isn't someone using the app
  const AFTER_START = 10 * 1000;
  // Counts are kept this long after the last one, or as the page goes away
  const KEEP_AFTER = 5 * 1000;
  // What one start sends at most, and how old a day can be before it's dropped
  const MAX_DAYS = 14;
  const KEEP_DAYS = 30;
  // A day's different errors, at most
  const MAX_ERRORS = 10;
  const VIA = new Set(["key", "menu", "context", "search", "toolbar"]);

  const load = (key) => {
    try {
      return JSON.parse(window.localStorage.getItem(key) || "null") || {};
    } catch (error) {
      return null;
    }
  };
  const store = (key, value) => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Private window, or full: nothing kept, nothing sent
    }
  };
  const read = () => load(STORE);
  const write = (state) => store(STORE, state);

  const desktop = window.TypeRDesktop;
  const ua = navigator.userAgent || "";
  const platform = () => {
    if (desktop) return desktop.platform;
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
    if (/CrOS/.test(ua)) return "chromeos";
    if (/Windows/.test(ua)) return "windows";
    if (/Macintosh|Mac OS X/.test(ua)) return "mac";
    if (/Linux/.test(ua)) return "linux";
    return "other";
  };
  const DAY = 86400000;
  const dayOf = (time) => new Date(time).toISOString().slice(0, 10);
  const today = () => dayOf(Date.now());

  const allowed = () => {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) || window.location.protocol === "file:";
    const asked = navigator.globalPrivacyControl === true || navigator.doNotTrack === "1";
    return !local && !asked && !navigator.webdriver;
  };
  const on = () => {
    const state = read();
    return Boolean(state) && !state.off && allowed();
  };

  // What was counted since the last time it was kept, added to what's kept: other tabs keep
  // theirs too
  let pending = {};
  let keepTimer = 0;
  const keep = () => {
    clearTimeout(keepTimer);
    keepTimer = 0;
    const days = Object.keys(pending);
    if (!days.length) return;
    const state = read();
    const stored = load(STORE_DAYS);
    if (!state || state.off || !stored) {
      pending = {};
      return;
    }
    const sent = new Set(state.sent || []);
    days.forEach((day) => {
      // Already sent, from another tab: its totals are there, a part of them would replace them
      if (sent.has(day)) return;
      const into = stored[day] || (stored[day] = { u: {}, e: {} });
      Object.entries(pending[day].u).forEach(([name, vias]) => {
        const counts = into.u[name] || (into.u[name] = {});
        Object.entries(vias).forEach(([via, n]) => { counts[via] = (counts[via] || 0) + n; });
      });
      Object.entries(pending[day].e).forEach(([error, n]) => {
        if (into.e[error] || Object.keys(into.e).length < MAX_ERRORS) into.e[error] = (into.e[error] || 0) + n;
      });
    });
    pending = {};
    store(STORE_DAYS, stored);
  };
  const keepSoon = () => {
    if (!keepTimer) keepTimer = setTimeout(keep, KEEP_AFTER);
  };
  const todays = () => pending[today()] || (pending[today()] = { u: {}, e: {} });
  window.addEventListener("pagehide", keep);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") keep();
  });

  const count = (name, via) => {
    if (typeof name !== "string" || !VIA.has(via) || !on()) return;
    const counts = todays().u[name] || (todays().u[name] = {});
    counts[via] = (counts[via] || 0) + 1;
    keepSoon();
  };

  // An error, said without what it was about: its kind, its message with names, paths, numbers
  // and quoted text taken out, and where in TypeR's own files it happened
  const describe = (error, message, source) => {
    const stack = String((error && error.stack) || "");
    const own = (url) => url && url.indexOf(window.location.origin) === 0;
    const frame = stack.match(/(?:https?|typer):\/\/[^\s()]+?\/([\w-]+\.js):(\d+)/) || (own(source && source.file) ? [null, source.file.split("/").pop().split("?")[0], source.line] : null);
    if (!frame || (frame[0] && !own(frame[0]))) return null;
    const kind = (error && error.name) || "Error";
    const text = String((error && error.message) || message || "")
      .replace(/(["'`«“‘])[^"'`»”’]*["'`»”’]/g, "…")
      .replace(/\b[\w.-]+:\/\/\S+/g, "…")
      .replace(/(?:[A-Za-z]:)?[\\/][^\s]+/g, "…")
      .replace(/\S+\.(?!js\b)[a-z0-9]{2,5}\b/gi, "…")
      .replace(/\d+/g, "#")
      .slice(0, 120);
    return `${kind}: ${text} @ ${frame[1]}:${frame[2]}`;
  };
  const failed = (error, message, source) => {
    if (!on()) return;
    const key = describe(error, message, source);
    if (!key) return;
    const errors = todays().e;
    if (!errors[key] && Object.keys(errors).length >= MAX_ERRORS) return;
    errors[key] = Math.min(10000, (errors[key] || 0) + 1);
    keepSoon();
  };
  window.addEventListener("error", (event) => {
    // A file that didn't load (an image, a font): no error object, and nothing of the app's
    if (!event.message) return;
    // The browser saying a layout took two passes: nothing went wrong
    if (/ResizeObserver loop/.test(event.message)) return;
    failed(event.error, event.message, { file: event.filename, line: event.lineno });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    // Stopped on purpose: a dialog closed, a load given up
    if (reason && reason.name === "AbortError") return;
    failed(reason instanceof Error ? reason : null, reason instanceof Error ? "" : String(reason));
  });

  const send = async () => {
    const state = read();
    if (!state || state.off || state.last === today() || !allowed()) return;
    if (!state.id) {
      if (!window.crypto || !window.crypto.randomUUID) return;
      state.id = window.crypto.randomUUID();
      write(state);
    }
    keep();
    // The days before today, the most recent first; those too old are dropped
    const stored = load(STORE_DAYS) || {};
    const oldest = dayOf(Date.now() - KEEP_DAYS * DAY);
    const past = Object.keys(stored).filter((day) => day < today()).sort().reverse();
    const days = {};
    past.filter((day) => day >= oldest).slice(0, MAX_DAYS).forEach((day) => { days[day] = stored[day]; });
    const version = (ua.match(/TypeR[ -]?Studio\/(\d+\.\d+\.\d+)/i) || [])[1];
    const lang = (window.TYPER_I18N && window.TYPER_I18N.lang) || "en";
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.id, app: desktop ? "desktop" : "web", platform: platform(), version, lang, touch: Boolean(window.TypeRShell && window.TypeRShell.touch), days }),
        keepalive: true,
      });
      // Turned off in the meantime: the number and the counts were just forgotten
      const now = read();
      if (!response.ok || !now || now.off) return;
      const sent = new Set(now.sent || []);
      Object.keys(days).forEach((day) => sent.add(day));
      write(Object.assign(now, { last: today(), sent: [...sent].filter((day) => day >= oldest).sort() }));
      const left = load(STORE_DAYS) || {};
      past.forEach((day) => { if (days[day] || day < oldest) delete left[day]; });
      store(STORE_DAYS, left);
    } catch (error) {
      // Offline: said at the next start
    }
  };

  window.TypeRStats = {
    enabled: () => {
      const state = read();
      return Boolean(state) && !state.off;
    },
    setEnabled(yes) {
      if (yes) {
        const state = read();
        if (state && state.off) write({});
        setTimeout(send, 0);
      } else {
        pending = {};
        write({ off: true });
        try {
          window.localStorage.removeItem(STORE_DAYS);
        } catch (error) {
          // Nothing kept
        }
      }
    },
    // A command or tool of TypeR Studio's own, by its English name, and from where (app.js)
    count,
    // An error the app caught but that stopped what the user asked for (an open, a save)
    error: (error) => failed(error instanceof Error ? error : null, error instanceof Error ? "" : String(error)),
  };

  setTimeout(send, AFTER_START);
})();
