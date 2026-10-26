#!/usr/bin/env node
// Measure resident memory (PSS) of the browser and each of its helper processes
// over time, alongside GPU memory. Zero dependencies.
//
//   node scripts/measure-memory.mjs <appimage> <url> <seconds>
//
// Sampling: one snapshot every 2 s. Every snapshot walks /proc, resolves the app
// root (the process whose /proc/<pid>/exe basename is `zephium-desktop` and
// whose PPID chain reaches the launched pid) plus all of its descendants, reads
// `Pss` from /proc/<pid>/smaps_rollup (falling back to summing `Pss:` in
// /proc/<pid>/smaps when smaps_rollup is unreadable) and groups the totals by
// executable basename.
//
// Output: one JSON line with every sample, plus a human table with the point
// measurement (t = 30 s, or t = seconds when that is smaller) and a `steady`
// median over five snapshots taken 2 s apart after that point.
//
// Exits non-zero when no WebKitWebProcess was ever found (a broken walk), and
// always kills the launched process group.

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROLE_NAMES = [
  "zephium-desktop",
  "WebKitWebProcess",
  "WebKitNetworkProcess",
  "WebKitGPUProcess",
];
const OTHER = "other";
const ALL_ROLES = [...ROLE_NAMES, OTHER];
const SAMPLE_MS = 2000;
const STEADY_SAMPLES = 5; // five snapshots, 2 s apart, taken after the point mark
const POINT_DEFAULT_S = 30;

function die(message, code = 2) {
  process.stderr.write(`measure-memory: ${message}\n`);
  process.exit(code);
}

const [appimageArg, url, secondsArg] = process.argv.slice(2);
if (!appimageArg || !url || !secondsArg) {
  die("usage: measure-memory.mjs <appimage> <url> <seconds>");
}
const appimage = resolve(appimageArg);
const seconds = Number(secondsArg);
if (!Number.isFinite(seconds) || seconds < 0) die(`invalid <seconds>: ${secondsArg}`);

const pointSeconds = Math.min(POINT_DEFAULT_S, seconds);
// Keep sampling long enough that the steady window always holds five snapshots
// taken after the point mark; the real end time is reported.
const endSeconds = Math.max(seconds, pointSeconds + (STEADY_SAMPLES * SAMPLE_MS) / 1000);

/* ---------------------------------------------------------------- hardware */

function gpuUsedMiB() {
  try {
    const raw = execFileSync(
      "nvidia-smi",
      ["--query-gpu=memory.used", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const value = Number.parseFloat((raw.trim().split("\n")[0] ?? "").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null; // no driver / no visibility: report null rather than invent
  }
}

/* -------------------------------------------------------------- /proc walk */

function readStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: tail[0], ppid: Number(tail[1]), pgrp: Number(tail[2]) };
  } catch {
    return null;
  }
}

function exePath(pid) {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null; // exited mid-walk, or not ours to inspect
  }
}

