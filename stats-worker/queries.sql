-- Reading the numbers: npx wrangler d1 execute typer-stats --remote --command "…" (in this folder).
-- Each number is a browser or a computer, not quite a person: someone on two computers, or who
-- clears their browser's data, counts twice.

-- People a day, desktop and web, over the last 30 days
SELECT day, app, COUNT(*) AS people FROM opens
WHERE day >= date('now', '-30 days') GROUP BY day, app ORDER BY day, app;

-- Active over the last 1, 7 and 30 days
SELECT app,
  COUNT(DISTINCT CASE WHEN day >= date('now', '-1 days') THEN id END) AS day,
  COUNT(DISTINCT CASE WHEN day >= date('now', '-7 days') THEN id END) AS week,
  COUNT(DISTINCT id) AS month
FROM opens WHERE day >= date('now', '-30 days') GROUP BY app;

-- New people a day (their first day)
SELECT first AS day, app, COUNT(*) AS new FROM (SELECT id, app, MIN(day) AS first FROM opens GROUP BY id)
WHERE first >= date('now', '-30 days') GROUP BY first, app ORDER BY first, app;

-- Systems, versions of the desktop app, languages and countries, over the last 30 days
SELECT app, platform, COUNT(DISTINCT id) AS people FROM opens WHERE day >= date('now', '-30 days') GROUP BY app, platform ORDER BY people DESC;
SELECT version, COUNT(DISTINCT id) AS people FROM opens WHERE app = 'desktop' AND day >= date('now', '-7 days') GROUP BY version ORDER BY people DESC;
SELECT lang, COUNT(DISTINCT id) AS people FROM opens WHERE day >= date('now', '-30 days') GROUP BY lang ORDER BY people DESC;
SELECT country, COUNT(DISTINCT id) AS people FROM opens WHERE day >= date('now', '-30 days') GROUP BY country ORDER BY people DESC LIMIT 20;

-- Who comes back: of those first seen 8 to 14 days ago, how many were seen again in the last 7
SELECT COUNT(*) AS new, SUM(back) AS came_back FROM (
  SELECT id, MIN(day) AS first, MAX(day >= date('now', '-7 days')) AS back FROM opens GROUP BY id
) WHERE first BETWEEN date('now', '-14 days') AND date('now', '-8 days');

-- The tools and commands, by how many people used them and how often, over the last 30 days.
-- Each day's totals come at a later start: the last day or two are missing.
SELECT u.key AS command, COUNT(DISTINCT o.id) AS people, SUM(v.value) AS uses
FROM opens o, json_each(o.usage) u, json_each(u.value) v
WHERE o.day >= date('now', '-30 days') GROUP BY u.key ORDER BY people DESC;

-- From where each one is used: keys, menu, context menu, search, toolbar. Often from the menu
-- and seldom from its keys: its shortcut is missing, or not known.
SELECT u.key AS command, v.key AS via, SUM(v.value) AS uses
FROM opens o, json_each(o.usage) u, json_each(u.value) v
WHERE o.day >= date('now', '-30 days') GROUP BY u.key, v.key ORDER BY u.key, uses DESC;

-- A new tool's take-up since a day: how many of the people using the app tried it
SELECT o.day, COUNT(DISTINCT o.id) AS people,
  COUNT(DISTINCT CASE WHEN json_extract(o.usage, '$."Tools:Lasso"') IS NOT NULL THEN o.id END) AS used_it
FROM opens o WHERE o.day >= '2026-11-12' AND o.usage IS NOT NULL GROUP BY o.day ORDER BY o.day;

-- The errors, by how many people ran into them, with the desktop app's version
SELECT e.key AS error, o.app, o.version, COUNT(DISTINCT o.id) AS people, SUM(e.value) AS times
FROM opens o, json_each(o.errors) e
WHERE o.day >= date('now', '-30 days') GROUP BY e.key, o.app, o.version ORDER BY people DESC LIMIT 30;
