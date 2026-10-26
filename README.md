<div align="center">
  <img src=".github/assets/logo.png" width="112" height="112" alt="Neuxie" />
  <h1>Neuxie</h1>

  <p><strong>A fast, fully featured browser and work environment,<br />built for Linux.</strong></p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue" alt="License: MPL-2.0" /></a>
    <img src="https://img.shields.io/badge/platform-Linux%20(experimental)%20%7C%20macOS%20%7C%20Windows-lightgrey" alt="Platforms: Linux (experimental), macOS and Windows" />
  </p>
</div>

Neuxie is a source fork of [Zephium](https://github.com/zephium-browser/Zephium)
that adds an experimental Linux build. It is the same browser: Rust on your
operating system's own web engine, not a fork of Chromium or Firefox. On Linux
it uses the system GTK 3 and WebKitGTK 4.1; on macOS and Windows it is upstream's
WebKit and WebView2 build unchanged. It blocks ads and trackers natively, runs
Chrome extensions on the platforms that have a WebExtension runtime, and puts
tasks, notes and your time on the web in one place.

Neuxie is **not affiliated with, endorsed by, or supported by the Zephium
project**. Upstream wrote essentially all of this code; see [NOTICE](NOTICE) for
attribution. The product name, identifier and icons were renamed for this fork.

## Build on Linux

Prerequisites:

- Rust 1.99 or newer, and the Node/pnpm versions pinned in `.node-version` and
  `package.json`
- GTK 3 and WebKitGTK 4.1 with its development headers
- `libayatana-appindicator` (Arch: `libappindicator`), `libsecret`
- GStreamer and its plugins, for media playback
- The usual build tools (`gcc`, `pkg-config`, `patchelf`), plus `bwrap` and
  `xdg-dbus-proxy` for the bundle and for running it (`bubblewrap`,
  `xdg-dbus-proxy` on Arch)

```sh
pnpm install --frozen-lockfile
NO_STRIP=1 pnpm -C desktop build --bundles appimage
```

The command yields
`target/release/bundle/appimage/app.neuxie_1.0.4_amd64.AppImage` — the file name
is the application id, the version in `tauri.conf.json`, and the Debian
architecture, because the bundler derives it from the Linux `productName` (which
must stay `app.neuxie` so the installed entry is `app.neuxie.desktop`).

`NO_STRIP=1` is required where the distro's binutils emit `.relr.dyn` sections:
the `strip` that ships inside linuxdeploy cannot read them and aborts the
bundle. The post-bundle step in `scripts/patch-appimage-sandbox.mjs` repairs the
library paths linuxdeploy relocates and repacks the image; without it the
AppImage dies at startup because WebKitGTK cannot find `bwrap`.

A plain development build is `cargo build -p zephium-desktop` (debug binaries
load the frontend from `http://localhost:1420`, so run `pnpm --dir frame dev`
alongside them).

## Run

```sh
./target/release/bundle/appimage/app.neuxie_1.0.4_amd64.AppImage
```

If FUSE is unavailable (common in containers and some minimal installs), unpack
and run instead:

```sh
./app.neuxie_1.0.4_amd64.AppImage --appimage-extract-and-run
```

A release download arrives without the executable bit; `chmod +x
app.neuxie_1.0.4_amd64.AppImage` once before running it.

The bundled WebKitGTK stays sandboxed, so the host must provide `bwrap` and
`xdg-dbus-proxy` (Arch: `bubblewrap`, `xdg-dbus-proxy`).

## Rendering on Linux

Neuxie picks WebKitGTK's render backend itself at startup, before GTK initialises, so the AppImage needs
no render environment from whoever launches it. The decision is reported once on stderr, prefixed like
every other line in the session log:

```
ts_ms=... session=... render: backend=Fallback session=Wayland nvidia=true reason=nvidia
```

The rule is vendor-based. A machine that exposes the NVIDIA kernel module
(`/proc/driver/nvidia/version` or `/sys/module/nvidia/version`) gets WebKit's fallback renderer, because
the proprietary and the open-kernel module both break the GBM/dmabuf path under Wayland and X11 alike.
Every other machine keeps the dmabuf renderer. `reason` is one of `nvidia`, `request`, `environment` or
`default`.

| `NEUXIE_RENDER_BACKEND` | Effect |
| --- | --- |
| unset, or `auto` | detect (default) |
| `dmabuf` | force the dmabuf renderer |
| `fallback` | disable the dmabuf renderer |
| `software` | disable dmabuf and compositing |

A `WEBKIT_DISABLE_DMABUF_RENDERER` that is already set always wins, so a launcher wrapper keeps working
unchanged.

Two things to know before reporting a rendering bug:

- The toplevel is opaque. No Linux build installs a native window material, so the alpha path bought
  nothing and cost an ARGB visual and a compositing surface for every window. Translucent chrome now
  blends against the window's own ground instead of whatever sits behind the window, so such a surface
  can look different from 1.0.3 over a wallpaper.
- WebKit's memory-pressure settings are construct-only on the bundled WebKitGTK 4.1, so the app leaves
  them alone instead of panicking during startup. Memory use is unchanged from 1.0.3, and the table below
  is the check.

### Measured on this class of machine

RTX 3050 Ti Laptop 4 GB (NVIDIA kernel module 615.78.08), Hyprland 0.56.2 on native Wayland, 16 cores,
14 GB RAM. `x11` means `GDK_BACKEND=x11`, which resolves to XWayland here; no bare Xorg session was
available to test against.

| | 1.0.3 | 1.0.4 |
| --- | --- | --- |
| launch with no render environment, native Wayland | process dies about 1.7 s after the window maps: `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display` | runs; prints `render: backend=Fallback session=Wayland nvidia=true reason=nvidia` |
| 600-frame scroll workload | never completes; the page never calls back | 599 of 599 frames, both sessions |
| frame time p50 / p95 | 17 / 31 ms, and only with the workaround exported; x11 produced no result | 17 / 19 ms native, 17 / 17 ms x11 |
| frames over 33.3 ms | up to 17 of 599 | 0 |
| idle flicker over 10 s, chrome band and whole window | 0 recorded, but the interactive state could not be exercised because the workload never ran | 0 in all four runs, peak frame difference 0.29 against the 2.0 threshold |
| steady PSS with the page loaded | 673.4 MiB native | 672.6 MiB native (−0.06%), 582.1 vs 616.6 MiB on x11 (−5.6%) |
| VRAM used while loaded | +5 MiB | +13 MiB |
| launch to window shown | 1470 ms | 1230 ms |

`scripts/measure-render.mjs`, `scripts/measure-memory.mjs` and `scripts/measure-flicker.sh` are in the
tree so these numbers can be re-taken on another machine.

This fork does not ship signed auto-updates yet, so updates are manual: re-download the newer AppImage from the releases page.

## Changes from upstream

- **Linux port.** Upstream refuses Linux at two gates; this fork carries the
  upstream contributor's unmerged gate fix (PR #221) plus the follow-up fixes
  needed to compile and link the desktop shell against GTK 3 and WebKitGTK 4.1.
- **Rebrand.** Application name `Neuxie`, identifier `app.neuxie`, new icons,
  wordmark and user-facing strings. The installed desktop entry is
  `app.neuxie.desktop` so the GTK application id and the portal registry id stay
  on one value.
- **Updates and links** point at this repository's releases and issues, never at
  upstream's, so an updated install can never be replaced by an upstream binary.

## Known Linux gaps

Not yet implemented or qualified on Linux:

- Native download transport
- Extension hosting: WebKitGTK has no native WebExtension runtime
- Ask's native page reader
- Work's native browser adapters
- Application credentials through Secret Service
- A qualified sandbox for Work command execution

Window behaviour, global shortcuts and the rest of the desktop integration are
unqualified across X11 and Wayland compositors: treat a Linux build as a
developer preview, not a release.

## License

Neuxie is distributed under the same terms as upstream: the Mozilla Public
License 2.0 (`MPL-2.0`), with the bundled blocker seed lists under
CC-BY-SA-3.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and
`assets/blocker-seed/v1/NOTICE`.