function pssKiB(pid) {
  // Preferred: the kernel's rolled-up Pss. Cheap and exact.
  try {
    const match = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)\s+kB/m);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    // unreadable (EACCES/ENOENT) or unsupported kernel: use the fallback
  }
  // Fallback: sum the per-mapping Pss lines.
  try {
    let total = 0;
    let found = false;
    for (const line of readFileSync(`/proc/${pid}/smaps`, "utf8").split("\n")) {
      const match = line.match(/^Pss:\s+(\d+)\s+kB/);
      if (match) {
        total += Number.parseInt(match[1], 10);
        found = true;
      }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

function roleOf(exe) {
  if (!exe) return OTHER;
  const name = basename(exe);
  for (const role of ROLE_NAMES) {
    if (name === role || name.startsWith(`${role}-`) || name.startsWith(`${role}.`)) return role;
  }
  return OTHER;
}

function processTable() {
  const table = new Map();
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return table;
  }
  for (const entry of entries) {
    const first = entry.charCodeAt(0);
    if (first < 48 || first > 57) continue; // numeric pids only
    const pid = Number(entry);
    const stat = readStat(pid);
    if (!stat) continue;
    table.set(pid, { pid, ...stat, exe: exePath(pid) });
  }
  return table;
}

function descendantsOf(table, rootPids) {
  const children = new Map();
  for (const proc of table.values()) {
    const siblings = children.get(proc.ppid);
    if (siblings) siblings.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const seen = new Set();
  const stack = [...rootPids];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return seen;
}

/**
 * Snapshot every process belonging to this launch.
 *
 * Discovery starts from the PPID chain below the launched pid (the spec). Two
 * invariants widen it so a re-exec by the AppImage runtime or a detached
 * supervisor cannot hide the tree: processes sharing the launched pid's own
 * process group (the child is a session leader, so that group is exclusively
 * ours) and the descendants of each resolved app root.
 */
function snapshot(launchedPid) {
  const table = processTable();
  const descendants = descendantsOf(table, [launchedPid]);

  const appRoots = [];
  for (const pid of descendants) {
    if (roleOf(table.get(pid)?.exe) === "zephium-desktop") appRoots.push(pid);
  }
  if (appRoots.length === 0 && roleOf(table.get(launchedPid)?.exe) === "zephium-desktop") {
    appRoots.push(launchedPid); // the launched pid itself re-exec'd into the app
  }

  let discovery = appRoots.length === 0 ? "unresolved" : "ppid";
  const selected = new Set(descendants);
  for (const root of appRoots) {
    for (const pid of descendantsOf(table, [root])) selected.add(pid);
  }
  for (const proc of table.values()) {
    if (proc.pgrp === launchedPid && proc.pgrp !== process.pid) {
      if (!selected.has(proc.pid)) discovery = `${discovery}+pgrp`;
      selected.add(proc.pid);
    }
  }

  const processes = [];
  const roles = Object.fromEntries(ALL_ROLES.map((role) => [role, 0]));
  for (const pid of selected) {
    const proc = table.get(pid);
    if (!proc) continue;
    const pss = pssKiB(pid);
    const role = roleOf(proc.exe);
    if (pss !== null) roles[role] += pss; // unreadable pids stay out of the totals
    processes.push({ pid, ppid: proc.ppid, role, exe: proc.exe, pssKiB: pss });
  }

  return {
    discovery,
    appRootPid: appRoots[0] ?? null,
    roles,
    processes: processes.sort((a, b) => a.pid - b.pid),
  };
}

/* --------------------------------------------------------------- lifecycle */

const stderrDir = mkdtempSync(join(tmpdir(), "neuxie-mem-"));
const stderrPath = join(stderrDir, "stderr.log");
const stderrFd = openSync(stderrPath, "w");

const gpuBaseline = gpuUsedMiB();

const child = spawn(appimage, [url], {
  detached: true, // own session + process group, so the whole tree can be killed
  stdio: ["ignore", "ignore", stderrFd],
  env: process.env,
});

child.on("error", (error) => {
  closeSync(stderrFd);
  die(`launch failed: ${error.message}`, 3);
});

process.stderr.write(
  `measure-memory: launched ${basename(appimage)} pid=${child.pid} url=${url}\n` +
    `measure-memory: stderr -> ${stderrPath}\n` +
    `measure-memory: sampling every ${SAMPLE_MS / 1000}s until t=${endSeconds}s ` +
    `(point t=${pointSeconds}s, steady = median of ${STEADY_SAMPLES} samples after it)\n`,
);

let killed = false;

function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      process.kill(child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function groupAlive() {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the whole group, give it 4 s, then SIGKILL whatever is left. */
function killTree() {
  if (killed) return;
  killed = true;
  signalGroup("SIGTERM");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && groupAlive()) {
    try {
      execFileSync("sleep", ["0.1"], { stdio: "ignore" });
    } catch {
      break;
    }
  }
  if (groupAlive()) signalGroup("SIGKILL");
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    killTree();
    process.exit(130);
  });
}

/* ------------------------------------------------------------------ report */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

const toMiB = (kib) => Math.round((kib / 1024) * 10) / 10;
const totalKiB = (roles) => ALL_ROLES.reduce((sum, role) => sum + roles[role], 0);

function renderTable(point, steady) {
  const width = Math.max(...ALL_ROLES.map((role) => role.length), "total".length);
  const left = `t=${point?.t ?? pointSeconds}s PSS`;
  const lines = [
    `${"role".padEnd(width)}  ${left.padEnd(14)}${"steady (median)".padEnd(18)}`,
    `${"-".repeat(width)}  ${"-".repeat(14)}${"-".repeat(18)}`,
  ];
  for (const role of ALL_ROLES) {
    const at = toMiB(point?.roles[role] ?? 0).toFixed(1).padStart(8);
    const mid = toMiB(steady?.[role] ?? 0).toFixed(1).padStart(10);
    lines.push(`${role.padEnd(width)}  ${`${at} MiB`.padEnd(14)}${`${mid} MiB`}`);
  }
  lines.push(`${"-".repeat(width)}  ${"-".repeat(14)}${"-".repeat(18)}`);
  const pointTotal = toMiB(point ? totalKiB(point.roles) : 0).toFixed(1).padStart(8);
  const steadyTotal = toMiB(steady ? totalKiB(steady) : 0).toFixed(1).padStart(10);
  lines.push(`${"total".padEnd(width)}  ${`${pointTotal} MiB`.padEnd(14)}${`${steadyTotal} MiB`}`);
  return lines.join("\n");
}

const samples = [];
try {
  const started = Date.now();
  for (let index = 0; ; index += 1) {
    const target = (index * SAMPLE_MS) / 1000;
    const wait = target - (Date.now() - started) / 1000;
    if (wait > 0) await sleep(wait * 1000);
    const t = Math.round(((Date.now() - started) / 1000) * 10) / 10;
    const snap = snapshot(child.pid);
    const gpu = gpuUsedMiB();
    samples.push({ t, gpuUsedMiB: gpu, ...snap });
    process.stderr.write(
      `measure-memory: t=${t}s discovery=${snap.discovery} root=${snap.appRootPid} ` +
        `procs=${snap.processes.length} pss=${toMiB(totalKiB(snap.roles))}MiB ` +
        `vram=${gpu ?? "n/a"}MiB\n`,
    );
    if (t >= endSeconds) break;
  }
} finally {
  killTree();
}

let stderrTail = "";
try {
  stderrTail = readFileSync(stderrPath, "utf8").split("\n").slice(-15).join("\n").trim();
} catch {
  stderrTail = "";
}

const point = samples.find((sample) => sample.t >= pointSeconds) ?? samples.at(-1) ?? null;
const afterPoint = samples.filter((sample) => sample.t > pointSeconds);
const steadySource = (afterPoint.length > 0 ? afterPoint : samples).slice(-STEADY_SAMPLES);
const steady =
  steadySource.length > 0
    ? Object.fromEntries(
        ALL_ROLES.map((role) => [
          role,
          median(steadySource.map((sample) => sample.roles[role])),
        ]),
      )
    : null;

const sawWebKitWebProcess = samples.some((sample) =>
  sample.processes.some((proc) => proc.role === "WebKitWebProcess"),
);

const result = {
  appimage,
  url,
  seconds,
  pointSeconds,
  endSeconds,
  gpu: {
    baselineUsedMiB: gpuBaseline,
    samples: samples.map((sample) => ({ t: sample.t, usedMiB: sample.gpuUsedMiB })),
  },
  sawWebKitWebProcess,
  point: point
    ? {
        t: point.t,
        discovery: point.discovery,
        appRootPid: point.appRootPid,
        roles: point.roles,
        gpuUsedMiB: point.gpuUsedMiB,
      }
    : null,
  steady: steady ? { sampleTimes: steadySource.map((sample) => sample.t), roles: steady } : null,
  samples,
  stderrPath,
  stderrTail,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
process.stdout.write(`\n${renderTable(point, steady)}\n`);
process.stdout.write(
  `vram: baseline ${gpuBaseline ?? "n/a"} MiB | point ${point?.gpuUsedMiB ?? "n/a"} MiB | ` +
    `steady ${median(steadySource.map((sample) => sample.gpuUsedMiB)) ?? "n/a"} MiB\n` +
    `procs at point: ${point?.processes.length ?? 0} | discovery: ${point?.discovery ?? "n/a"} | ` +
    `stderr: ${stderrPath}\n`,
);

if (!sawWebKitWebProcess) {
  die("FAIL no WebKitWebProcess in any sample — the /proc walk is broken", 1);
}
if (steadySource.length < STEADY_SAMPLES) {
  process.stderr.write(
    `measure-memory: note steady window has ${steadySource.length}/${STEADY_SAMPLES} samples\n`,
  );
}
process.exit(0);
