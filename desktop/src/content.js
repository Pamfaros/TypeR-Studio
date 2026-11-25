
"use strict";

/**
 * Nemesis Edition - local content management.
 *
 * Only bundled application resources are used.
 * Remote content updates are intentionally disabled.
 * New versions are distributed through manual installers.
 */

const fs = require("node:fs");
const path = require("node:path");

const SEED = path.join(__dirname, "..", "content");

let active = null;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
};

const seedInfo = () =>
  readJson(path.join(SEED, "content.json"));

const choose = () => {
  active = {
    root: SEED,
    info: seedInfo()
  };

  return active;
};

const current = () => active;

// Nemesis Edition never uses remotely downloaded content.
const isDownloaded = () => false;

// No remote content version needs confirmation.
const confirm = () => {};

// Remote update checks are permanently disabled.
const check = async () => false;

const update = async () => "none";

module.exports = {
  choose,
  current,
  isDownloaded,
  confirm,
  check,
  update
};
