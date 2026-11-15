-- One row per app (its random number) and per day (UTC) it was opened
CREATE TABLE IF NOT EXISTS opens (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  app TEXT NOT NULL,
  platform TEXT NOT NULL,
  version TEXT,
  lang TEXT,
  touch INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  -- That day's totals, sent at a later start: { "Tools:Lasso Tool": { "key": 30, "toolbar": 12 } }
  -- (from where: key, menu, context, search, toolbar) and { "TypeError: … @ app.js:#": 2 }
  usage TEXT,
  errors TEXT,
  PRIMARY KEY (day, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS opens_id ON opens (id, day);
