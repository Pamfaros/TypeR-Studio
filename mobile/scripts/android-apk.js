const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const android = path.resolve(__dirname, "../android");
const win = process.platform === "win32";
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", win ? "java.exe" : "java") : "java";
const version = spawnSync(java, ["-version"], { encoding: "utf8", timeout: 10000 });
const major = Number((version.stderr || "").match(/version "(\d+)/)?.[1]);
if (major !== 21) {
  console.error("Android builds use JDK 21. Set JAVA_HOME to its installation directory.");
  process.exit(1);
}
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!(sdk && fs.existsSync(sdk)) && !fs.existsSync(path.join(android, "local.properties"))) {
  console.error("Android SDK 36 is required. Set ANDROID_HOME or configure android/local.properties.");
  process.exit(1);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this command through npm: npm run android:apk");
const prepare = spawnSync(process.execPath, [npm, "run", "android:prepare"], {
  cwd: path.dirname(android), stdio: "inherit",
});
if (prepare.error) throw prepare.error;
if (prepare.status !== 0) process.exit(prepare.status || 1);
const command = win ? process.env.ComSpec || "cmd.exe" : "sh";
const args = win ? ["/d", "/c", "gradlew.bat", "--no-daemon", "assembleDebug"]
  : ["./gradlew", "--no-daemon", "assembleDebug"];
const result = spawnSync(command, args, { cwd: android, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const apk = path.join(android, "app/build/outputs/apk/debug/app-debug.apk");
fs.accessSync(apk, fs.constants.R_OK);
console.log(apk);
