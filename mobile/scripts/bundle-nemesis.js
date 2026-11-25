
"use strict";

/**
 * Nemesis Edition - offline ONNX Runtime bundler.
 *
 * Packages the pinned ONNX Runtime Web distribution
 * for offline inference on Android devices.
 *
 * License files are maintained separately because
 * onnxruntime-web@1.22.0 omits them from its npm archive.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const version = "1.22.0";
const packageVersion = `onnxruntime-web@${version}`;

const files = [
  "ort.wasm.min.mjs",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm"
];

const licenseFiles = [
  "LICENSE",
  "ThirdPartyNotices.txt"
];

const licenseDirectory = path.resolve(
  __dirname,
  "..",
  "licenses",
  `onnxruntime-web-${version}`
);

function bundleNemesis(target) {
  const npm = process.env.npm_execpath;

  if (!npm) {
    throw new Error("Run the mobile build through npm.");
  }

  // Validate locally maintained license files.
  for (const file of licenseFiles) {
    const source = path.join(licenseDirectory, file);

    if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
      throw new Error(`Missing ONNX Runtime license file: ${source}`);
    }
  }

  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "typer-nemesis-")
  );

  try {
    console.log(`[Nemesis] Preparing ${packageVersion}`);

    const [archive] = JSON.parse(
      execFileSync(
        process.execPath,
        [
          npm,
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          temp,
          packageVersion
        ],
        { encoding: "utf8" }
      )
    );

    // Extract only files actually included in the npm archive.
    execFileSync("tar", [
      "-xf",
      path.join(temp, archive.filename),
      "-C",
      temp,
      ...files.map((file) => `package/dist/${file}`)
    ]);

    fs.mkdirSync(target, { recursive: true });

    // Older Android WebViews may not recognize .mjs MIME types.
    for (const file of files) {
      const source = path.join(temp, "package", "dist", file);
      const outputName = file.replace(/\.mjs$/, ".js");
      const destination = path.join(target, outputName);

      fs.copyFileSync(source, destination);

      console.log(`[OK] ${outputName}`);
    }

    // Include the official license and third-party notices.
    for (const file of licenseFiles) {
      fs.copyFileSync(
        path.join(licenseDirectory, file),
        path.join(target, file)
      );

      console.log(`[OK] ${file}`);
    }

    console.log(
      "[Nemesis] Offline ONNX Runtime bundled successfully."
    );

  } finally {
    fs.rmSync(temp, {
      recursive: true,
      force: true
    });
  }
}

module.exports = bundleNemesis;
