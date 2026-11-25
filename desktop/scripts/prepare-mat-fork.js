
"use strict";

/**
 * TypeR Studio Nemesis Edition - build preparation.
 *
 * Validates the dedicated Nemesis Edition build configuration,
 * including MAT integration and Patch Tool resources.
 *
 * Nemesis Edition is an extended fork of TypeR Studio.
 * MAT is one of its features, not a separate product edition.
 *
 * Integration changes are maintained in Git and are not
 * generated or overwritten during packaging.
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const desktop = path.resolve(__dirname, "..");

const EDITION = {
  name: "TypeR Studio Nemesis Edition",
  appId: "local.typerstudio.nemed",
  configFile: "electron-builder.mat.cjs",
  outputDirectory: "dist-mat"
};

const resolve = (file) => path.resolve(desktop, file);

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
        `${file}: missing required integration: ${marker}`
      );
    }
  }

  console.log(`[OK] ${file}`);
}

function validateBuildConfig() {
  const pkg = JSON.parse(read("package.json"));

  // Preserve the upstream package as the base configuration.
  // The final product identity is defined by the Nemesis config.
  assert.equal(
    pkg.productName,
    "TypeR Studio",
    "Unexpected base package productName."
  );

  assert.equal(
    pkg.build.appId,
    "fr.hayasaku.typer-studio",
    "Unexpected base package appId."
  );

  const configFile = EDITION.configFile;

  read(configFile);

  const config = require(resolve(configFile));

  assert.equal(
    config.appId,
    EDITION.appId,
    "Incorrect Nemesis Edition appId."
  );

  assert.equal(
    config.productName,
    EDITION.name,
    "Incorrect Nemesis Edition productName."
  );

  // Keep the MAT runtime feature flag enabled.
  assert.equal(
    config.extraMetadata?.matFork,
    true,
    "MAT runtime integration must remain enabled."
  );

  assert.equal(
    config.directories?.output,
    EDITION.outputDirectory,
    "Unexpected build output directory."
  );

  // Nemesis releases are distributed manually.
  assert.deepEqual(
    config.publish,
    [],
    "Automatic publishing must be disabled."
  );

  // Do not register the upstream URL protocol.
  assert.deepEqual(config.protocols, []);

  // Do not execute upstream NSIS registration hooks.
  assert.equal(config.nsis?.include, null);

  // Required MAT backend resources.
  const resources = config.extraResources || [];

  for (const target of ["mat", "mat/MAT"]) {
    assert(
      resources.some((item) => item.to === target),
      `Missing extraResources destination: ${target}`
    );
  }

  console.log("[OK] Nemesis Edition identity");
  console.log("[OK] Dedicated Electron build configuration");
  console.log("[OK] MAT packaging resources");
  console.log("[OK] Automatic publishing disabled");
}

function validateMatIntegration() {
  validateMarkers("src/mat-fork.js", [
    "pkg.matFork === true",
    "TYPER_MAT_FORK"
  ]);

  validateMarkers("src/content.js", [
    'const check = async () => false',
    'const update = async () => "none"',
    'const isDownloaded = () => false'
  ]);

  validateMarkers("src/main.js", [
    'require("./mat-fork").enabled',
    "if (MAT_FORK)"
  ]);

  for (const file of [
    "src/mat-engine.js",
    "src/mat-installer.js",
    "mat/mat_worker.py",
    "mat/requirements-mat.txt"
  ]) {
    read(file);
    console.log(`[OK] ${file}`);
  }

  console.log("[OK] MAT integration");
}

function validatePatchTool() {
  const files = [
    "../web/patch-tool.js",
    "../web/patch-engine.js",
    "../web/photoshop.js",
    "../web/app.js",
    "../web/index.html"
  ];

  for (const file of files) {
    read(file);
    console.log(`[OK] ${file}`);
  }

  console.log("[OK] Patch Tool files");
}

function main() {
  console.log("Validating TypeR Studio Nemesis Edition...\n");

  validateBuildConfig();
  validateMatIntegration();
  validatePatchTool();

  console.log(
    "\nNemesis Edition configuration validated successfully."
  );

  console.log(
    "MAT and Patch Tool resources are present."
  );
}

try {
  main();
} catch (error) {
  console.error("\nNemesis build preparation failed:");
  console.error(error.message);
  process.exitCode = 1;
}
