#!/usr/bin/env bash
# Record the browser window for N seconds and count chrome-band repaint flicker.
#
#   scripts/measure-flicker.sh <seconds> <out.mp4> [top|full]
#
# Finds the client whose class is `app.neuxie` and title is `Neuxie Browser` via
# `hyprctl clients -j`, focuses it, records exactly that region (wf-recorder on
# Wayland, ffmpeg/x11grab otherwise), then differences consecutive frames and
# counts mean absolute differences above a fixed 2.0 YAVG threshold.
#
# Band: `top` (default) crops the first 64 px — chrome only, never page content,
# so it cannot see in-page UI flicker. `full` differences the whole window,
# which is what catches menus vanishing and returning inside the page.
set -euo pipefail

THRESHOLD=2.0
BAND_HEIGHT=64

usage() {
  printf 'usage: %s <seconds> <out.mp4> [top|full]\n' "$(basename "$0")" >&2
  exit 2
}

die() {
  printf 'measure-flicker: %s\n' "$*" >&2
  exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || usage
seconds=$1
out=$2
band=${3:-top}

case $band in
  top) ;;
  full) ;;
  *) usage ;;
esac

[[ $seconds =~ ^[0-9]+$ && $seconds -gt 0 ]] || die "invalid <seconds>: $seconds"
command -v jq >/dev/null || die "jq is required to parse hyprctl output"
command -v hyprctl >/dev/null || die "hyprctl is required (Hyprland session)"
command -v ffmpeg >/dev/null || die "ffmpeg is required"

# ---------------------------------------------------------------- geometry

clients=$(hyprctl clients -j) || die "hyprctl clients failed (is Hyprland running?)"

geometry=$(
  jq -r '
    [ .[] | select(.class == "app.neuxie" and .title == "Neuxie Browser") ] as $match
    | if ($match | length) == 0 then empty
      else $match[0] | [ .address, .at[0], .at[1], .size[0], .size[1] ] | @tsv
      end
  ' <<<"$clients"
)

[[ -n $geometry ]] || die 'no window with class "app.neuxie" and title "Neuxie Browser"'

IFS=$'\t' read -r address x y w h <<<"$geometry"

[[ $w =~ ^[0-9]+$ && $h =~ ^[0-9]+$ && $w -gt 0 && $h -gt 0 ]] || die "bad window size ${w}x${h}"
[[ $x =~ ^-?[0-9]+$ && $y =~ ^-?[0-9]+$ ]] || die "bad window position ${x},${y}"
[[ $band != top || $h -ge $BAND_HEIGHT ]] || die "window height $h is smaller than the ${BAND_HEIGHT}px chrome band"

printf 'window: address=%s at=%s,%s size=%sx%s\n' "$address" "$x" "$y" "$w" "$h"

hyprctl dispatch focuswindow "address:$address" >/dev/null 2>&1 || {
  # Hyprland builds configured in Lua evaluate `dispatch` as Lua and reject the
  # legacy `focuswindow address:0x…` form (exit 7). Fall back to the dispatcher.
  lua_focus="hl.dsp.focus({window=\"address:${address}\"})"
  if hyprctl dispatch "$lua_focus" 2>/dev/null | grep -qx 'ok'; then
    printf 'focus: lua dispatcher (hl.dsp.focus)\n'
  elif hyprctl eval "hl.dispatch($lua_focus)" 2>/dev/null | grep -qx 'ok'; then
    printf 'focus: lua eval (hl.dispatch)\n'
  else
    die "could not focus $address (legacy and lua dispatchers both failed)"
  fi
}

# ---------------------------------------------------------------- recording

mkdir -p "$(dirname "$out")"
rm -f "$out"

record_wf_recorder() {
  local geom=$1 log=$2 pid
  wf-recorder -g "$geom" -f "$out" >"$log" 2>&1 &
  pid=$!
  # wf-recorder exits immediately on a geometry/backend error; give it a moment
  # to prove the capture actually started before we commit to the full duration.
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" || true
    return 1
  fi
  sleep "$seconds"
  kill -INT "$pid" 2>/dev/null || true
  wait "$pid" || true
  [[ -s $out ]]
}

backend=""
record_log="$(mktemp -t neuxie-flicker-record-XXXXXX.log)"
trap 'rm -f "$record_log"' EXIT

if [[ -n ${WAYLAND_DISPLAY:-} ]]; then
  command -v wf-recorder >/dev/null || die "wf-recorder is required when WAYLAND_DISPLAY is set"
  backend="wf-recorder (wlr-screencopy, WAYLAND_DISPLAY=$WAYLAND_DISPLAY)"
  geom="${w}x${h}+${x}+${y}"
  if record_wf_recorder "$geom" "$record_log"; then
    printf 'geometry args: %s\n' "$geom"
  else
    # Older wf-recorder builds accept "x,y WxH" only; retry once with that form.
    alt="$x,$y ${w}x${h}"
    printf 'measure-flicker: wf-recorder rejected -g %s, retrying with "%s"\n' "$geom" "$alt" >&2
    rm -f "$out"
    if record_wf_recorder "$alt" "$record_log"; then
      geom=$alt
      printf 'geometry args: %s (fallback form)\n' "$geom"
    else
      printf 'measure-flicker: wf-recorder log (%s):\n' "$record_log" >&2
      sed -n '1,20p' "$record_log" >&2 || true
      die "wf-recorder could not record ${w}x${h}+${x}+${y}"
    fi
  fi
else
  command -v ffmpeg >/dev/null || die "ffmpeg is required when WAYLAND_DISPLAY is unset"
  backend="ffmpeg x11grab (:0.0, DISPLAY=${DISPLAY:-:0.0})"
  ffmpeg -hide_banner -loglevel error -y \
    -f x11grab -video_size "${w}x${h}" -framerate 30 -i ":0.0+${x},${y}" \
    -t "$seconds" -pix_fmt yuv420p "$out" || die "ffmpeg x11grab recording failed"
fi

[[ -s $out ]] || die "recording produced no data at $out"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out" 2>/dev/null |
  xargs -r printf 'recorded: %ss\n' || true
printf 'backend: %s\n' "$backend"

# ------------------------------------------------------------------- flicker

if [[ $band == top ]]; then
  filter="crop=iw:${BAND_HEIGHT}:0:0,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG"
  band_label="top (${BAND_HEIGHT}px chrome band)"
else
  filter="tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG"
  band_label="full (whole window ${w}x${h})"
fi

stats=$(
  ffmpeg -hide_banner -i "$out" \
    -vf "$filter" \
    -f null - 2>&1 |
    awk -v threshold="$THRESHOLD" '
      # ffmpeg prefixes the value line with "[Parsed_metadata_3 @ 0x…]", so the
      # value is not a fixed field; read whatever follows "YAVG=".
      index($0, "lavfi.signalstats.YAVG=") {
        v = $0
        sub(/.*lavfi\.signalstats\.YAVG=/, "", v)
        v = v + 0
        if (v > threshold) n++
        if (v > m) m = v
        seen++
      }
      END { printf "flicker_frames=%d max_yavg=%.3f samples=%d\n", n + 0, m + 0, seen + 0 }
    '
) || die "ffmpeg difference pass failed"

printf 'band: %s\n' "$band_label"
printf 'threshold: %s YAVG\n' "$THRESHOLD"
printf '%s\n' "$stats"
printf 'output: %s\n' "$out"
