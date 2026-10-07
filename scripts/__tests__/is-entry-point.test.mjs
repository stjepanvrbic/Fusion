import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../lib/is-entry-point.mjs";

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const noRealpath = () => {
  throw new Error("realpath unavailable");
};

test("isEntryPoint matches a Windows argv path, including spaces and drive-letter case", () => {
  const url = "file:///C:/Users/a%20b/repo/scripts/run-static-gate-checks.mjs";
  const opts = { platform: "win32", realpath: noRealpath };
  assert.equal(isEntryPoint(url, { ...opts, argv1: "C:\\Users\\a b\\repo\\scripts\\run-static-gate-checks.mjs" }), true);
  assert.equal(isEntryPoint(url, { ...opts, argv1: "c:\\Users\\a b\\repo\\scripts\\run-static-gate-checks.mjs" }), true);
  assert.equal(isEntryPoint(url, { ...opts, argv1: "C:/Users/a b/repo/scripts/run-static-gate-checks.mjs" }), true);
  assert.equal(isEntryPoint(url, { ...opts, argv1: "C:\\Users\\a b\\repo\\scripts\\other.mjs" }), false);
});

test("isEntryPoint matches a POSIX argv path with spaces and stays case-sensitive", () => {
  const url = "file:///home/u/a%20b/scripts/x.mjs";
  const opts = { platform: "linux", realpath: noRealpath };
  assert.equal(isEntryPoint(url, { ...opts, argv1: "/home/u/a b/scripts/x.mjs" }), true);
  assert.equal(isEntryPoint(url, { ...opts, argv1: "/home/u/a b/scripts/X.mjs" }), false);
});

test("isEntryPoint is false when imported (no argv entry) and true through a symlinked argv", () => {
  const url = "file:///real/scripts/x.mjs";
  assert.equal(isEntryPoint(url, { argv1: undefined, platform: "linux" }), false);
  assert.equal(isEntryPoint(url, { argv1: "", platform: "linux" }), false);
  const realpath = (p) => (p === "/link/x.mjs" ? "/real/scripts/x.mjs" : p);
  assert.equal(isEntryPoint(url, { argv1: "/link/x.mjs", platform: "linux", realpath }), true);
});

/*
FNXC:WindowsEntryGuard 2026-10-07-18:03:
Code-construct ratchet: the hand-built `file://` + argv comparison can never match a Windows path, so no script may reintroduce it.
*/
test("no script compares import.meta.url against a hand-built file:// argv string", () => {
  const brokenGuard = ["`file://", "${process.argv[1]}`"].join("");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (/\.m?js$/.test(entry.name)) {
        const code = readFileSync(full, "utf8")
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\*|\/\/)/.test(line))
          .join("\n");
        if (code.includes(`=== ${brokenGuard}`)) offenders.push(path.relative(scriptsDir, full));
      }
    }
  };
  walk(scriptsDir);
  assert.deepEqual(offenders, []);
});
