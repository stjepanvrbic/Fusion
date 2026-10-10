// Security tests for the ACP path deny-list. Each `it` runs against real temp
// dirs + real symlinks. Do NOT weaken these to go green — if one fails, the
// deny-list is wrong, not the test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  resolveAllowedPath,
  openAllowedPath,
  isSecretPath,
  isGitInternal,
} from "../path-deny-list.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  // realpath the temp roots up front so expected paths match resolved ones on
  // macOS, where /var is a symlink to /private/var.
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acp-deny-cwd-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "acp-deny-out-")));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

describe("resolveAllowedPath", () => {
  it("resolves an existing file inside cwd to its real path", async () => {
    await writeFile(path.join(cwd, "a.txt"), "hi", "utf8");
    expect(await resolveAllowedPath("a.txt", cwd)).toBe(path.join(cwd, "a.txt"));
  });

  it("resolves a not-yet-existing file", async () => {
    expect(await resolveAllowedPath("new-file.txt", cwd)).toBe(path.join(cwd, "new-file.txt"));
  });

  it("resolves paths outside cwd: absolute, `../`, and through a symlinked directory", async () => {
    await writeFile(path.join(outside, "notes.txt"), "x", "utf8");
    const expected = path.join(outside, "notes.txt");
    expect(await resolveAllowedPath(expected, cwd)).toBe(expected);
    expect(await resolveAllowedPath(path.relative(cwd, expected), cwd)).toBe(expected);
    await symlink(outside, path.join(cwd, "out-link"), "dir");
    expect(await resolveAllowedPath("out-link/notes.txt", cwd)).toBe(expected);
  });

  it("denies a secret outside cwd", async () => {
    await writeFile(path.join(outside, ".env"), "API_KEY=sk-123", "utf8");
    await expect(resolveAllowedPath(path.join(outside, ".env"), cwd)).rejects.toMatchObject({
      code: "denied_secret",
    });
  });

  it("denies a symlink whose real target is a secret", async () => {
    await writeFile(path.join(outside, "id_rsa"), "-----BEGIN", "utf8");
    await symlink(path.join(outside, "id_rsa"), path.join(cwd, "innocent.txt"));
    await expect(resolveAllowedPath("innocent.txt", cwd)).rejects.toMatchObject({
      code: "denied_secret",
    });
  });

  it("denies git internals of any repository", async () => {
    await mkdir(path.join(outside, ".git", "hooks"), { recursive: true });
    await expect(
      resolveAllowedPath(path.join(outside, ".git", "hooks", "pre-commit"), cwd),
    ).rejects.toMatchObject({ code: "denied_git" });
  });

  it("rejects a dangling symlink final component, whose eventual target is unknown", async () => {
    await symlink(path.join(outside, "nope.txt"), path.join(cwd, "dangling"));
    await expect(resolveAllowedPath("dangling", cwd)).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("rejects a NUL byte or an empty path with invalid_path", async () => {
    await expect(resolveAllowedPath("a\0b.txt", cwd)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(resolveAllowedPath("", cwd)).rejects.toMatchObject({ code: "invalid_path" });
  });
});

describe("openAllowedPath (TOCTOU defense)", () => {
  it("opens a regular file", async () => {
    const p = path.join(outside, "ok.txt");
    await writeFile(p, "content", "utf8");
    const handle = await openAllowedPath(p, fsConstants.O_RDONLY);
    const data = await handle.readFile({ encoding: "utf8" });
    await handle.close();
    expect(data).toBe("content");
  });

  it("refuses a checked path that was swapped for a symlink to a secret before open", async () => {
    const checked = await resolveAllowedPath("swapped.txt", cwd);
    await writeFile(path.join(outside, ".env"), "API_KEY=sk-123", "utf8");
    await symlink(path.join(outside, ".env"), checked);
    await expect(openAllowedPath(checked, fsConstants.O_RDONLY)).rejects.toBeTruthy();
  });
});

describe("deny-list predicates", () => {
  it("flags secret basenames", () => {
    for (const f of [
      ".env",
      ".env.local",
      ".env.production",
      "server.pem",
      "tls.key",
      ".npmrc",
      ".netrc",
      "id_rsa",
      "id_ed25519.pub",
      "credentials",
      // FIX 6: expanded secret deny-list.
      ".git-credentials",
      "server.p12",
      "cert.pfx",
      "release.keystore",
      "app.jks",
      ".dockercfg",
      ".pgpass",
      ".htpasswd",
    ]) {
      expect(isSecretPath(path.join(cwd, f))).toBe(true);
    }
  });

  it("does not flag ordinary files as secret", () => {
    for (const f of ["index.ts", "README.md", "envoy.json", "keyboard.txt"]) {
      expect(isSecretPath(path.join(cwd, f))).toBe(false);
    }
  });

  it("flags any path under a .git/ dir", () => {
    expect(isGitInternal(path.join(cwd, ".git", "config"))).toBe(true);
    expect(isGitInternal(path.join(cwd, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(isGitInternal(path.join(cwd, "src", "app.ts"))).toBe(false);
    expect(isGitInternal(path.join(cwd, "gitignore.txt"))).toBe(false);
  });
});
