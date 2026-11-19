
"use strict";

/**
 * TypeR Studio MAT Edition — build preparation.
 *
 * Validates the separate MAT build configuration without
 * modifying the official TypeR Studio package.json.
 *
 * MAT integration changes in main.js and content.js are
 * maintained in Git, not generated during packaging.
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const desktop = path.resolve(__dirname, "..");

const resolve = (file) => path.join(desktop, file);

function read(file) {
  const target = resolve(file);

  if (!fs.existsSync(target)) {
    throw new Error(`Missing required file: ${file}`);
  }

  return fs.readFileSync(target, "utf8");
}

function validateMarkers(file, markers) {
  const source = read(file);

  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(
        `${file}: missing required MAT integration: ${marker}`
      );
    }
  }

  console.log(`[OK] ${file}`);
}

function validateBuildConfig() {
  const pkg = JSON.parse(read("package.json"));

  // Official TypeR Studio configuration must stay intact.
  assert.equal(
    pkg.productName,
    "TypeR Studio",
    "The original package.json productName was modified."
  );

  assert.equal(
    pkg.build.appId,
    "fr.hayasaku.typer-studio",
    "The original package.json appId was modified."
  );

  const configFile = "electron-builder.mat.cjs";

  read(configFile);

  const config = require(resolve(configFile));

  assert.equal(config.appId, "local.typerstudio.mat");
  assert.equal(config.productName, "TypeR Studio MAT");
  assert.equal(config.extraMetadata?.matFork, true);
  assert.equal(config.directories?.output, "dist-mat");

  // A fork must not publish artifacts to ScanR's repository.
  assert.deepEqual(config.publish, []);

  // Do not replace the official URL protocol registration.
  assert.deepEqual(config.protocols, []);

  // Do not execute upstream NSIS registration hooks.
  assert.equal(config.nsis?.include, null);

  const resources = config.extraResources || [];

  for (const target of ["mat", "mat/MAT"]) {
    assert(
      resources.some((item) => item.to === target),
      `Missing extraResources destination: ${target}`
    );
  }

  console.log("[OK] Official package.json is unchanged");
  console.log("[OK] Separate MAT build configuration");
}

function validateIntegration() {
  validateMarkers("src/mat-fork.js", [
    "pkg.matFork === true",
    "TYPER_MAT_FORK"
  ]);

  validateMarkers("src/content.js", [
    'require("./mat-fork").enabled',
    "if (MAT_FORK)",
  ]);

  validateMarkers("src/main.js", [
    'require("./mat-fork").enabled',
    "if (MAT_FORK)"
  ]);

  // Files required by the packaged MAT backend.
  for (const file of [
    "src/mat-engine.js",
    "src/mat-installer.js",
    "mat/mat_worker.py",
    "mat/requirements-mat.txt"
  ]) {
    read(file);
    console.log(`[OK] ${file}`);
  }
}

function main() {
  console.log("Validating TypeR Studio MAT Edition...\n");

  validateBuildConfig();
  validateIntegration();

  console.log(
    "\nMAT configuration validated successfully."
  );

  console.log(
    "The original TypeR Studio configuration was not modified."
  );
}

try {
  main();
} catch (error) {
  console.error("\nMAT build preparation failed:");
  console.error(error.message);
  process.exitCode = 1;
}
