// linuxdeploy rewrites every literal `/usr/` inside the libraries it deploys
// into `././/`, which turns the absolute paths WebKitGTK hands to bubblewrap
// (`bwrap`, `xdg-dbus-proxy`, the WebKit processes, the library and data
// directories it mounts) into paths relative to a working directory the
// sandbox never mounts. The process then dies with
// `bwrap: execvp /usr/bin/xdg-dbus-proxy: No such file or directory`.
//
// The two prefixes are the same length, so restoring them is a byte-for-byte
// substitution that cannot shift any offset. Do that in the AppDir the bundler
// just produced, then repack the AppImage from it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const BROKEN = Buffer.from("././/");
const RESTORED = Buffer.from("/usr/");
const ELF = Buffer.from("\x7fELF");
const root = resolve(new URL("..", import.meta.url).pathname);
const appimageDir = join(root, "target/release/bundle/appimage");

let entries;
try {
  entries = readdirSync(appimageDir);
} catch {
  process.exit(0); // Nothing was bundled as an AppImage.
}
const appDirs = entries.filter((entry) => entry.endsWith(".AppDir"));
if (appDirs.length === 0) process.exit(0);

function elfFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...elfFiles(path));
    else if (entry.isFile() && statSync(path).size > 0) found.push(path);
  }
  return found;
}

/** Overwrites every prefix occurrence in place; the lengths must match. */
function restore(bytes) {
  let count = 0;
  for (let at = bytes.indexOf(BROKEN); at !== -1; at = bytes.indexOf(BROKEN, at + BROKEN.length)) {
    RESTORED.copy(bytes, at);
    count += 1;
  }
  return count;
}

const arch = { x64: "x86_64", arm64: "aarch64", arm: "armhf" }[process.arch];
if (!arch) throw new Error(`unsupported AppImage architecture ${process.arch}`);
const plugin = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "tauri",
  "linuxdeploy-plugin-appimage.AppImage",
);

// Tauri's GTK plugin pins every AppImage to the X11 backend, a workaround from
// before this shell ran on Wayland: under XWayland the web view never commits
// its first load. Let GDK follow the session's own backend instead.
function releaseBackend(appDir) {
  const hook = join(appDir, "apprun-hooks/linuxdeploy-plugin-gtk.sh");
  let text;
  try {
    text = readFileSync(hook, "utf8");
  } catch {
    return false;
  }
  const pinned = /^export GDK_BACKEND=x11.*$/m;
  if (!pinned.test(text)) return false;
  writeFileSync(hook, text.replace(pinned, "# Neuxie: GDK follows the session's backend."));
  return true;
}

for (const name of appDirs) {
  const appDir = join(appimageDir, name);
  const released = releaseBackend(appDir);
  let files = 0;
  let rewrites = 0;
  for (const path of elfFiles(join(appDir, "usr"))) {
    const bytes = readFileSync(path);
    if (bytes.length < 4 || !bytes.subarray(0, 4).equals(ELF)) continue;
    const count = restore(bytes);
    if (count === 0) continue;
    writeFileSync(path, bytes);
    files += 1;
    rewrites += count;
  }
  const product = basename(name, ".AppDir");
  const appImage = entries.find((entry) => entry.startsWith(`${product}_`) && entry.endsWith(".AppImage"));
  if (!appImage) throw new Error(`no AppImage beside ${name}`);
  execFileSync(plugin, ["--appdir", appDir], {
    stdio: "inherit",
    env: { ...process.env, OUTPUT: join(appimageDir, appImage), ARCH: arch, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  console.log(
    `restored ${rewrites} path prefixes in ${files} libraries` +
      `${released ? ", released the pinned X11 backend" : ""}, repacked ${appImage}`,
  );
}
