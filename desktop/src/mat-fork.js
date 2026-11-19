"use strict";

const pkg = require("../package.json");

module.exports = {
  enabled:
    pkg.matFork === true ||
    process.env.TYPER_MAT_FORK === "1",
};