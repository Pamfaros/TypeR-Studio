// Puts a copy of the site's app in www/: what the phone and tablet apps open with, even on a
// first launch with no connection. The same files as the desktop app's (see
// desktop/scripts/site-files.js), chosen by git.

const fs = require("fs");
const path = require("path");
const { REPO, describe } = require("../../desktop/scripts/site-files");
const pkg = require("../package.json");

const target = path.resolve(__dirname, "..", "www");
fs.rmSync(target, { recursive: true, force: true });

const { id, files } = describe();
for (const file of Object.keys(files)) {
  const to = path.join(target, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(REPO, file), to);
}
fs.writeFileSync(path.join(target, "content.json"), JSON.stringify({ id, builtAt: Date.now(), minShell: pkg.minContentShell, files }));
// The app lives in web/, as on the site: whatever leads to the root comes back to it
fs.writeFileSync(path.join(target, "index.html"), '<!DOCTYPE html><meta charset="UTF-8"><title>TypeR Studio</title><script>location.replace("web/index.html")</script>\n');

const bytes = Object.values(files).reduce((total, file) => total + file.size, 0);
console.log(`Content ${id}: ${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB.`);
