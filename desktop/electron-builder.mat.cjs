
"use strict";

const base = require("./package.json").build;

module.exports = {
  ...base,

  appId: "local.typerstudio.mat",
  productName: "TypeR Studio MAT",

  // Marks the packaged application as the MAT fork.
  extraMetadata: {
    ...base.extraMetadata,
    matFork: true,
    productName: "TypeR Studio MAT",
  },

  directories: {
    ...base.directories,
    output: "dist-mat",
  },

  // Do not register the official TypeR protocol.
  protocols: [],

  // Never publish artifacts to ScanR repositories.
  publish: [],

  nsis: {
    ...base.nsis,

    // Disable upstream custom installer hooks.
    include: null,

    artifactName:
      "TypeR-Studio-MAT-Setup-${version}.${ext}",
  },

  extraResources: [
    ...(base.extraResources || []),

    {
      from: "mat",
      to: "mat",
      filter: [
        "mat_worker.py",
        "requirements-mat.txt",
        "uv.exe",
      ],
    },

    {
      from: "mat/MAT",
      to: "mat/MAT",
      filter: [
        "**/*",
        "!**/.git/**",
        "!**/__pycache__/**",
        "!**/*.pyc",
        "!test_sets/**",
        "!datasets/**",
        "!figures/**",
        "!evaluation/**",
        "!**/*.pkl",
        "!**/*.pth",
      ],
    },
  ],
};
