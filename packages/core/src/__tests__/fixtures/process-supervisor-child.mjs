#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "keepalive";
const pidFile = process.argv[3];
const extraFile = process.argv[4];

if (pidFile) {
  writeFileSync(pidFile, String(process.pid), "utf8");
}

if (mode === "exit-immediately") {
  process.exit(0);
}

if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
}

if (mode === "spawn-child") {
  const selfPath = fileURLToPath(import.meta.url);
  const grandchild = spawn(process.execPath, [selfPath, "keepalive", extraFile].filter(Boolean), {
    stdio: "ignore",
  });
  grandchild.unref();
}

// The grandchild inherits this process's stdio, so it holds the supervisor's pipes the way a real
// test runner or dev server under `cmd.exe /c` does. "-then-exit" detaches it so it escapes both the
// POSIX process group and the Windows job of this process, then leaves it orphaned.
if (mode === "spawn-child-inherit" || mode === "spawn-child-inherit-then-exit") {
  const selfPath = fileURLToPath(import.meta.url);
  // process-supervisor-allowlist: test fixture models a descendant that escaped tree supervision.
  const grandchild = spawn(process.execPath, [selfPath, "keepalive", extraFile].filter(Boolean), {
    stdio: "inherit",
    detached: mode === "spawn-child-inherit-then-exit",
  });
  grandchild.unref();
  if (mode === "spawn-child-inherit-then-exit") {
    const exitWhenGrandchildRecorded = setInterval(() => {
      try {
        readFileSync(extraFile, "utf8");
        clearInterval(exitWhenGrandchildRecorded);
        process.exit(0);
      } catch {
        // Grandchild has not written its pid yet.
      }
    }, 20);
  }
}

setInterval(() => {}, 1_000);
