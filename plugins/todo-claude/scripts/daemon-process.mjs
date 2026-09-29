import path from "node:path";
import { spawnSync } from "node:child_process";

// Node uses Windows CRT quoting when constructing the CreateProcess command line.
// In particular, backslashes before a closing quote must be unescaped.
function windowsArguments(command) {
  const args = [];
  let i = 0;
  while (i < command.length) {
    while (/[ \t]/.test(command[i] || "") && i < command.length) i++;
    if (i === command.length) break;
    let value = "", quoted = false;
    while (i < command.length && (quoted || !/[ \t]/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === "\\") { slashes++; i++; }
      if (command[i] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else quoted = !quoted;
        i++;
      } else {
        value += "\\".repeat(slashes);
        if (i < command.length) value += command[i++];
      }
    }
    if (quoted) return null;
    args.push(value);
  }
  return args;
}

export function commandDaemonPath(command, repoRoot, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path;
  let executable, daemonPath;
  if (platform === "win32") {
    const args = windowsArguments(command);
    if (!args || args.length !== 4 || args[2] !== "--repo" ||
        !paths.isAbsolute(args[3]) ||
        paths.resolve(args[3]).toLowerCase() !== paths.resolve(repoRoot).toLowerCase()) return null;
    [executable, daemonPath] = args;
  } else {
    const repoSuffix = ` --repo ${repoRoot}`;
    if (!command.endsWith(repoSuffix)) return null;
    const launch = command.slice(0, -repoSuffix.length);
    const separator = launch.indexOf(" ");
    if (separator <= 0) return null;
    executable = launch.slice(0, separator);
    daemonPath = launch.slice(separator + 1);
  }
  if (!paths.isAbsolute(executable) ||
      !/^node(?:js)?(?:\.exe)?$/i.test(paths.basename(executable)) ||
      !paths.isAbsolute(daemonPath) ||
      !daemonPath.endsWith(paths.join("scripts", "daemon.mjs"))) return null;
  return paths.resolve(daemonPath);
}

export function inspectProcess(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    // Interpolate only a validated PID; paths and command lines are returned as
    // JSON data, never evaluated as PowerShell code. Keep Unicode paths intact.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
      "if ($null -eq $p) { exit 1 }",
      "@{ startedAt = $p.CreationDate.ToUniversalTime().ToString('o'); command = $p.CommandLine } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    if (result.status !== 0 || result.error) return null;
    try {
      const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
      const startedAt = Date.parse(value.startedAt);
      if (!Number.isFinite(startedAt) || typeof value.command !== "string" || !value.command.trim()) return null;
      return { startedAt, command: value.command };
    } catch { return null; }
  }
  const result = run("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const match = result.stdout?.trim().match(/^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  const startedAt = Date.parse(`${match?.[1] || ""} UTC`);
  if (result.status !== 0 || result.error || !Number.isFinite(startedAt) || !match?.[2]) return null;
  return { startedAt, command: match[2] };
}

export function signalDaemon(pid, signal, platform = process.platform) {
  // Windows emulates SIGTERM by killing the process, bypassing all cleanup.
  // The daemon polls authenticated stop/restart/dashboard request files instead.
  if (platform === "win32") return;
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== "ESRCH" && error.code !== "EINVAL") throw error; }
}
