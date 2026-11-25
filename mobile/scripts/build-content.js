// Puts a copy of the site's app in www/: what the phone and tablet apps open with, even on a
// first launch with no connection. The same files as the desktop app's (see
// desktop/scripts/site-files.js), chosen by git.

const fs = require("fs");
const path = require("path");
const { REPO, describe, hashOf } = require("../../desktop/scripts/site-files");
const pkg = require("../package.json");

const target = path.resolve(__dirname, "..", "www");
const build = fs.mkdtempSync(target + "-build-");
const next = path.join(build, "public");
const backup = path.join(build, "previous");
let preserveBackup = false;
try {
  const { id, files } = describe();
  for (const file of Object.keys(files)) {
    const to = path.join(next, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), to);
  }
  let contentId = id;
  if (process.argv.includes("--nemesis-runtime")) {
    const crypto = require("node:crypto");
    const vendor = "web/vendor/nemesis";
    const folder = path.join(next, vendor);
    const model = "web/models/nemesis-manhwa.onnx";
    if (!files[model]) throw new Error("The Nemesis ONNX export is missing: " + model);
    require("./bundle-nemesis")(folder);
    for (const name of fs.readdirSync(folder).sort()) files[vendor + "/" + name] = hashOf(fs.readFileSync(path.join(folder, name)));
    contentId = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
  }
  fs.writeFileSync(path.join(next, "content.json"), JSON.stringify({ id: contentId, builtAt: Date.now(), minShell: pkg.minContentShell, files }));
  // The app lives in web/, as on the site: whatever leads to the root comes back to it.
  fs.writeFileSync(path.join(next, "index.html"), '<!DOCTYPE html><meta charset="UTF-8"><title>TypeR Studio</title><script>location.replace("web/index.html")</script>\n');

  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(next, target);
  } catch (error) {
    if (fs.existsSync(backup)) {
      preserveBackup = true;
      fs.renameSync(backup, target);
      preserveBackup = false;
    }
    throw error;
  }
  const bytes = Object.values(files).reduce((total, file) => total + file.size, 0);
  console.log(`Content ${contentId}: ${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB.`);
} finally {
  if (!preserveBackup) fs.rmSync(build, { recursive: true, force: true });
}
