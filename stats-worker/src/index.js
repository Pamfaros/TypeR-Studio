// Counts the people who use TypeR Studio, and what they use: once a day, an open app (web/stats.js)
// says so, with a random number drawn for that browser or that computer, and the totals of the
// days before (how many times each tool and command was used, and from where; the errors the app
// ran into, without what they were about). Nothing about the person or their files. One row per
// number and per day (UTC) in D1. The address isn't kept: only the country Cloudflare reads from it.
//
// Deploy: npx wrangler deploy (in this folder). The table: npx wrangler d1 execute typer-stats
// --remote --file schema.sql. Reading the numbers: queries.sql.

const ORIGINS = new Set(["https://typer.hayasaku.fr", "typer://app"]);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const APPS = new Set(["desktop", "web"]);
const PLATFORMS = new Set(["windows", "mac", "linux", "android", "ios", "chromeos", "other"]);
const VIA = new Set(["key", "menu", "context", "search", "toolbar"]);
const MAX_BODY = 65536;
// What one start may send: the days before today, so many of them, so old at most
const MAX_DAYS = 14;
const KEEP_DAYS = 30;
const MAX_NAMES = 500;
const MAX_ERRORS = 10;

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

const reply = (status, origin) => new Response(null, { status, headers: origin ? cors(origin) : {} });

const clip = (value, pattern) => (typeof value === "string" && pattern.test(value) ? value : null);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const amount = (value, max) => (Number.isInteger(value) && value > 0 ? Math.min(value, max) : 0);
// A name or an error as the app says it: one line of text, not too long
const label = (text, max) => typeof text === "string" && text.length > 0 && text.length <= max && !/[\u0000-\u001f]/.test(text);

// A day's totals as they may be kept, or null: { name: { via: n } } and { error: n }
const usageOf = (value) => {
  if (!isObject(value)) return null;
  const usage = {};
  for (const [name, vias] of Object.entries(value).slice(0, MAX_NAMES)) {
    if (!label(name, 100) || !isObject(vias)) continue;
    const counts = {};
    for (const [via, n] of Object.entries(vias)) if (VIA.has(via) && amount(n, 100000)) counts[via] = amount(n, 100000);
    if (Object.keys(counts).length) usage[name] = counts;
  }
  return Object.keys(usage).length ? usage : null;
};
const errorsOf = (value) => {
  if (!isObject(value)) return null;
  const errors = {};
  for (const [error, n] of Object.entries(value).slice(0, MAX_ERRORS)) if (label(error, 200) && amount(n, 10000)) errors[error] = amount(n, 10000);
  return Object.keys(errors).length ? errors : null;
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (!ORIGINS.has(origin)) return reply(403);
    if (request.method === "OPTIONS") return reply(204, origin);
    if (request.method !== "POST") return reply(405, origin);

    if (env.LIMIT) {
      const { success } = await env.LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
      if (!success) return reply(429, origin);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, origin);
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return reply(400, origin);
    }
    const id = clip(data.id, ID);
    if (!id || !APPS.has(data.app)) return reply(400, origin);
    // The desktop app runs only from its own address, the web only from the site's
    if ((data.app === "desktop") !== (origin === "typer://app")) return reply(400, origin);

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const oldest = new Date(now - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    const about = [
      id,
      data.app,
      PLATFORMS.has(data.platform) ? data.platform : "other",
      clip(data.version, /^\d{1,3}\.\d{1,3}\.\d{1,4}$/),
      clip(data.lang, /^[a-z]{2}$/),
      data.touch === true ? 1 : 0,
      clip(request.cf && request.cf.country, /^[A-Z0-9]{2}$/),
    ];
    // Today: once a day per number, the app asks only once and a second time changes nothing
    const statements = [
      env.DB.prepare("INSERT OR IGNORE INTO opens (day, id, app, platform, version, lang, touch, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(today, ...about),
    ];
    // The days before: their totals, in their own row (made if that day's start wasn't said)
    const days = isObject(data.days) ? Object.entries(data.days).slice(0, MAX_DAYS) : [];
    for (const [day, totals] of days) {
      if (!DAY.test(day) || day >= today || day < oldest || !isObject(totals)) continue;
      const usage = usageOf(totals.u);
      const errors = errorsOf(totals.e);
      if (!usage && !errors) continue;
      statements.push(env.DB.prepare(
        "INSERT INTO opens (day, id, app, platform, version, lang, touch, country, usage, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        + "ON CONFLICT (day, id) DO UPDATE SET usage = excluded.usage, errors = excluded.errors",
      ).bind(day, ...about, usage && JSON.stringify(usage), errors && JSON.stringify(errors)));
    }
    await env.DB.batch(statements);
    return reply(204, origin);
  },
};
